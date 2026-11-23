/*
 * rdpenc: turns a recorded RDP session (the post-TLS PDU stream, in FreeRDP's
 * transport dump format) into video. It replays the server's PDUs into a
 * headless FreeRDP client, without delays, and writes the screen as raw BGR0
 * frames at a constant rate to stdout, each at the moment it was recorded.
 *
 * Based on FreeRDP's sample client (client/Sample/tf_freerdp.c, Apache-2.0).
 *
 *   rdpenc <dump|-> <fps> | ffmpeg -f rawvideo -pix_fmt bgr0 -s WxH -r <fps> -i - ...
 * The size is printed to stderr as "size WxH" before the first frame, and
 * "frames N, M ms" (the time the recording spans) at the end. The connector's
 * recording worker runs it (recmaint.go, EncodeRdp); the data plane writes the
 * dump (dataplane/rdprecord.go).
 *
 *   rdpenc --live <fps> [freerdp options]
 * Live watching (connector/rdplive.go): the server's PDUs arrive on stdin as
 * the session runs and are decoded as they come, watched or not, so the screen
 * is always current. Commands on file descriptor 3, one a line: "join" (a
 * viewer came: send the whole screen next) and "idle" (nobody watches: send
 * nothing). While watched, stdout carries Guacamole protocol a browser viewer
 * draws: the screen's size, then what changed, as JPEG, at most <fps> times a
 * second, each followed by a sync.
 *
 * A dump may start with a client record holding the network data block of the
 * client's Connect Initial (dataplane/rdprecord.go, connector/rdplive.go): the
 * static channels it asked for. The server numbers channels in that order, so
 * the replay asks for the same list; what arrives on a channel it has no
 * plugin for is dropped. Without that record (older recordings) it asks for
 * its own.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <freerdp/freerdp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/client.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/channels/channels.h>
#include <freerdp/client/channels.h>
#include <freerdp/gdi/gfx.h>
#include <freerdp/client/rdpgfx.h>
#include <freerdp/streamdump.h>
#include <freerdp/transport_io.h>
#include <winpr/stream.h>
#include <winpr/synch.h>
#include <poll.h>
#include <pthread.h>
#include <sys/time.h>
#include <unistd.h>
#include <turbojpeg.h>

typedef struct {
	rdpClientContext common;
} encContext;

static FILE* dumpFile;
static UINT64 firstTs, curTs;      /* ms, from the dump */
static UINT32 fps = 10;
static UINT64 framesOut;           /* frames written so far */
static UINT32 outW, outH;          /* fixed output size (the first desktop size) */
static BYTE* lastFrame;
static BOOL ended;

static void emit_until(UINT64 ts)
{
	if (!lastFrame)
		return;
	const UINT64 want = ((ts - firstTs) * fps) / 1000 + 1;
	while (framesOut < want) {
		if (fwrite(lastFrame, 1, (size_t)outW * outH * 4, stdout) != (size_t)outW * outH * 4) {
			ended = TRUE;
			return;
		}
		framesOut++;
	}
}

/* Copy the GDI surface into the fixed-size frame (cropped or padded). */
static void grab(rdpGdi* gdi)
{
	if (!outW) {
		outW = gdi->width & ~1u;
		outH = gdi->height & ~1u;
		lastFrame = calloc((size_t)outW * outH, 4);
		fprintf(stderr, "size %ux%u\n", outW, outH);
		fflush(stderr);
	}
	const UINT32 w = MIN(outW, (UINT32)gdi->width), h = MIN(outH, (UINT32)gdi->height);
	for (UINT32 y = 0; y < h; y++)
		memcpy(lastFrame + (size_t)y * outW * 4, gdi->primary_buffer + (size_t)y * gdi->stride, (size_t)w * 4);
}

static BOOL enc_begin_paint(rdpContext* context)
{
	context->gdi->primary->hdc->hwnd->invalid->null = TRUE;
	return TRUE;
}

/* ---- live watching ---- */

static BOOL live;
static rdpGdi* liveGdi;
static pthread_mutex_t liveMu = PTHREAD_MUTEX_INITIALIZER;
static BOOL watched, wantKey;
static BOOL dirty;
static INT32 dx1, dy1, dx2, dy2; /* the changed area since the last send */
static UINT64 lastSend;
static UINT32 streamNo;
static tjhandle tj;

static UINT64 now_ms(void)
{
	struct timeval tv;
	gettimeofday(&tv, NULL);
	return (UINT64)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

/* One Guacamole instruction: each element as LENGTH.VALUE (length in characters). */
static void guac(int n, const char** el)
{
	for (int i = 0; i < n; i++) {
		size_t len = strlen(el[i]);
		/* Every element is ASCII here, so its length in characters is its byte length. */
		printf("%zu.%s%c", len, el[i], i == n - 1 ? ';' : ',');
	}
}

static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* Send one area of the screen as a JPEG image stream. Callers hold liveMu. */
static void send_area(INT32 x, INT32 y, INT32 w, INT32 h)
{
	rdpGdi* gdi = liveGdi;
	if (w <= 0 || h <= 0 || !gdi || !gdi->primary_buffer)
		return;
	unsigned char* jpeg = NULL;
	unsigned long size = 0;
	const BYTE* src = gdi->primary_buffer + (size_t)y * gdi->stride + (size_t)x * 4;
	if (tjCompress2(tj, src, w, (int)gdi->stride, h, TJPF_BGRX, &jpeg, &size, TJSAMP_420, 80, TJFLAG_FASTDCT) != 0)
		return;
	char sn[16], xs[16], ys[16];
	streamNo = streamNo % 1000 + 1;
	snprintf(sn, sizeof sn, "%u", streamNo);
	snprintf(xs, sizeof xs, "%d", x);
	snprintf(ys, sizeof ys, "%d", y);
	const char* img[] = { "img", sn, "14", "0", "image/jpeg", xs, ys };
	guac(7, img);
	/* The data in blobs of at most 6 KiB of base64. */
	char chunk[6144 + 4];
	for (unsigned long off = 0; off < size; off += 4608) {
		unsigned long end = off + 4608 < size ? off + 4608 : size;
		size_t o = 0;
		for (unsigned long i = off; i < end; i += 3) {
			unsigned v = (unsigned)jpeg[i] << 16;
			if (i + 1 < end) v |= (unsigned)jpeg[i + 1] << 8;
			if (i + 2 < end) v |= jpeg[i + 2];
			chunk[o++] = b64[(v >> 18) & 63];
			chunk[o++] = b64[(v >> 12) & 63];
			chunk[o++] = i + 1 < end ? b64[(v >> 6) & 63] : '=';
			chunk[o++] = i + 2 < end ? b64[v & 63] : '=';
		}
		chunk[o] = 0;
		const char* blob[] = { "blob", sn, chunk };
		guac(3, blob);
	}
	const char* end[] = { "end", sn };
	guac(2, end);
	tjFree(jpeg);
}

/* Send what changed (or the whole screen for a new viewer). Callers hold liveMu. */
static void live_flush(BOOL force)
{
	if (!watched || !liveGdi)
		return;
	UINT64 t = now_ms();
	if (!force && t - lastSend < 1000 / fps)
		return;
	rdpGdi* gdi = liveGdi;
	BOOL any = FALSE;
	if (wantKey) {
		char ws[16], hs[16];
		snprintf(ws, sizeof ws, "%u", gdi->width);
		snprintf(hs, sizeof hs, "%u", gdi->height);
		const char* size[] = { "size", "0", ws, hs };
		guac(4, size);
		send_area(0, 0, gdi->width, gdi->height);
		wantKey = dirty = FALSE;
		any = TRUE;
	} else if (dirty) {
		INT32 x1 = MAX(0, dx1), y1 = MAX(0, dy1);
		INT32 x2 = MIN((INT32)gdi->width, dx2), y2 = MIN((INT32)gdi->height, dy2);
		send_area(x1, y1, x2 - x1, y2 - y1);
		dirty = FALSE;
		any = TRUE;
	}
	if (any) {
		char ts[24];
		snprintf(ts, sizeof ts, "%llu", (unsigned long long)t);
		const char* sync[] = { "sync", ts };
		guac(2, sync);
		fflush(stdout);
		lastSend = t;
	}
}

/* A command from the connector on fd 3. */
static void live_command(void)
{
	char buf[64];
	ssize_t n = read(3, buf, sizeof buf - 1);
	if (n <= 0) {
		ended = TRUE;
		return;
	}
	buf[n] = 0;
	pthread_mutex_lock(&liveMu);
	if (strstr(buf, "join"))
		watched = wantKey = TRUE;
	if (strstr(buf, "idle"))
		watched = FALSE;
	pthread_mutex_unlock(&liveMu);
}

static BOOL enc_end_paint(rdpContext* context)
{
	rdpGdi* gdi = context->gdi;
	if (gdi->primary->hdc->hwnd->invalid->null)
		return TRUE;
	if (live) {
		HGDI_RGN r = gdi->primary->hdc->hwnd->invalid;
		pthread_mutex_lock(&liveMu);
		liveGdi = gdi;
		if (!dirty) {
			dx1 = r->x, dy1 = r->y, dx2 = r->x + r->w, dy2 = r->y + r->h;
			dirty = TRUE;
		} else {
			dx1 = MIN(dx1, r->x), dy1 = MIN(dy1, r->y);
			dx2 = MAX(dx2, r->x + r->w), dy2 = MAX(dy2, r->y + r->h);
		}
		live_flush(FALSE);
		pthread_mutex_unlock(&liveMu);
		return TRUE;
	}
	emit_until(curTs);  /* the previous picture lasts until now */
	grab(gdi);
	return TRUE;
}

static BOOL enc_desktop_resize(rdpContext* context)
{
	rdpSettings* settings = context->settings;
	pthread_mutex_lock(&liveMu);
	BOOL ok = gdi_resize(context->gdi, freerdp_settings_get_uint32(settings, FreeRDP_DesktopWidth),
	                     freerdp_settings_get_uint32(settings, FreeRDP_DesktopHeight));
	wantKey = TRUE; /* a viewer needs the new size and all of the screen */
	pthread_mutex_unlock(&liveMu);
	return ok;
}

/* Live: wait for stdin, sending what changed meanwhile and taking commands. */
static BOOL live_wait(void)
{
	for (;;) {
		struct pollfd fds[2] = { { .fd = fileno(dumpFile), .events = POLLIN }, { .fd = 3, .events = POLLIN } };
		int n = poll(fds, 2, 1000 / (int)fps);
		if (n < 0)
			return FALSE;
		if (fds[1].revents & (POLLIN | POLLHUP))
			live_command();
		if (ended)
			return FALSE;
		pthread_mutex_lock(&liveMu);
		live_flush(wantKey);
		if (dirty)
			live_flush(TRUE);
		pthread_mutex_unlock(&liveMu);
		if (fds[0].revents & (POLLIN | POLLHUP))
			return TRUE;
	}
}

/* One record of the dump, into a buffer of its own. */
static BYTE* recBuf;
static size_t recCap, recLen;
static UINT64 recTs;
static BYTE recReceived;
static BOOL recHeld; /* read ahead of the connection: hand it out first */

static BOOL next_record(void)
{
	if (recHeld) {
		recHeld = FALSE;
		return TRUE;
	}
	UINT64 size = 0;
	UINT32 crc = 0;
	if (fread(&recTs, 8, 1, dumpFile) != 1 || fread(&recReceived, 1, 1, dumpFile) != 1 ||
	    fread(&crc, 4, 1, dumpFile) != 1 || fread(&size, 8, 1, dumpFile) != 1 || size > (1u << 26))
		return FALSE;
	if (size > recCap) {
		BYTE* b = realloc(recBuf, (size_t)size);
		if (!b)
			return FALSE;
		recBuf = b;
		recCap = (size_t)size;
	}
	recLen = (size_t)size;
	return fread(recBuf, 1, recLen, dumpFile) == recLen;
}

/* The recorded client's static channels (TS_UD_CS_NET). */
static CHANNEL_DEF recChannels[CHANNEL_MAX_COUNT];
static UINT32 recChannelCount;
static BOOL haveRecChannels;

static void read_client_channels(void)
{
	if (!next_record())
		return; /* the replay finds the end itself */
	if (!recReceived || recLen < 8 || recBuf[0] != 0x03 || recBuf[1] != 0xC0) {
		recHeld = TRUE;
		return;
	}
	UINT32 n = recBuf[4] | recBuf[5] << 8 | recBuf[6] << 16 | (UINT32)recBuf[7] << 24;
	if (n > CHANNEL_MAX_COUNT || 8 + 12 * (size_t)n > recLen)
		return;
	for (UINT32 i = 0; i < n; i++) {
		const BYTE* d = recBuf + 8 + 12 * i;
		memcpy(recChannels[i].name, d, 8);
		recChannels[i].name[7] = 0;
		recChannels[i].options = d[8] | d[9] << 8 | d[10] << 16 | (UINT32)d[11] << 24;
	}
	recChannelCount = n;
	haveRecChannels = TRUE;
	fprintf(stderr, "channels");
	for (UINT32 i = 0; i < n; i++)
		fprintf(stderr, "%s%s", i ? "," : " ", recChannels[i].name);
	fprintf(stderr, "\n");
}

/* Ask for the recorded client's channels, in its order: a loaded plugin keeps
 * its options, a channel without one is there by name. Plugins the recorded
 * client had no channel for go after them; the server's answer numbers only
 * the recorded ones, so they get none. */
static BOOL apply_client_channels(rdpSettings* settings)
{
	if (!haveRecChannels)
		return TRUE;
	CHANNEL_DEF defs[CHANNEL_MAX_COUNT];
	UINT32 n = recChannelCount;
	memcpy(defs, recChannels, sizeof(CHANNEL_DEF) * n);
	const UINT32 loaded = freerdp_settings_get_uint32(settings, FreeRDP_ChannelCount);
	for (UINT32 j = 0; j < loaded; j++) {
		const CHANNEL_DEF* d = freerdp_settings_get_pointer_array(settings, FreeRDP_ChannelDefArray, j);
		if (!d)
			continue;
		BOOL found = FALSE;
		for (UINT32 i = 0; i < recChannelCount; i++)
			if (strncmp(d->name, defs[i].name, CHANNEL_NAME_LEN) == 0) {
				defs[i].options = d->options;
				found = TRUE;
			}
		if (!found && n < CHANNEL_MAX_COUNT)
			defs[n++] = *d;
	}
	if (!freerdp_settings_set_pointer_len(settings, FreeRDP_ChannelDefArray, NULL, CHANNEL_MAX_COUNT))
		return FALSE;
	for (UINT32 i = 0; i < n; i++)
		if (!freerdp_settings_set_pointer_array(settings, FreeRDP_ChannelDefArray, i, &defs[i]))
			return FALSE;
	return freerdp_settings_set_uint32(settings, FreeRDP_ChannelCount, n);
}

/* Data on a channel without a plugin (the client's clipboard, drives, sound)
 * is dropped instead of ending the replay. */
static BOOL enc_receive_channel_data(freerdp* instance, UINT16 channelId, const BYTE* data, size_t size,
                                     UINT32 flags, size_t total)
{
	(void)freerdp_channels_data(instance, channelId, data, size, flags, total);
	return TRUE;
}

/* The replay transport: the server's PDUs from the dump, no delays. */
static int enc_read_pdu(rdpTransport* transport, wStream* s)
{
	for (;;) {
		if (live && !recHeld && !live_wait()) {
			ended = TRUE;
			return -1;
		}
		if (!next_record()) {
			ended = TRUE;
			return -1;
		}
		if (recReceived)
			continue; /* what the client sent: not replayed */
		Stream_SetPosition(s, 0);
		if (!Stream_EnsureCapacity(s, recLen)) {
			ended = TRUE;
			return -1;
		}
		memcpy(Stream_Buffer(s), recBuf, recLen);
		if (!firstTs)
			firstTs = recTs;
		curTs = recTs;
		Stream_SetLength(s, recLen);
		Stream_SetPosition(s, 0);
		return 1;
	}
}

static int enc_write_pdu(rdpTransport* transport, wStream* s)
{
	return 1;
}

static int enc_tcp_connect(rdpContext* context, rdpSettings* settings, const char* hostname, int port, DWORD timeout)
{
	return 42;
}

/* The plugins load here, before the Connect Initial is made. */
static pConnectCallback defaultLoadChannels;

static BOOL enc_load_channels(freerdp* instance)
{
	if (defaultLoadChannels && !defaultLoadChannels(instance))
		return FALSE;
	return apply_client_channels(instance->context->settings);
}

static BOOL enc_tls(rdpTransport* transport)
{
	return TRUE;
}

static rdpTransportLayer* enc_connect_layer(rdpTransport* transport, const char* hostname, int port, DWORD timeout)
{
	return NULL;
}

static BOOL enc_pre_connect(freerdp* instance)
{
	rdpSettings* settings = instance->context->settings;
	if (!freerdp_settings_set_uint32(settings, FreeRDP_OsMajorType, OSMAJORTYPE_UNIX))
		return FALSE;
	PubSub_SubscribeChannelConnected(instance->context->pubSub, freerdp_client_OnChannelConnectedEventHandler);
	PubSub_SubscribeChannelDisconnected(instance->context->pubSub, freerdp_client_OnChannelDisconnectedEventHandler);
	return TRUE;
}

static BOOL enc_post_connect(freerdp* instance)
{
	if (!gdi_init(instance, PIXEL_FORMAT_BGRX32))
		return FALSE;
	pthread_mutex_lock(&liveMu);
	liveGdi = instance->context->gdi;
	pthread_mutex_unlock(&liveMu);
	instance->context->update->BeginPaint = enc_begin_paint;
	instance->context->update->EndPaint = enc_end_paint;
	instance->context->update->DesktopResize = enc_desktop_resize;
	return TRUE;
}

static void enc_post_disconnect(freerdp* instance)
{
	gdi_free(instance);
}

static BOOL enc_client_new(freerdp* instance, rdpContext* context)
{
	instance->PreConnect = enc_pre_connect;
	instance->PostConnect = enc_post_connect;
	instance->PostDisconnect = enc_post_disconnect;
	return TRUE;
}

static int entry(RDP_CLIENT_ENTRY_POINTS* ep)
{
	ZeroMemory(ep, sizeof(*ep));
	ep->Version = RDP_CLIENT_INTERFACE_VERSION;
	ep->Size = sizeof(RDP_CLIENT_ENTRY_POINTS_V1);
	ep->ContextSize = sizeof(encContext);
	ep->ClientNew = enc_client_new;
	return 0;
}

int main(int argc, char* argv[])
{
	if (argc < 3) {
		fprintf(stderr, "usage: rdpenc <dump|-> <fps> [freerdp options]\n       rdpenc --live <fps> [freerdp options]\n");
		return 2;
	}
	live = strcmp(argv[1], "--live") == 0;
	if (live) {
		tj = tjInitCompress();
		/* Unbuffered reads: poll() must see what fread has not taken yet. */
		setvbuf(stdin, NULL, _IONBF, 0);
		setvbuf(stdout, NULL, _IOFBF, 1 << 16);
	}
	dumpFile = live || strcmp(argv[1], "-") == 0 ? stdin : fopen(argv[1], "rb");
	if (!dumpFile) {
		perror("dump");
		return 2;
	}
	fps = (UINT32)atoi(argv[2]);
	if (fps < 1 || fps > 30)
		fps = 10;

	RDP_CLIENT_ENTRY_POINTS ep;
	entry(&ep);
	rdpContext* context = freerdp_client_context_new(&ep);
	if (!context)
		return 1;
	/* What the recorded client asked for (graphics pipeline, channels) comes as options. */
	/* The parser writes into its arguments: give it copies. */
	const char* fixed[] = { "rdpenc", "/v:replay", "/u:replay", "/p:replay", "/cert:ignore", "/log-level:ERROR" };
	char* args[64] = { 0 };
	int n = 0;
	for (size_t i = 0; i < ARRAYSIZE(fixed); i++)
		args[n++] = _strdup(fixed[i]);
	for (int i = 3; i < argc && n < 63; i++)
		args[n++] = _strdup(argv[i]);
	if (freerdp_client_settings_parse_command_line(context->settings, n, args, FALSE) != 0)
		return 2;
	rdpSettings* settings = context->settings;
	freerdp_settings_set_bool(settings, FreeRDP_TransportDumpReplay, TRUE);
	freerdp_settings_set_bool(settings, FreeRDP_DeactivateClientDecoding, FALSE);

	rdpTransportIo io = *freerdp_get_io_callbacks(context);
	io.ReadPdu = enc_read_pdu;
	io.WritePdu = enc_write_pdu;
	io.TCPConnect = enc_tcp_connect;
	io.TLSConnect = enc_tls;
	io.TLSAccept = enc_tls;
	io.ConnectLayer = enc_connect_layer;
	if (!freerdp_set_io_callbacks(context, &io) || !freerdp_io_callback_set_event(context, TRUE))
		return 1;

	freerdp* instance = context->instance;
	instance->ReceiveChannelData = enc_receive_channel_data;
	defaultLoadChannels = instance->LoadChannels;
	instance->LoadChannels = enc_load_channels;
	read_client_channels();
	if (!freerdp_connect(instance)) {
		fprintf(stderr, "connect failed\n");
		return 1;
	}
	HANDLE handles[MAXIMUM_WAIT_OBJECTS] = { 0 };
	while (!ended && !freerdp_shall_disconnect_context(instance->context)) {
		DWORD nCount = freerdp_get_event_handles(instance->context, handles, ARRAYSIZE(handles));
		if (nCount == 0)
			break;
		(void)WaitForMultipleObjects(nCount, handles, FALSE, 100);
		if (!freerdp_check_event_handles(instance->context))
			break;
	}
	emit_until(curTs + 1000); /* the last picture, for a second */
	fflush(stdout);
	fprintf(stderr, "frames %llu, %llu ms\n", (unsigned long long)framesOut, (unsigned long long)(curTs - firstTs));
	freerdp_disconnect(instance);
	freerdp_client_context_free(context);
	return 0;
}

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

static BOOL enc_end_paint(rdpContext* context)
{
	rdpGdi* gdi = context->gdi;
	if (gdi->primary->hdc->hwnd->invalid->null)
		return TRUE;
	emit_until(curTs);  /* the previous picture lasts until now */
	grab(gdi);
	return TRUE;
}

static BOOL enc_desktop_resize(rdpContext* context)
{
	rdpSettings* settings = context->settings;
	return gdi_resize(context->gdi, freerdp_settings_get_uint32(settings, FreeRDP_DesktopWidth),
	                  freerdp_settings_get_uint32(settings, FreeRDP_DesktopHeight));
}

/* The replay transport: the server's PDUs from the dump, no delays. */
static int enc_read_pdu(rdpTransport* transport, wStream* s)
{
	for (;;) {
		UINT64 ts = 0, size = 0;
		BYTE received = 0;
		UINT32 crc = 0;
		if (fread(&ts, 8, 1, dumpFile) != 1 || fread(&received, 1, 1, dumpFile) != 1 ||
		    fread(&crc, 4, 1, dumpFile) != 1 || fread(&size, 8, 1, dumpFile) != 1) {
			ended = TRUE;
			return -1;
		}
		if (size > (1u << 26)) {
			ended = TRUE;
			return -1;
		}
		Stream_SetPosition(s, 0);
		if (!Stream_EnsureCapacity(s, (size_t)size)) {
			ended = TRUE;
			return -1;
		}
		if (fread(Stream_Buffer(s), 1, (size_t)size, dumpFile) != size) {
			ended = TRUE;
			return -1;
		}
		if (received)
			continue; /* what the client sent: not replayed */
		if (!firstTs)
			firstTs = ts;
		curTs = ts;
		Stream_SetLength(s, (size_t)size);
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
		fprintf(stderr, "usage: rdpenc <dump> <fps> [freerdp options]\n");
		return 2;
	}
	dumpFile = strcmp(argv[1], "-") == 0 ? stdin : fopen(argv[1], "rb");
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

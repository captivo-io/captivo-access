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
 *
 * The pointer: the server sends its shape, the client moves it. Client records
 * of tunnel.PointerRecord ("PT", x, y) say where it went; the video has the
 * pointer drawn in, and live watching sends it as Guacamole cursor and mouse.
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
#include <zlib.h>

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
	if (!lastFrame || ts < firstTs)
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

/* ---- what the server sent, for the log: why a video can come out black ---- */

static struct {
	UINT32 paints, bitmaps, surfaceBits, sbCodecs[256];
	UINT32 gfxVersion, gfxFlags, surfaces, resets, maps, scaledMaps, gfxCmds[16];
	UINT32 resetW, resetH, resetMonitors, mapX, mapY, surfW, surfH;
	UINT32 desktopW, desktopH, resizes;
} st;

static pcRdpgfxSurfaceCommand gfxSurfaceCommand;
static pcRdpgfxCreateSurface gfxCreateSurface;
static pcRdpgfxResetGraphics gfxResetGraphics;
static pcRdpgfxMapSurfaceToOutput gfxMapSurfaceToOutput;
static pcRdpgfxMapSurfaceToScaledOutput gfxMapSurfaceToScaledOutput;
static pcRdpgfxCapsConfirm gfxCapsConfirm;
static pBitmapUpdate bitmapUpdate;
static pSurfaceBits surfaceBits;

static UINT st_surface_command(RdpgfxClientContext* c, const RDPGFX_SURFACE_COMMAND* cmd)
{
	st.gfxCmds[cmd->codecId & 0x0F]++;
	return gfxSurfaceCommand ? gfxSurfaceCommand(c, cmd) : CHANNEL_RC_OK;
}
static UINT st_create_surface(RdpgfxClientContext* c, const RDPGFX_CREATE_SURFACE_PDU* p)
{
	st.surfaces++;
	st.surfW = p->width, st.surfH = p->height;
	return gfxCreateSurface ? gfxCreateSurface(c, p) : CHANNEL_RC_OK;
}
static UINT st_reset_graphics(RdpgfxClientContext* c, const RDPGFX_RESET_GRAPHICS_PDU* p)
{
	st.resets++;
	st.resetW = p->width, st.resetH = p->height, st.resetMonitors = p->monitorCount;
	return gfxResetGraphics ? gfxResetGraphics(c, p) : CHANNEL_RC_OK;
}
static UINT st_map_output(RdpgfxClientContext* c, const RDPGFX_MAP_SURFACE_TO_OUTPUT_PDU* p)
{
	st.maps++;
	st.mapX = p->outputOriginX, st.mapY = p->outputOriginY;
	return gfxMapSurfaceToOutput ? gfxMapSurfaceToOutput(c, p) : CHANNEL_RC_OK;
}
static UINT st_map_scaled(RdpgfxClientContext* c, const RDPGFX_MAP_SURFACE_TO_SCALED_OUTPUT_PDU* p)
{
	st.scaledMaps++;
	st.mapX = p->outputOriginX, st.mapY = p->outputOriginY;
	return gfxMapSurfaceToScaledOutput ? gfxMapSurfaceToScaledOutput(c, p) : CHANNEL_RC_OK;
}
static UINT st_caps_confirm(RdpgfxClientContext* c, const RDPGFX_CAPS_CONFIRM_PDU* p)
{
	if (p->capsSet)
		st.gfxVersion = p->capsSet->version, st.gfxFlags = p->capsSet->flags;
	return gfxCapsConfirm ? gfxCapsConfirm(c, p) : CHANNEL_RC_OK; /* gdi sets none */
}
static BOOL st_bitmap_update(rdpContext* c, const BITMAP_UPDATE* b)
{
	st.bitmaps++;
	return bitmapUpdate ? bitmapUpdate(c, b) : TRUE;
}
static BOOL st_surface_bits(rdpContext* c, const SURFACE_BITS_COMMAND* cmd)
{
	st.surfaceBits++;
	st.sbCodecs[cmd->bmp.codecID & 0xFF]++;
	return surfaceBits ? surfaceBits(c, cmd) : TRUE;
}

/* After the client's own handler has set up the graphics pipeline. A callback
 * gdi leaves unset stays unset: the wrapper only counts. */
static void st_channel_connected(void* ctx, const ChannelConnectedEventArgs* e)
{
	if (strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME) != 0)
		return;
	RdpgfxClientContext* gfx = (RdpgfxClientContext*)e->pInterface;
	if (!gfx || gfx->SurfaceCommand == st_surface_command)
		return;
	gfxSurfaceCommand = gfx->SurfaceCommand, gfx->SurfaceCommand = st_surface_command;
	gfxCreateSurface = gfx->CreateSurface, gfx->CreateSurface = st_create_surface;
	gfxResetGraphics = gfx->ResetGraphics, gfx->ResetGraphics = st_reset_graphics;
	gfxMapSurfaceToOutput = gfx->MapSurfaceToOutput, gfx->MapSurfaceToOutput = st_map_output;
	gfxMapSurfaceToScaledOutput = gfx->MapSurfaceToScaledOutput, gfx->MapSurfaceToScaledOutput = st_map_scaled;
	gfxCapsConfirm = gfx->CapsConfirm, gfx->CapsConfirm = st_caps_confirm;
}

/* One line on stderr: what drew the screen, and how much of the last picture is not black. */
static void print_stats(void)
{
	UINT64 lit = 0, all = (UINT64)outW * outH;
	for (UINT64 i = 0; lastFrame && i < all; i++)
		if (lastFrame[i * 4] | lastFrame[i * 4 + 1] | lastFrame[i * 4 + 2])
			lit++;
	fprintf(stderr, "stats paints=%u desktop=%ux%u resizes=%u bitmaps=%u surfacebits=%u", st.paints, st.desktopW, st.desktopH, st.resizes, st.bitmaps, st.surfaceBits);
	for (int i = 0; i < 256; i++)
		if (st.sbCodecs[i])
			fprintf(stderr, " sb[%d]=%u", i, st.sbCodecs[i]);
	fprintf(stderr, " gfx=%#x/%#x surfaces=%u(%ux%u) resets=%u(%ux%u,%u mon) maps=%u scaled=%u at=%u,%u", st.gfxVersion, st.gfxFlags,
	        st.surfaces, st.surfW, st.surfH, st.resets, st.resetW, st.resetH, st.resetMonitors, st.maps, st.scaledMaps, st.mapX, st.mapY);
	for (int i = 0; i < 16; i++)
		if (st.gfxCmds[i])
			fprintf(stderr, " codec[%#x]=%u", i, st.gfxCmds[i]);
	fprintf(stderr, " lit=%llu%%\n", all ? (unsigned long long)(lit * 100 / all) : 0ULL);
}

/* ---- the pointer ---- */

typedef struct {
	rdpPointer pointer;
	BYTE* pixels; /* BGRA */
} encPointer;

static BYTE* ptPixels;            /* the current shape, BGRA */
static UINT32 ptW, ptH, ptHotX, ptHotY;
static BOOL ptVisible;
static INT32 ptX = -1, ptY = -1;  /* where the client moved it */
static BOOL ptShapeSent, ptPosSent;

static BYTE* screenFrame;         /* the screen; lastFrame is it with the pointer */

/* Put the pointer on the screen into lastFrame. */
static void compose(void)
{
	if (!lastFrame)
		return;
	memcpy(lastFrame, screenFrame, (size_t)outW * outH * 4);
	if (!ptVisible || !ptPixels || ptX < 0)
		return;
	const INT32 ox = ptX - (INT32)ptHotX, oy = ptY - (INT32)ptHotY;
	for (UINT32 y = 0; y < ptH; y++) {
		const INT32 fy = oy + (INT32)y;
		if (fy < 0 || fy >= (INT32)outH)
			continue;
		for (UINT32 x = 0; x < ptW; x++) {
			const INT32 fx = ox + (INT32)x;
			if (fx < 0 || fx >= (INT32)outW)
				continue;
			const BYTE* s = ptPixels + ((size_t)y * ptW + x) * 4;
			BYTE* d = lastFrame + ((size_t)fy * outW + (size_t)fx) * 4;
			const unsigned a = s[3];
			for (int c = 0; c < 3; c++)
				d[c] = (BYTE)((s[c] * a + d[c] * (255 - a)) / 255);
		}
	}
}

/* Copy the GDI surface into the fixed-size frame (cropped or padded). */
static void grab(rdpGdi* gdi)
{
	if (!outW) {
		outW = gdi->width & ~1u;
		outH = gdi->height & ~1u;
		lastFrame = calloc((size_t)outW * outH, 4);
		screenFrame = calloc((size_t)outW * outH, 4);
		fprintf(stderr, "size %ux%u\n", outW, outH);
		fflush(stderr);
	}
	const UINT32 w = MIN(outW, (UINT32)gdi->width), h = MIN(outH, (UINT32)gdi->height);
	for (UINT32 y = 0; y < h; y++)
		memcpy(screenFrame + (size_t)y * outW * 4, gdi->primary_buffer + (size_t)y * gdi->stride, (size_t)w * 4);
	compose();
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

/* Send an image to a layer as a Guacamole image stream. */
static void send_image(const char* mask, const char* layer, const char* mime, INT32 x, INT32 y,
                       const unsigned char* jpeg, unsigned long size)
{
	char sn[16], xs[16], ys[16];
	streamNo = streamNo % 1000 + 1;
	snprintf(sn, sizeof sn, "%u", streamNo);
	snprintf(xs, sizeof xs, "%d", x);
	snprintf(ys, sizeof ys, "%d", y);
	const char* img[] = { "img", sn, mask, layer, mime, xs, ys };
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
}

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
	send_image("14", "0", "image/jpeg", x, y, jpeg, size);
	tjFree(jpeg);
}

static void png_chunk(BYTE** out, size_t* len, const char* type, const BYTE* data, size_t n)
{
	BYTE* p = *out + *len;
	p[0] = (BYTE)(n >> 24), p[1] = (BYTE)(n >> 16), p[2] = (BYTE)(n >> 8), p[3] = (BYTE)n;
	memcpy(p + 4, type, 4);
	if (n)
		memcpy(p + 8, data, n);
	uLong crc = crc32(crc32(0, NULL, 0), p + 4, (uInt)(n + 4));
	p[8 + n] = (BYTE)(crc >> 24), p[9 + n] = (BYTE)(crc >> 16), p[10 + n] = (BYTE)(crc >> 8), p[11 + n] = (BYTE)crc;
	*len += 12 + n;
}

/* A BGRA image as PNG (the pointer needs its transparency, which JPEG has not). */
static BYTE* png_encode(const BYTE* bgra, UINT32 w, UINT32 h, size_t* outLen)
{
	const size_t rawLen = (size_t)h * (1 + (size_t)w * 4);
	BYTE* raw = malloc(rawLen);
	uLongf zLen = compressBound((uLong)rawLen);
	BYTE* z = malloc(zLen);
	BYTE* out = malloc(zLen + 64);
	if (!raw || !z || !out) {
		free(raw), free(z), free(out);
		return NULL;
	}
	for (UINT32 y = 0; y < h; y++) {
		BYTE* r = raw + (size_t)y * (1 + (size_t)w * 4);
		r[0] = 0;
		for (UINT32 x = 0; x < w; x++) {
			const BYTE* s = bgra + ((size_t)y * w + x) * 4;
			r[1 + x * 4] = s[2], r[2 + x * 4] = s[1], r[3 + x * 4] = s[0], r[4 + x * 4] = s[3];
		}
	}
	if (compress2(z, &zLen, raw, (uLong)rawLen, 6) != Z_OK) {
		free(raw), free(z), free(out);
		return NULL;
	}
	static const BYTE sig[8] = { 0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n' };
	size_t len = 8;
	memcpy(out, sig, 8);
	BYTE ihdr[13] = { (BYTE)(w >> 24), (BYTE)(w >> 16), (BYTE)(w >> 8), (BYTE)w,
		              (BYTE)(h >> 24), (BYTE)(h >> 16), (BYTE)(h >> 8), (BYTE)h, 8, 6, 0, 0, 0 };
	png_chunk(&out, &len, "IHDR", ihdr, 13);
	png_chunk(&out, &len, "IDAT", z, zLen);
	png_chunk(&out, &len, "IEND", NULL, 0);
	free(raw), free(z);
	*outLen = len;
	return out;
}

/* The pointer's shape to the viewers: drawn on buffer layer -1, which the
 * cursor instruction takes. Hidden, it is one transparent pixel. Callers hold liveMu. */
static void send_cursor(void)
{
	static const BYTE clear[4] = { 0 };
	const BOOL shown = ptVisible && ptPixels;
	const BYTE* px = shown ? ptPixels : clear;
	const UINT32 w = shown ? ptW : 1, h = shown ? ptH : 1;
	size_t n = 0;
	BYTE* png = png_encode(px, w, h, &n);
	if (!png)
		return;
	char ws[16], hs[16], hx[16], hy[16];
	snprintf(ws, sizeof ws, "%u", w);
	snprintf(hs, sizeof hs, "%u", h);
	snprintf(hx, sizeof hx, "%u", shown ? ptHotX : 0);
	snprintf(hy, sizeof hy, "%u", shown ? ptHotY : 0);
	const char* size[] = { "size", "-1", ws, hs };
	guac(4, size);
	send_image("12", "-1", "image/png", 0, 0, png, n);
	const char* cursor[] = { "cursor", hx, hy, "-1", "0", "0", ws, hs };
	guac(8, cursor);
	free(png);
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
		ptShapeSent = ptPosSent = FALSE; /* a new viewer has neither */
		any = TRUE;
	} else if (dirty) {
		INT32 x1 = MAX(0, dx1), y1 = MAX(0, dy1);
		INT32 x2 = MIN((INT32)gdi->width, dx2), y2 = MIN((INT32)gdi->height, dy2);
		send_area(x1, y1, x2 - x1, y2 - y1);
		dirty = FALSE;
		any = TRUE;
	}
	if (!ptShapeSent) {
		send_cursor();
		ptShapeSent = any = TRUE;
	}
	if (!ptPosSent && ptX >= 0) {
		char xs[16], ys[16];
		snprintf(xs, sizeof xs, "%d", ptX);
		snprintf(ys, sizeof ys, "%d", ptY);
		const char* mouse[] = { "mouse", xs, ys, "0" };
		guac(4, mouse);
		ptPosSent = any = TRUE;
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
	st.paints++;
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

/* A pointer change: in the video the frames before it (pointer_before, at the
 * change's time) keep the old pointer; live, the viewers get the new one. */
static void pointer_changed(BOOL shape)
{
	if (!live)
		compose();
	else if (shape)
		ptShapeSent = FALSE;
	else
		ptPosSent = FALSE;
}

static void pointer_before(UINT64 ts)
{
	if (!live)
		emit_until(ts);
}

static void set_shape(const BYTE* px, UINT32 w, UINT32 h, UINT32 hx, UINT32 hy)
{
	BYTE* copy = malloc((size_t)w * h * 4);
	if (!copy)
		return;
	memcpy(copy, px, (size_t)w * h * 4);
	pthread_mutex_lock(&liveMu);
	pointer_before(curTs);
	free(ptPixels);
	ptPixels = copy, ptW = w, ptH = h, ptHotX = hx, ptHotY = hy, ptVisible = TRUE;
	pointer_changed(TRUE);
	pthread_mutex_unlock(&liveMu);
}

static BOOL enc_pointer_new(rdpContext* context, rdpPointer* pointer)
{
	encPointer* p = (encPointer*)pointer;
	p->pixels = calloc((size_t)pointer->width * pointer->height, 4);
	if (!p->pixels)
		return FALSE;
	return freerdp_image_copy_from_pointer_data(p->pixels, PIXEL_FORMAT_BGRA32, 0, 0, 0, pointer->width, pointer->height,
	                                            pointer->xorMaskData, pointer->lengthXorMask, pointer->andMaskData,
	                                            pointer->lengthAndMask, pointer->xorBpp, &context->gdi->palette);
}

static void enc_pointer_free(rdpContext* context, rdpPointer* pointer)
{
	free(((encPointer*)pointer)->pixels);
	((encPointer*)pointer)->pixels = NULL;
}

static BOOL enc_pointer_set(rdpContext* context, rdpPointer* pointer)
{
	const encPointer* p = (const encPointer*)pointer;
	if (p->pixels && pointer->width && pointer->height)
		set_shape(p->pixels, pointer->width, pointer->height, pointer->xPos, pointer->yPos);
	return TRUE;
}

static BOOL enc_pointer_set_null(rdpContext* context)
{
	pthread_mutex_lock(&liveMu);
	pointer_before(curTs);
	ptVisible = FALSE;
	pointer_changed(TRUE);
	pthread_mutex_unlock(&liveMu);
	return TRUE;
}

/* The system pointer: an arrow, drawn here. */
static BOOL enc_pointer_set_default(rdpContext* context)
{
	static const char* arrow[] = {
		"X           ", "XX          ", "X.X         ", "X..X        ", "X...X       ", "X....X      ",
		"X.....X     ", "X......X    ", "X.......X   ", "X........X  ", "X.........X ", "X......XXXXX",
		"X...X..X    ", "X..XX..X    ", "X.X  X..X   ", "XX   X..X   ", "X     X..X  ", "      X..X  ",
		"       XX   ",
	};
	enum { W = 12, H = 19 };
	BYTE px[W * H * 4] = { 0 };
	for (int y = 0; y < H; y++)
		for (int x = 0; x < W; x++) {
			BYTE* d = px + (y * W + x) * 4;
			if (arrow[y][x] == 'X')
				d[3] = 255;
			else if (arrow[y][x] == '.')
				d[0] = d[1] = d[2] = d[3] = 255;
		}
	set_shape(px, W, H, 0, 0);
	return TRUE;
}

static void move_pointer(UINT64 ts, INT32 x, INT32 y)
{
	pthread_mutex_lock(&liveMu);
	pointer_before(ts);
	ptX = x, ptY = y;
	pointer_changed(FALSE);
	pthread_mutex_unlock(&liveMu);
}

static BOOL enc_pointer_set_position(rdpContext* context, UINT32 x, UINT32 y)
{
	move_pointer(curTs, (INT32)x, (INT32)y);
	return TRUE;
}

static BOOL enc_desktop_resize(rdpContext* context)
{
	rdpSettings* settings = context->settings;
	st.resizes++;
	st.desktopW = freerdp_settings_get_uint32(settings, FreeRDP_DesktopWidth);
	st.desktopH = freerdp_settings_get_uint32(settings, FreeRDP_DesktopHeight);
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
	fprintf(stderr, "plugins");
	for (UINT32 j = 0; j < loaded; j++) {
		const CHANNEL_DEF* d = freerdp_settings_get_pointer_array(settings, FreeRDP_ChannelDefArray, j);
		fprintf(stderr, "%s%s", j ? "," : " ", d ? d->name : "?");
	}
	fprintf(stderr, "\n");
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
		if (recReceived) {
			/* What the client sent is not replayed; where it moved the pointer is drawn. */
			if (recLen == 6 && recBuf[0] == 'P' && recBuf[1] == 'T')
				move_pointer(recTs, recBuf[2] | recBuf[3] << 8, recBuf[4] | recBuf[5] << 8);
			continue;
		}
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

/* The replay loads only what draws the screen: the graphics pipeline and the
 * dynamic channel manager under it. The server's traffic on the other channels
 * (sound, clipboard, drives) answers what the real client said, which a plugin
 * here did not say: replayed into one, it ends in a protocol error (a sound
 * channel opened twice, a drive message out of turn) that stops the replay.
 * Without a plugin that traffic is dropped. FreeRDP loads the drive channel
 * (and a sound one with it) whenever auto-detect, heartbeat or multitransport
 * are on, so those are off while plugins load and back on for the replay.
 * A recording without the client's channel list (older ones) keeps them all:
 * its channel numbers are those of FreeRDP's own list. */
static BOOL enc_load_channels(freerdp* instance)
{
	rdpSettings* settings = instance->context->settings;
	static const FreeRDP_Settings_Keys_Bool off[] = {
		FreeRDP_RedirectClipboard, FreeRDP_AudioPlayback, FreeRDP_AudioCapture, FreeRDP_DeviceRedirection,
		FreeRDP_NetworkAutoDetect, FreeRDP_SupportHeartbeatPdu, FreeRDP_SupportMultitransport,
	};
	BOOL was[ARRAYSIZE(off)];
	for (size_t i = 0; i < ARRAYSIZE(off); i++) {
		was[i] = freerdp_settings_get_bool(settings, off[i]);
		if (haveRecChannels)
			(void)freerdp_settings_set_bool(settings, off[i], FALSE);
	}
	const BOOL ok = !defaultLoadChannels || defaultLoadChannels(instance);
	/* The first four had plugins: they stay off. The rest are no plugins. */
	for (size_t i = haveRecChannels ? 4 : 0; i < ARRAYSIZE(off); i++)
		(void)freerdp_settings_set_bool(settings, off[i], was[i]);
	return ok && apply_client_channels(settings);
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
	PubSub_SubscribeChannelConnected(instance->context->pubSub, st_channel_connected);
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
	bitmapUpdate = instance->context->update->BitmapUpdate, instance->context->update->BitmapUpdate = st_bitmap_update;
	surfaceBits = instance->context->update->SurfaceBits, instance->context->update->SurfaceBits = st_surface_bits;
	st.desktopW = freerdp_settings_get_uint32(instance->context->settings, FreeRDP_DesktopWidth);
	st.desktopH = freerdp_settings_get_uint32(instance->context->settings, FreeRDP_DesktopHeight);
	rdpPointer pointer = { 0 };
	pointer.size = sizeof(encPointer);
	pointer.New = enc_pointer_new;
	pointer.Free = enc_pointer_free;
	pointer.Set = enc_pointer_set;
	pointer.SetNull = enc_pointer_set_null;
	pointer.SetDefault = enc_pointer_set_default;
	pointer.SetPosition = enc_pointer_set_position;
	graphics_register_pointer(instance->context->graphics, &pointer);
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
	if (!live)
		print_stats();
	fprintf(stderr, "frames %llu, %llu ms\n", (unsigned long long)framesOut, (unsigned long long)(curTs - firstTs));
	freerdp_disconnect(instance);
	freerdp_client_context_free(context);
	return 0;
}

/*
 * Run at image build time against the patched libguac-terminal: with the xterm
 * key mode, keys that are not text go as xterm sends them (and with Shift,
 * Alt or Ctrl, as xterm's modifier parameter); without it, as the Linux console
 * sends them, as before. The image does not build if this fails.
 */
#include <guacamole/client.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include "terminal/terminal.h"
#include "terminal/terminal-priv.h"

static guac_terminal* term;

/* What one key press sends to the server, with the modifiers held. */
static int check(const char* name, int keysym, const int* mods, const char* want) {
    for (const int* m = mods; m && *m; m++)
        guac_terminal_send_key(term, *m, 1);
    guac_terminal_send_key(term, keysym, 1);
    guac_terminal_send_key(term, keysym, 0);
    for (const int* m = mods; m && *m; m++)
        guac_terminal_send_key(term, *m, 0);
    char got[64] = {0};
    int n = -1;
    /* A key that sends nothing must fail the check, not hang it. */
    struct pollfd p = { .fd = term->stdin_pipe_fd[0], .events = POLLIN };
    if (poll(&p, 1, 1000) == 1)
        n = read(term->stdin_pipe_fd[0], got, sizeof(got) - 1);
    if (n < 0 || strcmp(got, want) != 0) {
        fprintf(stderr, "FAIL %s: got", name);
        for (int i = 0; i < n; i++)
            fprintf(stderr, " %02x", (unsigned char) got[i]);
        fprintf(stderr, "\n");
        return 1;
    }
    printf("ok   %s\n", name);
    return 0;
}

int main(void) {
    guac_client* client = guac_client_alloc();
    guac_terminal_options* opts = guac_terminal_options_create(800, 200, 96);
    term = guac_terminal_create(client, opts);
    term->started = true; /* a connection starts it; keys before that are ignored */
    setvbuf(stdout, NULL, _IONBF, 0);
    const int ctrl[] = {0xFFE3, 0}, shift[] = {0xFFE1, 0}, alt[] = {0xFFE9, 0};
    int failed = 0;

    guac_terminal_set_xterm_keys(term, true);
    failed += check("xterm F1", 0xFFBE, NULL, "\x1BOP");
    failed += check("xterm F4", 0xFFC1, NULL, "\x1BOS");
    failed += check("xterm F5", 0xFFC2, NULL, "\x1B[15~");
    failed += check("xterm F10", 0xFFC7, NULL, "\x1B[21~");
    failed += check("xterm F12", 0xFFC9, NULL, "\x1B[24~");
    failed += check("xterm Home", 0xFF50, NULL, "\x1B[H");
    failed += check("xterm End", 0xFF57, NULL, "\x1B[F");
    failed += check("xterm Delete", 0xFFFF, NULL, "\x1B[3~");
    failed += check("xterm Ctrl+Left", 0xFF51, ctrl, "\x1B[1;5D");
    failed += check("xterm Alt+Right", 0xFF53, alt, "\x1B[1;3C");
    failed += check("xterm Shift+F1", 0xFFBE, shift, "\x1B[1;2P");
    failed += check("xterm Ctrl+Delete", 0xFFFF, ctrl, "\x1B[3;5~");
    failed += check("xterm Shift+Tab", 0xFF09, shift, "\x1B[Z");
    failed += check("xterm Ctrl+C is still ETX", 'c', ctrl, "\x03");
    failed += check("xterm text", 'x', NULL, "x");
    /* A full-screen program switches to application cursor keys (DECCKM). */
    guac_terminal_write(term, "\x1B[?1h", 5);
    failed += check("xterm Up (application)", 0xFF52, NULL, "\x1BOA");
    failed += check("xterm Home (application)", 0xFF50, NULL, "\x1BOH");
    guac_terminal_write(term, "\x1B[?1l", 5);

    guac_terminal_set_xterm_keys(term, false);
    failed += check("linux F1", 0xFFBE, NULL, "\x1B[[A");
    failed += check("linux Home", 0xFF50, NULL, "\x1B[1~");
    failed += check("linux Up", 0xFF52, NULL, "\x1B[A");
    failed += check("linux F11", 0xFFC8, NULL, "\x1B[23~");
    failed += check("linux F12", 0xFFC9, NULL, "\x1B[24~");

    /* Not freed: see osc_test.c. */
    return failed ? 1 : 0;
}

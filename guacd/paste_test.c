/*
 * Run at image build time against the patched libguac-terminal: a paste must
 * reach the application the way a terminal emulator sends it (line breaks as
 * CR, bracketed when the application asked for mode 2004). The image does not
 * build if this fails.
 */
#include <guacamole/client.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include "terminal/terminal.h"
#include "terminal/terminal-priv.h"

static int check(const char* name, const char* output, const char* clipboard,
        const char* want) {
    guac_client* client = guac_client_alloc();
    guac_terminal_options* opts = guac_terminal_options_create(800, 200, 96);
    guac_terminal* term = guac_terminal_create(client, opts);
    term->started = true;

    /* What the application printed (e.g. its mode switches), then the paste */
    guac_terminal_write(term, output, strlen(output));
    guac_terminal_clipboard_reset(term, "text/plain");
    guac_terminal_clipboard_append(term, clipboard, strlen(clipboard));
    guac_terminal_send_key(term, 0xFFE3, 1); /* Ctrl */
    guac_terminal_send_key(term, 'V', 1);

    char got[512] = {0};
    fcntl(term->stdin_pipe_fd[0], F_SETFL, O_NONBLOCK);
    ssize_t n = read(term->stdin_pipe_fd[0], got, sizeof(got) - 1);
    if (n < 0)
        n = 0;
    got[n] = '\0';

    /* Not freed: see osc_test.c */
    if (strcmp(got, want) != 0) {
        fprintf(stderr, "FAIL %s: got \"%s\", want \"%s\"\n", name, got, want);
        return 1;
    }
    printf("ok   %s\n", name);
    return 0;
}

int main(void) {
    int failed = 0;
    const char* pem = "-----BEGIN CERTIFICATE-----\nMIIDk\nCzAJ\n-----END CERTIFICATE-----\n";
    /* plain paste: every LF arrives as CR, as the Enter key sends */
    failed += check("lf as cr", "", pem,
        "-----BEGIN CERTIFICATE-----\rMIIDk\rCzAJ\r-----END CERTIFICATE-----\r");
    /* CR LF from a Windows clipboard is one line break, not two */
    failed += check("crlf as one cr", "", "a\r\nb", "a\rb");
    /* nano/vim/bash ask for bracketed paste; the text is wrapped */
    failed += check("bracketed", "\x1b[?2004h", "a\nb", "\x1b[200~a\rb\x1b[201~");
    /* an ESC inside the text cannot close the bracket early */
    failed += check("bracket escape", "\x1b[?2004h", "x\x1b[201~rm -rf /\n",
        "\x1b[200~x[201~rm -rf /\r\x1b[201~");
    /* the application turned it off again */
    failed += check("bracketed off", "\x1b[?2004h\x1b[?2004l", "a\nb", "a\rb");
    return failed ? 1 : 0;
}

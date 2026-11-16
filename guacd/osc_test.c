/*
 * Run at image build time against the patched libguac-terminal: text around
 * OSC sequences guacd does not implement must reach the screen, their payload
 * must not. The image does not build if this fails.
 */
#include <guacamole/client.h>
#include <stdio.h>
#include <string.h>
#include "terminal/terminal.h"
#include "terminal/terminal-priv.h"
#include "terminal/buffer.h"

static int check(const char* name, const char* input, const char* want) {
    guac_client* client = guac_client_alloc();
    guac_terminal_options* opts = guac_terminal_options_create(800, 200, 96);
    guac_terminal* term = guac_terminal_create(client, opts);
    guac_terminal_write(term, input, strlen(input));

    char got[256] = {0};
    guac_terminal_char* chars;
    bool wrapped;
    unsigned int n = guac_terminal_buffer_get_columns(term->current_buffer, &chars, &wrapped, 0);
    unsigned int len = 0;
    for (unsigned int i = 0; i < n && len < sizeof(got) - 1; i++)
        if (chars[i].value > 0 && chars[i].value < 128)
            got[len++] = (char) chars[i].value;
    while (len > 0 && got[len - 1] == ' ')
        got[--len] = '\0';

    /* Not freed: guac_terminal_free waits for a render thread that only a
     * running connection ends, and this process exits right after. */
    if (strcmp(got, want) != 0) {
        fprintf(stderr, "FAIL %s: got \"%s\", want \"%s\"\n", name, got, want);
        return 1;
    }
    printf("ok   %s\n", name);
    return 0;
}

int main(void) {
    int failed = 0;
    /* systemd's prompt context, terminated by ST (ESC \), backslash in a value */
    failed += check("osc 3008 (ST)",
        "\x1b]3008;start=5b29;user=root;hostname=securify-ubuntu;cwd=/root/a\\x5cb\x1b\\root@securify-ubuntu:~# ",
        "root@securify-ubuntu:~#");
    /* the end-of-command mark that followed */
    failed += check("osc 3008 end (ST)", "\x1b]3008;end=6ce1;exit=success\x1b\\$ ", "$");
    /* BEL-terminated OSC 7 and an OSC 8 hyperlink around its text */
    /* (string split after \x07: C would read "\x07b" as the one byte 0x7B) */
    failed += check("osc 7 (BEL)", "a\x1b]7;file://host/root\x07" "b", "ab");
    failed += check("osc 8 hyperlink", "\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\!", "link!");
    /* handled OSCs are unchanged: a window title is not printed */
    failed += check("osc 0 title", "\x1b]0;my title\x07prompt", "prompt");
    return failed ? 1 : 0;
}

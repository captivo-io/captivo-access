/*
 * Run at image build time against the patched libguac-terminal: entering and
 * leaving the alternate buffer must each send one captivo-altscreen
 * instruction to the connection, and nothing else must. The image does not
 * build if this fails.
 */
#include <guacamole/client.h>
#include <guacamole/socket.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include "terminal/terminal.h"
#include "terminal/terminal-priv.h"

static int count(const char* hay, const char* needle) {
    int n = 0;
    for (const char* p = hay; (p = strstr(p, needle)) != NULL; p += strlen(needle))
        n++;
    return n;
}

int main(void) {
    FILE* out = tmpfile();
    guac_client* client = guac_client_alloc();
    client->socket = guac_socket_open(fileno(out));
    guac_terminal_options* opts = guac_terminal_options_create(800, 200, 96);
    guac_terminal* term = guac_terminal_create(client, opts);

    const char* steps[] = {
        "$ vim notes\r\n",
        "\x1b[?1049h\x1b[Hediting",   /* vim starts */
        "\x1b[?1049h",                /* already there: no second notice */
        "\x1b[?1049l$ ",              /* vim ends */
        "\x1b[?47h\x1b[?47l",         /* the older mode, on and off */
    };
    for (size_t i = 0; i < sizeof(steps) / sizeof(steps[0]); i++)
        guac_terminal_write(term, steps[i], strlen(steps[i]));
    guac_socket_flush(client->socket);

    char buf[1 << 16] = {0};
    fflush(out);
    rewind(out);
    size_t n = fread(buf, 1, sizeof(buf) - 1, out);
    buf[n] = '\0';
    int on = count(buf, "17.captivo-altscreen,1.1;");
    int off = count(buf, "17.captivo-altscreen,1.0;");
    /* Not freed: see osc_test.c. */
    if (on != 2 || off != 2) {
        fprintf(stderr, "FAIL altscreen: %d on, %d off (want 2, 2)\n", on, off);
        return 1;
    }
    printf("ok   altscreen on/off notices\n");
    return 0;
}

// Kleine Weboberfläche (Port 80) zum Steuern vom Handy: Seite + JSON-API.
//   GET /            Bedienoberfläche
//   GET /api/state   Zustand als JSON (?full=1 mit Patternliste)
//   GET /api/cmd?c=  Befehl ausführen (wie über USB, z. B. "BPM 140"), Antwort = Zustand
//   POST /api/upload?size=&crc=  Pattern-Bank hochladen (Rohdaten im Body), Antwort = Zustand + reply
#include "web.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "lwip/tcp.h"
#include "sender.h"
#include "web_index.h"

typedef struct {
    char req[1600];
    int n;
    bool uploading;          // Body eines Uploads wird gerade empfangen
    uint32_t body_left;
    char buf[8448];          // Kopfzeilen + JSON-Antwort
    const uint8_t *seg[2];
    uint32_t len[2];
    int cur;
    bool closing;
} conn_t;

static void conn_close(struct tcp_pcb *pcb, conn_t *c) {
    tcp_arg(pcb, NULL);
    tcp_recv(pcb, NULL);
    tcp_sent(pcb, NULL);
    tcp_err(pcb, NULL);
    if (tcp_close(pcb) != ERR_OK) tcp_abort(pcb);
    free(c);
}

static void send_more(struct tcp_pcb *pcb, conn_t *c) {
    while (c->cur < 2) {
        if (!c->len[c->cur]) { c->cur++; continue; }
        uint32_t room = tcp_sndbuf(pcb);
        if (!room) break;
        uint32_t n = c->len[c->cur] < room ? c->len[c->cur] : room;
        if (tcp_write(pcb, c->seg[c->cur], (u16_t)(n > 0xFFFF ? 0xFFFF : n), 0) != ERR_OK) break;
        c->seg[c->cur] += n;
        c->len[c->cur] -= n;
    }
    tcp_output(pcb);
    if (c->cur >= 2) c->closing = true;
}

static err_t on_sent(void *arg, struct tcp_pcb *pcb, u16_t len) {
    conn_t *c = arg;
    if (!c) return ERR_OK;
    send_more(pcb, c);
    if (c->closing && tcp_sndqueuelen(pcb) == 0) conn_close(pcb, c);
    return ERR_OK;
}

static void url_decode(char *dst, const char *src, size_t cap) {
    size_t n = 0;
    while (*src && n + 1 < cap) {
        if (*src == '%' && src[1] && src[2]) {
            char hex[3] = {src[1], src[2], 0};
            dst[n++] = (char)strtol(hex, NULL, 16);
            src += 3;
        } else {
            dst[n++] = *src == '+' ? ' ' : *src;
            src++;
        }
    }
    dst[n] = 0;
}

static void respond_json(conn_t *c, bool full, const char *reply) {
    static char json[8192];
    int n = sender_state_json(json, sizeof json - 200, full);
    if (reply && n > 1) {
        char r[160];
        size_t k = 0;
        for (const char *s = reply; *s && k + 2 < sizeof r; s++) { if (*s == '"' || *s == '\\') r[k++] = '\\'; r[k++] = *s; }
        r[k] = 0;
        snprintf(json + n - 1, sizeof json - n + 1, ",\"reply\":\"%s\"}", r);
    }
    int len = (int)strlen(json);
    int h = snprintf(c->buf, sizeof c->buf,
                     "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n"
                     "Access-Control-Allow-Origin: *\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", len, json);
    c->seg[0] = (const uint8_t *)c->buf;
    c->len[0] = (uint32_t)(h < (int)sizeof c->buf ? h : (int)sizeof c->buf - 1);
}

static uint32_t query_u32(const char *path, const char *key) {
    const char *p = strstr(path, key);
    return p ? (uint32_t)strtoul(p + strlen(key), NULL, 10) : 0;
}

static void handle(conn_t *c) {
    const bool post = !strncmp(c->req, "POST ", 5);
    char *path = strchr(c->req, ' ');
    if (!path) return;
    path++;
    char *end = strchr(path, ' ');
    if (end) *end = 0;
    if (post && !strncmp(path, "/api/upload", 11)) {
        const uint32_t size = query_u32(path, "size="), crc = query_u32(path, "crc=");
        const char *err = sender_upload_begin(size, crc);
        if (err) { respond_json(c, false, err); return; }
        c->uploading = true;
        c->body_left = size;
        return; // Antwort erst, wenn alle Daten da sind
    }
    if (!strcmp(path, "/") || !strcmp(path, "/index.html")) {
        int h = snprintf(c->buf, sizeof c->buf,
                         "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %u\r\n"
                         "Connection: close\r\n\r\n", (unsigned)WEB_INDEX_LEN);
        c->seg[0] = (const uint8_t *)c->buf;
        c->len[0] = (uint32_t)h;
        c->seg[1] = WEB_INDEX;
        c->len[1] = WEB_INDEX_LEN;
    } else if (!strncmp(path, "/api/state", 10)) {
        respond_json(c, strstr(path, "full=1") != NULL, NULL);
    } else if (!strncmp(path, "/api/cmd?c=", 11)) {
        char line[200], reply[200];
        url_decode(line, path + 11, sizeof line);
        sender_command(line, false, reply, sizeof reply);
        respond_json(c, strstr(line, "PATTERN") == line, reply);
    } else {
        static const char nf[] = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        c->seg[0] = (const uint8_t *)nf;
        c->len[0] = sizeof nf - 1;
    }
}

static err_t on_recv(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err) {
    conn_t *c = arg;
    if (!p) { if (c) conn_close(pcb, c); else tcp_close(pcb); return ERR_OK; }
    if (!c || c->seg[0]) { tcp_recved(pcb, p->tot_len); pbuf_free(p); return ERR_OK; }
    if (c->uploading) {
        // Body direkt in den Flash schreiben (Block für Block)
        for (struct pbuf *q = p; q; q = q->next) {
            uint32_t n = q->len < c->body_left ? q->len : c->body_left;
            sender_upload_data(q->payload, n);
            c->body_left -= n;
        }
        tcp_recved(pcb, p->tot_len);
        pbuf_free(p);
    } else {
        int n = pbuf_copy_partial(p, c->req + c->n, (u16_t)(sizeof c->req - 1 - c->n), 0);
        int before = c->n;
        c->n += n;
        c->req[c->n] = 0;
        tcp_recved(pcb, p->tot_len);
        char *hdr_end = strstr(c->req, "\r\n\r\n");
        if (!hdr_end && c->n < (int)sizeof c->req - 1) { pbuf_free(p); return ERR_OK; }
        // Daten hinter dem Kopf gehören schon zum Body
        const int body_at = hdr_end ? (int)(hdr_end - c->req) + 4 : c->n;
        handle(c);
        if (c->uploading && body_at - before < p->tot_len) {
            static uint8_t tmp[1600];
            const u16_t off = (u16_t)(body_at - before), cnt = (u16_t)(p->tot_len - off);
            const u16_t got = pbuf_copy_partial(p, tmp, cnt < sizeof tmp ? cnt : sizeof tmp, off);
            const uint32_t use = got < c->body_left ? got : c->body_left;
            sender_upload_data(tmp, use);
            c->body_left -= use;
        }
        pbuf_free(p);
        if (!c->uploading && !c->seg[0]) { conn_close(pcb, c); return ERR_OK; }
    }
    if (c->uploading) {
        const char *res = sender_upload_result();
        if (!res && c->body_left) return ERR_OK;
        c->uploading = false;
        respond_json(c, false, res ? res : "ERR unvollständig");
    }
    send_more(pcb, c);
    return ERR_OK;
}

static void on_err(void *arg, err_t err) { free(arg); }

static err_t on_accept(void *arg, struct tcp_pcb *pcb, err_t err) {
    if (err != ERR_OK || !pcb) return ERR_VAL;
    conn_t *c = calloc(1, sizeof *c);
    if (!c) { tcp_abort(pcb); return ERR_ABRT; }
    tcp_arg(pcb, c);
    tcp_recv(pcb, on_recv);
    tcp_sent(pcb, on_sent);
    tcp_err(pcb, on_err);
    return ERR_OK;
}

void web_init(void) {
    struct tcp_pcb *pcb = tcp_new_ip_type(IPADDR_TYPE_ANY);
    if (!pcb || tcp_bind(pcb, IP_ANY_TYPE, 80) != ERR_OK) return;
    pcb = tcp_listen_with_backlog(pcb, 4);
    tcp_accept(pcb, on_accept);
}

FROM debian:bookworm-slim
ARG KASM_VER=1.5.0
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates chromium fluxbox python3 dumb-init ffmpeg hsetroot \
      libxfont2 libxtst6 libgl1 libgbm1 libxcb-render0 libxcb-shm0 \
    && curl -fsSL -o /tmp/kasmvnc.deb \
       "https://github.com/kasmtech/KasmVNC/releases/download/v${KASM_VER}/kasmvncserver_bookworm_${KASM_VER}_amd64.deb" \
    && apt-get install -y --no-install-recommends /tmp/kasmvnc.deb \
    && rm -f /tmp/kasmvnc.deb && rm -rf /var/lib/apt/lists/*
COPY kasm-browser/kasmvnc.yaml /kasmvnc.yaml
COPY kasm-browser/control.py /control.py
COPY kasm-browser/entrypoint.sh /entrypoint.sh
COPY kasm-browser/session-ext /session-ext
COPY kasm-browser/policy.json /captivo-policy.json
RUN chmod +x /entrypoint.sh /control.py
# One user per session display (control.py: SESSION_UID_BASE + display); no
# login shell, no home of their own (control.py makes a 0700 one per session).
RUN for d in $(seq 2 129); do useradd -M -d /nonexistent -s /usr/sbin/nologin -u $((20000 + d)) "sess$d"; done
EXPOSE 6901 7900
ENTRYPOINT ["dumb-init", "--"]
CMD ["/entrypoint.sh"]

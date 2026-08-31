FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    HOME=/home/box \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium-browser \
        dbus-x11 \
        fonts-dejavu-core \
        fonts-liberation \
        imagemagick \
        openbox \
        python3 \
        python3-evdev \
        scrot \
        tigervnc-standalone-server \
        tigervnc-common \
        x11-utils \
        x11-xserver-utils \
        xclip \
        xdotool \
        xterm \
    && rm -rf /var/lib/apt/lists/* \
    && (command -v chromium-browser >/dev/null || apt-get update && apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*)

# Ubuntu 24.04 already has uid 1000 (`ubuntu`). Rename it to `box`.
RUN usermod -l box ubuntu \
    && groupmod -n box ubuntu \
    && usermod -d /home/box -m box \
    && mkdir -p /workspace /home/box/.config/chromium /home/box/.vnc \
    && chown -R box:box /workspace /home/box

COPY bin/uinputd.py /usr/local/bin/uinputd
COPY bin/desk-shot /usr/local/bin/desk-shot
COPY bin/start-window /usr/local/bin/start-window
COPY bin/stop-window /usr/local/bin/stop-window
COPY bin/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/uinputd /usr/local/bin/desk-shot \
        /usr/local/bin/start-window /usr/local/bin/stop-window /usr/local/bin/entrypoint.sh \
    && usermod -aG input box || true

USER box
WORKDIR /workspace
# One RFB port per window index: 5900 + N
EXPOSE 5901-5908
VOLUME ["/workspace", "/home/box/.config/chromium"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Debian, not Ubuntu: Ubuntu's `chromium-browser` is a snap stub that cannot
# run in a container, and Debian ships a real chromium on amd64 and arm64.
FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    HOME=/home/box \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        dbus-x11 \
        fonts-dejavu-core \
        fonts-liberation \
        imagemagick \
        openssl \
        openbox \
        procps \
        python3 \
        scrot \
        x11vnc \
        x11-utils \
        x11-xserver-utils \
        xclip \
        xdotool \
        xterm \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 --shell /bin/bash box \
    && mkdir -p /workspace /home/box/.config/chromium /home/box/.vnc \
    && chown -R box:box /workspace /home/box

COPY bin/desk-shot /usr/local/bin/desk-shot
COPY bin/start-window /usr/local/bin/start-window
COPY bin/stop-window /usr/local/bin/stop-window
COPY bin/desk-up /usr/local/bin/desk-up
COPY bin/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/desk-shot \
        /usr/local/bin/start-window /usr/local/bin/stop-window \
        /usr/local/bin/desk-up /usr/local/bin/entrypoint.sh

USER box
WORKDIR /workspace
# RFB 5900+N (localhost x11vnc). noVNC 6080 primary, 6081+ forks.
EXPOSE 5901-5908 6080-6087
# Grok keeps /workspace, the browser profile and ~/.config across a rebuild;
# it does not keep ~/.local/state, and apt packages die with the image. Same
# boundary here, so a skill written for a Bot needs no edit.
VOLUME ["/workspace", "/home/box/.config"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

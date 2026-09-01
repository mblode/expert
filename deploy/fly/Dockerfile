# Cloud computer guest: desk (X.Org/Xvfb + x11vnc + Chromium) + hub.
# Keep the apt list in sync with apps/desk/Dockerfile.
# Build context is the repo root (`fly.toml` [build] dockerfile).

FROM node:24-bookworm-slim AS node

FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    HOME=/home/box \
    LANG=C.UTF-8 \
    COMPUTER_CLOUD=fly \
    COMPUTER_BIND=0.0.0.0 \
    COMPUTER_PORT=8080 \
    COMPUTER_DESK=local \
    COMPUTER_DATA=/data/bots.json

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

COPY --from=node /usr/local /usr/local

RUN useradd --create-home --uid 1000 --shell /bin/bash box \
    && mkdir -p /workspace /home/box/.config/chromium /home/box/.vnc /data /opt/computer \
    && chown -R box:box /workspace /home/box /data /opt/computer

COPY apps/desk/bin/desk-shot /usr/local/bin/desk-shot
COPY apps/desk/bin/start-window /usr/local/bin/start-window
COPY apps/desk/bin/stop-window /usr/local/bin/stop-window
COPY apps/desk/bin/desk-up /usr/local/bin/desk-up
COPY deploy/fly/guest-entrypoint.sh /usr/local/bin/guest-entrypoint.sh
COPY deploy/fly/edge-entrypoint.sh /usr/local/bin/edge-entrypoint.sh
RUN chmod 755 /usr/local/bin/desk-shot \
        /usr/local/bin/start-window /usr/local/bin/stop-window \
        /usr/local/bin/desk-up /usr/local/bin/guest-entrypoint.sh \
        /usr/local/bin/edge-entrypoint.sh

WORKDIR /opt/computer
COPY package.json package-lock.json ./
COPY apps/hub/package.json apps/hub/
COPY apps/web/package.json apps/web/
COPY apps/eve/package.json apps/eve/
COPY packages/shared/package.json packages/shared/
COPY packages/proto/package.json packages/proto/
RUN npm ci

COPY apps/hub apps/hub
COPY apps/web apps/web
COPY apps/eve apps/eve
COPY packages packages
# Server Next build (Vercel is the product front door). `out/` is no longer
# produced; the hub serves pixels/RPCs without a static panel.
RUN npm run build --workspace=@computer/web \
    && chown -R box:box /opt/computer

# Grok keeps /workspace and ~/.config across a rebuild; hub roster is /data.
VOLUME ["/workspace", "/home/box/.config", "/data"]
EXPOSE 8080 6080-6087

ENTRYPOINT ["/usr/local/bin/guest-entrypoint.sh"]

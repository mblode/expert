# Cloud computer guest: desk (X.Org/Xvfb + x11vnc + Chromium) + Eve + hub in
# one Fly Machine. Build context is the repo root (`fly.toml` [build]).
# The apt list is apps/desk/packages.txt, shared with the local desk image.
# The product web (apps/web) is deployed on Vercel and is not built here.

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
    COMPUTER_DATA=/workspace/.computer/bots.json \
    COMPUTER_EVE_BOTS=/opt/computer/apps/eve/bots

COPY apps/desk/packages.txt /tmp/packages.txt
RUN apt-get update \
    && grep -v '^#' /tmp/packages.txt | xargs apt-get install -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* /tmp/packages.txt

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

RUN useradd --create-home --uid 1000 --shell /bin/bash box \
    && mkdir -p /workspace /home/box/.config/chromium /opt/computer \
    && chown -R box:box /workspace /home/box /opt/computer

COPY --chmod=755 apps/desk/bin/ /usr/local/bin/
COPY --chmod=755 deploy/fly/guest-entrypoint.sh /usr/local/bin/guest-entrypoint.sh

# Install and build as `box`, the user that runs everything, so the tree is
# owned correctly from the start instead of `chown -R` doubling the layer.
USER box
WORKDIR /opt/computer
COPY --chown=box:box package.json package-lock.json ./
COPY --chown=box:box apps/hub/package.json apps/hub/
COPY --chown=box:box apps/web/package.json apps/web/
COPY --chown=box:box apps/eve/package.json apps/eve/
COPY --chown=box:box apps/eve/bots/main/package.json apps/eve/bots/main/
COPY --chown=box:box packages/shared/package.json packages/shared/
COPY --chown=box:box packages/proto/package.json packages/proto/
RUN npm ci --no-audit --no-fund

COPY --chown=box:box apps/hub apps/hub
COPY --chown=box:box apps/eve apps/eve
COPY --chown=box:box packages packages
COPY --chown=box:box api api
# `eve build` here so guest start only runs `eve start`.
RUN npm run build --workspace=@computer/eve-main

USER root
# Fly mounts `computer_workspace` at /workspace (roster, tokens, Eve secret).
VOLUME ["/workspace"]
EXPOSE 8080

# tini reaps the X server, Chromium and Eve children and forwards SIGTERM.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/guest-entrypoint.sh"]

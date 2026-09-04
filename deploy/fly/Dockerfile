# Cloud computer guest: desk (X.Org/Xvfb + x11vnc + Chromium) + Eve + hub in
# one Fly Machine. Build context is the repo root (`fly.toml` [build]).
# The apt list is apps/desk/packages.txt, shared with the local desk image.
# The product web (apps/web) is Vercel-only: .dockerignore excludes it, and
# the npm ci step drops that workspace so the guest never needs the Next tree.

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

# The package list is piped through grep; pipefail makes a bad list fail the build.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

COPY apps/desk/packages.txt /tmp/packages.txt
RUN apt-get update \
    && grep -v '^#' /tmp/packages.txt | xargs apt-get install -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* /tmp/packages.txt

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Two users. `box` is the desk and the model: X, Chromium, Eve, everything
# under /workspace. `hub` is the hub and the WhatsApp bridge: it owns the
# roster, seat tokens, channel secrets and Baileys credentials under
# /workspace/.computer, which box (and so the model's shell) cannot read.
# The hub runs desk commands (xdotool, screenshots, the model's shell) as
# box through sudo; that one line is the whole bridge between the two.
RUN useradd --create-home --uid 1000 --shell /bin/bash box \
    && useradd --create-home --uid 1001 --shell /usr/sbin/nologin hub \
    && echo "hub ALL=(box) NOPASSWD: ALL" > /etc/sudoers.d/hub \
    && chmod 440 /etc/sudoers.d/hub \
    && mkdir -p /workspace /home/box/.config/chromium /opt/computer /run/computer \
    && chown -R box:box /workspace /home/box /opt/computer

COPY --chmod=755 apps/desk/bin/desk-shot apps/desk/bin/desk-up apps/desk/bin/start-window apps/desk/bin/stop-window /usr/local/bin/
COPY --chmod=755 deploy/fly/guest-entrypoint.sh /usr/local/bin/guest-entrypoint.sh

# Install and build as `box`, the user that runs everything, so the tree is
# owned correctly from the start instead of `chown -R` doubling the layer.
USER box
WORKDIR /opt/computer
COPY --chown=box:box package.json package-lock.json ./
COPY --chown=box:box apps/hub/package.json apps/hub/
COPY --chown=box:box apps/eve/package.json apps/eve/
# One line per Bot, not a wildcard: `COPY apps/eve/bots/*/package.json` flattens
# every match onto one destination path, so the last one wins and npm ci
# installs a workspace tree that is missing the rest.
COPY --chown=box:box apps/eve/bots/main/package.json apps/eve/bots/main/
COPY --chown=box:box apps/eve/bots/chief-of-staff/package.json apps/eve/bots/chief-of-staff/
COPY --chown=box:box apps/eve/bots/software-engineer/package.json apps/eve/bots/software-engineer/
COPY --chown=box:box apps/eve/bots/qa/package.json apps/eve/bots/qa/
COPY --chown=box:box apps/eve/bots/pm/package.json apps/eve/bots/pm/
COPY --chown=box:box apps/eve/bots/seo/package.json apps/eve/bots/seo/
COPY --chown=box:box apps/eve/bots/gtm/package.json apps/eve/bots/gtm/
COPY --chown=box:box apps/eve/bots/designer/package.json apps/eve/bots/designer/
# Not a Bot: the project a Bot made with `Seat.CreateBot` runs, since it has
# no directory of its own. `eveProjectIds` skips it, so it never gets a roster
# row; it still has to be built like every other project here.
COPY --chown=box:box apps/eve/bots/template/package.json apps/eve/bots/template/
COPY --chown=box:box apps/whatsapp-bridge/package.json apps/whatsapp-bridge/
COPY --chown=box:box packages/shared/package.json packages/shared/
COPY --chown=box:box packages/proto/package.json packages/proto/
# LEFTHOOK=0: no git hooks in an image, so `prepare` is a no-op here.
ENV LEFTHOOK=0
# Product web is Vercel-only and excluded by .dockerignore. Root workspaces
# still lists apps/web; drop it so npm ci does not need that package.json
# or pull Next. Do not COPY the Next tree into the guest.
RUN node --input-type=module -e '\
const { readFileSync, writeFileSync } = await import("node:fs");\
const pkg = JSON.parse(readFileSync("package.json", "utf8"));\
pkg.workspaces = pkg.workspaces.filter((w) => w !== "apps/web");\
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");\
' && npm ci --no-audit --no-fund

COPY --chown=box:box apps/hub apps/hub
COPY --chown=box:box apps/eve apps/eve
COPY --chown=box:box apps/whatsapp-bridge apps/whatsapp-bridge
COPY --chown=box:box packages packages
COPY --chown=box:box api api
# `eve build` per Bot here, so the guest runs the built server rather than the
# eve CLI (three processes and 690 MB for one agent, against 224). Every
# directory under apps/eve/bots is a Bot, and init mints it a roster row on
# the next boot, so building the list rather than naming it keeps the image
# and the roster from drifting apart.
#
# The `node_modules` test is the other half of that: the COPY lines above are
# hand-written, and a Bot added without one is invisible to `npm ci`, builds
# from hoisted dependencies and ships subtly wrong. `|| exit 1` because the
# loop's status is the last iteration's, so without it a Bot that fails to
# build would ship as an image whose supervisor restarts it forever.
RUN for bot in apps/eve/bots/*/; do \
      test -d "${bot}node_modules" \
        || { echo "no npm ci for ${bot}: add its COPY line above" >&2; exit 1; }; \
      npm run build --workspace="${bot%/}" || exit 1; \
    done

# PID 1 is tini as root on purpose: the entrypoint execs the root init, which
# fixes volume ownership and supervises every other process as box or hub.
# hadolint ignore=DL3002
USER root
# Fly mounts `computer_workspace` at /workspace (roster, tokens, Eve secret).
VOLUME ["/workspace"]
EXPOSE 8080

# tini reaps the X server, Chromium and Eve children and forwards SIGTERM.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/guest-entrypoint.sh"]

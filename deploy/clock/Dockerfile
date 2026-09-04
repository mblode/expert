# The clock outside the box: a 256 MB always-on app whose whole job is to GET
# a suspended tenant's /healthz a few minutes before one of its routines is
# due. Build context is the repo root (`fly.clock.toml` [build]).
#
# It ships two workspaces and one data directory, and nothing else on purpose:
# no desk, no Eve, no hub, no credential. The routine manifests are the same
# files the guest image builds from, so a routine is declared once.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    CLOCK_BOTS=/opt/clock/apps/eve/bots \
    CLOCK_PORT=8080 \
    LEFTHOOK=0

WORKDIR /opt/clock

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/clock/package.json apps/clock/

# npm ci wants every workspace in the list to exist in the context, and this
# image has no business carrying the hub, eight Bots and Baileys to run a
# timer. So the workspace list is cut to the two this app is, exactly as the
# guest image cuts apps/web out of its own. `--omit=dev` is why `tsx` is a
# dependency of apps/clock rather than a devDependency: it is how it runs.
RUN node --input-type=module -e '\
const { readFileSync, writeFileSync } = await import("node:fs");\
const pkg = JSON.parse(readFileSync("package.json", "utf8"));\
pkg.workspaces = ["packages/shared", "apps/clock"];\
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");\
' && npm ci --omit=dev --no-audit --no-fund

COPY packages/shared packages/shared
COPY apps/clock apps/clock
# Only `*/agent/routines.json` is read from this tree. A per-Bot COPY line
# would be the correct narrowing and is not possible: `COPY a/*/b` flattens
# every match onto one destination, and a Bot without a routines.json would
# fail the build rather than be skipped.
COPY apps/eve/bots apps/eve/bots

# Nothing here needs root, and there is nothing to become root for.
USER node
EXPOSE 8080

# Straight to tsx, not `npm start`: the npm shim is a second Node process and
# 95 MB of the 256 this Machine has.
CMD ["/opt/clock/node_modules/.bin/tsx", "apps/clock/src/index.ts"]

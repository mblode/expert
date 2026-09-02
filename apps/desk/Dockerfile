# The local desk: Debian, not Ubuntu: Ubuntu's `chromium-browser` is a snap
# stub that cannot run in a container; Debian ships a real chromium on amd64
# and arm64. The Fly guest (deploy/fly/Dockerfile) installs the same list.
FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    HOME=/home/box \
    LANG=C.UTF-8

# The package list is piped through grep; pipefail makes a bad list fail the build.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

COPY packages.txt /tmp/packages.txt
RUN apt-get update \
    && grep -v '^#' /tmp/packages.txt | xargs apt-get install -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* /tmp/packages.txt

RUN useradd --create-home --uid 1000 --shell /bin/bash box \
    && mkdir -p /workspace /home/box/.config/chromium \
    && chown -R box:box /workspace /home/box

COPY --chmod=755 bin/ /usr/local/bin/

USER box
WORKDIR /workspace
# RFB 5900+N (localhost x11vnc). noVNC 6080 primary, 6081+ forks.
EXPOSE 5901-5908 6080-6087
# Grok keeps /workspace, the browser profile and ~/.config across a rebuild;
# it does not keep ~/.local/state, and apt packages die with the image. Same
# boundary here, so a skill written for a Bot needs no edit.
VOLUME ["/workspace", "/home/box/.config"]

# tini reaps the X server, x11vnc and Chromium children and forwards signals.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]

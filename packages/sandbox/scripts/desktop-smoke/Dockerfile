FROM oven/bun:1.3.13-slim
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs ffmpeg xvfb xdotool x11-utils x11-apps util-linux && rm -rf /var/lib/apt/lists/*
COPY driver.mjs /usr/local/lib/nap-desktop/driver.mjs
COPY smoke.sh /smoke.sh
COPY forced-cleanup.mjs /forced-cleanup.mjs
ENTRYPOINT ["bash", "/smoke.sh"]

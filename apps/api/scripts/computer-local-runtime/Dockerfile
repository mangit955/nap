FROM node:24-bookworm-slim

ARG BUN_VERSION=1.3.13
ARG CHROME_VERSION=156.0.8078.47-1
ARG CHROME_SHA256=6c92cd22e90c6e3e255d782991543fa2091db8614e8536a971a7433a5c4d7ac8

USER root
RUN useradd --create-home --shell /bin/bash user \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl dbus-x11 ffmpeg fonts-liberation git openbox openssl unzip util-linux \
    websockify novnc wget x11-utils x11vnc xdotool xvfb \
  && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --silent --show-error \
    "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
    --output /tmp/bun.zip \
  && unzip -q /tmp/bun.zip -d /tmp/bun \
  && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
  && rm -rf /tmp/bun /tmp/bun.zip \
  && test "$(bun --version)" = "${BUN_VERSION}"
RUN curl --fail --location --silent --show-error \
    "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb" \
    --output /tmp/nap-chrome.deb \
  && echo "${CHROME_SHA256}  /tmp/nap-chrome.deb" | sha256sum --check --strict \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/nap-chrome.deb \
  && rm -f /tmp/nap-chrome.deb \
  && rm -rf /var/lib/apt/lists/* \
  && test "$(google-chrome-stable --product-version)" = "${CHROME_VERSION%-1}"

COPY driver.mjs /usr/local/lib/nap-desktop/driver.mjs
COPY start-desktop.sh /usr/local/bin/nap-desktop-start
COPY exec.mjs file-helper.mjs tcp-forward.mjs /usr/local/lib/nap-local/
COPY supervisor.mjs /usr/local/lib/nap-local/supervisor.mjs
COPY --chown=user:user app/ /home/user/app/
RUN chmod 0755 /usr/local/bin/nap-desktop-start \
  && mkdir -p /etc/opt/chrome/policies/managed /home/user/.nap-desktop \
  && chown -R user:user /etc/opt/chrome/policies/managed /home/user/.nap-desktop

USER user
ENV HOME=/home/user DISPLAY=:99
WORKDIR /home/user/app
RUN bun install \
  && bun install --frozen-lockfile \
  && git init \
  && git config user.name "Nap Local" \
  && git config user.email "local@nap.invalid" \
  && git add --all \
  && git commit -m "Initial local template"

ENTRYPOINT ["node", "/usr/local/lib/nap-local/supervisor.mjs"]

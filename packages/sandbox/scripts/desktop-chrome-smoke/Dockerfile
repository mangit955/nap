FROM node:24-bookworm-slim
USER root
RUN useradd --create-home --shell /bin/bash user && apt-get update && apt-get install -y curl
COPY install.sh /tmp/install.sh
RUN bash /tmp/install.sh && rm -rf /var/lib/apt/lists/*
COPY driver.mjs /usr/local/lib/nap-desktop/driver.mjs
COPY start-desktop.sh /usr/local/bin/nap-desktop-start
COPY smoke.mjs fixture.mjs /smoke/
RUN chmod 755 /usr/local/bin/nap-desktop-start && mkdir /evidence && chown user:user /evidence
USER user
ENV HOME=/home/user DISPLAY=:99
ENTRYPOINT ["timeout", "--signal=TERM", "--kill-after=5s", "240s", "node", "/smoke/smoke.mjs"]

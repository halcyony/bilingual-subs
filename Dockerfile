# syntax=docker/dockerfile:1

# ---- alass (subtitle aligner) -------------------------------------------
# x86-64: use the official prebuilt binary. ARM64 (e.g. Oracle Ampere):
# there is no official build, so compile it from crates.io.
FROM rust:1.79-slim-bookworm AS alass
ARG TARGETARCH
RUN set -eux; \
    mkdir -p /out; \
    if [ "$TARGETARCH" = "amd64" ]; then \
      apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*; \
      curl -fsSL -o /out/alass-cli https://github.com/kaegi/alass/releases/download/v2.0.0/alass-linux64; \
      chmod +x /out/alass-cli; \
    else \
      # Pinned to the crate's own 2019 lockfile. If the compile ever fails,
      # the image still builds and the add-on falls back to its built-in
      # aligner (the startup log line "aligner:" shows which one is used).
      if cargo install alass-cli --version 2.0.0 --locked --root /tmp/alass; then \
        cp /tmp/alass/bin/alass-cli /out/alass-cli; \
      else \
        echo "WARNING: alass build failed; using the built-in aligner" >&2; \
      fi; \
    fi; \
    if [ -x /out/alass-cli ]; then /out/alass-cli --version; fi

# ---- add-on ---------------------------------------------------------------
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    ALASS_PATH=/opt/alass/alass-cli \
    PORT=7000 \
    HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=alass /out/ /opt/alass/
COPY bin ./bin
COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 7000

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bin/server.js"]

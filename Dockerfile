FROM mcr.microsoft.com/playwright:v1.62.1-noble

ARG TARGETARCH=amd64
ARG GH_VERSION=2.89.0
ARG SUPABASE_VERSION=2.75.0
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) GH_SHA=d0422caade520530e76c1c558da47daebaa8e1203d6b7ff10ad7d6faba3490d8; SB_SHA=e5597462f865d5ac72af0453358e37ecb0d85962ad6914a114a53de847303bde ;; \
      arm64) GH_SHA=9e64a623dfc242990aa5d9b3f507111149c4282f66b68eaad1dc79eeb13b9ce5; SB_SHA=b551c2f8e03715be428d2592765200a9e371168fc36ec2646a84ecc530d3120e ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    echo "$GH_SHA  /tmp/gh.tgz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tgz -C /tmp; \
    install "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh; \
    curl -fsSLo /tmp/supabase.tgz "https://github.com/supabase/cli/releases/download/v${SUPABASE_VERSION}/supabase_linux_${TARGETARCH}.tar.gz"; \
    echo "$SB_SHA  /tmp/supabase.tgz" | sha256sum -c -; \
    tar -xzf /tmp/supabase.tgz -C /usr/local/bin supabase; \
    rm -rf /tmp/gh.tgz /tmp/supabase.tgz "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}"; \
    gh --version; supabase --version

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/operator-console/package.json apps/operator-console/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ENV AUTOPILOT_CONTROL_API_ORIGIN=http://127.0.0.1:4310
RUN pnpm check
ENV NODE_ENV=production

EXPOSE 3000
CMD ["pnpm","start:remote"]

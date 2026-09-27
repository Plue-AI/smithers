# syntax=docker/dockerfile:1.8
# check=skip=FromPlatformFlagConstDisallowed
# The committed WebAssembly artifact is reproducible only on this host triple.
FROM --platform=linux/amd64 rust:1.98.0-bookworm AS flows-jj
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
COPY packages/smithers/flows/jj/wasm/flows_jj.wasm packages/smithers/flows/jj/wasm/flows_jj.wasm
RUN rustup target add wasm32-wasip1 \
  && CARGO_BUILD_JOBS=2 node crates/flows-jj/build-wasm.mjs --verify

FROM rust:1.98.0-bookworm AS jj-cli
ARG JJ_REVISION=47589ada70c12b3e829b5c98ab32503abad49eac
RUN CARGO_BUILD_JOBS=2 NIX_JJ_GIT_HASH="$JJ_REVISION" cargo install --locked \
    --git https://github.com/smithersai/jj.git \
    --rev "$JJ_REVISION" \
    --root /out/jj \
    jj-cli \
  && /out/jj/bin/jj --version | grep -Fx "jj 0.44.0-${JJ_REVISION}"

FROM rust:1.98.0-bookworm AS smithers-rust
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN CARGO_BUILD_JOBS=2 cargo build --locked --release --package smithers-ffi \
  && install -D -m 0555 target/release/libsmithers_ffi.so /out/lib/libsmithers_ffi.so \
  && install -D -m 0555 target/release/smithers-jj-export /out/bin/smithers-jj-export \
  && rm -rf target

# Git is built from an authenticated HTTPS source archive whose bytes and
# version are fixed here; a second kernel.org origin covers a mirror outage,
# and the digest check below decides either way. Runtime startup never downloads a tool.
FROM debian:bookworm-slim AS git-cli
ARG GIT_VERSION=2.50.1
ARG GIT_SHA256=7e3e6c36decbd8f1eedd14d42db6674be03671c2204864befa2a41756c5c8fc4
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl libcurl4-openssl-dev libexpat1-dev \
    libpcre2-dev libssl-dev xz-utils zlib1g-dev \
  && for origin in mirrors.edge.kernel.org cdn.kernel.org; do \
    curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 30 --retry 3 --retry-all-errors \
      "https://${origin}/pub/software/scm/git/git-${GIT_VERSION}.tar.xz" \
      --output /tmp/git.tar.xz && break; \
  done \
  && echo "${GIT_SHA256}  /tmp/git.tar.xz" | sha256sum -c - \
  && mkdir /tmp/git-src \
  && tar --extract --xz --file /tmp/git.tar.xz --directory /tmp/git-src --strip-components=1 \
  && make -C /tmp/git-src -j2 \
    prefix=/opt/smithers/git \
    NO_GETTEXT=YesPlease NO_TCLTK=YesPlease USE_LIBPCRE2=YesPlease all \
  && make -C /tmp/git-src \
    prefix=/opt/smithers/git DESTDIR=/out \
    NO_GETTEXT=YesPlease NO_TCLTK=YesPlease USE_LIBPCRE2=YesPlease install \
  && /out/opt/smithers/git/bin/git --version | grep -Fx "git version ${GIT_VERSION}" \
  && rm -rf /tmp/git-src /tmp/git.tar.xz /var/lib/apt/lists/*

FROM oven/bun:1.4.0-debian AS bun-buildchain

# Hutch's x64 devkit needs glibc 2.38+ to prepare the Vite aliases.
# Keep the packaged Node binary on Bookworm for the Bookworm runtime image.
FROM node:26.5.0-bookworm AS node-runtime

FROM node:26.5.0-trixie AS web
COPY --from=bun-buildchain /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.mjs tsconfig.json tsconfig.base.json ./
COPY patches patches
COPY packages packages
COPY flows flows
COPY factory factory
COPY .smithers/coding-project.json .smithers/coding-project.json
COPY evals evals
COPY apps apps
COPY examples examples
COPY scripts scripts
COPY distribution/flow-host-manifest.mjs distribution/flow-host-manifest.mjs
COPY --from=flows-jj /src/packages/smithers/flows/jj/wasm/flows_jj.wasm packages/smithers/flows/jj/wasm/flows_jj.wasm
RUN npm install --global pnpm@11.25.0 --ignore-scripts --no-audit --no-fund \
  && node --version && pnpm --version && bun --version \
  && pnpm install --frozen-lockfile
ARG BUILD_SHA
RUN printf '%s' "$BUILD_SHA" | grep -Eq '^[0-9a-f]{40,64}$' \
  && SMITHERS_BUILD_SHA="$BUILD_SHA" pnpm --dir apps/app run build:web
RUN pnpm --dir flows run typecheck
RUN node flows/coding/build.mjs /out/flow-hosts/smithers-coding-host \
  && node flows/librarian/build.mjs /out/flow-hosts/smithers-librarian-host \
  && node apps/model-host/build.mjs /out/flow-hosts/smithers-model-host \
  && node distribution/flow-host-manifest.mjs \
    /out/flow-hosts/flow-hosts.json \
    /out/flow-hosts/smithers-coding-host \
    /out/flow-hosts/smithers-librarian-host

FROM golang:1.26.8-bookworm AS backend
ARG BUILD_SHA
WORKDIR /src
RUN printf '%s' "$BUILD_SHA" | grep -Eq '^[0-9a-f]{40,64}$' || (echo 'BUILD_SHA must be an exact source revision' >&2; exit 1)
COPY go.mod go.sum ./
RUN go mod download
COPY apps/backend apps/backend
COPY apps/smithers apps/smithers
COPY packages/backend packages/backend
RUN GOMAXPROCS=2 CGO_ENABLED=1 go build -trimpath -ldflags="-s -w -X github.com/smithersai/smithers/packages/backend/internal/compose.BuildSHA=$BUILD_SHA" -o /out/smithers-backend ./apps/backend
RUN GOMAXPROCS=2 CGO_ENABLED=1 go build -trimpath -ldflags='-s -w' -o /out/smithers ./apps/smithers

# Debian/glibc is required by libsmithers_ffi; Alpine/musl is ABI-incompatible.
# This base supplies PostgreSQL 18 pg_dump/pg_restore/psql for maintenance.
FROM postgres:18.6-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libatomic1 libcurl4 libexpat1 libpcre2-8-0 libssl3 tini util-linux zlib1g && rm -rf /var/lib/apt/lists/* \
  && groupadd --system smithers && useradd --system --gid smithers --home-dir /var/lib/smithers --shell /usr/sbin/nologin smithers \
  && install -d -o smithers -g smithers -m 0700 /var/lib/smithers \
  && install -d -o root -g root -m 0755 /opt/smithers /opt/smithers/bin /opt/smithers/lib /opt/smithers/web /opt/smithers/migrations /opt/smithers/licenses
COPY --from=backend /out/smithers-backend /opt/smithers/bin/smithers-backend
COPY --from=backend /out/smithers /opt/smithers/bin/smithers
COPY --from=node-runtime /usr/local/bin/node /opt/smithers/bin/node
COPY --from=web /out/flow-hosts/ /opt/smithers/bin/
COPY --from=web /usr/local/LICENSE /opt/smithers/licenses/node-LICENSE
COPY --from=smithers-rust /out/bin/smithers-jj-export /opt/smithers/bin/smithers-jj-export
COPY --from=jj-cli /out/jj/bin/jj /opt/smithers/bin/jj
COPY --from=git-cli /out/opt/smithers/git /opt/smithers/git
COPY --from=web /src/apps/app/dist /opt/smithers/web
COPY --from=smithers-rust /out/lib/libsmithers_ffi.so /opt/smithers/lib/libsmithers_ffi.so
COPY packages/backend/db/product/migrations /opt/smithers/migrations
COPY distribution/lib.sh distribution/entrypoint.sh distribution/backup.sh distribution/restore.sh distribution/upgrade.sh distribution/version.env /opt/smithers/
COPY LICENSE THIRD_PARTY_NOTICES.md distribution/licenses/ /opt/smithers/licenses/
# A version-only release must not invalidate the runtime setup above.
ARG SMITHERS_DISTRIBUTION_VERSION=0.1.0
RUN schema_version="$(find /opt/smithers/migrations -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort | tail -n 1 | cut -c 1-4 | sed 's/^0*//')" \
  && test -n "$schema_version" \
  && sed -i "s/^SMITHERS_DISTRIBUTION_VERSION=.*/SMITHERS_DISTRIBUTION_VERSION=${SMITHERS_DISTRIBUTION_VERSION}/; s/^SMITHERS_SCHEMA_VERSION=.*/SMITHERS_SCHEMA_VERSION=${schema_version}/" /opt/smithers/version.env \
  && chmod 0555 /opt/smithers/*.sh /opt/smithers/bin/node /opt/smithers/bin/smithers /opt/smithers/bin/smithers-backend /opt/smithers/bin/smithers-coding-host /opt/smithers/bin/smithers-librarian-host /opt/smithers/bin/smithers-model-host /opt/smithers/bin/smithers-jj-export /opt/smithers/bin/jj \
  && chmod 0444 /opt/smithers/bin/flow-hosts.json /opt/smithers/bin/*.sha256 \
  && cd /opt/smithers/bin \
  && sha256sum -c smithers-coding-host.sha256 smithers-librarian-host.sha256 smithers-model-host.sha256 \
  && ./node --version | grep -Eq '^v26\.' \
  && ./jj --version | grep -Fx 'jj 0.44.0-47589ada70c12b3e829b5c98ab32503abad49eac' \
  && /opt/smithers/git/bin/git --version | grep -Fx 'git version 2.50.1' \
  && PATH=/opt/smithers/bin:$PATH ./smithers-coding-host --help >/dev/null \
  && PATH=/opt/smithers/bin:$PATH ./smithers-librarian-host --help >/dev/null \
  && PATH=/opt/smithers/bin:$PATH ./smithers-model-host --help >/dev/null \
  && chown -R root:root /opt/smithers && chown smithers:smithers /var/lib/smithers
ENV SMITHERS_DATA_ROOT=/var/lib/smithers \
    SMITHERS_FLOW_HOST_MANIFEST=/opt/smithers/bin/flow-hosts.json \
    SMITHERS_WORKSPACE_CODING_HOST_BINARY=/opt/smithers/bin/smithers-coding-host \
    SMITHERS_WORKSPACE_LIBRARIAN_HOST_BINARY=/opt/smithers/bin/smithers-librarian-host \
    SMITHERS_MODEL_HOST_BUNDLE=/opt/smithers/bin/smithers-model-host \
    SMITHERS_NODE_BINARY=/opt/smithers/bin/node \
    SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=/opt/smithers/bin/smithers-jj-export \
    SMITHERS_JJ_PATH=/opt/smithers/bin/jj \
    SMITHERS_FFI_LIBRARY_PATH=/opt/smithers/lib/libsmithers_ffi.so \
    PATH=/opt/smithers/bin:/opt/smithers/git/bin:/usr/lib/postgresql/18/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER smithers
EXPOSE 4000
VOLUME ["/var/lib/smithers"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 CMD curl --fail --silent "http://127.0.0.1:$${PORT:-4000}/readyz" >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/opt/smithers/entrypoint.sh"]
CMD []

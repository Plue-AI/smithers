# syntax=docker/dockerfile:1.8
# check=skip=FromPlatformFlagConstDisallowed
# The committed WebAssembly artifact is reproducible only on this host triple.
FROM --platform=linux/amd64 rust:1.98.0-bookworm@sha256:82150a52ec202c1b14d7817e14516c392bb7f5cfebd88f1ed531cb37ebd39922 AS flows-jj
RUN apt-get update && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/* \
  && rustup target add wasm32-wasip1 \
  && useradd --create-home builder && install -d -o builder -g builder /src
ENV CARGO_HOME=/home/builder/.cargo
USER builder
WORKDIR /src
COPY --chown=builder:builder Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY --chown=builder:builder crates crates
COPY --chown=builder:builder packages/smithers/flows/jj/wasm/flows_jj.wasm packages/smithers/flows/jj/wasm/flows_jj.wasm
RUN CARGO_BUILD_JOBS=2 node crates/flows-jj/build-wasm.mjs --verify

FROM rust:1.98.0-bookworm@sha256:82150a52ec202c1b14d7817e14516c392bb7f5cfebd88f1ed531cb37ebd39922 AS jj-cli
ENV JJ_REVISION=47589ada70c12b3e829b5c98ab32503abad49eac
RUN CARGO_BUILD_JOBS=2 NIX_JJ_GIT_HASH="$JJ_REVISION" cargo install --locked \
    --git https://github.com/smithersai/jj.git \
    --rev "$JJ_REVISION" \
    --root /out/jj \
    jj-cli \
  && /out/jj/bin/jj --version | grep -Fx "jj 0.44.0-${JJ_REVISION}"

FROM rust:1.98.0-bookworm@sha256:82150a52ec202c1b14d7817e14516c392bb7f5cfebd88f1ed531cb37ebd39922 AS smithers-rust
RUN useradd --create-home builder && install -d -o builder -g builder /src /out
ENV CARGO_HOME=/home/builder/.cargo
USER builder
WORKDIR /src
COPY --chown=builder:builder Cargo.toml Cargo.lock ./
COPY --chown=builder:builder crates crates
RUN CARGO_BUILD_JOBS=2 cargo build --locked --release --package smithers-ffi \
  && install -D -m 0555 target/release/libsmithers_ffi.so /out/lib/libsmithers_ffi.so \
  && install -D -m 0555 target/release/smithers-jj-export /out/bin/smithers-jj-export \
  && rm -rf target

# Git is built from an authenticated HTTPS source archive whose bytes and
# version are fixed here; a second kernel.org origin covers a mirror outage,
# and the digest check below decides either way. Runtime startup never downloads a tool.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS git-cli
ENV GIT_VERSION=2.50.1
ENV GIT_SHA256=7e3e6c36decbd8f1eedd14d42db6674be03671c2204864befa2a41756c5c8fc4
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

FROM oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef AS bun-buildchain

# Hutch's x64 devkit needs glibc 2.38+ to prepare the Vite aliases.
# Keep the packaged Node binary on Bookworm for the Bookworm runtime image.
FROM node:26.5.0-bookworm@sha256:219fc9da91e7f29a9f32290ff598cdf8886fd68f421ff515c8f93434da39a271 AS node-runtime

FROM node:26.5.0-trixie@sha256:0473e7dc433a1310f436edee02aa79737ec78a4b345433ab0963d4a256f9ad85 AS web
COPY --from=bun-buildchain /usr/local/bin/bun /usr/local/bin/bun
RUN npm install --global pnpm@11.25.0 --ignore-scripts --no-audit --no-fund \
  && install -d -o node -g node /src /out
USER node
WORKDIR /src
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.mjs tsconfig.json tsconfig.base.json ./
COPY --chown=node:node patches patches
COPY --chown=node:node packages packages
COPY --chown=node:node flows flows
COPY --chown=node:node factory factory
COPY --chown=node:node .smithers/coding-project.json .smithers/coding-project.json
COPY --chown=node:node evals evals
COPY --chown=node:node apps apps
COPY --chown=node:node examples examples
COPY --chown=node:node scripts scripts
COPY --chown=node:node distribution/flow-host-manifest.mjs distribution/build-cli.mjs distribution/install-cli.mjs distribution/
COPY --chown=node:node --from=flows-jj /src/packages/smithers/flows/jj/wasm/flows_jj.wasm packages/smithers/flows/jj/wasm/flows_jj.wasm
RUN node --version && pnpm --version && bun --version \
  && pnpm install --frozen-lockfile
ARG BUILD_SHA
RUN printf '%s' "$BUILD_SHA" | grep -Eq '^[0-9a-f]{40,64}$' \
  && SMITHERS_BUILD_SHA="$BUILD_SHA" pnpm --dir apps/app run build:web
# Ship the same npm package and production dependencies for offline boxes.
RUN node distribution/build-cli.mjs /out/cli \
  && tar -cf /out/cli.tar -C /out/cli .
RUN pnpm --dir flows run typecheck
RUN node flows/coding/build.mjs /out/flow-hosts/smithers-coding-host \
  && node apps/model-host/build.mjs /out/flow-hosts/smithers-model-host \
  && node distribution/flow-host-manifest.mjs \
    /out/flow-hosts/flow-hosts.json \
    /out/flow-hosts/smithers-coding-host

FROM golang:1.26.8-bookworm@sha256:a688600ca24f8a4d3ca77f95b0dd40704a9fc787c826660eb7ba0b641b8b175d AS backend
ARG BUILD_SHA
RUN useradd --create-home builder && install -d -o builder -g builder /src /out
ENV GOPATH=/home/builder/go
USER builder
WORKDIR /src
RUN printf '%s' "$BUILD_SHA" | grep -Eq '^[0-9a-f]{40,64}$' || (echo 'BUILD_SHA must be an exact source revision' >&2; exit 1)
COPY --chown=builder:builder go.mod go.sum ./
RUN go mod download
COPY --chown=builder:builder apps/backend apps/backend
COPY --chown=builder:builder packages/backend packages/backend
COPY --chown=builder:builder packages/smithers/package.json packages/smithers/package.json
COPY --chown=builder:builder scripts/build-backend.sh scripts/build-backend.sh
RUN GOMAXPROCS=2 CGO_ENABLED=1 sh scripts/build-backend.sh /out/smithers-backend "$BUILD_SHA" preview

# Debian/glibc is required by libsmithers_ffi; Alpine/musl is ABI-incompatible.
# Native PostgreSQL is supervised by the preview backend.
FROM postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650
ARG BUILD_SHA
LABEL org.opencontainers.image.revision=$BUILD_SHA
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libatomic1 libcurl4 libexpat1 libpcre2-8-0 libssl3 tini util-linux zlib1g && rm -rf /var/lib/apt/lists/* \
  && groupadd --system smithers && useradd --system --gid smithers --home-dir /var/lib/smithers --shell /usr/sbin/nologin smithers \
  && install -d -o smithers -g smithers -m 0700 /var/lib/smithers /tmp/smithers-preview \
  && install -d -o root -g root -m 0755 /opt/smithers /opt/smithers/bin /opt/smithers/lib /opt/smithers/web /opt/smithers/migrations /opt/smithers/licenses
COPY --from=backend /out/smithers-backend /opt/smithers/bin/smithers-backend
COPY --from=node-runtime /usr/local/bin/node /opt/smithers/bin/node
COPY --from=web /out/flow-hosts/ /opt/smithers/bin/
COPY --from=web /out/cli /opt/smithers/cli
COPY --from=web /out/cli.tar /opt/smithers/cli.tar
COPY --from=web /usr/local/LICENSE /opt/smithers/licenses/node-LICENSE
COPY --from=smithers-rust /out/bin/smithers-jj-export /opt/smithers/bin/smithers-jj-export
COPY --from=jj-cli /out/jj/bin/jj /opt/smithers/bin/jj
COPY --from=git-cli /out/opt/smithers/git /opt/smithers/git
COPY --from=web /src/apps/app/dist /opt/smithers/web
COPY --from=smithers-rust /out/lib/libsmithers_ffi.so /opt/smithers/lib/libsmithers_ffi.so
COPY packages/backend/db/product/migrations /opt/smithers/migrations
COPY distribution/entrypoint.sh /opt/smithers/
COPY LICENSE THIRD_PARTY_NOTICES.md distribution/licenses/ /opt/smithers/licenses/
RUN chmod 0555 /opt/smithers/*.sh /opt/smithers/bin/node /opt/smithers/bin/smithers-backend /opt/smithers/bin/smithers-coding-host /opt/smithers/bin/smithers-model-host /opt/smithers/bin/smithers-jj-export /opt/smithers/bin/jj \
  && chmod 0444 /opt/smithers/bin/flow-hosts.json /opt/smithers/bin/*.sha256 \
  && ln -s ../cli/node_modules/@smthrs/cli/bin/smithers.mjs /opt/smithers/bin/smithers \
  && ln -s smithers /opt/smithers/bin/smthrs \
  && cd /opt/smithers/bin \
  && sha256sum -c smithers-coding-host.sha256 smithers-model-host.sha256 \
  && ./node --version | grep -Eq '^v26\.' \
  && ./jj --version | grep -Fx 'jj 0.44.0-47589ada70c12b3e829b5c98ab32503abad49eac' \
  && /opt/smithers/git/bin/git --version | grep -Fx 'git version 2.50.1' \
  && chown -R root:root /opt/smithers && chown smithers:smithers /var/lib/smithers
ENV SMITHERS_WORKSPACE_ISOLATION=off \
    SMITHERS_NATIVE_POSTGRES_BIN=/usr/lib/postgresql/18/bin \
    SMITHERS_NATIVE_STATE_DIR=/tmp/smithers-preview \
    SMITHERS_WEB_ROOT=/opt/smithers/web \
    SMITHERS_WORKSPACE_CLI_PACKAGE=/opt/smithers/cli.tar \
    SMITHERS_DATA_ROOT=/var/lib/smithers \
    SMITHERS_FLOW_HOST_MANIFEST=/opt/smithers/bin/flow-hosts.json \
    SMITHERS_WORKSPACE_CODING_HOST_BINARY=/opt/smithers/bin/smithers-coding-host \
    SMITHERS_MODEL_HOST_BUNDLE=/opt/smithers/bin/smithers-model-host \
    SMITHERS_NODE_BINARY=/opt/smithers/bin/node \
    SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=/opt/smithers/bin/smithers-jj-export \
    SMITHERS_JJ_PATH=/opt/smithers/bin/jj \
    SMITHERS_FFI_LIBRARY_PATH=/opt/smithers/lib/libsmithers_ffi.so \
    PATH=/opt/smithers/bin:/opt/smithers/git/bin:/usr/lib/postgresql/18/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER smithers
RUN smithers-coding-host --help >/dev/null && smithers-model-host --help >/dev/null
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 CMD curl --fail --silent "http://127.0.0.1:$${PORT:-4000}/readyz" >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/opt/smithers/entrypoint.sh"]
CMD []

# Self-hosted distribution

Run one unprivileged Smithers application container with an external PostgreSQL 18 service and one persistent data volume. The application container needs no privileged mode, KVM, Docker socket, system service manager, or execution broker. Local jobs are trusted processes for one owner, or microVMs with [MicroVM isolation](#microvm-isolation).

```sh
umask 077
cat >smithers.env <<EOF
DATABASE_URL=postgres://smithers:replace-me@postgres:5432/smithers?sslmode=require
SMITHERS_AUTH_BOOTSTRAP_TOKEN=$(openssl rand -hex 32)
EOF
export SMITHERS_DOCKER_NETWORK=smithers # a network that reaches PostgreSQL
docker run --name smithers --restart unless-stopped -p 4000:4000 \
  --network "$SMITHERS_DOCKER_NETWORK" \
  --env-file ./smithers.env \
  -v smithers-data:/var/lib/smithers \
  ghcr.io/smithersai/smithers:0.1.0
```

`DATABASE_URL` (or `SMITHERS_DATABASE_URL`) must name the external PostgreSQL 18 database. The bootstrap token is required only until the first owner account exists; keep it private and remove it from the service environment after setup. Set `PORT` when the application must listen on a port other than 4000.

On Railway, attach PostgreSQL 18 and a volume mounted at `/var/lib/smithers`, set `SMITHERS_AUTH_BOOTSTRAP_TOKEN` to `openssl rand -hex 32`, and use Railway's existing `DATABASE_URL`, `PORT`, and `RAILWAY_PUBLIC_DOMAIN` variables. The entrypoint maps `DATABASE_URL` before startup and the backend derives its public HTTPS origin from `RAILWAY_PUBLIC_DOMAIN`.

The image contains the web build, `apps/backend`, the canonical coding and model TypeScript hosts with exact SHA-256 manifests, embedded product migrations, the Rust 1.98 glibc FFI library and canonical jj WebAssembly artifact (both built with the pinned toolchain), the `jj` 0.44 CLI built from revision `47589ada70c12b3e829b5c98ab32503abad49eac`, checksum-pinned Git 2.50.1, Node 26, and PostgreSQL 18 client tools. Startup verifies the host artifacts and never downloads an executable. The backend listens on port 4000 and owns the process adapter; PostgreSQL is external.

The image also includes the npm `@smthrs/cli` package as `smithers` (`smthrs` is an alias). Boxes receive its installed dependency tree from `SMITHERS_WORKSPACE_CLI_PACKAGE`, defaulting to `/opt/smithers/cli.tar`; they require Node 26. `distribution/build-cli.mjs` builds and packs the CLI through the existing release tooling. No Go CLI or registry download is needed in a box.

## Slack and Telegram

The backend can run the [durable chat connector host](../packages/backend/chatconnector/README.md). Set its configuration and owner credential file paths, plus the configured provider credentials, in the backend environment. Its SQLite action receipts and polling cursors live in the persistent data volume and are included in the existing backup.

## Platform model keys

Agent runs, workspaces and Flow hosts can use provider keys the installation pays for, as well as repository keys and connected accounts. After the first start, put the keys in a JSON file of provider name to key in the data volume. The providers are `anthropic`, `openai`, `cerebras`, `openrouter` and `vercel` (the AI Gateway key for recommendations, in place of `AI_GATEWAY_API_KEY`):

```sh
docker run --rm -i -v smithers-data:/var/lib/smithers --entrypoint sh \
  ghcr.io/smithersai/smithers:0.1.0 \
  -c 'f=/var/lib/smithers/config/platform-model-keys.json; umask 077 && cat >"$f" && chmod 600 "$f"' <<'EOF'
{"anthropic": "sk-ant-...", "openai": "sk-..."}
EOF
echo SMITHERS_PLATFORM_MODEL_KEYS_FILE=/var/lib/smithers/config/platform-model-keys.json >>smithers.env
```

Then remove the container and run it again with the same `docker run` command, which reads `smithers.env`; do the same after changing the set of providers. Startup fails if the file is readable by other users, is not a JSON object, names an unknown provider or holds a placeholder. Each call reads its key from the file, so a replaced key applies to the next call without a restart. Keys are never logged or placed in a guest's or Flow host's environment: guests and Flow hosts reach the providers through the backend's metered model proxy with a Smithers credential. This file is the only way Flow hosts get platform models; provider keys such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in the backend's environment are never passed to them. Local jobs are trusted processes of the same user, so they are not a boundary against the owner's own code reading the file.

To send a provider's calls to another origin, such as an inference gateway, set `SMITHERS_MODEL_PROXY_UPSTREAMS` to a JSON object of provider name to HTTP(S) origin, for example `{"openai":"https://gateway.internal"}`. The proxy sends that provider's platform key to the origin, so name only origins you trust.

Every call on these keys is metered in the owner's credit ledger at the provider's list price, including long-context rates, and is refused when the credit is spent. Fund it from the running container:

```sh
docker exec smithers /opt/smithers/bin/smithers-backend credits grant -owner user:OWNER -usd 25 -key 2026-10
docker exec smithers /opt/smithers/bin/smithers-backend credits balance -owner user:OWNER
```

`-owner` is `user:NAME` or `org:NAME`. A grant is applied once per `-key`; `-expires` takes an RFC 3339 time.

## Subscription connections

Claude and ChatGPT (Codex) subscription connections are disabled by default.
The hosted product keeps them disabled. A self-hosted installation can set
`SMITHERS_FEATURE_FLAGS_SUBSCRIPTION_CONNECTIONS=true` in its backend environment
and restart to let each user connect their own subscription for their own runs
and workspaces.

With the flag off, provider-connection routes return 403, the account refresh
worker does not start, and execution does not resolve stored subscription
tokens. The app hides the connection buttons. Secret, variable, and agent
environment writes also reject recognized subscription credentials, including
`CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_CODEX_ACCESS_TOKEN`, and `CODEX_AUTH_JSON`.
Provider API keys remain supported through their existing credential paths.

## Native application

The macOS package has two modes. `SMITHERS_BACKEND_MODE=own` starts the same Go backend plus the PostgreSQL 18 bundle copied at build time. `SMITHERS_BACKEND_MODE=plue` starts neither and uses `SMITHERS_API_ORIGIN`. Own mode is the default. Both canonical Flow hosts, their digest manifest, the canonical model host and checksum, the FFI library, the pinned `jj` CLI, relocatable Git helpers and templates, PostgreSQL server, and all PostgreSQL maintenance tools are inside the application; launch performs no download.

A release build supplies a PostgreSQL 18 distribution at build time:

```sh
export SMITHERS_NODE_BINARY=/path/to/node-v26/bin/node
SMITHERS_POSTGRES_BUNDLE_DIR=/opt/homebrew/Cellar/postgresql@18/18.6 \
  pnpm --dir apps/app run build:native
```

The native release builder requires Apple Git 2.50.1 from Xcode 26.3 (`Apple Git-155`) and builds `jj` from the same pinned source revision used by the Rust library. A different Git toolchain fails the build instead of silently changing the installed runtime.

The ordinary stable package uses WKWebView and opens no debug port. The native real-window matrix has a separate, explicit CEF build:

```sh
SMITHERS_NATIVE_E2E_CEF=1 \
SMITHERS_NATIVE_E2E_CDP_PORT=9444 \
SMITHERS_POSTGRES_BUNDLE_DIR=/opt/homebrew/Cellar/postgresql@18/18.6 \
  pnpm --dir apps/app run build:native
```

That artifact binds Chromium debugging to `127.0.0.1:9444`. Issue 16 consumes it through an environment-only envelope such as `{"executable":"/absolute/path/to/launcher","cdpEndpoint":"http://127.0.0.1:9444","environment":{"SMITHERS_BACKEND_MODE":"own"}}`. The build refuses a CDP port unless the explicit CEF flag is enabled.

After installing the generated application, the real lifecycle acceptance is:

```sh
bun apps/app/scripts/test-native-owned.ts \
  /Applications/Smithers.app/Contents/MacOS/launcher
```

It initializes bundled PostgreSQL, serves the real UI and API, bootstraps the owner, creates a real repository, stops PostgreSQL, restarts against the same state, and verifies that Plue mode starts no local backend or database.

For a native whole-state backup, quit Smithers and copy `~/Library/Application Support/Smithers` while the app is stopped. Record the installed Smithers version with the backup and restore it only while Smithers is stopped, initially with that same version. The PostgreSQL supervisor refuses a different PostgreSQL major and the product migrator refuses a schema newer than the installed application. This stopped-state copy includes the clean PostgreSQL cluster and runtime journals and never copies live WAL or SQLite writers.

## MicroVM isolation

On a Mac (or Linux with KVM) the backend can run every workspace, command, service, terminal, preview and Flow host in a local [Microsandbox](https://github.com/superradcompany/microsandbox) microVM instead of a trusted process. It is opt-in and never falls back:

```sh
npm install -g microsandbox@0.6.16    # the backend is qualified with msb 0.6.16
export SMITHERS_WORKSPACE_ISOLATION=microvm
export SMITHERS_MICROSANDBOX_BIN="$(npm root -g)/microsandbox/node_modules/@superradcompany/microsandbox-darwin-arm64/bin/msb"
smithers-backend microvm doctor       # read-only: msb, image, owned microVMs and layers, free disk
```

With `SMITHERS_WORKSPACE_ISOLATION=microvm` the backend refuses to start when `msb` is missing, is another release, or `msb doctor` is not ready. `SMITHERS_SERVER_ADDR` needs a fixed port: guests have no network except that port on the host, reached at their own `127.0.0.1`. The chat model host, which holds model credentials and runs no repository code, stays a trusted process under `<data>/control`.

The coding Flow host runs in the workspace's microVM with its shell, file, test and build tools. The backend plants the host from the `SMITHERS_FLOW_HOST_MANIFEST` bundle into the guest, digest-checked, together with the Linux workspace helper the host uses: put a Linux arm64 `smithers-jj-export` in the bundle and name it with `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY`, or the backend refuses to start. On a Mac, cross-build it with [Zig](https://ziglang.org) as the linker:

```sh
rustup target add aarch64-unknown-linux-gnu --toolchain 1.98.0
printf '#!/bin/sh\nfor a; do shift; [ "$a" = -Wl,--fix-cortex-a53-843419 ] || set -- "$@" "$a"; done\nexec zig cc -target aarch64-linux-gnu.2.36 "$@"\n' > zigcc; chmod +x zigcc
CC_aarch64_unknown_linux_gnu=$PWD/zigcc CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=$PWD/zigcc \
  cargo +1.98.0 build --locked --release -p smithers-ffi --bin smithers-jj-export --target aarch64-unknown-linux-gnu
install -D -m 0755 target/aarch64-unknown-linux-gnu/release/smithers-jj-export "$BUNDLE/linux-arm64/smithers-jj-export"
export SMITHERS_WORKSPACE_JJ_EXPORT_BINARY="$BUNDLE/linux-arm64/smithers-jj-export"
```

Model calls from the guest go through the backend's model proxy or account pool on the bridged port with the binding's credential; no provider key enters a VM.

A workspace boots from environment layers the backend builds once and caches as APFS-cloned disk snapshots: the repository's declared toolchain (`.node-version`, `packageManager`, `go.mod`, `.smithers/WORKSPACE.ts`, `rust-toolchain.toml`, each download checked against a reviewed SHA-256), then the install nodes of `.smithers/target-index.json` (pnpm store, Go modules, Cargo registry, Playwright browsers, tool downloads). A change to a declared input rebuilds only the layers it feeds. The first workspace of a repository takes a few minutes; later ones boot in about two seconds and link dependencies offline. Layers are garbage collected to `SMITHERS_MICROVM_LAYER_BUDGET_GIB` (default 48) and no build or boot starts below `SMITHERS_MICROVM_MIN_FREE_GIB` of free disk (default 40). Per-VM size: `SMITHERS_MICROVM_CPUS` (4), `SMITHERS_MICROVM_MEMORY_MIB` (8192), `SMITHERS_MICROVM_DISK_MIB` (32768); at most `SMITHERS_MICROVM_MAX_RUNNING` (3) run at once. The Docker image cannot host microVMs.

## Backup, restore, and upgrade

Stop the app container first. The maintenance lock refuses backup, restore, or upgrade while the app owns the volume. This example publishes a complete backup under `./backups`:

```sh
docker stop smithers
mkdir -p ./backups
docker run --rm --network "$SMITHERS_DOCKER_NETWORK" \
  --env-file ./smithers.env \
  -e SMITHERS_BACKUP_ROOT=/backups \
  -v smithers-data:/var/lib/smithers \
  -v "$PWD/backups:/backups" \
  --entrypoint /opt/smithers/backup.sh \
  ghcr.io/smithersai/smithers:0.1.0
```

The command uses `pg_dump`, archives repositories, blobs, workspaces, journals, and configuration, and writes checksums before publishing the backup. Copy the resulting backup directory away from the host. Browser-only drafts remain on their originating device and are outside the server backup.

On a clean target with an empty database and empty data volume, restore with the exact image version recorded in the backup manifest:

```sh
docker run --rm --network "$SMITHERS_DOCKER_NETWORK" \
  --env-file ./smithers.env \
  -v smithers-restored-data:/var/lib/smithers \
  -v "$PWD/backups:/backups:ro" \
  --entrypoint /opt/smithers/restore.sh \
  ghcr.io/smithersai/smithers:0.1.0 \
  /backups/smithers-YYYYMMDDTHHMMSSZ
```

Restore verifies archive checksums, the distribution/schema/PostgreSQL versions, and the archived state manifest before changing PostgreSQL. It stages files inside the writable data volume, restores PostgreSQL in one transaction, then publishes the files.

Never change issue or comment rows with triggers disabled (for example `session_replication_role = replica`). Triggers record who last wrote each title and body, and automation trusts that record; text changed without them keeps its previous writer.

For an upgrade, first create the backup with the old image as above. Then run the new image against the stopped installation and that verified backup:

```sh
docker run --rm --network "$SMITHERS_DOCKER_NETWORK" \
  --env-file ./smithers.env \
  -v smithers-data:/var/lib/smithers \
  -v "$PWD/backups:/backups:ro" \
  --entrypoint /opt/smithers/upgrade.sh \
  ghcr.io/smithersai/smithers:NEW_VERSION \
  /backups/smithers-YYYYMMDDTHHMMSSZ
```

Migration is exclusive under the maintenance lock. The state manifest changes only after migration succeeds. Normal startup refuses a distribution, schema, or PostgreSQL version mismatch.

This edition targets one host and local disk, with maintenance downtime. It makes no high availability or autoscaling claim.

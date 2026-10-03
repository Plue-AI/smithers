# Self-hosted distribution

The MVP installs on one Apple Silicon Mac as a launchd service that runs the backend, PostgreSQL 18 and a microVM for each awake branch, reachable at any address the owner sets in Settings (loopback by default, plain HTTP works; HTTPS and remote access are the team's choice, for example `tailscale serve` or a reverse proxy; M-28) ([MVP spec](../.specs/product/mvp.md) §6.1). That Mac install is being rebuilt in stage 1 (§11) and has no package yet.

The Docker recipe below is retained as a test fixture until T-INS-05 removes it. It can't host the microVMs required by the MVP.

## Docker image

The test fixture uses one unprivileged application container with an external PostgreSQL 18 service and one persistent data volume. The container needs no privileged mode, KVM, Docker socket, system service manager, or execution broker. Its process workspace runtime cannot bind repository flows unless the test composition explicitly sets `flowhost.Config.AllowTrustedProcessForTests`; no environment variable opts in. Production repository flows require [microVMs](#microvm-isolation).

A prebuilt test fixture requires a public image digest in its [release notes](https://github.com/smithersai/smithers/releases). The commands below require that publication receipt. For a source build, follow the [release guide](../packages/backend/docs/distribution-release.md).

```sh
export SMITHERS_IMAGE=ghcr.io/smithersai/smithers:1.0.0-rc.1
umask 077
cat >smithers.env <<EOF
DATABASE_URL=postgres://smithers:replace-me@postgres:5432/smithers?sslmode=require
EOF
export SMITHERS_DOCKER_NETWORK=smithers # a network that reaches PostgreSQL
docker run --name smithers --restart unless-stopped -p 4000:4000 \
  --network "$SMITHERS_DOCKER_NETWORK" \
  --env-file ./smithers.env \
  -v smithers-data:/var/lib/smithers \
  "$SMITHERS_IMAGE"
```

`DATABASE_URL` (or `SMITHERS_DATABASE_URL`) must name the external PostgreSQL 18 database. Until the install has an owner, the container prints `Setup URL: <origin>/setup?token=<T>` for each listener (`docker logs smithers`). Open it and sign in with GitHub: that account becomes the owner, and the token works once. Set `PORT` when the application must listen on a port other than 4000.

On Railway, attach PostgreSQL 18 and a volume mounted at `/var/lib/smithers`, read the setup URL from the deploy logs, and use Railway's existing `DATABASE_URL`, `PORT`, and `RAILWAY_PUBLIC_DOMAIN` variables. The entrypoint maps `DATABASE_URL` before startup and the backend derives its public HTTPS origin from `RAILWAY_PUBLIC_DOMAIN`.

The image contains the web build, `apps/backend`, the canonical coding and model TypeScript hosts with exact SHA-256 manifests, embedded product migrations, the Rust 1.98 glibc FFI library and canonical jj WebAssembly artifact (both built with the pinned toolchain), the `jj` 0.44 CLI built from revision `47589ada70c12b3e829b5c98ab32503abad49eac`, checksum-pinned Git 2.50.1, Node 26, and PostgreSQL 18 client tools. Every base image is pinned by digest. Startup verifies the host artifacts and never downloads an executable. The fixture backend listens on port 4000 and retains a process adapter for tests; PostgreSQL is external. This adapter provides no production repository-flow execution path.

The image also includes the npm `@smthrs/cli` package as `smithers` (`smthrs` is an alias). Boxes receive its installed dependency tree from `SMITHERS_WORKSPACE_CLI_PACKAGE`, defaulting to `/opt/smithers/cli.tar`; they require Node 26. `distribution/build-cli.mjs` builds and packs the CLI through the existing release tooling. No Go CLI or registry download is needed in a box.

## Platform model keys

Agent runs, workspaces and Flow hosts can use provider keys the installation pays for, as well as repository keys and connected accounts. After the first start, put the keys in a JSON file of provider name to key in the data volume. The providers are `anthropic`, `openai`, `cerebras`, `openrouter` and `vercel` (the AI Gateway key for recommendations, in place of `AI_GATEWAY_API_KEY`):

```sh
docker run --rm -i -v smithers-data:/var/lib/smithers --entrypoint sh \
  "$SMITHERS_IMAGE" \
  -c 'f=/var/lib/smithers/config/platform-model-keys.json; umask 077 && cat >"$f" && chmod 600 "$f"' <<'EOF'
{"anthropic": "sk-ant-...", "openai": "sk-..."}
EOF
echo SMITHERS_PLATFORM_MODEL_KEYS_FILE=/var/lib/smithers/config/platform-model-keys.json >>smithers.env
```

Then remove the container and run it again with the same `docker run` command, which reads `smithers.env`; do the same after changing the set of providers. Startup fails if the file is readable by other users, is not a JSON object, names an unknown provider or holds a placeholder. Each call reads its key from the file, so a replaced key applies to the next call without a restart. Keys are never logged or placed in a guest's or Flow host's environment: guests and Flow hosts reach the providers through the backend's metered model proxy with a Smithers credential. This file is the only way Flow hosts get platform models; provider keys such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in the backend's environment are never passed to them. A process workspace used with explicit test opt-in shares the owner's file permissions and provides no isolation boundary. Production repository flows run inside microVMs.

To send a provider's calls to another origin, such as an inference gateway, set `SMITHERS_MODEL_PROXY_UPSTREAMS` to a JSON object of provider name to HTTP(S) origin, for example `{"openai":"https://gateway.internal"}`. The proxy sends that provider's platform key to the origin, so name only origins you trust.

Every call on these keys is metered in the owner's credit ledger at the provider's list price, including long-context rates, and is refused when the credit is spent. Fund it from the running container:

```sh
docker exec smithers /opt/smithers/bin/smithers-backend credits grant -owner user:OWNER -usd 25 -key 2026-10 \
  -actor OPERATOR -reason "October credit"
docker exec smithers /opt/smithers/bin/smithers-backend credits balance -owner user:OWNER
```

`-owner` is `user:NAME` or `org:NAME`. A grant is applied once per `-key`. `-actor` (who granted it) and `-reason` are required and recorded in the grant's audit trail; `-expires` takes an RFC 3339 time.

To cap what the platform keys spend across every owner, set `SMITHERS_MODEL_DAILY_SPEND_CAP_USD` to a USD amount per UTC day, for example `500`. The day's spend counts settled calls at their charge and open calls at their bound. A call that would pass the cap is refused with HTTP 429 `insufficient_quota` and `Retry-After: 3600`, so runs park and retry hourly until the next UTC day or a raised cap. The check is not atomic: calls admitted concurrently each see the same prior spend, so together they can pass the cap. Each refusal logs `model provider spend cap reached: platform model calls are parked` at ERROR, the same line a provider's own account cap logs. Startup fails on a value that is not a positive amount; blank means no cap.

## Subscription connections

ChatGPT (Codex) subscription connections are disabled by default. No
deployment stores a Claude subscription: Anthropic's terms forbid storing
Claude.ai credentials, so Claude subscriptions run locally through the user's
own logged-in Claude Code (`claude-code:*` seats). A Claude connection is an
Anthropic API key only.

The hosted product keeps them disabled. A self-hosted installation can set
`SMITHERS_FEATURE_FLAGS_SUBSCRIPTION_CONNECTIONS=true` in its backend environment
and restart to let each user connect their own subscription for their own runs
and workspaces.

With the flag off, provider-connection routes return 403, the account refresh
worker does not start, and execution does not resolve stored subscription
tokens. The app hides the connection buttons. Secret, variable, and agent
environment writes also reject recognized subscription credentials (a Claude one
even with the flag on), including
`CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_CODEX_ACCESS_TOKEN`, and `CODEX_AUTH_JSON`.
Provider API keys remain supported through their existing credential paths.
On every start, every deployment deletes the secrets, variables, and provider
connections that hold a Claude subscription token, clears such model
credentials, removes the token from agent environments, logs each removal by
table, owner, and entry name, and marks the workspaces and snapshots built
with them for rebuild. The scan costs about 7 µs per stored row. A marked workspace or snapshot is refused whatever the flag says: a
deployment that turns the flag on after running with it off still rebuilds the
workspaces it marked for a ChatGPT token. The account pool serves only
connected ChatGPT sign-ins (`/provider-pool/chatgpt`); a Claude subscription
runs only on the user's own logged-in Claude Code.

## Mac install

The native macOS package (`build:native`, `Smithers.app`) was deleted with Electrobun distribution. The MVP's Mac install is being rebuilt as a launchd service, from the assembler half of the deleted `apps/app/scripts/build-native.ts` (at `5b77095672`), without Electrobun ([MVP spec](../.specs/product/mvp.md) §6.1 and §11, stage 1). Until it ships, there is no supported Mac package.

## MicroVM isolation

The MVP Mac install runs every workspace, command, service, terminal, preview and coding Flow host in a local [Microsandbox](https://github.com/superradcompany/microsandbox) microVM. The owned backend launcher always selects `microvm` and ignores shell isolation overrides. For a direct backend launch, set it explicitly; it never falls back:

```sh
npm install -g microsandbox@0.6.16    # the backend is qualified with msb 0.6.16
export SMITHERS_WORKSPACE_ISOLATION=microvm
export SMITHERS_MICROSANDBOX_BIN="$(npm root -g)/microsandbox/node_modules/@superradcompany/microsandbox-darwin-arm64/bin/msb"
smithers-backend microvm doctor       # read-only: msb, image, owned microVMs and layers, stopped disks, free disk
```

With `SMITHERS_WORKSPACE_ISOLATION=microvm` the backend refuses to start when `msb` is missing, is another release, or `msb doctor` is not ready. `SMITHERS_SERVER_ADDR` needs a fixed port: guests have no network except that port on the host, reached at their own `127.0.0.1`. They also reach the egress relay on `SMITHERS_EGRESS_RELAY_PORT` (default: the backend port + 1), which swaps bound credentials into requests so a guest never holds them; keep it fixed across restarts. The chat model host, which holds model credentials and runs no repository code, stays a trusted process under `<data>/control`.

The process workspace runtime is for tests only. An overridable Flow host refuses it with `isolation_required`; tests must opt in through `flowhost.Config.AllowTrustedProcessForTests`, never through an install environment variable.

An agent workspace stopped for 24 hours gives back its microVM disk. Resuming it boots a fresh microVM and checks the repository out again; work on its bookmark is kept, anything else in the old disk is not. `microvm doctor` reports the unique bytes stopped microVMs still hold.

The coding Flow host runs in the workspace's microVM with its shell, file, test and build tools. The backend plants the host from the `SMITHERS_FLOW_HOST_MANIFEST` bundle into the guest, digest-checked, together with the Linux workspace helper. A microVM install must name a Linux arm64 build of `smithers-jj-export` with `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY`, or the backend refuses to start. To build a custom bundle on a Mac, cross-build with [Zig](https://ziglang.org) as the linker:

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
  "$SMITHERS_IMAGE"
```

The command uses `pg_dump`, archives repositories, blobs, workspaces, journals, and configuration, and writes checksums before publishing the backup. The scripts pass `psql`, `pg_dump`, and `pg_restore` the database URL without its password and hand the password over in `PGPASSWORD`, so other users on a shared Docker host cannot read it from the process list. This covers both places a `postgres://` URL can hold a password: the userinfo (`postgres://user:secret@host/db`) and a `password=` query parameter, which wins when both are present, as in libpq. A key/value connection string such as `host=... password=...` is passed unchanged; use a `postgres://` URL. Copy the resulting backup directory away from the host. Browser-only drafts remain on their originating device and are outside the server backup.

On a clean target with an empty database and empty data volume, set `SMITHERS_IMAGE` to the exact image version recorded in the backup manifest, then restore:

```sh
docker run --rm --network "$SMITHERS_DOCKER_NETWORK" \
  --env-file ./smithers.env \
  -v smithers-restored-data:/var/lib/smithers \
  -v "$PWD/backups:/backups:ro" \
  --entrypoint /opt/smithers/restore.sh \
  "$SMITHERS_IMAGE" \
  /backups/smithers-YYYYMMDDTHHMMSSZ
```

Restore verifies archive checksums, the distribution/schema/PostgreSQL versions, and the archived state manifest before changing PostgreSQL. It refuses an archive holding an absolute link, a link that resolves outside the data root, or a link loop. It stages files inside the writable data volume, restores PostgreSQL in one transaction, then publishes the files.

Never change issue or comment rows with triggers disabled (for example `session_replication_role = replica`). Triggers record who last wrote each title and body, and automation trusts that record; text changed without them keeps its previous writer.

For an upgrade, first create the backup with the old image as above. Set `SMITHERS_NEW_IMAGE` to the digest-pinned image from the new release notes, then run it against the stopped installation and that verified backup:

```sh
docker run --rm --network "$SMITHERS_DOCKER_NETWORK" \
  --env-file ./smithers.env \
  -v smithers-data:/var/lib/smithers \
  -v "$PWD/backups:/backups:ro" \
  --entrypoint /opt/smithers/upgrade.sh \
  "$SMITHERS_NEW_IMAGE" \
  /backups/smithers-YYYYMMDDTHHMMSSZ
```

Migration is exclusive under the maintenance lock. The state manifest changes only after migration succeeds. Normal startup refuses a distribution, schema, or PostgreSQL version mismatch. An interrupted upgrade blocks startup and maintenance until [recovery from the pre-upgrade backup](../packages/backend/docs/upgrade-recovery.md). Restoring returns to the backup point and loses later changes.

This edition targets one host and local disk, with maintenance downtime. It makes no high availability or autoscaling claim.

### Rotate the operator key

The operator key seals connected provider accounts, secrets, model credentials and webhook signing secrets. It is `SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY`, kept in the data volume's `config/secrets.json` unless set in the environment. Take a backup, stop the container, then run:

```sh
docker run --rm --network "$SMITHERS_DOCKER_NETWORK" \
  --env-file ./smithers.env \
  -v smithers-data:/var/lib/smithers \
  --entrypoint /opt/smithers/bin/smithers-backend \
  "$SMITHERS_IMAGE" keys rotate
```

It writes a new key beside the old one, reseals every stored value under the new key, then deletes the old key. It prints counts per table and never a key. If it stops partway, run it again: it finishes with the key it already wrote, and the app starts in between because the file holds both keys. A value no key opens stops it and names the table and row. A backup keeps the key it was made with.

When the key comes from the environment, `keys rotate` refuses. Set the new key in `SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY` and the old one in `SMITHERS_WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS` (comma separated, newest first), restart, and run `smithers-backend keys reseal` with the same variables while the app runs. It repeats until a pass finds every value under the new key, then resets each Flow journal database role to the password the new key derives; a Flow host started under the old key reconnects only after it restarts. Then remove `SMITHERS_WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS` and restart.

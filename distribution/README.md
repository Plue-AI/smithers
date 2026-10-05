# Self-hosted distribution

The MVP installs on one Apple Silicon Mac as a launchd service that runs the backend, PostgreSQL 18 and a microVM for each awake branch, reachable at any address the owner sets in Settings (loopback by default, plain HTTP works; HTTPS and remote access are the team's choice, for example `tailscale serve` or a reverse proxy; M-28) ([MVP spec](../.specs/product/mvp.md) §6.1). That Mac install is being rebuilt in stage 1 (§11) and has no package yet.

## Preview image

This linux/amd64 image previews Home with machines off (M-41). It is never an install path and runs no workspace, flow, terminal or check. Native PostgreSQL and application data are ephemeral and reset when the container is replaced. No repository credentials or model keys enter the image. The disabled `WorkspaceRuntime` and fail-closed service admission prevent machine work from executing. Early refusal before effects is tested for the marked route sweep and the independent replay inventory; an unmarked route still cannot dispatch through a service.

```sh
BUILD_SHA=$(git rev-parse HEAD)
docker buildx build --platform linux/amd64 --build-arg "BUILD_SHA=$BUILD_SHA" \
  -f distribution/Dockerfile --load -t smithers-preview:local .
SMITHERS_BUILD_SHA="$BUILD_SHA" SMITHERS_DOCKER_SKIP_BUILD=1 \
  bash distribution/test-preview.sh smithers-preview:local
```

`smthrs build //distribution:image` writes the OCI archive to `distribution/docker-image/`. Once the owner chooses the Google Cloud project and the repository declares its preview target, `smthrs run //distribution:preview` deploys privately with Cloud Run IAM and an expiry. Open it through the returned proxy line (`gcloud run services proxy <service> --project <project> --region <region>`). Nothing deploys from this image build or the release workflow.

## Mac install

The macOS server assembler is restored without desktop distribution. Its output is an unprivileged, relocatable server bundle; installation and launcher readiness belong to T-INS-08 and T-INS-02.

## MicroVM isolation

The MVP Mac install runs every workspace, command, service, terminal, local preview and coding Flow host in a local [Microsandbox](https://github.com/superradcompany/microsandbox) microVM. The owned backend launcher always selects `microvm` and ignores shell isolation overrides. For a direct backend launch, set it explicitly; it never falls back:

```sh
BUNDLE=/path/to/installed/smithers    # includes msb 0.6.16
export SMITHERS_WORKSPACE_ISOLATION=microvm
export SMITHERS_MICROSANDBOX_BIN="$BUNDLE/bin/msb"
"$BUNDLE/bin/smithers-backend" microvm doctor # read-only: msb, image, owned microVMs and layers, stopped disks, free disk
```

With `SMITHERS_WORKSPACE_ISOLATION=microvm` the backend refuses to start when `msb` is missing, is another release, or `msb doctor` is not ready. `SMITHERS_SERVER_ADDR` needs a fixed port: guests have no network except that port on the host, reached at their own `127.0.0.1`. They also reach the egress relay on `SMITHERS_EGRESS_RELAY_PORT` (default: the backend port + 1), which swaps bound credentials into requests so a guest never holds them; keep it fixed across restarts. The chat model host, which holds model credentials and runs no repository code, stays a trusted process under `<data>/control`.

The process workspace runtime is for tests only. An overridable Flow host refuses it with `isolation_required`; tests must opt in through `flowhost.Config.AllowTrustedProcessForTests`, never through an install environment variable.

An agent workspace stopped for 24 hours gives back its microVM disk. Resuming it boots a fresh microVM and checks the repository out again; work on its bookmark is kept, anything else in the old disk is not. `microvm doctor` reports the unique bytes stopped microVMs still hold.

The coding Flow host runs in the workspace's microVM with its shell, file, test and build tools. The backend plants the host from the `SMITHERS_FLOW_HOST_MANIFEST` bundle into the guest, digest-checked, together with the Linux workspace helper. A microVM install must name a Linux arm64 build of `smithers-jj-export` with `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY`, or the backend refuses to start; the macOS server bundle ships it as `bin/linux-arm64/smithers-jj-export`, and its launcher sets that variable. To build the bundle on a Mac, cross-build the helper with [Zig](https://ziglang.org) as the linker and place it where `smthrs build //apps/app:serverBundle` reads it:

```sh
rustup target add aarch64-unknown-linux-gnu --toolchain 1.98.0
printf '#!/bin/sh\nfor a; do shift; [ "$a" = -Wl,--fix-cortex-a53-843419 ] || set -- "$@" "$a"; done\nexec zig cc -target aarch64-linux-gnu.2.36 "$@"\n' > zigcc; chmod +x zigcc
CC_aarch64_unknown_linux_gnu=$PWD/zigcc CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=$PWD/zigcc \
  cargo +1.98.0 build --locked --release -p smithers-ffi --bin smithers-jj-export --target aarch64-unknown-linux-gnu
mkdir -p apps/app/.native-inputs/linux-arm64
install -m 0755 target/aarch64-unknown-linux-gnu/release/smithers-jj-export apps/app/.native-inputs/linux-arm64/smithers-jj-export
```

Model calls from the guest go through the backend's model proxy or account pool on the bridged port with the binding's credential; no provider key enters a VM.

A workspace boots from environment layers the backend builds once and caches as APFS-cloned disk snapshots: the repository's declared toolchain (`.node-version`, `packageManager`, `go.mod`, `.smithers/WORKSPACE.ts`, `rust-toolchain.toml`, each download checked against a reviewed SHA-256), then the install nodes of `.smithers/target-index.json` (pnpm store, Go modules, Cargo registry, Playwright browsers, tool downloads). A change to a declared input rebuilds only the layers it feeds. The first workspace of a repository takes a few minutes; later ones boot in about two seconds and link dependencies offline. Machine and prepare sizes, capacity and the layer budget derive from the detected host profile. The owner can lower capacity; each read clamps it to the formula. Machines use 32 GiB disks, with a 40 GiB free-space floor. See [host capacity](../packages/backend/docs/host-capacity.md). The Docker image cannot host microVMs.

## macOS server bundle

`smthrs build //apps/app:serverBundle` restores the non-desktop native assembly
stages. See [build prerequisites and verification](../apps/app/scripts/README.md#server-bundle).
The unprivileged assembler emits `apps/app/.native-archive/smithers-server.tar.gz`,
with the operator README and bundled host CLI, including PostgreSQL 18,
MicroSandbox 0.6.16 and the digest-pinned Linux arm64 base image as an OCI
archive. It never installs a service or boots a guest. Preserve the complete
payload and its `manifest.json` when unpacking it. The sibling distribution
manifest records the archive digest. Operator instructions have one source:
[Stage-1 service](../apps/app/scripts/README.md#stage-1-service).

The lifecycle scripts (`backup.sh`, `restore.sh`, `upgrade.sh`, `lib.sh`) and guard tests are retained as T-INS-07 port sources with no production invocation.

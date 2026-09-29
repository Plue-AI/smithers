# Microsandbox workspace runtime

`microsandbox.Runtime` implements the common workspace contract
(`packages/backend/workspace`) with one local Microsandbox microVM per
workspace. `apps/backend` composes it when `SMITHERS_WORKSPACE_ISOLATION=microvm`;
setup is in [distribution/README.md](../../../distribution/README.md#microvm-isolation).

## Boundary

The runtime drives the pinned `msb` 0.6.16 CLI with a scrubbed environment
(`MSB_BACKEND=local`). Startup qualifies the release, `msb doctor` and the local
backend, or refuses. Every product execution path already goes through the
workspace contract, so no caller can run agent work on the host: commands,
services, managed Flow hosts, terminals (`msb exec -t` under a host PTY),
previews and file operations all run in the guest.

Machines and snapshots carry the ownership labels of `@smthrs/sandbox`'s
`MicrosandboxSandbox` (`smithers.provider`, `smithers.owner`, `smithers.holder`);
the owner is per installation (`<root>/owner`), so nothing of another
installation is reaped or collected.

## Guest

`guest/smithers-guest.py` is planted in every machine (digest-checked) and is
the only thing `msb exec` runs:

- `exec` puts each command in its own cgroup v2 as the unprivileged `agent`
  user. Exit reaps the cgroup, so a daemon the command left behind dies, as a
  process group does under the process adapter, and so does a `setsid`
  escapee. Cancellation kills the `msb exec` client (the guest ends the
  session) and then the cgroup. The helper ends stderr with an exit trailer; a
  missing trailer is reported as `ErrUnavailable`, never as a command exit.
  Completed stderr snapshots exclude the trailer from diagnostics and their
  output limit; repeated observations preserve the same captured bytes. Stdout
  and live output remain literal.
- `fs` confines paths to the root in the guest with the process adapter's
  rules; `relay` carries a byte stream to a guest loopback port (managed-host
  HTTP clients, `DialWorkspacePort`, previews); `bridge` exposes the backend's
  own port at guest `127.0.0.1`, the only destination the VM's network policy
  (`--no-net --net-rule allow@host:tcp:<port>`) allows.

A managed host's program and every environment value naming a file under a
`Config.Artifacts` directory (the packaged Flow host bundle and its Linux
workspace helper) are copied into the guest, digest-checked, and rewritten to
the guest path before the host starts; no host path reaches the guest.

Every non-PTY `msb exec` uses `--stream`: without it stdin of a few MiB never
arrives. Guests keep no credentials but task-scoped ones: the product's
revoked-after-use clone token and the binding-scoped Flow and model-proxy
credentials.

## Environment layers

A workspace with a `Source` boots from content-addressed snapshots
(`layers.go`):

| Layer | Key |
| --- | --- |
| toolchain | pinned image + the index's one `Environment.Toolchain` row: each tool's version, artifact URL and SHA-256, the Rust toolchain and PostgreSQL major |
| dependencies | toolchain key + the install nodes of `.smithers/target-index.json` (`Install`, `Go.ModDownload`, Cargo inputs, lockfile-built `NodeBinary` tools) and the content of their declared inputs, plus pnpm patches, hook and member manifests |

The layer's
environment (`/opt/smithers/env.json`) also lands where each tool looks under
the agent's home by default (`~/.config/go/env`, and links for the Playwright
browsers, the Cargo and rustup homes, the pnpm store and cache, and dprint's
cache), so a process that keeps only `PATH` and `HOME`, such as a coding host's
least-authority tool, works offline too. Each key also covers the build script and network allowlist. Layers are built
in prepare VMs whose domain allowlists are exactly the `destinations` the
layer's index rows declare (CDN CNAME targets included: domain rules match the
name a connection resolved through). A repository without a committed index,
or a download-performing node that declares no destinations, is refused by
name. Layers are verified in a fresh offline VM and kept as APFS clones. Caches live outside the workspace
root; after the product checkout `LinkWorkspaceEnvironment` links `node_modules`
offline. `collect` keeps referenced layers and the newest per family, then
evicts the least recently used until the owner's layer bytes and the host
free-disk floor are met.

## Recovery

Metadata is written before a machine exists. On start the runtime kills
`msb exec` clients orphaned by a dead backend (macOS has no parent-death
signal), removes owned machines without metadata, kills leftover command
cgroups and stops running machines: live processes are never inferred, and the
product's reconciliation starts the workspace and its services again. A
workspace whose machine is gone reports `recovery_required`.

## Tests

Unit tests need nothing. Real microVM tests need `SMITHERS_MICROSANDBOX_BIN`:

```sh
SMITHERS_MICROSANDBOX_BIN=/path/to/msb go test ./packages/backend/microsandbox -run TestRealMicroVM -v
# layers, a package's tests and an app screenshot in a VM; layers persist under the root
SMITHERS_MICROVM_LAYER_ROOT=/path/to/state SMITHERS_MICROVM_SCREENSHOT=/tmp/app.png \
  SMITHERS_MICROSANDBOX_BIN=/path/to/msb go test ./packages/backend/microsandbox -run 'Layers' -v -timeout 60m
```

Each test removes every machine and snapshot its owner created.

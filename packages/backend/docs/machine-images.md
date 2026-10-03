---
title: "Machine images"
description: "Detected toolchains, reviewed image packages, and Source ready and Machine ready."
---

## Repositories without declarations

The machine layer builder uses main’s committed `.smithers/target-index.json` when
present. An invalid index fails; it never silently switches to detection.
Without an index, `microsandbox.DetectRecipe` reads only:

| Files                                                                       | Recipe                                        |
| --------------------------------------------------------------------------- | --------------------------------------------- |
| `.node-version`, `.nvmrc`, `package.json`                                   | Node version and package manager              |
| `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`, `bun.lockb` | Package manager and dependency install        |
| `go.mod`                                                                    | Go version and `go mod download`              |
| `rust-toolchain.toml`, `Cargo.toml`                                         | Rust version and `cargo fetch`                |
| `.python-version`, `pyproject.toml`, `uv.lock`, `requirements*.txt`         | Python version and `uv sync` or `pip install` |

`packageManager` wins over lockfiles. Conflicting lockfiles from different
package managers fail with both filenames. `.node-version` wins over `.nvmrc`,
which wins over `engines.node`. Go's `toolchain` directive wins over `go`.
The recipe records tool versions, install argv and public registry destinations.
Detection executes no code and reads no host environment configuration.

The file-reader callback represents a `requirements*.txt` listing as a JSON
object of root filenames to their text. The product reader enumerates metadata
and reads only matching files at the same mirror revision. Dependency preparation
also reads lockfiles and workspace member manifests to complete its caches.

The embedded `microsandbox/toolchains.json` pins Linux ARM64 artifact URLs and
SHA-256 checksums. Releases update the manifest. Major and minor version
declarations select their newest matching pin. An exact version absent from the
manifest selects the nearest patch in the same minor. A version without a
matching pin fails with the filename to change. Layer identities include the
detector version, selected pins, input contents, build script and allowlist.
Cargo's `rust-version` is a minimum and selects the newest satisfying pin;
`rust-toolchain.toml` supplies an explicit toolchain when present.

With no recognized files and no image packages, the base image suffices. A
missing recognized executable exits with a `missing_machine_tool` error of
class `user`, naming the file to add, such as `rust-toolchain.toml` for `cargo`.

## Reviewed packages

`.smithers/machine.json` is read from the mirror's `main`, including when a
different revision is prepared:

```json
{ "packages": ["libssl-dev", "jq"] }
```

The sole field is `packages`, an array with at most 64 entries. Names match
`^[a-z0-9][a-z0-9+.-]{0,127}$`. Packages install in the prepare VM as root and
join the toolchain identity. Branch commands run as the unprivileged `agent`.
Dependency preparation also runs as `agent`, with Node lifecycle scripts
disabled until workspace linking. Python console scripts installed beneath
`python-site/bin` are on the machine PATH.
Download destinations govern the actual file write beneath the toolchain prefix.
Held directory descriptors and no-follow opens refuse parent and symlink escapes
with `invalid_download_destination`, including existing aliased leaves.
The current apt repositories supply packages; package versions are not pinned
to a Debian snapshot.

### What runs during preparation, and as whom

| Preparation step                                     | Runs as               | Execution and shared-layer effects                                                                                       |
| ---------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Toolchain download, SHA-256 verification, extraction and inventory | `guestUser` (`agent`) | Index pins come only from main. Artifacts run at `guestUID` under the agent-owned `/opt/smithers/toolchain` prefix. |
| Shipped toolchain system setup | `root` | Installs reviewed apt packages and creates agent-owned toolchain directories. Executes no toolchain artifacts. |
| Shipped browser system packages | `root` | Installed unconditionally in toolchain setup from shipped package pins, never selected by branch lockfiles. |
| Input planting, warm home defaults and layer markers | `guestUser` (`agent`) | Branch manifests and output are consumed only after the UID drop. Root only flushes the disk with the shipped `sync` command. |
| Dependency script                                    | `guestUser` (`agent`) | Runs repository-selected dependency commands at a nonzero uid.                                                           |
| npm, pnpm, yarn and bun installs                     | `guestUser` (`agent`) | Use `--ignore-scripts` during preparation. Lifecycle scripts run only at workspace link time, at a nonzero uid.          |
| pip wheel builds (`setup.py`) and `toolNode` entries | `guestUser` (`agent`) | Run repository code during preparation. Their effects are baked into a shared layer keyed by the digests of every input. |

## Setup readiness

`InstallMachineReadyService` reports `source` and `machine` separately, each
with `state`, `pct`, and an optional typed error. Source becomes ready only
after the mirror resolves `main` to a commit. Machine becomes ready only after
the layer builder completes and verifies required layers. Source remains ready
while the machine builds or a machine build fails.

The service accepts a persistence interface for serialized readiness receipts.
Each attempt resolves the current cached recipe even when `main` is unchanged,
so detector and manifest updates cannot reuse a stale machine receipt. An
attempt fence rejects a late build result. The install settings, durable setup
runner, HTTP resource and shared projection writer are supplied by their own
tickets; this service does not implement their schema or notifications.

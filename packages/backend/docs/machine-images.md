---
title: "Machine images"
description: "Detected toolchains, reviewed image packages, and Source ready and Machine ready."
---

## Repositories without declarations

The machine layer builder uses main’s committed `.smithers/target-index.json` when
present. An invalid index fails; it never silently switches to detection. Indexed and
detected inputs share the toolchain and dependency recipe builders.
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

## Base image

Every machine starts from the pinned `microsandbox.DefaultImage`. The install
bundle ships it as `share/microsandbox/base-image.oci.tar` (spec §16.1.0).
When an installed runtime starts, it verifies the archive against the bundle
manifest and loads it under the `DefaultImage` tag; a failed check or load
refuses the runtime. Installed machines and layers then create with
`--pull never`, so the install never reaches a registry. A runtime without a
bundle, as in development, pulls with `--pull if-missing`.

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

## Setup readiness seam

Setup step 5 (`source`) needs no machine. The install's import ends once the
mirror holds `main` (spec §8.6.3). The step then asks the stack service for
the repository's stack and completes without waiting for it. A TODO is
accepted once the stack worker reports the stack `active`.

Setup step 6 (`machine`) runs `InstallMachineReadyService`. It resolves `main`
to an immutable mirror revision and builds main's first image with the bound
image builder. Machine ready commits only after the builder returns verified
layers. Failures retain the recipe error and its fix; attempt fencing rejects
stale completion after a retry. Readiness persists in `setup.step.source` and
`setup.step.machine` in one transaction, written only by the operation that
holds the machine step. Step completion serializes as `done` (§14.3).

The install bundle binds step 6 to its microVM runtime's layer builder. It runs
the root toolchain setup above with only `packages` from `.smithers/machine.json`
and the PostgreSQL major from `.smithers/target-index.json` at `main`, both
validated before any VM boots (`TestRootLayerInputsValidatedBeforeUse`, T-INS-06
R4). A path that is not a regular file at `main`, such as a symlink, fails the
step naming the path. A composition whose runtime has no builder of its own may
inject `Options.MachineImages`; one beside an image-building runtime is refused.

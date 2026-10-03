# T-MCH-10 Toolchain detection, `.smithers/machine.json`, Source and Machine ready

Stage S1 · Size M · Depends on — · Unblocks T-APP-02, T-APP-03, T-FLW-02, T-FLW-05, T-INS-06, T-MCH-01, T-REL-02 · Issue: [#3439](https://github.com/smithersai/smithers/issues/3439)
Spec: spec.md §8.6, §16.2 steps 5–6, §14.3 Setup · Delta: delta.md §3 (toolchain detector row) · Product: mvp.md J1.3, J1.4, §6.1 Machine image without declarations, M-29
Ready: 2026-10-03 smithers-8a sha256:55b6efa95f5b

Rescoped by the minimal-code synthesis, 2026-10-03 (v2 "Reuse named in tickets"; v2 reverts, `7a5ab6140`). Landed in part: `7a5ab6140`, `617c991b3`, `0ecf139ad`. What remains is the rework below.

## Goal

A repository with no Smithers files gets a machine image with its toolchain and dependencies installed, and setup shows **Source ready** and **Machine ready** as two separate steps.

## Scope

In:
- A detector that reads only the files in §8.6.2 at a revision of the mirror and emits a recipe: tool versions, package manager, install command and network destinations. The supported envelope is Node, Go, Rust and Python, and nothing else.
- Version resolution through `toolchains.json` (§8.6.2a), a pinned manifest shipped in the install bundle and updated each release: version → download URL → SHA-256. A version absent from the manifest resolves to the nearest pinned patch of the same minor version, or fails naming the file to change.
- Layers built from that recipe when `.smithers/target-index.json` is absent. A committed index still wins.
- `.smithers/machine.json` with `packages[]` (Debian package names) added to the toolchain layer. It is read from `main` and reviewed like any change (M-29).
- With none of the §8.6.2 files: the base image only. A run step that needs a missing tool fails with a typed error naming the file to add.
- Two setup step states for `/api/install` and the `install` topic: `source {state, pct}` (the mirror holds `main`) and `machine {state, pct}` (the first recipe for `main` is built), §8.6.3.

Out:
- The durable setup step runner and the Setup card (T-INS-06, T-APP-03).
- Detected check commands and other install-stored configuration (T-FLW-02, spec §11.2).
- Shared prepared bases across repositories (#3382, do-not-implement).
- Any `sudo` path for adding packages at run time (M-29).

## Changes

- Keep (landed): `microsandbox/toolchains.json`, `toolchains.go` (`Resolve` with the nearest-patch rule), `machine_json.go`, the root-boundary fixes of `617c991b3` and `0ecf139ad`, and the exit-127 mapping to a `user`-class error.
- Reshape, one detector: the package-manager and lockfile rules live once, in `packages/smithers/src/suggest/Checklist.ts:183` (`evidence`). Extend it with the §8.6.2 version files (`.node-version`, `.nvmrc`, `engines.node`, `go.mod`, `rust-toolchain.toml`, `.python-version`, `pyproject.toml`, `uv.lock`, `requirements*.txt`) and delete the duplicate rules from `microsandbox/toolchain_detect.go` (354 lines, `7a5ab6140`). Go keeps only manifest resolution and recipe assembly from the evidence.
- Reshape `microsandbox/layers.go`: merge `detectedToolchainRecipe` (`:1623`) and `detectedDependencyRecipe` (`:1678`) into `toolchainRecipe` (`:850`) and `dependencyRecipe` (`:1293`), which take either index rows or detected rows. One recipe digest covers both.
- Delete `internal/services/install_machine_ready.go` and its two tests (670 lines, zero callers). T-INS-06's step store reports `source` from the mirror and `machine` from the layer build of `main`'s recipe; no source durable cursors writer.
- Docs: `packages/backend/microsandbox/README.md` "Environment layers"; `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/backend:docs`.
- New: none.

## Tests

- unit (`packages/smithers/test/ChecklistEvidence.test.ts`, extend; the landed `toolchain_detect_test.go` fixtures move here): one fixture per §8.6.2 row; precedence (`packageManager` over lockfile, `.node-version` over `.nvmrc` over `engines`); conflicting lockfiles produce a typed refusal naming both; no files produce the base-only recipe; files outside §8.6.2 (for example `.tool-versions`, `Gemfile`) are ignored.
- unit (`packages/backend/microsandbox/layers_test.go`; fold `detected_layers_test.go` into it): index rows and detected rows produce the same layer through the one recipe builder.
- unit (`packages/backend/microsandbox/toolchains_test.go`, landed): an exact manifest hit; `node 22.11.4` absent but `22.11.3` pinned resolves to `22.11.3`; a version with no pinned patch in its minor fails naming `.node-version`; every manifest row has a URL and a 64-hex SHA-256.
- unit (`packages/backend/microsandbox/machine_json_test.go`, new): valid list, invalid name, over 64 entries, absent file.
- integration (real microVM on the reference host, `packages/backend/microsandbox/real_layers_test.go`): a pnpm repository and a `go.mod` repository with no target index build layers, and `pnpm test` and `go test ./...` pass offline in a fresh VM.
- integration (real PostgreSQL): `source` turns ready only when the mirror holds `main`, `machine` only when the layer verify VM passes, and a failed build shows `failed` with the step's error (honest state, §19.3).

## Acceptance

- [C-J1-06](../checks/C-J1-06.md): a repository with no Smithers files gets a working machine, its checks run, and setup shows Source ready before Machine ready.
- [C-APP-03](../checks/C-APP-03.md): Add to machine image from Settings and from a failed step drafts a TODO whose seed adds only the package; after merge the retried step passes
- [C-J1-04](../checks/C-J1-04.md): First TODO to merged PR, unassisted, within 60 minutes of starting the install
- [C-SEC-02](../checks/C-SEC-02.md): The host process never loads or executes repository flows; no fallback to host processes

## Risks and notes

- The manifest goes stale between releases: a repository that pins a version newer than the bundle resolves to an older patch or fails. Confirmed by a fixture `.node-version` one minor ahead of the manifest. The failure names the file, and the next release's manifest fixes it.
- Private registries (`.npmrc`, `GOPRIVATE`) need credentials and destinations that detection can't see. Confirmed if the dependency layer fails on `smithersai/smithers`. Credentials come from secrets (T-MCH-12) only after S2, so S1 supports public registries only. Say so in the setup error.
- `apt-get` packages without a snapshot date aren't reproducible, so the same recipe digest can build different layers. Confirmed by building one recipe twice a week apart and diffing `dpkg -l`. Escalate whether to pin `snapshot.debian.org`.
- Open design point for smithers-3f before restamp: how the Go layer builder obtains `Checklist.evidence` output. The evidence must be computed from `main`'s files without running repository code on the host (M-29).

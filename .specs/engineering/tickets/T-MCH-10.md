# T-MCH-10 Toolchain detection, `.smithers/machine.json`, Source and Machine ready

Stage S1 · Size M · Depends on — · Unblocks T-INS-06, T-FLW-02 · Issue: [#3439](https://github.com/smithersai/smithers/issues/3439)
Spec: spec.md §8.6, §16.2 steps 5–6, §14.3 Setup · Delta: delta.md §3 (toolchain detector row) · Product: mvp.md J1.3, J1.4, §6.1 Machine image without declarations, M-29

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

- `packages/backend/microsandbox/toolchain_detect.go` (new): `DetectRecipe(read func(string) ([]byte, bool, error)) (Recipe, error)`. It ports the package-manager and lockfile rules of `packages/smithers/src/suggest/Checklist.ts:174-226` to Go and adds the version files: `.node-version`, `.nvmrc`, `package.json#engines.node`, `packageManager`, the four lockfiles, `go.mod` `go`/`toolchain`, `rust-toolchain.toml`, `Cargo.toml`, `.python-version`, `pyproject.toml`, `uv.lock`, `requirements*.txt`. Nothing outside the envelope (no Ruby, Java or .NET rows).
- `packages/backend/microsandbox/layers.go:565-580` `readTargetIndex`: a missing index no longer refuses ("environment layers need a committed …"). The layer builder asks the detector, and `toolchainRecipe` (`:614`) and `dependencyRecipe` (`:915`) take the detected rows. The recipe digest includes the detector version and each resolved manifest row, so a detector or manifest change rebuilds layers.
- `packages/backend/microsandbox/toolchains.json` (new) and `toolchains.go` (new): the manifest, its schema check, and `Resolve(tool, version) (url, sha256, error)` with the nearest-patch rule. A release step refreshes the manifest; T-INS-01 ships it in the bundle.
- `packages/backend/microsandbox/machine_json.go` (new): parse and validate `.smithers/machine.json` (`packages[]` matching `^[a-z0-9][a-z0-9+.-]{0,127}$`, at most 64 entries). Packages install with `apt-get` in the prepare VM as root. No session ever runs as root.
- Missing-tool failures: the machine command runner maps exit 127 for `node`, `pnpm`, `npm`, `yarn`, `bun`, `go`, `cargo`, `python` and `uv` to a `user`-class error (§6.2.3), for example "cargo isn't installed · add `rust-toolchain.toml`".
- Setup progress: `packages/backend/internal/services/install_machine_ready.go` (new) computes `source` from the mirror and `machine` from the layer build of `main`'s recipe, and writes `projection_events` for the `install` topic in the same transaction (§3.1).
- Docs: `packages/backend/microsandbox/README.md` "Environment layers" (detected recipe, `machine.json`); `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/backend:docs`.

## Tests

- unit (`packages/backend/microsandbox/toolchain_detect_test.go`, new): one fixture per §8.6.2 row; precedence (`packageManager` over lockfile, `.node-version` over `.nvmrc` over `engines`); conflicting lockfiles produce a typed refusal naming both; no files produce the base-only recipe; files outside §8.6.2 (for example `.tool-versions`, `Gemfile`) are ignored.
- unit (`packages/backend/microsandbox/toolchains_test.go`, new): an exact manifest hit; `node 22.11.4` absent but `22.11.3` pinned resolves to `22.11.3`; a version with no pinned patch in its minor fails naming `.node-version`; every manifest row has a URL and a 64-hex SHA-256.
- unit (`packages/backend/microsandbox/machine_json_test.go`, new): valid list, invalid name, over 64 entries, absent file.
- integration (real microVM on the reference host, `packages/backend/microsandbox/real_layers_test.go`): a pnpm repository and a `go.mod` repository with no target index build layers, and `pnpm test` and `go test ./...` pass offline in a fresh VM.
- integration (real PostgreSQL): `source` turns ready only when the mirror holds `main`, `machine` only when the layer verify VM passes, and a failed build shows `failed` with the step's error (honest state, §19.3).

## Acceptance

- [C-J1-06](../checks/C-J1-06.md): a repository with no Smithers files gets a working machine, its checks run, and setup shows Source ready before Machine ready.

## Risks and notes

- The manifest goes stale between releases: a repository that pins a version newer than the bundle resolves to an older patch or fails. Confirmed by a fixture `.node-version` one minor ahead of the manifest. The failure names the file, and the next release's manifest fixes it.
- Private registries (`.npmrc`, `GOPRIVATE`) need credentials and destinations that detection can't see. Confirmed if the dependency layer fails on `smithersai/smithers`. Credentials come from secrets (T-MCH-12) only after S2, so S1 supports public registries only. Say so in the setup error.
- `apt-get` packages without a snapshot date aren't reproducible, so the same recipe digest can build different layers. Confirmed by building one recipe twice a week apart and diffing `dpkg -l`. Escalate whether to pin `snapshot.debian.org`.
- Two detectors (Go here, TS in `Checklist.ts` for `smthrs suggest`) duplicate the package-manager rule. `smthrs suggest` is hidden in the MVP. Raise it with T-CUT-03 rather than delete it here.

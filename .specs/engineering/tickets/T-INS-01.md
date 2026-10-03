# T-INS-01 Server bundle assembler from the `build-native.ts` stages at `5b77095672`

Stage S1 · Size M · Depends on — · Unblocks T-ACC-07, T-INS-02, T-INS-05, T-INS-08, T-INS-09, T-REL-02, T-TRM-02 · Issue: [#3432](https://github.com/smithersai/smithers/issues/3432)
Spec: spec.md §1.2, §16.1.0, §16.1.1 · Delta: delta.md §1 (Restore→rewrite row) · Product: mvp.md J1.1, §6.1 Install on a Mac, §11 stage 1 item 1, §12.5, M-10

## Goal
One command in a clean checkout produces a relocatable darwin-arm64 server bundle that the launcher starts with no hand-placed file.

## Scope
In:
- Restore the bundling stages of `apps/app/scripts/build-native.ts` at `5b77095672` (313 lines; `jj --ignore-working-copy file show -r 5b77095672 apps/app/scripts/build-native.ts`): `SMITHERS_BUILD_SHA` pin (`:20-21`), Node 26.4+ and pnpm pins (`:42-75`), `rustup toolchain install` (`:175`), `smithers-ffi` (`:181`), jj at rev `47589ada70…` (`:182-195`), Go backend through `scripts/build-backend.sh` (`:196-200`), coding host `flows/coding/build.mjs` (`:203`), model host `apps/model-host/build.mjs` (`:214`), linux-arm64 `smithers-jj-export` (`:217-224`), flow host manifest `distribution/flow-host-manifest.mjs` (`:225-236`), Node runtime and licenses (`:240-245`), git packaging and the packaged git/jj smoke (`:248-288`), FFI and `smithers-jj-export` copies (`:290-304`), `bundlePostgres` (`:305`), the web bundle `pnpm run build:web` (`:307`).
- Add stages: the launcher compiled from `apps/app/src/bun/serve.ts` to `bin/smithers-server`; `msb` 0.6.16 with `lib/libkrunfw.5.dylib` from the pinned `@superradcompany/microsandbox-darwin-arm64` package, version checked against `packages/backend/microsandbox/cli.go:19`; the guest helper `packages/backend/microsandbox/guest/smithers-guest.py`.
- The pinned guest base image as an OCI archive (spec §16.1.0), so the first machine needs no registry pull. The runtime loads the image from the archive instead of pulling it by digest at first wake (`packages/backend/microsandbox/runtime.go:57`).
- A bundle manifest: every file with its sha256 and the stage that produced it.
- The layout `apps/app/src/bun/NativeBackendProcess.ts:300-345` resolves (`bin/`, `libexec/git-core`, `share/git-core/templates`, `postgres/`, `bin/flow-hosts.json`, `bin/linux-arm64/`), under one prefix that T-INS-05 installs as a keg `libexec`.

Out:
- Electrobun `.app`, the CEF matrix (`build-native.ts:25-37, 308-313`), `electrobun.config.ts`, `NativeApp.ts`, `NativeRendererServer.ts`, `DeepLink.ts`: deleted at `39e43c0fe4` and stay deleted.
- Formula, entitlement signing, launchd and the `smthrs host` lifecycle group (T-INS-03, T-INS-05, T-INS-07).
- Launcher environment changes (T-INS-02).
- `smithers-machined` in the guest root filesystem (T-COL-03 adds a stage to this assembler).

## Changes
- `apps/app/scripts/build-server-bundle.ts` (new) ← the stages above. Writes `apps/app/.server-bundle/` (gitignored) and `manifest.json`.
- `apps/app/scripts/build-server-bundle.test.ts` (new) ← `5b77095672:apps/app/scripts/build-native.test.ts` without the Electrobun and CEF cases.
- Reused unchanged: `apps/app/scripts/bundle-postgres.ts` (already ad-hoc signs PostgreSQL, `:200`), `system-linkage.ts`, `validate-git-bundle.ts`, `distribution/flow-host-manifest.mjs`, `scripts/build-backend.sh`.
- PostgreSQL 18 bundle and the linux-arm64 helper become declared build steps (pinned download with sha256; the release job's helper artifact), replacing the operator-supplied `SMITHERS_POSTGRES_BUNDLE_DIR` and `SMITHERS_LINUX_ARM64_JJ_EXPORT_BINARY` of `build-native.ts:141-147, 217-220`.
- `apps/app/PACKAGE.ts:337-338` → add a `serverBundle` ToolBuild target, so `smthrs build //apps/app:serverBundle` is the one command. Add the assembler to the `backend-child-env` security entry's `paths` (`PACKAGE.ts:257-268`; paths there are relative to `apps/app`).
- `.github/workflows/release.yml` → a darwin-arm64 job builds `serverBundle` and uploads the archive; fix the stale comment at `:520`.
- `distribution/README.md` "Native application" section and `apps/app/scripts/README.md` → describe the bundle; delete `build:native` text (stale per research/install-runtime.md).

## Tests
- unit `apps/app/scripts/build-server-bundle.test.ts`: refuses a missing or short `SMITHERS_BUILD_SHA`, a PostgreSQL major other than 18, Node outside 26.4+, an `msb` other than 0.6.16, and a binary linking a non-system dylib (`system-linkage.ts`).
- unit: a bundle file with no manifest entry, or a hash mismatch, fails the manifest check.
- integration `apps/app/scripts/server-bundle.integration.test.ts` (new): fresh clone, one build command, launcher started from the output with an empty state dir; `/readyz` within 30 s; every spawned executable and loaded dylib lives under the bundle prefix or the OS; `smithers-backend microvm doctor` is ready with the bundled `msb`; the first machine boots with the network to the image registry blocked.

## Acceptance
- [C-INS-05](../checks/C-INS-05.md): a clean checkout's build output starts with no hand-assembled file and no tool from nvm or Homebrew.
- [C-J1-04](../checks/C-J1-04.md): First TODO to merged PR, unassisted, within 60 minutes of starting the install

## Risks and notes
- The jj stage compiles from a git revision with cargo. Observation that confirms the risk: the macOS build exceeds 30 min. Cache the jj binary by revision.
- `msb` may not accept a local OCI archive in place of a registry reference. Observation that confirms it: setup's Machine ready step makes a registry request with the archive present. Fallback: load the archive into `msb`'s image store at first start.
- `smthrs host` is the install lifecycle group (`start`, `stop`, `status`, `upgrade`, `backup`, `restore`; T-INS-05, T-INS-07). The launchd daemon runs this bundle's `bin/smithers-server`, so one launcher implementation exists.
- Open (Will): AGENTS.md puts CI/CD on Smithers Cloud, which has no macOS host, and the bundle needs a macOS arm64 builder. Where release builds run is undecided.

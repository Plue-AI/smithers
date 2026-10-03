# T-INS-01 Restore `build-native.ts` from `5b77095672` as the server bundle assembler

Stage S1 · Size M · Depends on — · Unblocks T-INS-02, T-INS-05, T-INS-08, T-INS-09, T-REL-02, T-TRM-02 · Issue: [#3432](https://github.com/smithersai/smithers/issues/3432)
Spec: spec.md §1.2, §16.1.0, §16.1.1 · Product: mvp.md J1.1, §6.1, §11 stage 1 item 1, M-10
Rescoped by the minimal-code synthesis, 2026-10-03 (v1 §5). Restored code is not new code.

## Goal
One command in a clean checkout produces a relocatable darwin-arm64 server bundle that the launcher starts with no hand-placed file.

## Scope
In: the restored non-desktop stages, the launcher binary, `msb` with `libkrunfw`, the guest base image archive, a manifest, one build target and the release build steps.
Out: Electrobun `.app`, the CEF matrix, `electrobun.config.ts`, `NativeApp.ts`, `NativeRendererServer.ts`, `DeepLink.ts` (deleted at `39e43c0fe4`, stay deleted); formula, signing, launchd and `smthrs host` (T-INS-03, T-INS-05, T-INS-07, T-INS-08); launcher environment (T-INS-02); `smithers-machined` (T-COL-03 adds its stage).

## Changes
- Restore `5b77095672:apps/app/scripts/build-native.ts` (313 lines) at its old path, minus `:25-37` and `:308-313` (Electrobun and CEF). Kept stages: `SMITHERS_BUILD_SHA` pin, Node and pnpm pins, rustup, `smithers-ffi`, jj at the pinned rev, `scripts/build-backend.sh`, coding and model hosts, linux-arm64 `smithers-jj-export`, `distribution/flow-host-manifest.mjs`, Node runtime and licenses, git packaging and the packaged git/jj smoke, FFI copies, `bundlePostgres`, `pnpm run build:web`.
- Restore `5b77095672:apps/app/scripts/build-native.test.ts` (79 lines) without the Electrobun and CEF cases.
- Restore the `native-mode-matrix` setup and build steps of `39e43c0fe4^:.github/workflows/release.yml:78-117` (about 35 lines) as the darwin-arm64 bundle job.
- Reuse unchanged: `apps/app/scripts/bundle-postgres.ts`, `system-linkage.ts`, `validate-git-bundle.ts`, `scripts/build-backend.sh`. PostgreSQL 18 comes from `brew --prefix postgresql@18`, as the old release job did (`release.yml:117`).
- Reuse: the guest helper ships embedded in the backend (`packages/backend/microsandbox/guest.go:18`, `//go:embed`); no separate stage.
- Reshape `apps/app/PACKAGE.ts`: one `serverBundle` target, so `smthrs build //apps/app:serverBundle` is the one command.
- New: the launcher stage (`apps/app/src/bun/serve.ts` compiled to `bin/smithers-server`). Rejected reuse: the old stages built only the Electrobun `.app` launcher.
- New: `msb` 0.6.16 with `lib/libkrunfw.5.dylib` from the pinned `@superradcompany/microsandbox-darwin-arm64` package, checked against `packages/backend/microsandbox/cli.go:19`, and the pinned guest base image as an OCI archive. Rejected reuse: no stage at `5b77095672` packaged microVM tools; the runtime otherwise pulls by digest at first wake (`runtime.go:57`).
- New: `manifest.json` with each file's sha256 and producing stage. Rejected reuse: `distribution/flow-host-manifest.mjs` covers flow hosts only.
- Docs: `apps/app/scripts/README.md` and `distribution/README.md` describe the bundle; delete stale `build:native` text.

## Tests
- Unit (restored test): refuses a missing or short `SMITHERS_BUILD_SHA`, PostgreSQL other than 18, Node outside 26.4+, `msb` other than 0.6.16, and a binary linking a non-system dylib.
- Unit: a file with no manifest entry, or a hash mismatch, fails the manifest check.
- Integration `apps/app/scripts/server-bundle.integration.test.ts` (new): fresh clone, one build command, launcher started with an empty state dir; `/readyz` within 30 s; every spawned executable and loaded dylib is under the bundle prefix or the OS; `microvm doctor` is ready with the bundled `msb`; the first machine boots with the image registry blocked.

## Acceptance
- [C-INS-05](../checks/C-INS-05.md): a clean checkout's build output starts with no hand-assembled file and no tool from nvm or Homebrew at run time.
- [C-J1-04](../checks/C-J1-04.md): S1 part.

## Risks and notes
- The jj stage compiles with cargo; cache the binary by revision if the build exceeds 30 min.
- `msb` may refuse a local OCI archive. Fallback: load it into `msb`'s image store at first start.
- Open (Will): release builds need a macOS arm64 builder; where they run is undecided.

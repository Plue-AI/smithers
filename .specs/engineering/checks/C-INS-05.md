# C-INS-05 The bundle runs from a clean checkout's build output with no hand-assembled files

Proves: mvp.md §6.1 Install on a Mac, §11 stage 1 item 1 · spec.md §1.2, §16.1.0, §16.1.1 · Layer: integration · Stage: S1 · Tickets: T-INS-01
Automation: `apps/app/scripts/server-bundle.integration.test.ts` (new) · Runs in: CI on a macOS arm64 runner, and the reference host before each release

## Setup
- Apple Silicon, macOS 15 or later, with the toolchains the assembler pins (Node 26.4+, pnpm from `package.json`, rustup, Go).
- A fresh clone of the repository at commit X in an empty temporary directory: no `node_modules`, no `apps/app/bin`, no `apps/app/postgres`, no `.server-bundle`.
- No `msb`, `jj`, PostgreSQL or Homebrew `git` on `PATH` for the launch steps (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`).
- An empty state directory for the launch.

## Steps
1. Run the one documented build command, `smthrs build //apps/app:serverBundle`, with only `SMITHERS_BUILD_SHA=X` set.
2. List changes in the clone (`jj status` or `git status --porcelain` in the test's own clone).
3. Read `manifest.json`; hash every file in the bundle; list files missing from the manifest.
4. Start `bin/smithers-server` with the empty state directory.
5. Poll `http://127.0.0.1:4000/readyz`. List every process in the launcher's tree with its executable path, and the dylibs each loads (`ps -o pid,command`, `lsof -p`).
6. Run `bin/smithers-backend microvm doctor` against the bundled `msb`; with outbound access to the image registry blocked, boot one VM from the bundled base image archive and run `echo ok`.
7. Write one row through the API, stop the launcher with SIGTERM, start it again, read the row.

## Pass when
- Step 1 exits 0 with no other environment variable and no file supplied by hand.
- Step 2 shows only the gitignored bundle output.
- Step 3: every file has a manifest entry with its sha256 and producing stage, and every hash matches.
- Step 5: `/readyz` returns 200 within 30 s; every executable and dylib path is under the bundle prefix, `/usr/lib` or `/System`.
- Step 6 prints `ok`; doctor reports ready.
- Step 7: the row is present; PostgreSQL reports major 18.

## Fail when
- The build needs `SMITHERS_POSTGRES_BUNDLE_DIR` or `SMITHERS_LINUX_ARM64_JJ_EXPORT_BINARY` set by hand, as `build-native.ts` did at `5b77095672`.
- A process runs `git`, `jj`, `node` or `msb` from nvm, Homebrew or a global npm path.
- The bundle contains Electrobun, CEF or `NativeRendererServer` artifacts.
- The first VM boot pulls the base image from a registry instead of the bundled OCI archive (§16.1.0).
- The test passes on the maintainer's machine only (a path into the developer's home in the manifest).

## Evidence
`.artifacts/checks/C-INS-05/<UTC timestamp>/`: build log, `manifest.json`, the hash verification output, the process and dylib listing, readiness timing, doctor output, the runner's `sw_vers`, commit X.

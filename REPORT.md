# T-INS-01 (#3432) — crit-t-ins-01

Ready: sha256:bc6bed23a1c7. Lead smithers-df holds the claim.

Restored the non-desktop assembler and tests from 5b77095672. Added the
compiled server launcher, integrity-pinned msb 0.6.16/libkrunfw, digest-pinned
OCI image packaging, embedded guest-helper copy and complete bundle manifest.
The serverBundle target is uncached (Shell.Build defaults to cacheable=false).
The restored macOS release job assembles and checks a relocated copy without
Electrobun, CEF, browser tests, installation or guest startup.

## Operator commands on this Mac mini

Run as the ordinary build user, from this worktree:

```sh
source ~/lanes/env.sh
export PATH="$HOME/.local/node/bin:$HOME/.bun/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"
# Prerequisites: PostgreSQL 18, skopeo, pinned pnpm/Rust/Go, Xcode Git,
# official Node 26.4+ and its sibling ../LICENSE.
# Obtain the release job's native-helper-linux-arm64 artifact first.
export SMITHERS_LINUX_ARM64_JJ_EXPORT_BINARY=/absolute/path/to/linux-arm64/smithers-jj-export
pnpm exec smthrs build //apps/app:serverBundle
bun apps/app/scripts/server-bundle-manifest.ts apps/app/.native
SMITHERS_SERVER_BUNDLE_INTEGRATION=1 bun test apps/app/scripts/server-bundle.integration.test.ts
```

Successful assembly prints `[build-native] server bundle ready: <worktree>/apps/app/.native`.
Manifest verification exits 0 without output. The integration test invokes the
production target, copies the output with relative symlinks preserved, checks
literal layout and independent hashes, observes Node linkage and msb's version,
and checks the relocated manifest. It never starts the server or a guest.
Assembly opens no listener. T-INS-02 owns startup and localhost:4000 readiness;
T-INS-08 owns host start/setup handoff. Their paths, setup, TODO execution and
merge still need the combined C-J1-04 run.

## Executed evidence

Logs are in /tmp/crit-ins-*.log on this host (not acceptance receipts).

- `cd apps/app && bun test --isolate scripts/build-native.test.ts scripts/server-bundle-manifest.test.ts scripts/server-bundle.integration.test.ts scripts/validate-git-bundle.test.ts`: 22 pass, 0 fail, 2 skipped (real assembly lacks the release helper/skopeo). Compiler-built fixtures are confined to version/linkage refusal tests; integration mocks no build tools.
- Post-rebase `cd apps/app && bun test --isolate src/mainview/state/controller/gateway.test.ts scripts/build-native.test.ts scripts/server-bundle-manifest.test.ts scripts/server-bundle.integration.test.ts scripts/validate-git-bundle.test.ts`: 69 pass, 0 fail, 2 skipped (real assembly and upstream installed-bundle boundary).
- `cd apps/app && pnpm typecheck`: original base pass; first rebase failed on upstream missing notification_refused mapping. Added the existing notification error mapping and regression assertion; final rebase pass, exit 0.
- `cd apps/app && bun build --compile --target=bun-darwin-arm64 src/bun/serve.ts --outfile .native/validation-smithers-server`: pass, 378 modules; validation output removed afterward. No launcher executed. Recompiled successfully after T-INS-02 landed (3 modules).
- `pnpm exec smthrs build //apps/app:serverBundle`: fail, missing SMITHERS_LINUX_ARM64_JJ_EXPORT_BINARY, before destructive assembly/compilation. skopeo is also absent on this host. No complete bundle was produced.
- `node --test scripts/release-rehearsal.test.mjs scripts/pack-release.test.mjs`: tip 75 pass/4 fail; origin/main workflow 75 pass/4 fail. Same existing CI/release mirroring failures: gate roster, server gate, executable examples, wasm build-script argv.
- `pnpm run target-index`: blocked by unchanged //flows:testCoverage. Direct `cd flows && node --test test/target-coverage.test.ts`: 1 pass/1 fail; unregistered flows/test/coding-recovery-policy.test.ts. Both files are identical to origin/main.
- Generated .smithers/target-index.json via `pnpm exec smthrs index '//...' --json` and the TargetIndex renderer's exact JSON formatting. No gate was disabled; the normal generation gate remains red.
- Initial app test attempt used Homebrew Node 24 and was refused by the existing toolchain preflight; corrected PATH places ~/.local/node/bin first.

## Contracts and security

No root step, sudo, privileged install, signing, service installation or guest
startup was introduced or executed. Root input inventory: empty. No branch
artifact was loaded or executed by root. Build tools and compiler fixtures run
as the invoking user.

The Linux arm64 helper is a release input, checked for ELF64 little-endian
AArch64 before assembly; its version/provenance comes from the release helper
job, and the existing flow-host manifest records its digest. The assembler
uses the backend's existing msb 0.6.16 and DefaultImage pins and refuses drift.
base-image.json carries version, image, platform and archive. OCI copy uses
skopeo --preserve-digests. First-start loading of that archive belongs to the
launcher/runtime consumer, not this assembler. The guest-helper file is copied
from the same source the backend embeds, and independently compared in the
real integration test.

Manifest contract: version 1, platform darwin-arm64, revision, and files entries with
bundle-relative path with sha256, mode, producing stage, and optional
relative symlink target. Files and symlink referents hash bytes; symlinks retain their target text,
and resolve inside the canonical bundle root. Extra/missing/changed files,
modes and escaping links fail verification. T-INS-08 landed during rebase; array entries and symlink byte hashes now
match its host-start verifier, with a direct compatibility test. T-INS-02/T-INS-08 consume the
bundle layout and validation contract. T-INS-02 landed during rebase; its startup and boundary test are retained.
Launcher environment and readiness were not changed by this lane. The web
asset output uses T-INS-02's landed views/mainview contract. Ticket/spec PostgreSQL packaging wins over delta.md's stale
"bundled-PostgreSQL stage stays out" row.

## Files and positive-net reasons

No deleted files: the assembler and tests were already deleted on main.
Restoration replaces their absence; desktop stages stay deleted.

- apps/app/scripts/build-native.ts: restored host/tool/PG/web stages plus launcher/microVM/manifest wiring; no existing server assembler remains.
- apps/app/scripts/build-native.test.ts: restored linkage tests plus requested version/refusal coverage.
- apps/app/scripts/bundle-microsandbox.ts: no historical stage packages msb/libkrunfw or the offline pinned image.
- apps/app/scripts/server-bundle-manifest.ts: existing flow-host manifest covers only hosts, not the installation inventory.
- apps/app/scripts/server-bundle-manifest.test.ts: independent relocation, digest, mode and containment assertions.
- apps/app/scripts/server-bundle.integration.test.ts: requested production-target/layout/relocation integration, requires real release inputs.
- apps/app/src/mainview/state/controller/GatewayFailureCopy.ts and gateway.test.ts: one existing notification-code mapping and regression assertion repair the upstream exhaustive-map typecheck blocker; no new copy.
- apps/app/PACKAGE.ts: one serverBundle entry replaces the missing native target.
- .smithers/target-index.json: generated serverBundle declaration row.
- .github/workflows/release.yml: restored darwin-arm64 release assembly/provider artifact steps; no desktop matrix.
- apps/app/scripts/README.md and distribution/README.md: operator prerequisites/layout, replace stale build:native distribution wording.
- REPORT.md: requested operator/evidence/handoff record.

## Not done

C-INS-05 real assembly/relocation and C-J1-04 have no passing receipts. The
integration test was skipped, not passed. No coverage completion is claimed.
Release job has not run remotely. No full build, PostgreSQL startup, guest
startup, root safety acceptance, signing, install or release acceptance was
performed. Missing helper/skopeo and pre-existing flow inventory/release gate
failures remain for the lead to reconcile; do not close #3432 from this report.
Landed SHA and net lines are recorded in ~/lanes/crit-t-ins-01.REPORT.md after push.

---

# T-INS-02 (#3521) lane receipt

Ready stamp: sha256:290af6548bad. Lead smithers-df holds the issue claim; this lane did not run gh or issue-claim.

Implemented startup increment: bundled owned backend only, executable-realpath bundle resolution, fixed microVM/msb/relay/HTTP/SSH settings, fixed OS PATH, inherited stdout/stderr, argv-only socket handoff, canonical state directory, and production isolation refusal before keys/manifest/repository resources. The launcher no longer reads or generates setup tokens. Web assets also resolve from the bundle. Guest dispatch was not enabled or changed.

## Operator commands on this Mac mini

Use the assembled T-INS-01 installation, not a checkout script. Replace /path/to/installed/smithers with its actual directory; the bundle provider has not supplied that directory to this lane.

```sh
source ~/lanes/env.sh
export PATH="$HOME/.local/node/bin:$HOME/.bun/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"
BUNDLE=/path/to/installed/smithers
"$BUNDLE/bin/smithers-server"
```

Run as the installing user, never sudo. State is ~/Library/Application Support/Smithers. HTTP readiness is http://127.0.0.1:4000/readyz (expected 200 within 30 seconds); SSH configuration is 127.0.0.1:2222 (the SSH server remains a later provider); relay is 127.0.0.1:4001. PostgreSQL stays installer-owned and loopback. From a second terminal:

```sh
curl --fail http://127.0.0.1:4000/readyz
SMITHERS_DATA_ROOT="$HOME/Library/Application Support/Smithers" \
SMITHERS_MICROSANDBOX_BIN="$BUNDLE/bin/msb" \
"$BUNDLE/bin/smithers-backend" microvm doctor
```

After T-ACC-01 lands, fresh terminal startup must emit one newline-terminated {"setup_urls":[...]} line directly from the backend; open its URL to continue setup. After claim, restart must emit no setup URL. This lane has not observed that behavior. SIGTERM the launcher to stop it; restart preserves the same state directory. Do not remove an existing owner's state to simulate a fresh install; use the acceptance check's fresh macOS user.

Production boundary refusal test, after bundle assembly:

```sh
cd /Users/williamcory/lanes/crit-t-ins-02/apps/app
SMITHERS_TEST_SERVER_BUNDLE="$BUNDLE" bun test --isolate scripts/server-bundle.integration.test.ts
```

It copies the bundle and removes only the copy's msb; expected nonzero startup with "Bundled microVM runtime is unavailable", no setup line or readiness publication. The launcher refuses before backend spawn. No root step runs.

## Validation actually run

- apps/app: bun test --isolate src/bun/NativeBackendProcess.test.ts src/bun/ServeEntrypoint.test.ts scripts/server-bundle.integration.test.ts: 21 pass, 0 fail, 1 skip (no assembled bundle supplied).
- apps/app: pnpm typecheck: clean on the original lane base. After rebasing onto main 24e794f2d3, both main and tip return exit 2 for the identical pre-existing GatewayFailureCopy.ts:64 missing notification_refused mapping. Main was checked by temporarily switching this same worktree to the parent commit, running pnpm typecheck, and switching back; no other checkout was touched.
- repository root: go test ./apps/backend -count=1 -json: 35 passing test/subtest events, 0 failures, 2 skips: TestOwnerChatHTTPIntegration and TestSignalStopReportsShutdownFailure (built helper/database prerequisites).
- repository root: go build ./apps/backend: pass; generated untracked backend binary removed.
- packages/backend: go build ./... and go vet ./internal/...: pass. Linker warned that objects built for macOS 15.5 were linked with an 11.0 deployment target.
- git diff --check: pass.
- Initial launcher test command selected Node 24 through Homebrew and refused before tests. Prepending $HOME/.local/node/bin selects the installed required Node 26. Initial test failures from macOS /var -> /private/var fixture canonicalization were corrected; final targeted tests pass.

## Assumed contracts and remaining journey work

- T-INS-01: executable at bin/smithers-server; backend, msb, Node, Flow host manifest and helpers under bin; PostgreSQL under postgres; SPA under views/mainview. All paths derive from the executable realpath. No shell binary/path overrides remain.
- T-ACC-01: backend-only committed setup-URL mint/stdout and owner claim; the launcher sends no bootstrap token or public origin.
- T-INS-08: launcher --setup-handoff=socket passes that same backend argv; backend owns in-memory host.sock handoff, owner lock and setup_closed/setup_mint_failed responses. No launcher cache exists.
- T-INS-04: backend loads configured exposure/origins from install_settings; launcher readiness always uses loopback.
- Existing T-MCH-01 profile sizing remains unchanged. Existing guest coding binding remains unchanged; trusted-process coding still refuses isolation_required unless a test explicitly supplies the programmatic configuration.

Not done: assembled-bundle startup/offline VM boot/persistence, positive guest production dispatch, setup token independent SHA/rotation/claim proof, missing libkrun/failed hypervisor process-tree receipts, TestTargetIndexReadFromMainNotBranch, and C-J1-04's complete install/setup/TODO/merge journey. C-INS-05, C-SEC-02, C-SEC-04 and C-J1-04 are NOT claimed passing. T-SEC-01 root-hardening production receipts and the managed-artifact gate remain required before enabling repository execution; this increment adds no root step and executes no branch-built bytes at root.

## Change accounting

Deleted file: apps/app/e2e/fixtures/unit-entrypoints/ServeReadiness.preload.ts (obsolete shell-selected Plue fixture). Deleted launcher shell-mode/path/origin overrides, local token producer and inherited PATH append; deleted real-entrypoint Plue-only tests because the bundled launcher can no longer select Plue.

Positive file deltas are behavioral tests and the requested security review predicates: NativeBackendProcess.test.ts (hostility/symlink/output/argv/missing-runtime coverage), main_test.go (early production refusal/exempt doctor coverage), isolation_test.go (wrong-version refusal), server-bundle.integration.test.ts (real assembled-entrypoint refusal), PACKAGE.ts (security review checks), main.go and isolation.go (production startup has no prior early isolation guard, so the new guard and explicit test parameter replace ambient process selection). REPORT.md is the explicitly requested operator/evidence record. No existing production path served those assertions. Other implementation files shrink or preserve size. Final net and landed SHA are recorded in ~/lanes/crit-t-ins-02.REPORT.md after push.
# T-INS-08 (#3523) — first increment

Ready: sha256:d46fdac6ad4b. Lead smithers-df holds the issue claim.

Restored plist rendering and launchctl installation/removal from
35ec608f65^:flows/organization/setup/service.ts. Removed the clean agent,
organization checkout/runtime discovery and organization CLI arguments from
the restored implementation. Replaced the CLI's /api/host status call with
local launchd, readiness and bundled doctor diagnostics. No deleted files.

## Operator commands on this Mac mini

From this worktree, `source ~/lanes/env.sh` and
`export PATH="$HOME/.local/node/bin:$HOME/.bun/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"`.
Build the bundle using `node packages/smithers/bin/smithers.mjs build //apps/app:serverBundle`
when T-INS-01 lands, then:

```
node packages/smithers/bin/smithers.mjs host start --bundle <bundle-directory>
node packages/smithers/bin/smithers.mjs host status
node packages/smithers/bin/smithers.mjs host stop
```

Start waits up to 60 seconds for HTTP 127.0.0.1:4000/readyz. Expected output
is one or more http://localhost:4000/setup?token=... links (plus configured
origins). A running repeat retains the token. Start exits 0/setup_ready,
3/setup_closed (Already set up.), or 4/setup_mint_failed. A missing socket or
failed readiness exits 1, never 3. Status reports launchd/readiness/doctor,
bundle path and version. The per-user agent is sh.smithers.host in gui/<uid>;
state is ~/Library/Application Support/Smithers. Stop retains all data.
No root step is added or used. No branch code is installed/executed as root.

Real qualification, after dependencies land and the existing host is stopped:

```
cd packages/smithers
SMITHERS_HOST_TEST_BUNDLE=<absolute-real-bundle> pnpm exec vitest run test/host-service.integration.test.ts --coverage.enabled=false
```

This harness uses real launchd and the production source CLI, refuses an
already-loaded agent, runs a real bundle, and writes redacted observations to
.artifacts/checks/C-INS-06/. It is not a full acceptance receipt: login after
reboot, owner claim, all child UIDs and disabled-msb qualification remain.

## Assumed provider contracts

- T-INS-01 manifest.json has files[{path,sha256,stage}], covering every file
  except manifest.json; bin/smithers-server, bin/smithers-backend and bin/msb
  are executable. Version display uses version or buildSha until confirmed.
- T-INS-02's newer adopted socket contract supersedes this ticket's older
  file handoff: ProgramArguments includes --setup-handoff=socket. No
  setup-urls.json is created. Launcher derives state from the installing user’s HOME.
- T-ACC-01 must expose committed URLs in backend memory. T-INS-08 will wire
  a private 0600 installing-user-owned run/host.sock; GET /setup-urls returns
  200 {setup_urls:[...]}, 401 {error:setup_closed}, or
  503 {error:setup_mint_failed}. Reads and claim must share the owner lock.
- Default Homebrew bundle path is /opt/homebrew/opt/smithers/libexec; T-INS-05
  may refine it. No shell executable lookup is used.
- /readyz is fixed at http://127.0.0.1:4000. Before T-INS-06 telemetry is omitted.

## Validation

- pnpm exec vitest run test/HostService.test.ts test/host-service.integration.test.ts test/OneCli.test.ts test/BackendCommands.test.ts --coverage.enabled=false:
  225 passed, 1 skipped (real bundle unavailable); no coverage claim.
- pnpm exec tsc -p packages/smithers/tsconfig.json --noEmit: exit 0.
- pnpm docs:sync and pnpm docs:check: exit 0.
- cd packages/smithers && pnpm build: exit 0 (Node 26.5.0).
- node packages/smithers/bin/smithers.mjs docs //packages/smithers:docs --verbose:
  exit 0, one target ran successfully. Node 24 failed this target; corrected PATH.
- Test-tree tsc: two pre-existing SkillsPaths.test.ts errors, no touched-file errors.
- cd apps/app && pnpm typecheck: exit 0 (only app docs changed).
- Corrected pre-existing OneCli count drift for retired repo report and
  history backfill; the starting tree defines 204 commands against an
  expectation of 206. Tip adds two commands and names both prior retirements.

## Not done

Backend memory/socket wiring awaits the concurrent T-ACC-01 mint/claim API;
no second minter has been added. The first-merge C-J1-04 journey, named
acceptance checks and receipt-bound issue closure are NOT passed. A real
bundle and safe bundled microVM startup from T-INS-01/T-INS-02 remain required.
No issue-claim/gh invocation was made; the lead owns issue writes.

## Net lines

First increment: 11 files, +694/-28 (net +666). Positive files are justified as follows: HostService.ts
restores the deleted service with new bundle verification/socket consumption
(no current service implementation exists); HostService.test.ts restores
its behavioral coverage; host-service.integration.test.ts is the named real
CLI/launchd automation with no existing equivalent; Commands.ts and
Definitions.ts add the two requested CLI doors and local health; CLI tests
cover new dispatch, exits and intentional token output; source docs and their
generated projection describe the new operator commands; this report is the
requested operator/evidence handoff. apps/app/scripts/README.md is docs only.

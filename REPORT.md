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

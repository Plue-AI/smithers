# C-SEC-02 The host never loads or executes repository flows

Proves: mvp.md §9 Isolation, §6.12 Change the factory, M-29, M-30 · spec.md §1.3, §11.1, §17.3 · Layer: integration · Stage: S1 · Tickets: T-FLW-01, T-INS-02, T-ACC-07
Automation: `packages/backend/internal/compose/flow_isolation_integration_test.go` (new), with the process-tree sampler `scripts/checks/host-process-sampler.mjs` (new) · Runs in: reference host (needs `msb` 0.6.16 and libkrun), nightly

## Setup
- Install built from the commit under test, started through the bundled launcher and `smthrs host start`; launcher-forced microVM mode and bundled runtime paths; real PostgreSQL 18; fake GitHub serving one repository. Use a disposable bundle copy for runtime-failure cases.
- Repository at a fixture commit containing:
  - `flows/canary/beacon.ts`: on import, writes `$HOME/.smithers-canary/<nonce>` and opens TCP to `127.0.0.1:<canaryPort>` sending the nonce;
  - `flows/todo/flow.ts`, `flows/canary/flow.ts` and `flows/merge/flow.ts`, each importing the beacon.
- A canary listener on the host at `127.0.0.1:<canaryPort>`, recording every connection.
- One owner session; capacity at least 2.

## Steps
1. Start the sampler: every 250 ms it records `ps -axo pid,ppid,uid,command` for all descendants of the launchd job, and `lsof -p <pid> -Fn` for every `node`, `bun` and `smithers-*` process among them.
2. Create a TODO "add a README line" and let it run to In review.
3. Run `/flow.run canary` with `{}`.
4. Read the Flow card and the `flows` projection for `merge`.
5. Read `$HOME/.smithers-canary/` on the host. Inside the TODO's machine, read the same path through `msb exec`.
6. Stop the install. In the disposable bundle, remove the actual configured `bin/msb`, then separately remove its configured libkrun library; start through the same launcher for each case. Restore the bundle between cases. Separately verify that unset or hostile shell isolation variables do not override the launcher’s microVM settings.
7. Restart normally, start a TODO, and kill the `msb` process of its machine mid-run.
8. In a separate fresh install, invoke the real bundled `bin/smithers-server` with real backend/PostgreSQL. Capture the backend stdout pipe and launcher terminal output at token mint; compare the single setup line byte-for-byte including newline. Seed literal stored origins `http://lan-a:4000` and `https://box.example`. Restart before claim, verify a new token and refusal of the old one through the served exchange. Claim through served OAuth with fake GitHub, then restart. Scan stdout outside the exact mint-line range, stderr and ordinary logs for both token values. This subcase enables no repository dispatch. No expectation is derived from spec files or launcher code at runtime.

## Pass when
- The canary listener received 0 connections across steps 2–7.
- `$HOME/.smithers-canary/` doesn't exist on the host. The marker exists inside the machine (positive control: the beacon ran there).
- No host process imports, evaluates or executes repository code, including flow-load and coding steps; these run inside machines. Reading source, Markdown and object bytes as data for preflight, File cards or transfer is allowed. Capture host loader/exec targets and repository canary activity; a host file-open alone is not failure evidence.
- `merge` shows as refused with `reserved_name`, and no run of a repository `merge` flow exists.
- Both configured-runtime failure starts exit non-zero within 30 s with a typed message naming the missing runtime dependency; no machine workspace is created and no backend or PostgreSQL child remains. Hostile shell isolation settings are ignored and normal starts still use the bundled microVM runtime.
- After step 7 the run is resumed in a machine or shows `interrupted`; no host process picks up its steps.
- Step 8: one structured mint line covers the literal loopback and configured origins; launcher bytes equal backend bytes without prefix or reconstruction. Pre-claim restart rotates and relays once; post-claim restart emits no setup line on either side. Neither token occurs in any other output or ordinary log. C-SEC-04 proves digest-only storage. Save redacted evidence, not raw tokens.

## Fail when
- The canary listener or the host marker sees the nonce: the host imported repository code.
- The install starts in `process` mode on step 6, or the killed run continues as a host process: a silent fallback.
- `flows/merge/flow.ts` replaces the system merge, or is silently ignored without a refusal on the Flow card.
- The guest marker is absent, so the check proved nothing about where the code ran.

## Evidence
`.artifacts/checks/C-SEC-02/<UTC timestamp>/`: `process-samples.jsonl`, `lsof-samples.jsonl`, `canary-listener.log`, host and guest `ls` output for the marker path, the `flows` projection JSON, step 6 stderr and exit codes, `smthrs host status` output, and the commit and install version.

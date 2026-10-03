# C-SEC-02 The host never loads or executes repository flows

Proves: mvp.md §9 Isolation, §6.12 Change the factory, M-29, M-30 · spec.md §1.3, §11.1, §17.3, §10.4.4, §11.4, §15.2 · Layer: integration · Stage: S1 · Tickets: T-FLW-01, T-INS-02, T-INS-08, T-FLW-11, T-STK-12, T-MCH-14
Automation: `packages/backend/internal/compose/flow_isolation_integration_test.go` (new), with the process-tree sampler `scripts/checks/host-process-sampler.mjs` (new) · Runs in: reference host (needs `msb` 0.6.16 and libkrun), nightly

## Setup
- FLW11 QA G07/G08/R50 fixtures add root/nested agent-written AGENTS.md, repo configuration, instruction files and diff/tool-returned instruction canaries to both workspace and immutable candidate. Capture the pinned reviewer instruction/closure hash before these writes. Reviewer tools expose framed read-only candidate data; exec, filesystem write and GitHub write are disabled.
- Production NativeCoding calls have real current run/machine credentials plus wrong install/repository/TODO/attempt/branch/workspace/machine, stale attempt, draft, delegated/session and unbound machine controls. Host transfer uses minimal environment with hooks/helpers/config-selected filters disabled. Model requests use the host proxy; no provider key enters the guest.
- Install built from the commit under test, started through the bundled launcher and `smthrs host start`; launcher-forced microVM mode and bundled runtime paths; real PostgreSQL 18; fake GitHub serving one repository. Use a disposable bundle copy for runtime-failure cases.
- Repository at a fixture commit containing:
  - `flows/canary/beacon.ts`: on import, writes `$HOME/.smithers-canary/<nonce>` and opens TCP to `127.0.0.1:<canaryPort>` sending the nonce;
  - `flows/todo/flow.ts`, `flows/canary/flow.ts` and `flows/merge/flow.ts`, each importing the beacon.
- A canary listener on the host at `127.0.0.1:<canaryPort>`, recording every connection.
- One owner session; capacity at least 2.

## Steps
- Drive T-SEC-01 through production guest bootstrap/setup/exec/fs/cgroup/relay boundaries on fresh and retained machines. Run `TestGuestHelperInstallPinsInterpreterAndEnv`, `TestRootSetupNeverFollowsMemberSymlinks`, `TestRootPreflightParsesOnlyEnvelope`. Use hostile PATH/PYTHONPATH/LD_PRELOAD, replaced helper/interpreter destinations, member-home symlinks to /etc and /root, and malformed authority envelopes. Independently observe groups/GID/UID before payload use and record zero root canaries or outside writes. Each refusal has a valid positive control.
- Run `TestRootLayerInputsValidatedBeforeUse` through sec10 with main fixed and a hostile branch index, poisoned tar/chown destinations and marker parents. Run `TestRootManagedArtifactInstallUsesApprovedBundleOnly` and the guest-coding binding/helper tests through T-FLW-01’s follow-up. Prove artifact bytes come only from the installed bundle/catalog digest, never the branch. Branch-built root payloads remain forbidden regardless of test results.
- FLW11 QA G07 (I14/I15/I52): invoke both stack.candidate and stack.propose Action.make tags through production guest-to-host dispatch with each credential/binding variant. Snapshot/check runs in guest; sample host execution around capture and object transfer with hostile repository configuration.
- FLW11 QA G08/R50/R51 (I38/I39/U17/I41): review candidate/diff canaries in a fresh separate context on the TODO machine, inspect trusted prompt and tools, try denied exec/write, and vary exact first-line verdict. At 98,304 bytes review normally; at 98,305 bytes open generation-bound person approval without invoking reviewer. Advance generation and replay stale approval.
- FLW11 QA G19/R60: wake a held run with missing guest and denied token capacity, then recover. The signal stays durable; host never runs the repository, and model dispatch resumes only after the same run reacquires reservations.
1. Start the sampler: every 250 ms it records `ps -axo pid,ppid,uid,command` for all descendants of the launchd job, and `lsof -p <pid> -Fn` for every `node`, `bun` and `smithers-*` process among them.
2. Create a TODO "add a README line" and let it run to In review.
3. Run `/flow.run canary` with `{}`.
4. Read the Flow card and the `flows` projection for `merge`.
5. Read `$HOME/.smithers-canary/` on the host. Inside the TODO's machine, read the same path through `msb exec`.
6. Stop the install. In the disposable bundle, remove the actual configured `bin/msb`, then separately remove its configured libkrun library; start through the same launcher for each case. Restore the bundle between cases. Separately verify that unset or hostile shell isolation variables do not override the launcher’s microVM settings.
7. Restart normally, start a TODO, and kill the `msb` process of its machine mid-run.
8. In a separate fresh install, Invoke the real bundled bin/smithers-server and assert one newline-terminated printed line with the literal {"setup_urls": [...]} shape and sole key setup_urls. Independently compute SHA-256 of the printed token and compare it with the PostgreSQL stored digest. Restart before claim to prove rotation; restart after served OAuth claim to prove silence. Never tap the backend pipe inside the production launcher. Add hostile SMITHERS_BACKEND_MODE=plue and SMITHERS_MICROSANDBOX_BIN inputs; assert bundled mode and <bundle>/bin/msb. Start once with Homebrew and a hostile user directory on inherited PATH; assert child PATH contains only bundle bin and fixed OS directories, and executables/dylibs resolve under bundle or OS. Seed literal stored origins http://lan-a:4000 and https://box.example. Refuse the old printed token through the served exchange after rotation. Claim through served OAuth with fake GitHub. Scan stdout outside the exact printed-line range, stderr and ordinary logs for both token values; retain only redacted evidence. This subcase enables no repository dispatch.

## Pass when
- Admission's server-resolved current live run/machine binding admits only its own install/repository/TODO/attempt/branch/workspace. Wrong, stale, draft, public and unbound callers deny before capture or receipt lookup. Both tags are packaged Action.make operations, not repository Flow.make registrations; dispatcher usage has a production receipt.
- Trusted review instructions match the pinned hash and do not inherit the implementer's session or discover root/nested candidate/workspace AGENTS.md/config/instructions. Candidate/export/diff/tool-returned bytes are framed untrusted data. Tools deny commands, filesystem writes and GitHub writes; the reviewer runs on the TODO machine and host canaries stay absent.
- Exact first-line approve continues; request-changes becomes one durable input to implement; unread yields review/unread. Oversize data opens person-only generation approval and records substituted human review evidence, never model approval; a new generation invalidates it.
- Missing guest reaches the 15-minute wake failure without host fallback. Token denial parks the same run with the install owner, retaining inputs, and all resumed model requests traverse the host proxy's reacquired run/per-call gate.
- The canary listener received 0 connections across steps 2–7.
- `$HOME/.smithers-canary/` doesn't exist on the host. The marker exists inside the machine (positive control: the beacon ran there).
- No host process imports, evaluates or executes repository code, including flow-load and coding steps; these run inside machines. Reading source, Markdown and object bytes as data for preflight, File cards or transfer is allowed. Capture host loader/exec targets and repository canary activity; a host file-open alone is not failure evidence.
- `merge` shows as refused with `reserved_name`, and no run of a repository `merge` flow exists.
- Both configured-runtime failure starts exit non-zero within 30 s with a typed message naming the missing runtime dependency; no machine workspace is created and no backend or PostgreSQL child remains. Hostile shell isolation settings are ignored and normal starts still use the bundled microVM runtime.
- After step 7 the run is resumed in a machine or shows `interrupted`; no host process picks up its steps.
- Step 8: the real bundled bin/smithers-server prints exactly one newline-terminated line with the literal `{"setup_urls": [...]}` shape and sole key setup_urls. The independently computed SHA-256 of the printed token equals the PostgreSQL stored digest. Pre-claim restart rotates and prints once; post-claim restart emits no setup line. No production launcher pipe tap supplies evidence. Hostile mode/runtime inputs do not override bundled mode and <bundle>/bin/msb. Child PATH contains only bundle bin and fixed OS directories; executables/dylibs resolve under bundle or OS. Neither token occurs elsewhere in output or ordinary logs. Save redacted evidence.

## Fail when
- A caller widens its TODO/run binding, repository hooks/config-selected helpers/filters run on the host, or either reserved operation is registered as a repository flow.
- Agent-written instructions enter the reviewer trusted prompt, its tools execute/write, size handling fabricates model approval, or stale generation human approval authorizes fresh acceptance.
- The canary listener or the host marker sees the nonce: the host imported repository code.
- The install starts in `process` mode on step 6, or the killed run continues as a host process: a silent fallback.
- `flows/merge/flow.ts` replaces the system merge, or is silently ignored without a refusal on the Flow card.
- The guest marker is absent, so the check proved nothing about where the code ran.

## Evidence
- Also retain production binding/refusal receipts, guest capture/check location, hostile config host-canary logs, trusted review prompt/hash and framed tool data, exec/write refusal log, generation-specific oversize wait/approval evidence and host-proxy reservation/dispatch journal. Redact credentials and provider keys.
`.artifacts/checks/C-SEC-02/<UTC timestamp>/`: `process-samples.jsonl`, `lsof-samples.jsonl`, `canary-listener.log`, host and guest `ls` output for the marker path, the `flows` projection JSON, step 6 stderr and exit codes, `smthrs host status` output, and the commit and install version.

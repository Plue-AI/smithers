# T-MCH-12 Secrets into machines; main-only kept out

Stage S2 · Size M · Depends on T-MCH-11, T-COL-03, T-COL-03a, T-TRM-07 · Unblocks T-REL-02 · Issue: [#3456](https://github.com/smithersai/smithers/issues/3456)
Spec: spec.md §8.8, §8.9, §17.2, §17.4, §5.2 (Read secret values: nobody) · Delta: delta.md §3 (secrets row) · Product: mvp.md J1.8, §6.15 Secrets, M-18, M-25, D-24

## Goal

Every all-branches secret without declared hosts is an environment variable in every session and in the coding host on every branch machine. A secret that declares hosts never enters a machine: the relay substitutes it toward those hosts only. Main-only secrets, provider model keys and the GitHub App PEM never enter a branch machine.

## Scope

In:
- Two kinds of secret (§8.8.0). A secret that declares hosts stays egress-bound as today: the relay substitutes its value only toward those hosts (§8.9; `packages/backend/microsandbox/egress_secrets.go`). Only secrets without declared hosts become environment variables.
- At boot, all-branches secrets without declared hosts are written to `/run/smithers/env`, owned `root:team`, mode 0640, and the daemon rewrites the file within 5 s of a change (§8.8.1). New sessions and runs load the new values; running processes keep theirs. Daemon-owned sessions (§8.10.3, §8.11.1), the guest helper's `exec` and the coding host load it.
- By design, any session on a machine can print these values. "Nobody reads values back" applies to the API and the Secrets card (§8.8.1).
- Main-only secrets reach only an ephemeral background machine for a trusted run on `main`. In the MVP that means a manual run by a maintainer, since triggers are deferred. Never an item or scratch branch, an agent run or an outsider-triggered run (§8.8.2).
- Provider model keys stay on the host, and the coding agent's model calls go through the model proxy with its `run` credential (§8.8.3, §15.2).
- The API returns names and scopes only. No route returns a value (§5.2).
- Lands dark until T-MCH-11: refuse secret-bearing boot and session admission without the assigned uid and `team` group; never fall back to root or `developer`. Lands dark until T-COL-03 and T-COL-03a: refuse secret-bearing boot/wake and new runs without the authenticated per-boot connection and atomic env replacement. Lands dark until T-TRM-07: refuse daemon session starts until its unprivileged environment-loading contract is available. Build against these contracts before they land. Check: C-MCH-07 dependency-unavailable cases.
- Lands dark until T-FLW-01 and T-SEC-01: keep secret-bearing repository execution disabled unless the installed machine-only dispatcher and trusted guest bootstrap are available; no host or root fallback. These are activation preconditions, not new code dependencies. Check: C-SEC-02 through the production TODO and manual flow dispatchers.

Out:
- [D] Secret usage by run (spec §0, §8.8.1). No `secret_uses` table, column or count.
- The Secrets card (T-APP-13). Secret CRUD and role gating (T-ACC-03: Maintainer sets).
- Triggers and scheduled trusted runs (spec §11.7 [D]).
- New secret stores, a second host-binding splitter, provider-key storage or proxy redesign, SSH/terminal transports and personal tool-login copying. Reuse their owners' contracts. No root package installation, branch-built privileged artifact or launchd plist load.

## Changes
- Reuse `repository_secrets.main_only` (migration `packages/backend/db/product/migrations/0059_main_only_secrets.sql:7`) and the existing host-binding columns and loaders. Keep `repository_agent_environment_secrets` for its existing setup path. No new scope column, parallel table or secret CRUD implementation. Check: C-MCH-07.

- Reshape `packages/backend/internal/services/workspace_provisioning.go:445-490` `workspaceEgressProxy` and the boot path to reuse `SecretInjector.RepositorySecrets(ctx, repo, mainTrusted=false)` (`packages/backend/internal/services/secret_injection.go:118`), which already drops main-only rows at `:233` and separates `Env`, `Secrets` and `Bound` at `:134-150`. Use its unbound secret values for the env file and its `Bound` for the existing relay policy. Do not implement another splitter. No row goes to both.
- `packages/backend/microsandbox/runtime.go:587` `prepareGuest`: extend the trusted guest helper in `packages/backend/microsandbox/guest/smithers-guest.py` with a data-only `put-env` operation. Write `/run/smithers/env` with mode 0640 and group `team`, on tmpfs so it never reaches the disk or a capture. Reuse this operation for atomic live replacement through T-COL-03/T-COL-03a, not a second privileged writer. Check: C-MCH-07 and `TestSecretEnvRootInputsValidatedBeforeUse`.
- Live rewrite: a secret write publishes to every awake branch machine, and the daemon (T-COL-03) replaces the file atomically within 5 s (§8.8.1).
- Reshape the environment loading for `packages/backend/microsandbox/exec.go:189` `request` and `guest/smithers-guest.py:169` `base_environment()`: the guest loads `/run/smithers/env` as data after dropping uid/groups, before the request's own environment. Apply the same loader contract in T-TRM-07's broker sessions (terminal, SSH and coding host). Never source the file as shell code or merge it into the root helper environment. Check: C-MCH-07 and `TestSecretEnvLoadedOnlyAfterUidDrop`.
- Main-only path: reshape `workflowRunOnTrustedMain` (`packages/backend/internal/services/workflow_cache.go:1080`) for the MVP restriction before reusing `workflow_sandbox_scheduler.go:515`. Its current trigger/ref test also admits push, schedule and an empty ref; that alone is insufficient. Resolve the stored run's person, active maintainer/owner role, manual origin, trusted `main` revision and ephemeral background-machine binding on the server. Missing evidence returns false. Item and scratch branch machines, agents and outsider-started runs never call `RepositorySecrets(…, mainTrusted=true)`. One function decides, with a unit test per input and C-SEC-01 production-dispatch cases.
- Redaction: values reach run logs only through `RedactSecretValues` (`secret_injection.go:402`). Machine-side output that is projected (check logs, agent transcript) goes through it.
- `docs/api/openapi/repositories.yaml` secrets paths: confirm no response schema carries a value field.
- Docs: the Secrets page states that a secret is readable inside any session on any branch machine, and that main-only secrets are not.

## Tests

C-MCH-07 (folded steps and assertions):
1. Ben opens the Secrets card and sets `CANARY_TOKEN` (all branches) to a random 32-byte value V, and `DEPLOY_KEY` (main-only) to W.
2. At least 5 s after step 1, Alice opens a new terminal on branch A, which stayed awake. She runs `printenv CANARY_TOKEN DEPLOY_KEY`.
3. Alice runs `ssh -p 2222 <branch>@<install host> 'printenv CANARY_TOKEN'`.
4. Start a TODO through the production dispatcher. Its coding-host check step runs a fixed fixture command that asserts `CANARY_TOKEN == V` and `DEPLOY_KEY` is absent, then echoes both injected sentinel values in a separate redaction probe. Supply V from the test fixture; record the guest uid, check receipt and projected logs. The command runs only inside the machine.
5. Through the production router, call `GET /api/repos/{owner}/{repo}/secrets`, its POST/PATCH/DELETE routes and the existing `/agent-environment` routes (`packages/backend/internal/compose/router.go:1255-1266`). Use owner, maintainer and member sessions, delegated CLI, run and machine credentials. Active member sessions list names/scopes; only maintainer/owner sessions write. Delegated, run and machine credentials are denied before effects. Use disposable records for mutations; record bodies and persisted state. No response returns a stored value.
6. Search all response bodies, the run's projected logs and the activity for V and W.
7. Read the terminal opened before step 1 (on branch A): `printenv CANARY_TOKEN`.

Pass when:
- Step 2 prints V only; `printenv` returns nonzero because `DEPLOY_KEY` is absent. Test absence explicitly, not an expected blank line.
- Step 3 prints V.
- Step 4 records the explicit V equality and main-only absence assertions as passed in the guest; the projected redaction probe contains neither sentinel.
- Step 5 returns metadata only for admitted sessions and permission refusals for ineligible credentials; no body holds V or W, and denied writes change no row.
- Step 6 finds V and W 0 times. A value echoed by `printenv` into a terminal stream is excluded: any session can print all-branches values by design (§8.8.1).
- Step 7 prints no value and returns nonzero: running processes keep their environment, and only new sessions load the rewritten file (§8.8.1).

Fail when:
- The secret reaches the terminal but not the coding host, or the reverse.
- A new session opened 5 s after the write lacks V, which means the daemon didn't rewrite `/run/smithers/env`.
- `DEPLOY_KEY` is set in any branch session.
- Any API response, log line or activity entry contains V or W.
- The card shows "set" before the write commits (honest state, §19.3).


- unit (`packages/backend/internal/services/secret_machine_env_test.go`, new): for {item branch, scratch branch, agent run, outsider-started run, maintainer manual run on `main`}, only the last includes main-only rows. For every input, a secret with declared hosts appears in the relay policy and never in the env set.
- integration (real PostgreSQL, `secret_main_only_test.go` extended): a branch machine's env snapshot never contains a main-only name.
- integration (reference host, real microVM): sentinel values for an unbound all-branches secret, a host-bound all-branches secret, a main-only secret, a provider key and the App PEM. A scan of the guest filesystem, `/proc/*/environ` and `/run` finds only the unbound sentinel, and a request to the bound secret's host through the relay carries the bound value. This is C-SEC-01.
- integration (reference host, real microVM): replace a secret while a machine is awake. A session opened 5 s later sees the new value, and a session opened before keeps the old one (§8.8.1).
- e2e: C-MCH-07 (terminal, SSH session and a check step all see the unbound all-branches secret; no API response holds a value). The Secrets card is the final e2e boundary once T-APP-13 lands; component integration drives the served write routes without requiring that downstream ticket to land first.
- C-MCH-07 dependency-unavailable cases: through production boot/wake, TODO dispatch and session admission, remove each identity, daemon/relay or session capability in turn. Assert refusal before secret delivery or process start, then restore it for a positive control. No fallback starts repository work on the host or as root.
- C-SEC-01: drive manual flow/TODO dispatch with maintainer/owner manual `main`, member manual `main`, push, schedule, agent, outsider, empty/unresolved ref, item and scratch cases. Only the maintainer/owner manual trusted-main background case receives W. Include host-bound, provider and PEM sentinels, capture and model-proxy assertions. Hard-code the allow/deny matrix in fixtures; never derive it from the predicate under test.
- C-MCH-07/C-SEC-02 (`packages/backend/microsandbox/secret_env_integration_test.go`, new): `TestSecretEnvRootInputsValidatedBeforeUse` drives real fresh boot, retained wake and live `put-env` replacement. Poison `/run/smithers`, env/temp destinations and parent paths with branch-created symlinks and special files; send malformed/oversized maps, NULs, shell substitutions and hostile PATH/PYTHONPATH/LD_PRELOAD. Refuse before writes outside the fixed directory or root execution; valid literal data has a positive control and remains byte-exact. Assert tmpfs, root:team 0640, atomic replacement and zero sentinel bytes in captures.
- `TestSecretEnvLoadedOnlyAfterUidDrop` drives real guest `exec` and broker `open_session` for terminal, SSH and coding host: independently record effective uid and groups before environment loading and command execution. Repository commands and env contents never execute as root or on the host. Re-run C-SEC-02 with installed bundle bytes; branch-built privileged artifacts are forbidden even if tests pass.
- All test expectations are literal fixture assertions or independent OS observations. Tests never read spec files or use implementation policy/schema at runtime as the expected result.

## Acceptance

- [C-MCH-07](../checks/C-MCH-07.md): all-branches secrets without declared hosts are present in every session and the coding host; values are never readable through the API.
- [C-SEC-01](../checks/C-SEC-01.md): provider keys, the App PEM and main-only secrets never appear in any branch machine.

## Risks and notes

- Any member can `printenv` a value in a session, by design (§8.8.1). The spec enforces write-only at the API (§5.2), and the docs say so plainly.
- The coding agent is in `team`, so it reads unbound all-branches secrets. An agent steered by issue text can exfiltrate them over open egress (§8.9). This is spec behavior (§8.8.1); declaring hosts on a secret is the mitigation, and the Secrets docs say so. Record it for the maintainer release's outsider rules.
- `/run/smithers/env` on a disk-backed `/run` would land in `capture()` or a disk clone. Confirmed by `findmnt /run`. Require tmpfs.
- Decisions: smithers-3f approves the guest/broker seam, tmpfs and atomic replacement, trusted-main predicate, redaction coverage and security evidence; smithers-b8 approves public route/schema behavior and Secrets docs. smithers-8a accepts any contract/ADR change after those reviews. No product-policy change is authorized here.
- Root-input inventory for boot/wake `put-env`, live replacement and session preflight: helper/broker/interpreter bytes, fixed paths, mode, uid/gid policy and sanitized bootstrap environment come from reviewed main in the installed bundle/base image, never a lane build; repository/workspace/boot binding and member uid/group come from authenticated host state, not branch assertions; the secret map comes from host-persisted encrypted rows written through the authorized routes, never branch files. Root handles that map only as bounded literal data. Retained guest directory entries, symlinks and request argv/env/cwd/stdin are branch-controlled inputs. Validate directory descriptors with no symlink following before root file operations; validate only the authority envelope at root, then drop uid/groups before opening command payloads or loading env. `TestSecretEnvRootInputsValidatedBeforeUse` and `TestSecretEnvLoadedOnlyAfterUidDrop` prove these boundaries. No other input is allowed.
- C-SEC-01's privileged scan consumes a bundle-shipped scanner/interpreter and fixture sentinels from the trusted reference-host harness, not a branch revision. Guest file names, contents and `/proc` bytes are branch-controlled data: the scanner must not execute, source or follow them outside its scan roots. Include hostile scan paths and a root canary in `TestSecretEnvRootInputsValidatedBeforeUse`. Never run a repository-supplied scan script as root. No plist load occurs here.

## Ready checklist

1. Dependencies: T-MCH-11 identities, T-COL-03 host client, T-COL-03a broker/core and T-TRM-07 session code are consumed directly; S2 order is preserved. Scope names fail-closed dark landing for each unavailable contract and the machine-only activation prerequisites.
2. Exclusions: no secret CRUD/card, new secret store or splitter, usage tracking, triggers, provider redesign, transport rewrite, token copying or privileged branch artifact.
3. Boundaries: C-MCH-07 drives served secret routes, production boot/wake, terminal/SSH and TODO checks; C-SEC-01 drives real dispatch, captures and model calls. Fixtures and OS observations supply independent expectations.
4. Decisions: smithers-3f approves runtime/security seams; smithers-b8 approves API/docs; smithers-8a accepts contract/ADR changes after owner review.
5. Owner pre-review (post hoc under the parallel-build directive): smithers-3f must answer: Does the shared writer validate every root input on fresh boot, retained wake and live replacement? Do all session paths load secrets only after uid/group drop and fail closed when contracts are absent? Does the stored-run predicate exclude every non-manual/non-maintainer/non-main case? smithers-b8 must answer: Do served routes preserve metadata-only responses and person-only role gating? Do the Secrets docs distinguish session visibility, host binding and main-only scope? No UI View or TypeScript library changes are in scope.
6. Security: smithers-3f reviews the enumerated root inputs and the named production-lifecycle tests; C-SEC-02 proves repository execution stays in machines as non-root. Root executes only reviewed main/bundle bytes; branch-controlled data is validated before privileged use. No branch artifact or lane plist reaches root.


# T-MCH-12 Secrets into machines; main-only kept out

Stage S2 · Size M · Depends on T-MCH-11, T-COL-03 · Unblocks T-APP-13 · Issue: [#3456](https://github.com/smithersai/smithers/issues/3456)
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

Out:
- [D] Secret usage by run (spec §0, §8.8.1). No `secret_uses` table, column or count.
- The Secrets card (T-APP-13). Secret CRUD and role gating (T-ACC-03: Maintainer sets).
- Triggers and scheduled trusted runs (spec §11.7 [D]).

## Changes

- `packages/backend/internal/services/workspace_provisioning.go:445-490` `workspaceEgressProxy` and the boot path: fetch `SecretInjector.RepositorySecrets(ctx, repo, mainTrusted=false)` (`packages/backend/internal/services/secret_injection.go:118`), which already drops main-only rows at `:233`. Split the result once: rows with declared hosts go to the egress relay policy, rows without go to the env file. No row goes to both.
- `packages/backend/microsandbox/runtime.go` `prepareGuest` (`:581`): write `/run/smithers/env` at boot through the guest helper (new `put-env` subcommand in `packages/backend/microsandbox/guest/smithers-guest.py`), with mode 0640 and group `team`, on tmpfs so it never reaches the disk or a capture.
- Live rewrite: a secret write publishes to every awake branch machine, and the daemon (T-COL-03) replaces the file atomically within 5 s (§8.8.1).
- `packages/backend/microsandbox/exec.go:189` `request`: commands run by the guest helper (the coding host, checks) load `/run/smithers/env` before the request's own environment.
- Main-only path: the ephemeral background machine for a maintainer's manual `main` run calls `RepositorySecrets(…, mainTrusted=true)` only when `workflowRunOnTrustedMain` (`packages/backend/internal/services/workflow_cache.go:1080`) holds, as `workflow_sandbox_scheduler.go:515` does today. Item and scratch branch machines never call it with `true`. One function decides, with a unit test per input.
- Redaction: values reach run logs only through `RedactSecretValues` (`secret_injection.go:402`). Machine-side output that is projected (check logs, agent transcript) goes through it.
- `docs/api/openapi/repositories.yaml` secrets paths: confirm no response schema carries a value field.
- Docs: the Secrets page states that a secret is readable inside any session on any branch machine, and that main-only secrets are not.

## Tests

- unit (`packages/backend/internal/services/secret_machine_env_test.go`, new): for {item branch, scratch branch, agent run, outsider-started run, maintainer manual run on `main`}, only the last includes main-only rows. For every input, a secret with declared hosts appears in the relay policy and never in the env set.
- integration (real PostgreSQL, `secret_main_only_test.go` extended): a branch machine's env snapshot never contains a main-only name.
- integration (reference host, real microVM): sentinel values for an unbound all-branches secret, a host-bound all-branches secret, a main-only secret, a provider key and the App PEM. A scan of the guest filesystem, `/proc/*/environ` and `/run` finds only the unbound sentinel, and a request to the bound secret's host through the relay carries the bound value. This is C-SEC-01.
- integration (reference host, real microVM): replace a secret while a machine is awake. A session opened 5 s later sees the new value, and a session opened before keeps the old one (§8.8.1).
- e2e: C-MCH-07 (terminal, SSH session and a check step all see the unbound all-branches secret; no API response holds a value).

## Acceptance

- [C-MCH-07](../checks/C-MCH-07.md): all-branches secrets without declared hosts are present in every session and the coding host; values are never readable through the API.
- [C-SEC-01](../checks/C-SEC-01.md): provider keys, the App PEM and main-only secrets never appear in any branch machine.

## Risks and notes

- Any member can `printenv` a value in a session, by design (§8.8.1). The spec enforces write-only at the API (§5.2), and the docs say so plainly.
- The coding agent is in `team`, so it reads unbound all-branches secrets. An agent steered by issue text can exfiltrate them over open egress (§8.9). This is spec behavior (§8.8.1); declaring hosts on a secret is the mitigation, and the Secrets docs say so. Record it for the maintainer release's outsider rules.
- `/run/smithers/env` on a disk-backed `/run` would land in `capture()` or a disk clone. Confirmed by `findmnt /run`. Require tmpfs.

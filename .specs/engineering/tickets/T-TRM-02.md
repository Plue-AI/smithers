# T-TRM-02 Terminal auto sign-in and the Smithers skill on machines

Stage S1, S2 · Size S · Depends on S1: T-ACC-04, T-CAT-02 · S2: T-MCH-11, T-TRM-01, T-ACC-05 · S2: T-MCH-11, T-TRM-01, T-ACC-05 · Unblocks — · Issue: to file
Spec: spec.md §5.3, §5.3.2, §6.4, §8.11.1, §15.3, §17.2 · Delta: delta.md §5 (terminal auto sign-in row) · Product: mvp.md J6.1–J6.3, §6.13 CLI and Attribution, M-18, M-21

## Goal

A member who opens a terminal on a branch can run `claude` or `codex` there and use Smithers through the skill without logging in, and every action shows as "Ben via Claude Code".

## Scope

In:
- The host mints a `delegated(via=terminal)` credential for that member and branch only when the member opens a terminal (§5.3.2, §8.11.1). It expires with the session and is revoked when the session closes.
- S1 scope list (§8.11.1), enforced by `Authorize` (T-ACC-03), never by the CLI. Everything outside it, including drop, move, merge, confirmations, secrets and members, is refused with `403 {class: permission}`:
  - reads the member can do;
  - `todo.answer` and `todo.steer` on that branch's TODO only;
  - `todo.new`, append placement only;
  - wiki reads.
- The session environment gets `SMITHERS_TOKEN_FILE` and `SMITHERS_URL`. `SMITHERS_URL` is the backend as the guest reaches it: the bridge at guest `127.0.0.1:<backend port>` (`packages/backend/microsandbox/README.md` "bridge").
- The `smthrs` CLI gains a `SMITHERS_TOKEN_FILE` reader. None exists today: `packages/smithers/src/internal/backend/Session.ts` reads only `SMITHERS_TOKEN` (`:151`, `:346`), the keyring and the auth file. The file is read after `SMITHERS_TOKEN` and before the keyring.
- `Smithers-Via` from the environment (§6.4): `CLAUDECODE=1` gives `claude-code`, `CODEX_*` gives `codex`, otherwise the credential's `via`.
- The packaged linux-arm64 `smthrs` CLI is planted in every machine. The generated Smithers skill (T-CAT-02) is placed where Claude Code and Codex discover skills in the session's home.
- Stage 1 token path: `/run/smithers/sessions/<session id>/token`, mode 0600, owned by the session's unix user. In S1 terminals keep `msb exec -t` as the guest's single user, uid 1500 (§8.11.1).
- When T-MCH-11 lands, the path becomes `/run/smithers/<uid>/token`, owned by the member's uid with mode 0600 (§5.3.2). That move is required, not optional. Once the token is private to its member, the S1 list gives way to the catalog's `agent: run | confirm | never` rules that every delegated credential follows (§15.1.5), so a merge from the terminal opens the person's Review & merge confirmation.

Out:
- Per-member unix users and homes (T-MCH-11). Owner-only input (T-TRM-01).
- Person confirmations themselves (T-ACC-05).
- `via` badges in the UI (T-APP-09).
- A member's personal Claude or Codex subscription. They sign in with their own login in their own terminal (spec §15.2).

## Changes

- `packages/backend/internal/services/terminal_signin.go` (new): mint on terminal open through T-ACC-04's delegated issuer with the scope list above as the credential's `scopes[]` (§3), write the token through the guest helper, revoke on close, on member removal (§5.6) and on machine sleep.
- `packages/backend/internal/services/workspace_runtime.go:1084` `OpenWorkspaceTerminal`: pass the session environment. This is today's microVM terminal path through `msb exec -t` (`packages/backend/microsandbox/exec.go:597-627`). T-TRM-01 moves it to a daemon session (`open_session`, §9.1.2) in S2 and keeps this environment contract.
- `packages/backend/microsandbox/guest/smithers-guest.py`: a `put-token SESSION_ID USER` subcommand that writes the file with `O_CREAT|O_EXCL`, mode 0600, under `/run` (tmpfs).
- `packages/smithers/src/internal/backend/Session.ts`: a new `SMITHERS_TOKEN_FILE` branch beside `SMITHERS_TOKEN` at `:151` and `:346`. It re-reads the file on 401, since the file is replaced on rotation. The no-login error at `:377` names `SMITHERS_TOKEN_FILE` too. `logout` (`:413`) reports `env_active` for either variable.
- `packages/backend/internal/access/` (T-ACC-03's `Authorize`): the terminal scope list as one data table checked for `scopes[]` credentials, with a unit test per row.
- `apps/backend/isolation.go:147` `microVMConfig` `Artifacts` (same mechanism as `guestHostBundle`, `:145`): plant the packaged `smthrs` and the generated skill directory at `/opt/smithers/bin` and `/opt/smithers/skills`. The session start links the skill into the home.
- Docs: `packages/smithers/docs/` CLI auth page (`SMITHERS_TOKEN_FILE`); `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/smithers:docs`.

## Tests

- unit (`packages/smithers/test/BackendClientCredentials.test.ts`): precedence `SMITHERS_TOKEN` > `SMITHERS_TOKEN_FILE` > keyring > auth file; a rotated file is re-read after a 401; a missing or unreadable file gives a typed refusal, never a fallback to another identity.
- integration (real PostgreSQL): the minted credential has kind `delegated`, `via=terminal`, member, branch and the scope list. Every in-scope call succeeds and every out-of-scope call returns `403 permission`; it is revoked within 5 s of session close; no credential is minted for a machine with no open terminal. This is C-SEC-05.
- integration (reference host, real microVM): a terminal session runs `smthrs whoami` and gets Ben; with `CLAUDECODE=1` a TODO created through the CLI records `{person: Ben, via: "claude-code"}`.
- e2e: C-J6-01.

## Acceptance

- [C-J6-01](../checks/C-J6-01.md): S1 proves append-only scoped calls and typed scope refusals; S2 proves full delegation, after-placement confirmation, Review & merge and per-uid isolation. Each phase completes independently.
- [C-SEC-05](../checks/C-SEC-05.md): the stage-1 terminal token allows only its scope list; an agent-uid process holding it can't drop, reorder or merge.

## Risks and notes

- Stage 1 exposure (decided, §8.11.1): in S1 every terminal on a machine runs as the guest's single user, uid 1500 (`packages/backend/microsandbox/runtime.go:50-51`, `exec.go:207-208`), the same uid as the coding agent. So the coding agent and every other member's terminal on that branch can read Ben's token file and act as "Ben's terminal" within the scope list: reads, answer or steer on that branch's TODO, append a TODO and read the wiki. Never drop, reorder or merge. Confirmed by `cat /run/smithers/sessions/*/token` from a coding-agent step. The spec accepts this because the token exists only while a terminal is open, is limited to that list, and no release ships stage 1 alone.
- The token file must move to `/run/smithers/<uid>/token` in the same change that lands T-MCH-11. C-MCH-06 and C-J3-02 check that Alice and `agent` get `EACCES` on it.
- Spec gap: §16.1.1 doesn't list a linux-arm64 `smthrs` CLI in the guest image, but the skill calls `smthrs`. This ticket plants it (owner: tech lead adds it to §16.1.1 and T-INS-01's bundle).
- Risk: Claude Code or Codex moves its skill discovery directory. The integration test pins both directories and fails when an agent's discovery path changes.

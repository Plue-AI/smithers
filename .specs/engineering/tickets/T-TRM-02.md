# T-TRM-02 Terminal auto sign-in and the Smithers skill on machines

Stage S1, S2 · Size S · Depends on S1: T-ACC-04, T-CAT-02, T-INS-01, T-INS-02, T-ACC-06, T-APP-09 · S2: T-MCH-11, T-TRM-01, T-ACC-05, T-APP-04, T-COL-06 · Unblocks T-REL-02 · Issue: [#3537](https://github.com/smithersai/smithers/issues/3537)
Spec: spec.md §5.3, §5.3.2, §6.4, §8.11.1, §15.3, §17.2 · Delta: delta.md §5 (terminal auto sign-in row) · Product: mvp.md J6.1–J6.3, §6.13 CLI and Attribution, M-18, M-21

## Goal

A member who opens a terminal on a branch can run `claude` or `codex` there and use Smithers through the skill without logging in, and every action shows as "Claude Code for Ben".

## Scope
Approved integration requirements (In):
- Store terminal_s1 with member and branch for both actor fixtures. A person typing in their own terminal or CLI appends `todo.new` directly only with a person-bound credential whose stored kind is session, stored via is terminal or cli, and no agent session is bound. A delegated credential, including stored via terminal, cli, claude-code or codex, commits `todo.new` under A✓: return 202 with a private Confirm card for its person, and create no TODO until that person confirms from their own app session. If S1 has no Confirm-card path for this command, return HTTP 403, class `permission`, code `confirm_in_app`, message "Confirm in the app", with no TODO, confirmation row or other side effect. Stored credential kind and via decide the actor; client headers cannot select person authority or widen scope. Checks: C-SEC-05, C-J6-01, C-ACC-01.

In:
- The host mints separate person-session (via terminal) and delegated agent credentials for the member and branch on terminal open. Bind agent sessions to delegated credentials and issuer-stored via; never select kind from environment or headers. Both expire with the terminal session. Check: C-SEC-05.
- S1 scope list (§8.11.1), enforced by `Authorize` (T-ACC-03), never by the CLI. Everything outside it, including drop, move, merge, explicit confirmation creation, secrets and members, is refused with `403 {class: permission}`:
  - eligible non-private reads; no roster, secret names, install status, confirmations or personal view state;
  - question/conflict todo.answer and todo.steer on that branch's TODO only; no approval-kind answer;
  - `todo.new`, append placement only: person direct append; delegated private Confirm card or 403 permission/confirm_in_app without effects;
  - wiki reads.
- The session environment gets `SMITHERS_TOKEN_FILE` and `SMITHERS_URL`. `SMITHERS_URL` is the backend as the guest reaches it: the bridge at guest `127.0.0.1:<backend port>` (`packages/backend/microsandbox/README.md` "bridge").
- The `smthrs` CLI gains a `SMITHERS_TOKEN_FILE` reader. None exists today: `packages/smithers/src/internal/backend/Session.ts` reads only `SMITHERS_TOKEN` (`:151`, `:346`), the keyring and the auth file. The file is read after `SMITHERS_TOKEN` and before the keyring.
- `Smithers-Via` from the environment (§6.4): `CLAUDECODE=1` gives `claude-code`, `CODEX_*` gives `codex`, otherwise the credential's `via`. This is an attribution hint, not authority to select another person, branch, role or participant; the host resolves identity from authenticated context. A plain terminal command remains the person's terminal, not an inferred working agent (§14.6a, M-34).
- The packaged linux-arm64 `smthrs` CLI is planted in every machine. The generated Smithers skill (T-CAT-02) is placed where Claude Code and Codex discover skills in the session's home.
- Stage 1 token path: `/run/smithers/sessions/<session id>/token`, mode 0600, owned by the session's unix user. In S1 terminals keep `msb exec -t` as the guest's single user, uid 1500 (§8.11.1).
- When T-MCH-11 lands, the path becomes `/run/smithers/<uid>/token`, owned by the member's uid with mode 0600 (§5.3.2). That move is required, not optional. In S2 the delegated S1 list gives way to the catalog's `agent: run | confirm | never` rules that every delegated credential follows (§15.1.5), so a merge from the terminal opens the person's Review & merge confirmation.

Out:
- Per-member unix users and homes (T-MCH-11). Owner-only input (T-TRM-01).
- Person confirmations themselves (T-ACC-05).
- `via` badges in the UI (T-APP-09).
- A member's personal Claude or Codex subscription. They sign in with their own login in their own terminal (spec §15.2).
- Deferred credential-store carry between machines (product §16), SSH authentication, external-transcript import (T-AGT-01..03), participant Views and edits to catalog confirmation policy. This ticket consumes those contracts; it does not infer agent identity from process environment alone.

## Changes

- `packages/backend/internal/services/terminal_signin.go` (new): mint separate person and delegated credentials on terminal open, using T-ACC-04’s issuer for delegation with the scope list above as the credential's `scopes[]` (§3), write the token through the guest helper, revoke on close, on member removal (§5.6) and on machine sleep.
- `packages/backend/internal/services/workspace_runtime.go:1084` `OpenWorkspaceTerminal`: pass the session environment. This is today's microVM terminal path through `msb exec -t` (`packages/backend/microsandbox/exec.go:597-627`). T-TRM-01 moves it to a daemon session (`open_session`, §9.1.2) in S2 and keeps this environment contract.
- `packages/backend/microsandbox/guest/smithers-guest.py`: a `put-token SESSION_ID USER` subcommand that writes the file with `O_CREAT|O_EXCL`, mode 0600, under `/run` (tmpfs).
- `packages/smithers/src/internal/backend/Session.ts`: a new `SMITHERS_TOKEN_FILE` branch beside `SMITHERS_TOKEN` at `:151` and `:346`. It re-reads the file on 401, since the file is replaced on rotation. The no-login error at `:377` names `SMITHERS_TOKEN_FILE` too. `logout`'s return (`:413`) reports `env_active` for either variable.
- `packages/rpc/src/catalog/` and `packages/backend/internal/access/` (T-CAT-01 and T-ACC-03): encode the named `terminal_s1` scope profile in the shared catalog and enforce it through `Authorize` (§6.1.2c1). Do not create a second permission table. Each terminal scope is intersected with catalog actor eligibility and current member rights; tests pin allowed/denied outcomes independently of the runtime catalog.
- `apps/backend/isolation.go:147` `microVMConfig` `Artifacts` (same mechanism as `guestHostBundle`, `:145`): plant the packaged `smthrs` and the generated skill directory at `/opt/smithers/bin` and `/opt/smithers/skills`. The session start links the skill into the home.
- Bundle follow-up owned here: extend T-INS-01's `apps/app/scripts/build-server-bundle.ts` (new there) to include the linux-arm64 `smthrs` executable and T-CAT-02's generated skill with hashes in `manifest.json`. This ticket plants those declared artifacts; it refuses a missing or wrong-architecture artifact rather than using a laptop CLI.
- Docs: `packages/smithers/docs/` CLI auth page (`SMITHERS_TOKEN_FILE`); `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/smithers:docs`.

## Tests
- S1 person append creates one TODO and zero confirmations. Delegated append creates one private Confirm card and no TODO until app confirmation, or returns exact 403 permission/confirm_in_app, "Confirm in the app", without effects if the card path is absent. Non-append, explicit create and approval-kind answer=403 permission/permission. Forged headers cannot change either actor. Close=401 permission/unauthenticated; physical revocation ≤5 s. S2 delegated todo.new uses ordinary 202. Check: C-SEC-05.

- unit (`packages/smithers/test/BackendClientCredentials.test.ts`): precedence `SMITHERS_TOKEN` > `SMITHERS_TOKEN_FILE` > keyring > auth file; a rotated file is re-read after a 401; a missing or unreadable file gives a typed refusal, never a fallback to another identity.
- integration (real PostgreSQL): inspect separate person session via terminal and delegated agent credentials, stored member, branch, profile and via. Exercise both actor paths through the real TODO route, including the missing-card refusal. No environment/header change converts delegated to person. Revoke both within 5 s of close; mint none without an open terminal. Check: C-SEC-05.
- integration (reference host, real microVM): a terminal session runs `smthrs whoami` and gets Ben; an agent session uses a delegated credential with stored via claude-code and creates no TODO before Ben confirms its private card. The confirmed TODO records Ben and the Claude Code participant. Check: C-J6-01.
- boundary integration, C-SEC-05: open and close through the production authenticated terminal route (`packages/backend/internal/compose/router.go:818` today), not a direct mint helper. Invoke the packaged guest `smthrs` and generated skill against the production router/catalog/Authorize path; independently inspect rows and refusal side effects. Repeat token reuse after close, member removal and machine sleep. Never expose token bytes in evidence.
- boundary integration, S2: `C-J6-01` exercises real daemon terminals and the installed person Confirm/Review & merge consumer; no delegated token can approve. A same-uid second terminal and token rotation must not let a closed session's credential become valid again.
- Oracle: literal precedence, status codes, scope outcomes, owner/mode and fixed TODO order in test fixtures, not expectations generated from spec files, the runtime catalog or authorizer. Authentication uses the catalog at runtime; test expectations remain independent.
- e2e: C-J6-01.

## Acceptance

- [C-J6-01](../checks/C-J6-01.md): S1 proves append-only scoped calls and typed scope refusals; S2 proves full delegation, after-placement confirmation, Review & merge and per-uid isolation. Each phase completes independently.
- [C-SEC-05](../checks/C-SEC-05.md): the stage-1 terminal token allows only its scope list; an agent-uid process holding it can't drop, reorder or merge.

## Risks and notes

- Stage 1 exposure (decided, §8.11.1): in S1 every terminal on a machine runs as the guest's single user, uid 1500 (`packages/backend/microsandbox/runtime.go:50-51`, `exec.go:207-208`), the same uid as the coding agent. So the coding agent and every other member's terminal on that branch can read Ben's token file and act as "Ben's terminal" within the scope list: reads, answer or steer on that branch's TODO, request an append through a private Confirm card, or receive 403 permission/confirm_in_app if S1 has no card path, and read the wiki. The readable guest token is delegated; never place the direct-append person credential in this shared file. Check: C-SEC-05. Never drop, reorder or merge. Confirmed by `cat /run/smithers/sessions/*/token` from a coding-agent step. The spec accepts this because the token exists only while a terminal is open, is limited to that list, and no release ships stage 1 alone.
- The token file must move to `/run/smithers/<uid>/token` in the same change that lands T-MCH-11. C-MCH-06 and C-J3-02 check that Alice and `agent` get `EACCES` on it.
- §16.1.1 already requires the linux-arm64 `smthrs` CLI and skill in the guest image. This ticket owns the assembler follow-up and runtime planting. smithers-b8 approves the bundle/CLI seam and smithers-3f approves guest placement before start; no edit to frozen T-INS-01 is needed.
- Risk: Claude Code or Codex moves its skill discovery directory. The integration test pins both directories and fails when an agent's discovery path changes.

## Ready checklist

1. Dependencies: S1 lists delegation/catalog plus the hashed bundle, microVM launcher, member revocation and actor adapter; S2 lists private member users, daemon terminals, person confirmations with their installed consumer and participant presence. The linux CLI/skill assembler follow-up belongs to this ticket after T-INS-01.
2. Exclusions: personal vendor sign-in, cross-machine credential store, SSH auth, transcript import, Views and catalog policy redesign are explicit.
3. Boundary tests: C-SEC-05 opens/closes the real terminal route and calls the packaged guest CLI/skill through router/catalog/Authorize. C-J6-01 proves S1 scopes and S2 private-token/full-delegation/confirmation behavior separately. Literal expected statuses, identity/mode and stack order are independent of spec files and runtime implementation/catalog values.
4. Decisions: smithers-b8 accepts bundle/CLI/skill behavior and discovery fixtures; smithers-38 signs Session.ts public API changes under §21.1; smithers-3f accepts mint/revoke/guest seams. smithers-8a accepts the session-lifetime/rotation contract; Will alone changes the accepted S1 exposure or product delegation.
5. Owner pre-review: smithers-b8, smithers-38 and smithers-3f before each phase starts. Are the linux CLI and generated skill hashed bundle artifacts and discovered without a manual install? Do file precedence, rotation and 401 handling fail closed without switching identities? Do close/removal/sleep revoke the right session, including concurrent same-uid terminals, while S2 token paths and confirmation approvals remain private?
6. Security: smithers-3f reviews token lifecycle and machine execution before start. Claude Code, Codex, CLI skill commands and repository code run only in machines; the host only authorizes, mints, dispatches and packages. S1's documented uid-1500 exposure is limited to its exact allowlist; S2 moves the token to member uid 0600 before enabling full delegation. Guest token creation rejects traversal/symlink paths, logs redact credentials, environment via hints confer no authority, and no member/agent sudo or provider keys enter guests. C-SEC-05 and C-J6-01 prove the phase boundaries.

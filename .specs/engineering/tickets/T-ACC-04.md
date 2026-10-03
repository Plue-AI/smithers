# T-ACC-04 Delegated credentials with `via`; `smthrs login --agent`; attribution

Stage S1 · Size M · Depends on T-ACC-03, T-ACC-02, T-INS-04 · Unblocks T-ACC-05, T-ACC-06, T-APP-09, T-APP-23, T-CAT-02, T-COL-02, T-GH-04, T-REL-02, T-STK-04, T-STK-07, T-TRM-02 · Issue: [#3493](https://github.com/smithersai/smithers/issues/3493)
Spec: spec.md §5.3, §5.3.1, §6.4, §2 (actor notation), §15.1.1, §15.1.4, §15.3 · Delta: delta.md §2 (Add `delegated` + `via`; Add actor `via` on audit) · Product: mvp.md J6.3–J6.4, §6.13 "CLI", "Attribution", M-21, Appendix A closing note

## Goal
`smthrs login <install origin>` (and `--agent claude-code`) yields a `delegated` credential that acts as the member under the `agent: run | confirm | never` rules. App-agent turns get the same kind of credential, minted on the host and never sent to a browser. Every write made with one is recorded as "Claude Code for Ben" or "Ben via Smithers".

## Scope
Approved integration requirements (In):
- The issuer binds delegated actor class to the stored credential: `smithers` is app_agent; `cli`, `claude-code`, `codex` and `terminal` are external_agent. Unknown issuer actor classes are refused. `Smithers-Via` is attribution only and cannot alter that binding or scope profile. Mint immutable credential identity and stored class/profile. Legacy sync/platform kinds have no implicit install authority. Checks: C-ACC-01, C-ACC-02, C-SEC-05.
In:
- `kind` and `via` stored on every non-session token.
- `smthrs login <install origin>` always mints `delegated`, for any origin the owner configured (http or https). `via` defaults to `cli`; `--agent <name>` sets it (§5.3.1).
- The `Smithers-Via` header: the CLI sets it from the environment, and the host records `via` with the credential first (§6.4).
- One actor resolver producing `{person, via?, session?}` / `{agent: "coding", run}` (§2) for audit and for every event writer that adopts it.
- A host-side minting API for the other doors:
  - `delegated(via=smithers)` per app-agent turn for the prompt's author (§15.1.1, §15.1.4). The host turn runner holds it in memory for the turn and revokes it at the turn's end; it never reaches a browser. T-APP-23 moves turns and command dispatch onto the host and uses it.
  - `delegated(via=terminal)` for T-TRM-02.
- The browser holds only its `session` cookie. Every request from a browser is a person's request; no bearer rides beside the cookie, and the server never has to choose between two credentials on one request.
- SG-02 (security, tech lead 2026-10-02 18:01): issue a person-bound session credential with stored via `terminal` or `cli` only to a person typing with no agent session; issue a delegated credential, with issuer-bound stored via, to every agent session. Never take kind or authority from `Smithers-Via`, environment flags or client actor assertions, and never place the person direct-append credential in the S1 shared guest token file. Checks: C-SEC-05, C-J6-01.

Out:
- Confirmations and per-command `agent` dispatch (§15.1.5, T-ACC-05).
- The host turn runner and the live-channel UI-only instructions (T-APP-23); context preflight (T-APP-17).
- Terminal auto sign-in files (T-TRM-02).
- Rendering "via" badges (T-APP-09).
- Presence and activity actors (S2: T-COL-04, T-COL-06).

## Changes
- `packages/backend/db/product/migrations/01NN_credential_kind.sql` (new) on `access_tokens` (`0001_product_baseline.sql:1536`).
  - Stores delegated/run/machine token kinds and via; the classifier also admits session cookies and memberless setup. Legacy sync/platform storage keeps compatibility but no implicit install authority. Check: C-ACC-01.
  - Backfill: user-created tokens become `delegated`/`cli`; `system_issued` tokens become `run`, `sync` or `machine` by scopes (`0021_oauth2_grant_source.sql:14`).
  - Spec §3 names the logical table `credentials`. This ticket reshapes `access_tokens` in place and adds no parallel table.
- `packages/backend/internal/middleware/run_credential.go:62-77`: `TokenCredentialKind` reads the stored kind. A token is never `person`; only a session is.
- `packages/backend/internal/routes/auth.go:482-500` (`completeCLIOAuth`) and the `/api/auth/github/cli` start (`compose/router.go:932`):
  - accept `agent` (`[a-z0-9-]{1,32}`);
  - mint `delegated(via)`;
  - never include an approval scope. `ExchangeGitHubToken` (`services/auth.go:804-806`) does the same in install mode.
  - `POST /api/user/tokens` (`router.go:1565`) mints `delegated(via=cli)`.
- `packages/backend/internal/services/delegated_mint.go` (new): `MintForTurn(member, conversation)` and `MintForTerminal(member, branch)`, each with a TTL and revocation, callable only from host code (no HTTP route).
- `packages/backend/internal/actor/actor.go` (new): `FromRequest(ctx)` → actor JSON. It resolves `via` from the credential first, then from the header; a session ignores the header.
- `packages/backend/internal/services/audit.go:24-77`: `AuditEvent.Via`, with a migration adding `audit_log.via` (`0001_product_baseline.sql:1907`). `routes/auth.go` audit calls use `actor.FromRequest`.
- CLI:
  - `packages/smithers/src/internal/backend/Auth.ts:100-170` adds `login --agent <name>`.
  - `Client.ts` sends `Smithers-Via` from the environment: `CLAUDECODE=1` → `claude-code`, `CODEX_*` → `codex`, else none.
  - `Session.ts:343-370` keeps its resolution order.
- OpenAPI: `authentication.yaml` documents `agent` on `/api/auth/github/cli` and the `Smithers-Via` header. `user.yaml` documents the token's `kind`/`via`.
- Docs: `packages/smithers/docs/` login page covers `--agent`. Run `pnpm docs:sync`, `pnpm docs:check` and `smthrs docs //packages/smithers:docs`.

## Tests
- Boundary: `compose/delegated_credential_integration_test.go` drives the actual composed OAuth start/callback, token exchange and `POST /api/user/tokens`, then sends the issued bearer through production command dispatch and reads persisted audit rows. CLI cases invoke the registered `smthrs login --agent` command through `makeCli`, not only an option parser. Use committed literal credential kinds, via values, response envelopes and audit fields; no runtime spec, catalog or implementation-derived oracle. T-APP-23 must prove turn-end revocation through its real runner; this ticket proves the mint/revoke API and that no HTTP route exposes a turn bearer.
- Forge attribution headers without changing class/profile/scope. Equal class/profile/role/subject gives equal decisions; app-only terminal and external-only source co-edit differ. Replacement/session/delegated identities with equal member/key cannot reuse results. Inactive holders=401 permission/unauthenticated. Checks: C-ACC-01, C-ACC-02, C-SEC-05.
- Integration, real PostgreSQL: `compose/delegated_credential_integration_test.go` (new).
  - The CLI OAuth flow with `agent=claude-code` stores `kind=delegated, via=claude-code`.
  - The token calls a `todo.write` route that runs at once (for example a steer), and the audit row reads person=Ben, via=claude-code.
  - Eligible delegated Merge=202 confirmation/state, no merge; eligible member write=403 never/never; role/scope failure=403 permission/permission; missing consumer=503 infra/confirmation_unavailable. Checks: C-ACC-01, C-ACC-02.
  - A forged `Smithers-Via: codex` header on a `claude-code` token still records `claude-code`.
  - `MintForTurn` yields `via=smithers`; the token stops working when the turn ends; no HTTP route returns it.
- Unit (app): `apps/app/src/mainview/runtime/ApplicationClient.test.ts` asserts that no app request sends an `Authorization` header; app requests carry only the session cookie.
- Unit: `actor/actor_test.go`, covering the credential-first precedence table and session-ignores-header.
- Unit (CLI): `packages/smithers/test/BackendCommands.test.ts` covers the `--agent` option and the header derived from the environment.
- Migration test: the backfill classifies a seeded user PAT, a run token and a workspace token correctly.

## Acceptance



- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-ACC-02](../checks/C-ACC-02.md): delegated credentials can't merge or approve.
- [C-J6-02](../checks/C-J6-02.md): laptop `smthrs login` gets a delegated credential (the merge-confirmation half needs T-ACC-05).
- [C-ACC-01](../checks/C-ACC-01.md): Every permission-matrix row is enforced server-side for every credential kind

## Risks and notes
- Decisions before start: smithers-3f approves credential backfill, active-member checks, TTL/revoke semantics and install/Plue isolation; smithers-b8 approves OAuth/header/OpenAPI/CLI contracts; smithers-38 approves the actor and client-library seams. smithers-8a accepts shared contracts. No new credential privileges are an implementation choice.
- Security: mint only for an active member; bind terminal credentials to member and branch with the S1 scope restriction (§5.3.2), and keep turn bearers host-only. This ticket launches no repository code. Any terminal or run using a bearer still requires §1.3/M-29 machine confinement. smithers-3f reviews scopes, revocation and bearer/cookie precedence (C-ACC-01, C-ACC-02, C-SEC-05).
- Today an agent-driven `/merge` runs in the browser with the session cookie (`apps/app/src/mainview/runtime/ApplicationClient.test.ts:45` `credentials: "include"`) and acts as the person. T-APP-23 must move dispatch onto the host with `MintForTurn`; the full app-agent C-ACC-02 row remains pending until that real runner lands.
- Keep install-mode delegated classification separate from Plue’s existing PAT authority. smithers-3f approves the shared-schema migration and smithers-8a accepts any cross-composition seam; Will must approve any product-policy change before Plue behavior changes. Existing Plue regression fixtures must retain their outcomes (C-ACC-01).
- C-ACC-01's delegated column passes only once this ticket mints delegated tokens.
- `smthrs auth login --admin` tokens (`packages/smithers/src/internal/backend/Auth.ts:120-125`) serve Plue operators. They're out of scope; `/api/admin/*` isn't mounted on the install (T-CUT-02).

## Ready checklist
1. Dependencies: T-ACC-03 supplies fail-closed authorization, T-ACC-02 active-member status and revocation seam, T-INS-04 real configured-origin OAuth. Confirmations, turn runner and terminal token installation remain downstream.
2. Exclusions: confirmation storage/dispatch, host turns, context preflight, terminal files, actor views, presence and Plue admin tokens are explicit; Plue PAT policy changes require a separate decision.
3. Tests: real OAuth/token routes and production dispatcher, registered login command and audit persistence use fixed outcomes. Turn-runner lifetime cases remain pending for T-APP-23; no runtime spec or code oracle.
4. Decisions: smithers-3f credential/schema/TTL/scopes, smithers-b8 public CLI/API, smithers-38 library seams, smithers-8a cross-composition contracts; Will alone decides product-policy changes.
5. Owner pre-review before start: smithers-3f: Does backfill preserve Plue and restrict install tokens? Are active-member, branch scope, TTL and revocation enforced? smithers-b8: Do login, header and API contracts keep bearers out of browsers? smithers-38: Do actor/client consumers use one credential-first attribution contract?
6. Security: no repository execution added; terminal/run consumers require §1.3/M-29 machines. smithers-3f reviews host-only turn minting, narrowed S1 terminal scopes and credential precedence under C-ACC-01/C-ACC-02/C-SEC-05.

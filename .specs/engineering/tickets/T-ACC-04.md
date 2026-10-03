# T-ACC-04 Delegated credentials with `via`; `smthrs login --agent`; attribution

Stage S1 · Size M · Depends on T-ACC-03, T-ACC-02 · Unblocks T-APP-04, T-APP-09, T-APP-16, T-GH-04, T-REL-02, T-STK-04, T-TRM-02 · Issue: [#3493](https://github.com/smithersai/smithers/issues/3493)
Spec: spec.md §5.3, §5.3.1, §6.4, §2 (actor notation), §15.1.1, §15.1.4, §15.3 · Delta: delta.md §2 (Add `delegated` + `via`; Add actor `via` on audit) · Product: mvp.md J6.3–J6.4, §6.13 "CLI", "Attribution", M-21, Appendix A closing note

## Goal
`smthrs login <install origin>` (and `--agent claude-code`) yields a `delegated` credential that acts as the member under the `agent: run | confirm | never` rules. App-agent turns get the same kind of credential, minted on the host and never sent to a browser. Every write made with one is recorded as "Claude Code for Ben" or "Smithers for Ben".

## Scope
In (adopted owner pre-review):
- Lands before T-INS-04 (tech lead 2026-10-02, edge cut): ACC-04 lands stored-kind migration, attribution and host mint/revoke APIs against ACC-03/02. Install OAuth start/callback, exchange and public minting remain unmounted or return **503 infra/credential_issuer_unavailable** before cookies, token mint or disclosure unless the INS-04 effective-origin provider is installed. This code is a proposed new refusal contract, requiring the named API owner's review. Never fall back to the old global-origin middleware. INS-04 integration then wires the provider and runs the actual configured-origin OAuth/login matrix before enabling those routes.; its integration test with T-INS-04 runs after T-INS-04 lands and gates C-ACC-01 and C-J6-02 (S1 configured-origin credential exit).
- Extend `TokenCredentialKind` in `middleware/run_credential.go`: issuer-bound `via:<name>` is a scope entry; system-issued plus via classifies delegated. Install user-created PATs are delegated/cli. Preserve run/machine subject bindings and Plue classification; unknown install bindings fail closed. No schema migration.
- CLI credentials expire in 30 days; turn/terminal credentials in 1 hour. Renewal rechecks active membership and subject. Revoke on completion, close or suspension within 5 s; no renewal outlives its subject. Check: C-ACC-01.
- `packages/backend/internal/routes/auth.go:482-500` (`completeCLIOAuth`) and the `/api/auth/github/cli` start (`compose/router.go:932`):
  - accept `agent` (`[a-z0-9-]{1,32}`);
  - mint `delegated(via)`;
  - never include an approval scope. `ExchangeGitHubToken` (`services/auth.go:804-806`) does the same in install mode.
  - `POST /api/user/tokens` (`router.go:1565`) mints `delegated(via=cli)`.
- Add `MintForTurn` and `MintForTerminal` to the existing token service with TTL and revocation; host-only functions, no new route.
- Define `FromRequest` beside `AuditEvent`; resolve via from issuer-bound scopes, never from a client authority assertion.
- Write via in `AuditEvent.Metadata` (`audit.go:24–34`); no audit migration.
- CLI:
  - `packages/smithers/src/internal/backend/Auth.ts:100-170` adds `login --agent <name>`.
  - `Client.ts` sends `Smithers-Via` from the environment: `CLAUDECODE=1` → `claude-code`, `CODEX_*` → `codex`, else none.
  - `Session.ts:343-370` keeps its resolution order.
- OpenAPI: `authentication.yaml` documents `agent` on `/api/auth/github/cli` and the `Smithers-Via` header. `user.yaml` documents the token's `kind`/`via`.
- Docs: `packages/smithers/docs/` login page covers `--agent`. Run `pnpm docs:sync`, `pnpm docs:check` and `smthrs docs //packages/smithers:docs`.

## Tests
- Through production OAuth/token, command and Git HTTP routes with real PostgreSQL, migrate identical pre-existing install and Plue PAT fixtures. Install PATs lose approval authority; Plue fixtures retain their prior outcomes. Send expired, revoked, inactive-member and wrong-branch credentials and assert typed refusals before writes. Exercise turn completion/cancellation, terminal close and suspension/removal, measuring revocation and testing replacement identity isolation. Check: C-ACC-01.

- Boundary: `compose/delegated_credential_integration_test.go` drives the actual composed OAuth start/callback, token exchange and `POST /api/user/tokens`, then sends the issued bearer through production command dispatch and reads persisted audit rows. CLI cases invoke the registered `smthrs login --agent` command through `makeCli`, not only an option parser. Use committed literal credential kinds, via values, response envelopes and audit fields; no runtime spec, catalog or implementation-derived oracle. T-APP-16 must prove turn-end revocation through its real runner; this ticket proves the mint/revoke API and that no HTTP route exposes a turn bearer.
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
- [C-J6-02](../checks/C-J6-02.md): laptop `smthrs login` gets a delegated credential (the merge-confirmation half needs T-APP-04).
- [C-ACC-01](../checks/C-ACC-01.md): Every permission-matrix row is enforced server-side for every credential kind

## Risks and notes
- Decisions before start: smithers-3f approves credential backfill, active-member checks, TTL/revoke semantics and install/Plue isolation; smithers-b8 approves OAuth/header/OpenAPI/CLI contracts; smithers-38 approves the actor and client-library seams. smithers-8a accepts shared contracts. No new credential privileges are an implementation choice.
- Security: mint only for an active member; bind terminal credentials to member and branch with the S1 scope restriction (§5.3.2), and keep turn bearers host-only. This ticket launches no repository code. Any terminal or run using a bearer still requires §1.3/M-29 machine confinement. smithers-3f reviews scopes, revocation and bearer/cookie precedence (C-ACC-01, C-ACC-02, C-SEC-05).
- Today an agent-driven `/merge` runs in the browser with the session cookie (`apps/app/src/mainview/runtime/ApplicationClient.test.ts:45` `credentials: "include"`) and acts as the person. T-APP-16 must move dispatch onto the host with `MintForTurn`; the full app-agent C-ACC-02 row remains pending until that real runner lands.
- Keep install-mode delegated classification separate from Plue’s existing PAT authority. smithers-3f approves the shared-schema migration and smithers-8a accepts any cross-composition seam; Will must approve any product-policy change before Plue behavior changes. Existing Plue regression fixtures must retain their outcomes (C-ACC-01).
- C-ACC-01's delegated column passes only once this ticket mints delegated tokens.
- `smthrs auth login --admin` tokens (`packages/smithers/src/internal/backend/Auth.ts:120-125`) serve Plue operators. They're out of scope; `/api/admin/*` isn't mounted on the install (T-CUT-02).

## Ready checklist
1. Dependencies: T-ACC-03 supplies fail-closed authorization, T-ACC-02 active-member status and revocation seam. Confirmations, turn runner and terminal token installation remain downstream. Landing condition for the T-INS-04 edge cut: ACC-04 lands stored-kind migration, attribution and host mint/revoke APIs against ACC-03/02. Install OAuth start/callback, exchange and public minting remain unmounted or return **503 infra/credential_issuer_unavailable** before cookies, token mint or disclosure unless the INS-04 effective-origin provider is installed. This code is a proposed new refusal contract, requiring the named API owner's review. Never fall back to the old global-origin middleware. INS-04 integration then wires the provider and runs the actual configured-origin OAuth/login matrix before enabling those routes.; its integration test with T-INS-04 runs after T-INS-04 lands and gates C-ACC-01 and C-J6-02 (S1 configured-origin credential exit).
2. Exclusions: confirmation storage/dispatch, host turns, context preflight, terminal files, actor views, presence and Plue admin tokens are explicit; Plue PAT policy changes require a separate decision.
3. Tests: real OAuth/token routes and production dispatcher, registered login command and audit persistence use fixed outcomes. Turn-runner lifetime cases remain pending for T-APP-16; no runtime spec or code oracle.
4. Decisions: smithers-3f credential/schema/TTL/scopes, smithers-b8 public CLI/API, smithers-38 library seams, smithers-8a cross-composition contracts; Will alone decides product-policy changes.
5. Owner pre-review before start: smithers-3f: Does backfill preserve Plue and restrict install tokens? Are active-member, branch scope, TTL and revocation enforced? smithers-b8: Do login, header and API contracts keep bearers out of browsers? smithers-38: Do actor/client consumers use one credential-first attribution contract? smithers-3f: answered, BLOCKING edits applied (tech lead adopts). smithers-b8: answered 18:23, ok.
6. Security: no repository execution added; terminal/run consumers require §1.3/M-29 machines. smithers-3f reviews host-only turn minting, narrowed S1 terminal scopes and credential precedence under C-ACC-01/C-ACC-02/C-SEC-05.

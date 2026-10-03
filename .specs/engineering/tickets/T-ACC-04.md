# T-ACC-04 Delegated credentials with `via`; `smthrs login --agent`; attribution

Stage S1 · Size M · Depends on T-ACC-03, T-ACC-02 · Unblocks T-APP-01, T-APP-04, T-APP-09, T-APP-16, T-GH-04, T-MNT-01, T-MNT-03, T-REL-02, T-STK-04, T-TRM-02 · Issue: [#3493](https://github.com/smithersai/smithers/issues/3493)
Spec: spec.md §5.3, §5.3.1, §6.4, §2 (actor notation), §15.1.1, §15.1.4, §15.3 · Delta: delta.md §2 (Reshape existing PAT classification and actor attribution) · Product: mvp.md J6.3–J6.4, §6.13 "CLI", "Attribution", M-21, Appendix A closing note

## Goal
`smthrs login <install origin>` (and `--agent claude-code`) yields a `delegated` credential that acts as the member under the `agent: run | confirm | never` rules. App-agent turns get the same kind of credential, minted on the host and never sent to a browser. Every write made with one is recorded as "Claude Code for Ben" or "Smithers for Ben".

## Scope
In (adopted owner pre-review):
- Land dark against the T-ACC-03 authorization and T-ACC-02 active-member/revocation contracts. Until both providers are installed, keep install delegated issuance and bearer dispatch unmounted or refused before token mint, disclosure or effects; never use legacy person-PAT authority as a fallback. Enable only after the production missing-provider and installed-provider cases in C-ACC-01 pass.
- Preserve the adopted T-INS-04 edge cut: install OAuth start/callback, exchange and public minting stay unmounted or return **503 infra/credential_issuer_unavailable** before cookies, token mint or disclosure until the effective-origin provider is installed. Never fall back to global-origin middleware. smithers-b8 reviews this proposed refusal contract and smithers-8a accepts the seam. T-INS-04 integration runs the configured-origin OAuth/login matrix before enabling the routes; it gates C-ACC-01 and C-J6-02.
- Extend `TokenCredentialKind` in `middleware/run_credential.go`: issuer-bound `via:<name>` is a scope entry; system-issued plus via classifies delegated. Install user-created PATs are delegated/cli. Preserve run/machine subject bindings and Plue classification; unknown install bindings fail closed. No schema migration.
- CLI credentials expire in 30 days; turn/terminal credentials in 1 hour. Renewal rechecks active membership and subject. Revoke on completion, close or suspension within 5 s; no renewal outlives its subject. Check: C-ACC-01.
- `packages/backend/internal/routes/auth.go:482-500` (`completeCLIOAuth`) and the `/api/auth/github/cli` start (`compose/router.go:944`):
  - accept `agent` (`[a-z0-9-]{1,32}`) as an external-agent label; only host-only turn minting may bind app_agent. Public `agent=smithers`, scopes or headers cannot select app_agent or a terminal profile. Check: C-ACC-01;
  - mint `delegated(via)`;
  - never include an approval scope. `ExchangeGitHubToken` (`services/auth.go:807-815`) does the same in install mode.
  - `POST /api/user/tokens` (`compose/router.go:1577`) mints `delegated(via=cli)`.
- Reshape `services/auth.go:1007` (`CreateToken`) and `:1062` (`DeleteToken`) for issuer-bound scopes, TTL and revocation. Add host-only `MintForTurn` and `MintForTerminal` wrappers, no new route. Reuse the existing mint, expiry and revoke paths; the wrappers add subject/lifetime bindings those generic methods do not enforce. Check: C-ACC-01.
- Reshape the existing request credential context and `services/audit.go:24` (`AuditEvent`) with a `FromRequest` helper; reuse authenticated identity and stored scopes instead of a new actor package. Resolve via from issuer-bound scopes, never from a client authority assertion. Carry that actor into existing audit, activity and item-event writes. Check: C-ACC-01.
- Write via in `AuditEvent.Metadata` (`audit.go:24–34`); no audit migration.
- CLI:
  - `packages/smithers/src/internal/backend/Auth.ts:56-142,164-180` reshapes browser login for `login --agent <name>`.
  - `Client.ts` sends `Smithers-Via` from the environment: `CLAUDECODE=1` → `claude-code`, `CODEX_*` → `codex`, else the stored credential via (§6.4).
  - `Session.ts:343-370` keeps its resolution order.
- OpenAPI: reshape `docs/api/openapi/authentication.yaml:116` for `agent` on `/api/auth/github/cli` and the `Smithers-Via` header; `docs/api/openapi/user.yaml` documents the token's derived `kind`/`via`. No stored kind column or new credential table.
- Docs: `packages/smithers/docs/` login page covers `--agent`. Run `pnpm docs:sync`, `pnpm docs:check` and `smthrs docs //packages/smithers:docs`.

Out: confirmation storage, dispatch consumers and approval (T-APP-04); the host turn runner and browser-tool relocation (T-APP-16); context preflight (T-APP-17); terminal token files and guest installation (T-TRM-02); actor views and presence (T-APP-09, T-COL-06); Plue admin tokens and Plue PAT policy; new credential/actor tables, schema migration and a separate actor library.

## Changes
Reshape the existing middleware, auth routes/service, audit service, CLI Auth/Client/Session and OpenAPI files named above. Reuse `packages/rpc/src/CardPrimitives.ts` actor/via contracts; make `packages/rpc/src/MembersCard.ts:23` consume the shared member-role schema instead of its inline enum (delta.md §2). Preserve already consolidated schemas. smithers-38 approves these library contracts. Check: C-ACC-01.

## Tests
- Through production OAuth/token, command and Git HTTP routes with real PostgreSQL, load identical pre-existing install and Plue PAT fixtures and exercise the reshaped classification without a backfill or schema migration. Install PATs lose approval authority; Plue fixtures retain their prior outcomes. Send expired, revoked, inactive-member and wrong-branch credentials and assert typed refusals before writes. Exercise turn completion/cancellation, terminal close and suspension/removal, measuring revocation and testing replacement identity isolation. Check: C-ACC-01.

- Boundary: `compose/delegated_credential_integration_test.go` drives the actual composed OAuth start/callback, token exchange and `POST /api/user/tokens`, then sends the issued bearer through production command dispatch and reads persisted audit rows. CLI cases invoke the registered `smthrs login --agent` command through `makeCli`, not only an option parser. Use committed literal credential kinds, via values, response envelopes and audit fields; no runtime spec, catalog or implementation-derived oracle. T-APP-16 must prove turn-end revocation through its real runner; this ticket proves the mint/revoke API and that no HTTP route exposes a turn bearer.
- Forge attribution headers without changing class/profile/scope. Equal class/profile/role/subject gives equal decisions; app-only terminal and external-only source co-edit differ. Replacement/session/delegated identities with equal member/key cannot reuse results. Inactive holders=401 permission/unauthenticated. Checks: C-ACC-01, C-ACC-02, C-SEC-05.
- Integration, real PostgreSQL: `packages/backend/internal/compose/delegated_credential_integration_test.go` (new). Existing service-only `services/auth_token_exchange_test.go` and route-only `routes/auth_token_exchange_test.go` cannot prove composed OAuth, dispatch and persisted attribution together; retain them and add this boundary test. Remove each ACC-02/03 and effective-origin provider in isolation: assert no mint, disclosure, write or outbound call through production routes. Checks: C-ACC-01, C-J6-02.
  - The CLI OAuth flow with `agent=claude-code` stores issuer-bound via scopes on `access_tokens`; inspecting those fields yields literal `kind=delegated, via=claude-code`, without a stored kind column.
  - The token calls a `todo.write` route that runs at once (for example a steer), and the audit row reads person=Ben, via=claude-code.
  - Eligible delegated Merge=202 confirmation/state, no merge; eligible member write=403 never/never; role/scope failure=403 permission/permission; missing consumer=503 infra/confirmation_unavailable. Checks: C-ACC-01, C-ACC-02.
  - A forged `Smithers-Via: codex` header on a `claude-code` token still records `claude-code`.
  - `MintForTurn` yields `via=smithers`; the token stops working when the turn ends; no HTTP route returns it.
- Unit (app): extend the existing literal install-browser cases in `apps/app/src/mainview/runtime/ApplicationClient.test.ts:45-51` to assert cookie-only requests and no turn bearer. Preserve separate Plue and native auth fixtures.
- Unit: extend existing `packages/backend/internal/middleware/run_credential_test.go` and `packages/backend/internal/services/audit_test.go` for credential-first precedence and session-ignores-header; no new actor package.
- Unit (CLI): `packages/smithers/test/BackendCommands.test.ts` covers the `--agent` option and the header derived from the environment.
- Classification regression: existing user PAT, run token and workspace token fixtures retain subject bindings; install PATs classify delegated/cli without a migration. Assert public agent/scopes/header inputs cannot acquire host app_agent authority or terminal profiles. Check: C-ACC-01.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-ACC-02](../checks/C-ACC-02.md): delegated credentials can't merge or approve.
- [C-J6-02](../checks/C-J6-02.md): laptop `smthrs login` gets a delegated credential (the merge-confirmation half needs T-APP-04).
- [C-ACC-01](../checks/C-ACC-01.md): Every permission-matrix row is enforced server-side for every credential kind

## Risks and notes
- Decisions before start: smithers-3f approves existing-PAT classification, active-member checks, TTL/revoke semantics and install/Plue isolation; smithers-b8 approves OAuth/header/OpenAPI/CLI contracts; smithers-38 approves the actor and client-library seams. smithers-8a accepts shared contracts. No new credential privileges are an implementation choice.
- Security: mint only for an active member; bind terminal credentials to member and branch with the S1 scope restriction (§5.3.2), and keep turn bearers host-only. This ticket launches no repository code. Any terminal or run using a bearer still requires §1.3/M-29 machine confinement. smithers-3f reviews scopes, revocation and bearer/cookie precedence (C-ACC-01, C-ACC-02, C-SEC-05).
- The install-browser fixture uses a session cookie (`apps/app/src/mainview/runtime/ApplicationClient.test.ts:45`). It does not prove production agent dispatch or turn lifetime. T-APP-16 must dispatch on the host with `MintForTurn`; the full app-agent C-ACC-02 row remains pending until that real runner lands.
- Keep install-mode delegated classification separate from Plue’s existing PAT authority. smithers-3f approves the shared stored-scope contract and smithers-8a accepts any cross-composition seam; Will must approve any product-policy change before Plue behavior changes. Existing Plue regression fixtures must retain their outcomes (C-ACC-01).
- C-ACC-01's delegated column passes only once this ticket mints delegated tokens.
- `smthrs auth login --admin` tokens (`packages/smithers/src/internal/backend/Auth.ts:164-178`) serve Plue operators. They're out of scope; `/api/admin/*` isn't mounted on the install (T-CUT-02).

## Ready checklist
1. Dependencies: T-ACC-03 authorization and T-ACC-02 active-member/revocation are the landing contracts; Scope refuses missing providers before issuance or bearer effects. Preserve the adopted T-INS-04 edge cut and configured-origin enablement gate. Confirmation consumers, turn runner and terminal installation are downstream, with their full boundary cases pending until integration.
2. Exclusions: Scope names confirmations, host runner, context preflight, terminal files/installation, actor views, presence, Plue admin/PAT policy and new tables/migrations/actor library.
3. Tests: composed production OAuth/token, command and Git HTTP routes, persisted audit rows and registered makeCli login use committed literal outcomes. C-ACC-01 covers missing-provider and forged-authority cases; T-APP-04, T-APP-16 and T-TRM-02 own real downstream lifecycle/confirmation cases. No runtime spec, catalog or implementation oracle.
4. Decisions: smithers-3f approves stored-scope classification, TTL, revocation and install/Plue isolation; smithers-b8 approves public CLI/API and the proposed unavailable-issuer refusal; smithers-38 approves actor/client/RPC contracts; smithers-8a accepts cross-composition seams. Will decides product-policy changes.
5. Owner pre-review: smithers-3f: Does existing-PAT classification preserve Plue and deny install approval authority? Do membership, branch/subject, TTL and revocation checks fail closed without their providers? smithers-b8: Do OAuth/login/header/OpenAPI contracts keep turn bearers out of browsers? Can public agent inputs select only external-agent authority? smithers-38: Do actor/client/RPC consumers reuse one credential-first contract and shared schemas? Recorded answers stand: smithers-3f answered, BLOCKING edits applied (tech lead adopts); smithers-b8 answered 18:23, ok. Owners review these draft corrections post hoc under Will's parallel-build directive; smithers-38's answer is not recorded here.
6. Security: host minting executes shipped install code only; repository checks and docs scripts execute inside machines under §1.3/M-29. This ticket adds no root step, guest provisioning or root-consumed main/branch inputs. Terminal files and root provisioning belong to T-TRM-02 and its security review. smithers-3f reviews host-only minting, stored authority, branch scopes, bearer/cookie precedence and revocation under C-ACC-01/C-ACC-02/C-SEC-05.

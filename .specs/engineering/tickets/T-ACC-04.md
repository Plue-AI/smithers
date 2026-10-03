# T-ACC-04 Delegated credentials with `via`; `smthrs login --agent`; attribution

Stage S1 · Size M · Depends on T-ACC-03 · Unblocks T-ACC-05, T-APP-09, T-APP-23, T-COL-02, T-REL-02, T-STK-04, T-TRM-02 · Issue: [#3493](https://github.com/smithersai/smithers/issues/3493)
Spec: spec.md §5.3, §5.3.1, §6.4, §2 (actor notation), §15.1.1, §15.1.4, §15.3 · Delta: delta.md §2 (Add `delegated` + `via`; Add actor `via` on audit) · Product: mvp.md J6.3–J6.4, §6.13 "CLI", "Attribution", M-21, Appendix A closing note

## Goal
`smthrs login <install origin>` (and `--agent claude-code`) yields a `delegated` credential that acts as the member under the `agent: run | confirm | never` rules. App-agent turns get the same kind of credential, minted on the host and never sent to a browser. Every write made with one is recorded as "Claude Code for Ben" or "Ben via Smithers".

## Scope
In:
- `kind` and `via` stored on every non-session token.
- `smthrs login <install origin>` always mints `delegated`, for any origin the owner configured (http or https). `via` defaults to `cli`; `--agent <name>` sets it (§5.3.1).
- The `Smithers-Via` header: the CLI sets it from the environment, and the host records `via` with the credential first (§6.4).
- One actor resolver producing `{person, via?, session?}` / `{agent: "coding", run}` (§2) for audit and for every event writer that adopts it.
- A host-side minting API for the other doors:
  - `delegated(via=smithers)` per app-agent turn for the prompt's author (§15.1.1, §15.1.4). The host turn runner holds it in memory for the turn and revokes it at the turn's end; it never reaches a browser. T-APP-16 and T-APP-17 move turns and command dispatch onto the host and use it.
  - `delegated(via=terminal)` for T-TRM-02.
- The browser holds only its `session` cookie. Every request from a browser is a person's request; no bearer rides beside the cookie, and the server never has to choose between two credentials on one request.

Out:
- Confirmations and per-command `agent` dispatch (§15.1.5, T-ACC-05).
- The host turn runner and the live-channel UI-only instructions (T-APP-16, T-APP-17).
- Terminal auto sign-in files (T-TRM-02).
- Rendering "via" badges (T-APP-09).
- Presence and activity actors (S2: T-COL-04, T-COL-06).

## Changes
- `packages/backend/db/product/migrations/01NN_credential_kind.sql` (new) on `access_tokens` (`0001_product_baseline.sql:1536`).
  - Adds `kind text NOT NULL CHECK (kind IN ('delegated','run','machine','sync'))` and `via text NULL`.
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
- Integration, real PostgreSQL: `compose/delegated_credential_integration_test.go` (new).
  - The CLI OAuth flow with `agent=claude-code` stores `kind=delegated, via=claude-code`.
  - The token calls a `todo.write` route that runs at once (for example a steer), and the audit row reads person=Ben, via=claude-code.
  - The same token gets `permission` with a `review_merge` fix on merge, and `permission` with no fix on a members write.
  - A forged `Smithers-Via: codex` header on a `claude-code` token still records `claude-code`.
  - `MintForTurn` yields `via=smithers`; the token stops working when the turn ends; no HTTP route returns it.
- Unit (app): `runtime/ApplicationClient.test.ts` asserts that no app request sends an `Authorization` header; app requests carry only the session cookie.
- Unit: `actor/actor_test.go`, covering the credential-first precedence table and session-ignores-header.
- Unit (CLI): `packages/smithers/test/BackendCommands.test.ts` covers the `--agent` option and the header derived from the environment.
- Migration test: the backfill classifies a seeded user PAT, a run token and a workspace token correctly.

## Acceptance



- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-ACC-02](../checks/C-ACC-02.md): delegated credentials can't merge or approve.
- [C-J6-02](../checks/C-J6-02.md): laptop `smthrs login` gets a delegated credential (the merge-confirmation half needs T-ACC-05).
- [C-ACC-01](../checks/C-ACC-01.md): Every permission-matrix row is enforced server-side for every credential kind

## Risks and notes
- Today an agent-driven `/merge` runs in the browser with the session cookie (`ApplicationClient.test.ts:45` `credentials: "include"`) and acts as the person. It closes when T-APP-16 moves dispatch onto the host with `MintForTurn`; until then C-ACC-02's app-agent row fails, by design.
- **Plue impact:** reclassifying user PATs as `delegated` changes multitenant behavior too. Run `rg 'write:approval|PostLandingReview' ~/plue` before landing. If hosted flows approve with a PAT, gate the change to install mode and escalate.
- C-ACC-01's delegated column passes only once this ticket mints delegated tokens.
- `smthrs auth login --admin` tokens (`Auth.ts:107-113`) serve Plue operators. They're out of scope; `/api/admin/*` isn't mounted on the install (T-CUT-02).

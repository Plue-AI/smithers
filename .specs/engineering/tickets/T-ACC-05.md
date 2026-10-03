# T-ACC-05 Person confirmations

Stage S1 · Size M · Depends on T-ACC-04, T-CAT-01, T-STK-01, T-COL-02 · Unblocks T-APP-04, T-APP-23, T-CAT-02, T-FLW-05, T-FLW-13, T-GH-06, T-GH-09, T-MCH-08, T-MNT-01, T-MNT-03, T-REL-02, T-STK-02, T-STK-04, T-STK-09, T-STK-15, T-STK-16, T-TRM-02 · Issue: [#3494](https://github.com/smithersai/smithers/issues/3494)
Spec: spec.md §5.4, §5.2 ("confirmation only"), §3 (`person_confirmations`), §6.3 (`/api/confirmations`), §7.2 (`confirmations` topic), §14.3 (Confirm card), §14.5.1, §15.1.3–§15.1.5 · Delta: delta.md §2 (Add `person_confirmations` + `/api/confirmations`; CLI `/merge` creates a confirmation) · Product: mvp.md §2 rule 6, §6.13 "CLI", J6.4, M-05, M-21, Appendix A closing note, Appendix B legend (A✓) and B.6

## Goal
Every delegated credential follows one rule set (§15.1.5): a command whose catalog row says `agent: run` executes at once with the member's rights; `agent: confirm` posts a confirmation the member presses from their own session, bound to the exact revision; `agent: never` is refused. Merge opens the member's **Review & merge**, maintainers only. Agents never see more than a confirmation's id and state.

## Scope
In (adopted owner pre-review):
- Store review_merge bindings as (generation, reviewed_pr_head_sha). Approval rereads both under the subject transaction and expires/refuses a stale binding before effects. Pass both to the merge consumer. MergeReady and definitive GitHub refusals leave the confirmation pending; only a confirmed merge settles approved. Missing handlers leave it unapproved. Check: C-ACC-02.

Approved integration requirements (In):
- The create endpoint accepts only a delegated credential with confirmation scope and a resolved command whose catalog policy is `confirm`. It resolves the command and exact subject, validates their descriptor and performs one Authorize decision on that underlying action before creating anything; it does not first authorize a generic create action and then make a second command decision. A full-scope delegated requester receives HTTP 202 only if actor eligibility, role and subject permit that command. A session caller of explicit create gets HTTP 403 permission and must invoke the command directly; run, machine and setup callers also get HTTP 403 permission while live. Dead callers get HTTP 401. `never` targets receive 403 never after role/scope checks; a target with policy `run` has no confirmation-create path and returns 403 permission. List is own-only for session/delegated; run/machine return 403 permission. Approval or denial requires that confirmation's requesting member's session, current underlying-command role and exact revision; delegated/run/machine and another member's session receive 403 permission. A session press is a new request with one fresh Authorize decision on the bound action; the previous creation decision cannot authorize execution. Without a confirmation consumer, return HTTP 503, class `infra`, code `confirmation_unavailable`, before any handler effect or fabricated 202. Implement credential-scoped replay under §6.2.1, with one fresh decision per create/press/replay. Check: C-ACC-02.
In:
- Dispatch by the catalog's `agent` field (T-CAT-01) for every delegated credential: the app agent's host turns, external agents through the CLI or skill, and terminal sessions (§15.1.5, Appendix B.6).
  - `run`: reads, UI-only flows on the prompter's own screen, steer, answer, stop, resume, retry, rebase, fork, run a flow, wiki writes. Executes with `Authorize` (T-ACC-03).
  - `confirm`: commit, amend or drop a TODO, add to stack, Bring in or Discard a foreign push, delete a wiki page, propose a flow or agent edit, and `/review`; use the descriptor’s minimum role. Create a `one_click` row and return `202 {confirmation: id, state: "pending"}` (§5.2.1).
  - Merge: `confirm` with kind `review_merge`. Created only when the member's role may merge (owner or maintainer), approved only from that member's session.
  - `never`: members, secrets, settings and merge-gating approvals. Return 403 `never` after role and scope eligibility; insufficient role or scope returns 403 `permission`. Create no row. These commands are absent from agent tools.
- The `person_confirmations` table (§3) with `kind ∈ {one_click, review_merge}` and its state machine: `pending → approved | denied | expired`. Expiry after 24 h or when the subject's revision changes (§5.4).
- Approve and deny with the same member's `session` only. On approve, recheck the member’s active status, current role, command scope and subject revision through `Authorize`; run the action with that session against `revision`. An unavailable action handler fails closed before approval or side effects (C-ACC-02).
- Each confirmation is private to its member and published only on `confirmations:<member>` (§7.2.2). T-APP-16/T-APP-04 later persist and render its private Confirm entry with `audience_member_id` (§14.5.1). Shared topics never carry confirmation data (C-ACC-02).

Out:
- The Confirm card UI (T-APP-04) and the conversation entry table (T-APP-16).
- The catalog's `agent` field and its values (T-CAT-01). This ticket reads it.
- The merge mechanics: order, checks and the GitHub call (T-STK-04). This ticket calls its service.
- Browser notifications (T-APP-18); new command handlers, flow runtime changes, repository-code execution on the host, Plue policy changes and S1 terminal-scope expansion.

## Changes

- The existing successful Review & merge approval writer emits review lifecycle evidence pairing its open confirmation with confirmed merge approval; source_key is confirmation id. Credit delegated participation only to the confirming person. Definitive refusals remain pending and produce no approved receipt. T-REL-03 only reads evidence. Checks: C-ACC-02, C-REL-04.
- Store review_merge bindings as (generation, reviewed_pr_head_sha). Approval rereads both under the subject transaction and expires/refuses a stale binding before effects. Pass both to the merge consumer. MergeReady and definitive GitHub refusals leave the confirmation pending; only a confirmed merge settles approved. Missing handlers leave it unapproved. Check: C-ACC-02.

- `packages/backend/db/product/migrations/01NN_person_confirmations.sql` (new). Columns per §3, including `kind` (`one_click` | `review_merge`), plus the stored command payload for `one_click`; an index on `(member_id, state)`.
- `packages/backend/internal/services/confirmations.go` (new):
  - `Create(cred, kind, action, subject, revision, payload)`, `Approve(session, id)`, `Deny(session, id)`, `ListMine(cred)`, and an expiry sweep at 24 h;
  - `Approve` re-reads the subject's current revision in the same transaction; Merge binds and compares both generation and PR head SHA. Check: C-ACC-02.
  - each state change writes a projection event (§3.1) on `confirmations:<member>`.
- `packages/backend/internal/services/command_dispatch.go`: call the catalog authorizer once before dispatch; execute `run`, reject typed `never` or `permission`, or consume its internal confirmation-required decision by creating a row and returning 202 with `confirmation` and `state`. No confirmation decision is exposed as a 403 fix. C-ACC-01 covers every dispatch door.
- `packages/backend/internal/routes/confirmations.go` (new), per §6.3:
  - `GET /api/confirmations`: own full rows for session, own id/state for delegated; live run/machine/setup=403 permission/permission; dead callers=401;
  - `POST /api/confirmations {command, subject, payload}` from eligible full-scope delegated dispatch only; resolve stored subject/revision and consume one underlying-command decision; live session/run/machine/setup=403 permission/permission;
  - `POST /api/confirmations/{id}/approve|deny`: a session for the confirmation's member, else `permission`.
  - Every mutating route takes `Idempotency-Key` (§6.2.1).
- Action dispatch on approve: `review_merge` → T-STK-04’s merge service with `generation` and `reviewed_head_sha` from the stored binding; `one_click` → the stored command, run with the member’s session. T-STK-04 depends on this ticket, so do not add the reverse edge. Supply the confirmation-to-action seam here and fail closed with `confirmation_unavailable`, class `infra`, when its production handler is absent; no approved row or action receipt is written. T-STK-04 wires and proves the real merge handler before enabling Merge (C-ACC-02). Every later confirmable command consumer must install and test its real handler before enabling approval.
- CLI: T-CAT-02 prints Waiting for <person> to confirm, id/pending state and an exit code distinct from refusal. Check: C-CAT-02.
- OpenAPI: `docs/api/openapi/confirmations.yaml` (new), then run `scripts/openapi-bundle.mjs`.
- Docs: the backend package docs page for confirmations. Run `pnpm docs:sync` and `pnpm docs:check`.

## Tests
- Assert literal `state: "pending"` in the 202 dispatch response, delegated id/state read, session list and CLI output. The stored row and live confirmation projection use the same word. Check: C-ACC-02, C-CAT-02.

- Use production create/approve routes and real merge-consumer wiring with fixed GitHub outcomes. Change generation while the displayed head stays unchanged and assert stale refusal, zero merge sends and no approved row. Assert MergeReady and each definitive GitHub refusal leave pending; only independently confirmed merge marks approved. Retain these assertions in downstream T-STK-04 integration. Check: C-ACC-02.

- Boundary: `compose/confirmations_integration_test.go` sends commands and `POST /api/confirmations/{id}/approve|deny` through the composed install router and production dispatcher, then subscribes over the real `/api/live` hub. Real PostgreSQL stores confirmations and the TODO created by the installed `todo.new` handler. Committed literal request/result fixtures cover status, body keys, audience, role demotion, member suspension, idempotency replay/mismatch and unavailable handlers; no expectations read spec Markdown, catalog policy or implementation code at runtime. Merge/GitHub cases become mandatory in T-STK-04’s real integration; mark them pending until then.
- Confirmation fixtures carry command, subject, payload, stored revision and scope: eligible todo.new DO/DM/DE=C; Merge DO/DM=C and DE=P; terminal_s1=P; never target=N after scope/role; run target=P. Live session O/M/E and run/machine/setup create=P. Own session/delegated lists expose permitted fields only; run/machine lists=P. Non-session and other-member decisions=P. Missing S1 delegated todo.new card path=403 permission/confirm_in_app, "Confirm in the app", without effects; other missing consumers=503 infra/confirmation_unavailable and zero effects. Check: C-ACC-02.
- Idempotency fixtures: same credential/same canonical request; different command/subject/payload within scope=409 conflict/idempotency_mismatch; replacement/session/delegated/run/machine identity separation; role-downgrade/dead replay refuses before recorded-response disclosure; expired/resolved confirmation replay reports current state without duplicate rows. Duplicate session press uses terminal-state and durable operation deduplication, no second merge. Check: C-ACC-02.

- Integration, real PostgreSQL plus a GitHub fake: `compose/confirmations_integration_test.go` (new). Cases:
  - a Maintainer's delegated merge request creates a pending `review_merge` row, and the dispatch returns 202 with only `confirmation` and `state`;
  - approve is refused for a delegated, run or machine credential, and for another member's session;
  - approve with the maintainer's session calls the fake GitHub merge once, with `sha = revision`;
  - when the PR head moves before approve, the row becomes `expired` with `409 conflict`, and GitHub gets no merge call;
  - a row past 24 h is `expired`; deny settles the row, and a later approve gets `409`;
  - a Member-role delegated merge request is refused at create;
  - `/todo.new` from a host-minted `via=smithers` credential creates a `one_click` row and no TODO; the author's session press creates exactly one TODO; another member's session gets `permission`;
  - delegated full-scope CLI and S2 terminal todo.new=202; terminal_s1 person append executes with no row; delegated append=202 with a private Confirm card and no TODO until app approval, or 403 permission/confirm_in_app, "Confirm in the app", without effects when the S1 card path is absent; non-append and explicit create=403 permission/permission;
  - a steer from any delegated credential runs at once with no row;
  - a members, secrets or settings write, or `approval.approve`, from any delegated credential is refused with no row.
- Integration: a confirmation reaches only its member's `confirmations:<member>` subscription; another member's subscription to it gets `err forbidden`.
- Downstream merge integration, owned by T-STK-04 with T-GH-09: kill the host between approval and the GitHub call, restart and reconcile by the outbound key; no second merge happens (C-ACC-02, C-GH-09). Before that handler lands, test the unavailable-handler refusal, never a substitute merge implementation.
- Unit: the state machine table, every allowed and refused transition, for both kinds.

## Acceptance

- Landing qualifies confirmation against T-STK-01’s production append route. Before/Move confirmation integration remains pending until T-STK-02 lands; an absent handler leaves the row unapproved. Check: C-ACC-02.



- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-ACC-02](../checks/C-ACC-02.md): a confirmation can be approved only from the member's session, bound to the revision.
- [C-J6-02](../checks/C-J6-02.md): a laptop `smthrs merge` opens a confirmation.

## Risks and notes
- Decisions before start: smithers-3f approves transaction, revision, idempotency, expiry and missing-handler behavior; smithers-b8 approves confirmation API/CLI outcomes; smithers-38 approves catalog-dispatch consumption. smithers-8a accepts the confirmation-to-merge seam with T-STK-04. Will decides product-policy exceptions. Register `person_confirmations` ownership as `planned:T-ACC-05` with one owner before Ready (C-PRC-02).
- Security: confirmation approval grants only the re-authorized command, never a reusable person credential. A flow, image or terminal action must still pass §1.3/M-29 guest-only dispatch; approval never authorizes host execution of repository code. smithers-3f reviews the session-only, private-audience and execution seams (C-ACC-02, C-SEC-02).
- Explicit create is eligible delegated dispatch, never generic row insertion. Role/scope precede never and run-policy targets have no create path. Check: C-ACC-02.
- `GrantConfirm` (`apps/app/src/mainview/cards/CardActions.ts`, `ChatCards.tsx`) is today's client-side confirm for consequential agent acts. The `one_click` row replaces it as the enforced path; T-APP-04 deletes the client-only path when the Confirm card reads these rows.

## Ready checklist
1. Dependencies: T-ACC-04 supplies real delegated credentials; T-CAT-01 supplies descriptors; T-STK-01 supplies production append creation and the projection writer; T-COL-02 supplies private live transport. Confirmation can land against append creation before Before/Move are enabled. T-STK-02 completes Before/Move confirmation integration. T-STK-04 is downstream; absent action handlers fail closed before approval. Check: C-ACC-02.
2. Exclusions: Confirm view/conversation storage, catalog policy, merge mechanics, new command handlers, notifications, host repository execution, Plue policy and S1 scope expansion are explicit.
3. Tests: C-ACC-02 uses composed command/confirmation routes, real TODO persistence and real private subscriptions with literal fixtures; real merge/fault cases run in T-STK-04 and remain pending until installed.
4. Decisions: smithers-3f backend semantics, smithers-b8 public outcomes, smithers-38 catalog consumer, smithers-8a merge seam; Will decides product exceptions. person_confirmations needs planned ownership under C-PRC-02.
5. Owner pre-review before start: smithers-3f: Does approval recheck current role/revision and prevent duplicate effects? Does a missing handler leave the row unapproved? smithers-b8: Do API/CLI responses expose only permitted fields? smithers-38: Does production dispatch consume the catalog once? smithers-3f: answered, BLOCKING edits applied (tech lead adopts). smithers-b8: answered 18:23, ok.
6. Security: only the named active member’s session approves; private topics never reach agents or other members. §1.3/M-29 still gates repository execution in machines; smithers-3f reviews C-ACC-02/C-SEC-02, including S1 terminal refusal.

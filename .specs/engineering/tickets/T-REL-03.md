# T-REL-03 Alpha scorecard instrumentation (mvp.md §10)

Stage S1, S2, S3 · Size M · Depends on S1: T-STK-01, T-INS-06, T-ACC-03, T-GH-02, T-APP-16, T-FLW-03 · S2: T-COL-04, T-COL-06 · S3: T-FLW-06 · Unblocks T-REL-02 · Issue: [#3527](https://github.com/smithersai/smithers/issues/3527)
Spec: spec.md §20.4 (scorecard definitions), §6.3 (`GET /api/install/scorecard`), §3 (`mythical_items`, `product_job_events`, `checks.Attempts`, `activity`, `burst_files`, `chat_turns`, `workflow_definitions`, `proposals`, `install_settings`), §3.0 (GitHub synced store), §20.3 · Delta: none (new) · Product: mvp.md §10 Success and kill criteria, §12.2 dogfood, M-22, M-31

## Goal
The owner gets a scorecard for any date window, computed from the install's PostgreSQL data for automated measures, with core-value person-minutes reviewed separately from sampled, annotated alpha sessions, and every mvp.md §10 measure, its target, its kill signal and a verdict.

## Scope

- Read server-derived lifecycle receipts from existing rows: answer pairs an open wait with that member’s `todo.answer`; review pairs an open Review & merge confirmation with successful approval; edit uses S2 bursts. Use the wait, confirmation or burst id as `source_key`. Credit delegated participation only to the confirming person. Each lifecycle step’s existing writer emits its own evidence; this ticket reads it. This evidence supports automated coverage, not person-minute estimates. Check: C-REL-04.
In:
- Raw measures with the spec §20.4 definitions: install start, first answer and first merge timestamps (from `product_job_events` and conversation entries); **accepted** (a TODO committed to the stack); **merged, dropped, failed** (TODO states, §4.1); **terminal edits** (bursts whose actor has `via` terminal or ssh); **second-member actions** (activity entries on a branch by a person other than the TODO's owner); **flow revisions** (activations, §11.3); **outside work** (commits that reached `main` without a TODO PR).
- Verdicts for the mvp.md §10 table: dogfood (merged TODOs in two weeks; share of outside work), activation (first merge within 60 minutes of install start), core value (at least 10 accepted TODOs per week and a separate sampled-session median below 15 person-minutes for answers, review and edits; kill below 3 accepted in week 2 or a rising sampled weekly median; no-hand-written-code share is diagnostic only, C-REL-04), multiplayer (two or more members acting on one branch in at least 3 separate **sessions** a week; a session is one `audit_log` row, a person's continuous presence on a branch for at least 2 min, §7.3.1a), retention (TODOs accepted in week 3), self-improvement (a learning-proposed flow change merged that **measurably helps**: its failure signature's rate over the next 5 TODOs is lower than over the previous 5).
- Each automated measure carries value, target, kill signal, verdict (`pass`, `kill`, `between`), window and source tables. A measure whose source table is not migrated yet returns `source_missing` naming the ticket that adds it, never 0 or `pass`.
- A merge on GitHub counts like a merge in Smithers (M-22).
- Owner-only read: `GET /api/install/scorecard?from&to` (§6.3, §20.4), computed from product tables, never from logs. JSON only; the owner shares it by hand.

Out:
- Sending data anywhere: the install uses no service run by us (spec §16.1).
- A card or dashboard (minimal text rule; the owner reads JSON), external telemetry, cross-install aggregation, billing, log-derived metrics, burst-count effort estimates and host execution of repository code. The scorecard read transaction never writes. No effort table, scorecard writer or ingestion route ships. Lifecycle evidence remains with each existing step writer. Person-minutes come from sampled, annotated alpha sessions (C-REL-04).

## Changes
- `packages/backend/internal/services/scorecard.go` (new): read-only queries in one `REPEATABLE READ, READ ONLY` transaction.
- `packages/backend/db/product/queries/scorecard.sql` (new); `sqlc generate`.
- `packages/backend/internal/routes/install_scorecard.go` (new), wired through `packages/backend/internal/compose/router.go` and T-ACC-03 authorization; row in `docs/api/openapi/install.yaml` (new, shared with T-INS-06); regenerate `packages/backend/apiclient/client.gen.go`. smithers-b8 signs off the public API; smithers-3f approves query and migration design; smithers-8a accepts instrumentation coverage.
- Keep core-value effort outside the scorecard API. Report `person_minutes: {source: "sampled_alpha_sessions", verdict: "manual"}`; do not infer effort from runs, bursts or conversation timestamps. The alpha owner records sampled TODOs, session annotations, per-person answer/review/edit intervals and weekly medians in the C-REL-04 evidence directory. Union overlapping intervals for the same person and TODO, then sum across people. Preserve unsampled TODOs as unsampled, never zero effort.
- Sources: install start from the `install_settings` setup state (T-INS-06); first answer from `chat_turns` (kind `answer`); TODO counts and merges from `mythical_items` and `product_job_events`; terminal edits and person edits from `activity` bursts and `burst_files` (T-COL-04); second-member actions from `activity` actors; sessions from `audit_log` (§3, written by T-COL-06); flow revisions from `workflow_definitions`; measurably helps from `proposals.signature` matched against each TODO's attempt evidence (`checks.Attempts`, §10.4.3); outside work from commits on `main` in the GitHub synced store that no TODO PR produced.

## Tests

C-REL-04 (folded steps and assertions):
1. Through the production router, request GET /api/install/scorecard?from&to as the owner for [t0, t0 + 14 d] and [t0 + 14 d, t0 + 21 d]. Feed effort fixtures through the production attributed dispatcher; reject forged member identity and agent-only durations and replay duplicate source keys without double counting. Compare with committed literal expected JSON; never read spec/product Markdown or derive expected verdicts from production code.
2. Request [t0, t0 + 14 d] on a second database at the stage-1 migration head, where `burst_files` does not exist yet.
3. Review separate annotated-session variants with medians exactly 15 (target fails) and 10 then 12 (rising, kill). Load the automated week-2 count variant 2 (kill). Changing only code-authorship share never changes the core-value conclusion. Missing annotations leave person-minutes unmeasured.
4. Request through the same router as maintainer, member, delegated, run and machine credentials and without authentication; assert literal refusal statuses.
5. Request with a window whose boundaries fall at 23:30 in the install's time zone.
6. Through the production scorecard route, test present-but-empty burst_files and audit_log with incomplete producer coverage, then complete coverage with no matching activity.

Pass when:
- Read lifecycle evidence from existing wait/confirmation/burst rows with source_key equal to their ids; credit delegated participation only to confirming person. Existing step writers emit their own evidence; T-REL-03 reads only. Person-minutes remain manual sampled evidence. Production scorecard route refuses eligible delegated owner with 403 never/never and member with 403 permission/permission.
- Step 1 equals the expectations field for field, each measure with value, target, kill signal and verdict: dogfood 52 merged in two weeks (pass, target 50) with 5 of 57 changes to `main` made outside Smithers (8.8 %, under the half kill line); activation 48 min (pass, ≤ 60); core value 30 accepted in each week (pass, ≥ 10/week); API person_minutes has source sampled_alpha_sessions and verdict manual; separate annotated-session evidence shows medians 12 then 10 (pass, < 15, not rising); no hand-written code 43/52 = 82.7 % (diagnostic only); terminal edits 6; flow revisions 2; multiplayer 4 sessions (pass, ≥ 3); retention 11 (pass, ≥ 10); self-improvement 1 learning-proposed change merged that measurably helps (3/5 → 0/5, pass). The definitions are spec §20.4's. Multiplayer passes only once presence intervals are persisted (T-REL-03 Open); until then it returns `source_missing`.
- Step 2: multiplayer and terminal edits return `source_missing`, never 0 or `pass`; the TODO-based measures match step 1; person_minutes remains explicitly manual at every stage.
- Step 3 matches each literal variant's target and kill result, independent of code authorship.
- Step 4: maintainer, member, delegated, run and machine credentials return 403 through the production router; unauthenticated requests are refused.
- Step 5: week boundaries use UTC timestamps consistently; the result matches the expectation file's boundary case.
- Step 6: incomplete lifecycle producer coverage returns source_missing even with present-but-empty tables. Only complete coverage with no matching activity returns 0; person_minutes remains explicitly manual.
- No statement in the scorecard transaction writes (the transaction is read-only), and the result is the same with `$STATE/logs/` empty (product tables only).

Fail when:
- The dropped-then-reopened TODO counts as both dropped and merged, or merges on GitHub are left out (M-22 counts them).
- Agent-authored bursts count as person edits, or a claude-code burst counts as a terminal edit.
- A measure with no source reports 0 and passes.
- Core value rewards the absence of person editing, ignores answers/review effort, fails to sum people's minutes or derives expected effort from production code.


- C-REL-04 uses fixed wait, confirmation and burst ids to verify lifecycle source keys and confirming-person attribution. Through the production scorecard route, eligible delegated owner credentials return HTTP 403, class and code `never`; member credentials return HTTP 403, class and code `permission`. No rejected read writes data.
- C-REL-04: literal automated counts through the owner-only production GET route; separate annotated-session fixtures prove medians 12 then 10, exactly-15 failure and rising-median kill. No automated effort ingestion is required.
- integration (real PostgreSQL) `packages/backend/internal/services/scorecard_test.go` (new): a fixture window with hand-computed answers per measure, including a TODO dropped then reopened, a merge on GitHub, a member removed mid-window, an agent burst beside a person burst on one item branch, and a laptop commit on `main`; output equals the expected JSON field for field.
- integration: edit and multiplayer measures return `source_missing` when their required lifecycle producers or coverage are incomplete, including when `burst_files` or `audit_log` exists but is empty. Return 0 for an empty table only after instrumentation coverage is complete. Person effort remains the explicitly manual sampled source. Check: C-REL-04.
- integration: a week where Ben's and Alice's `audit_log` rows overlap on one branch in 3 separate intervals meets the multiplayer target; a week with 2 doesn't.
- integration: measurably helps compares the 5 TODOs before and after a learning proposal's merge on a fixture where the signature's rate drops from 3/5 to 0/5, and reports not helped on a fixture where it stays 3/5.
- Integration (real PostgreSQL): `packages/backend/internal/routes/install_scorecard_test.go` (new) sends the fixture windows through the production router at `GET /api/install/scorecard?from&to`, including its credential middleware and authorizer. Owner responses equal committed hand-computed JSON; maintainer, member, delegated, run and machine credentials get 403, and an unauthenticated request is refused. Tests use literal counts, verdicts and status codes; no test reads spec Markdown or derives expected policy from production code.

## Acceptance
- [C-REL-04](../checks/C-REL-04.md): the scorecard automated measures equal the hand-computed fixture answers and the annotated-session review proves core-value effort, with honest `source_missing`.

## Risks and notes
- Stage split: the TODO-based measures pass at stage 1; terminal edits and the code-authorship diagnostic need bursts (T-COL-04, stage 2); core-value person-minutes come from sampled, annotated alpha sessions reviewed separately; multiplayer needs `audit_log` (T-COL-06, stage 2); self-improvement needs proposals (T-FLW-06, stage 3). Until then those measures return `source_missing`.
- M-31 moves Smithers' own development onto the stack after J1 and J2 pass; the dogfood measure is only meaningful from that date. The scorecard takes any window, so the owner picks it.

## Ready checklist

1. Dependencies: retained measures use setup, authorization, synced commits, conversation entries, bursts, presence sessions, flow activations and proposals. Sampled person-minutes require no app lifecycle producers or effort migration.
2. Exclusions: dashboards, external telemetry, aggregation, billing, logs, estimated effort and host repository execution are explicit.
3. Boundary: C-REL-04 exercises the authenticated production GET route with literal expected JSON and refusal cases, then reviews separate annotated-session evidence.
4. Decisions: smithers-3f approves read-only data/query design; smithers-b8 signs off the API; the alpha owner selects and documents the sample. Will decides changes to product targets or kill signals.
5. Owner pre-review before start: smithers-3f verifies owner-only read transactions and honest missing sources. smithers-b8 verifies automated response fields and the explicit manual effort source. The alpha owner verifies sampling and annotation coverage. smithers-3f: answered 18:2x, ok. smithers-b8: answered, BLOCKING edits applied (tech lead adopts). smithers-38: answered 19:4x, ok.
6. Security: the scorecard executes SQL only and never loads repository modules. C-REL-04 exercises credential refusals. No attributed effort ingestion ships.


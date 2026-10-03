# T-REL-03 Alpha scorecard instrumentation (mvp.md §10)

Stage S1, S2, S3 · Size M · Depends on S1: T-STK-01, T-INS-06 · S2: T-COL-04, T-COL-06 · S3: T-FLW-06 · Unblocks T-REL-02 · Issue: [#3527](https://github.com/smithersai/smithers/issues/3527)
Spec: spec.md §20.4 (scorecard definitions), §6.3 (`GET /api/install/scorecard`), §3 (`todos`, `todo_events`, `todo_attempts`, `activity`, `burst_files`, `conversation_entries`, `flow_activations`, `proposals`, `install_settings`), §3.0 (GitHub synced store), §20.3 · Delta: none (new) · Product: mvp.md §10 Success and kill criteria, §12.2 dogfood, M-22, M-31

## Goal
The owner gets a scorecard for any date window, computed only from the install's PostgreSQL data, with every mvp.md §10 measure, its target, its kill signal and a verdict.

## Scope
In:
- Raw measures with the spec §20.4 definitions: install start, first answer and first merge timestamps (from `todo_events` and conversation entries); **accepted** (a TODO committed to the stack); **merged, dropped, failed** (TODO states, §4.1); **terminal edits** (bursts whose actor has `via` terminal or ssh); **second-member actions** (activity entries on a branch by a person other than the TODO's owner); **flow revisions** (activations, §11.3); **outside work** (commits that reached `main` without a TODO PR).
- Verdicts for the mvp.md §10 table: dogfood (merged TODOs in two weeks; share of outside work), activation (first merge within 60 minutes of install start), core value (at least 10 accepted TODOs per week and median below 15 person-minutes for answers, review and edits; kill below 3 accepted in week 2 or a rising weekly median; no-hand-written-code share is diagnostic only, C-REL-04), multiplayer (two or more members acting on one branch in at least 3 separate **sessions** a week; a session is one `presence_sessions` row, a person's continuous presence on a branch for at least 2 min, §7.3.1a), retention (TODOs accepted in week 3), self-improvement (a learning-proposed flow change merged that **measurably helps**: its failure signature's rate over the next 5 TODOs is lower than over the previous 5).
- Each measure carries value, target, kill signal, verdict (`pass`, `kill`, `between`), window and source tables. A measure whose source table is not migrated yet returns `source_missing` naming the ticket that adds it, never 0 or `pass`.
- A merge on GitHub counts like a merge in Smithers (M-22).
- Owner-only read: `GET /api/install/scorecard?from&to` (§6.3, §20.4), computed from product tables, never from logs. JSON only; the owner shares it by hand.

Out:
- Sending data anywhere: the install uses no service run by us (spec §16.1).
- A card or dashboard (minimal text rule; the owner reads JSON). The scorecard read transaction never writes; effort ingestion writes only through the attributed production service.

## Changes
- `packages/backend/internal/services/scorecard.go` (new): read-only queries in one `REPEATABLE READ, READ ONLY` transaction.
- `packages/backend/db/product/queries/scorecard.sql` (new); `sqlc generate`.
- `packages/backend/internal/routes/install_scorecard.go` (new); row in `docs/api/openapi/install.yaml`; regenerate `packages/backend/apiclient/client.gen.go`.
- Add `todo_person_effort(todo_id, member_id, kind, started_at, ended_at, source_key)` with a unique source key, positive-duration validation and kind answer/review/edit. Add an idempotent attributed effort writer; integrate real answer, review and edit lifecycle receipts through the production dispatcher, verify the requesting member, and reject agent-only durations. Union overlapping same-member intervals before summing across members; no burst-count or elapsed-run estimate is accepted. C-REL-04 uses literal intervals through that writer. Missing lifecycle coverage returns `source_missing`; coordinate app producer changes with their owner without editing app tickets here. smithers-3f and smithers-b8 pre-review the attribution and receipt seam; smithers-8a accepts it.
- Sources: install start from the `install_settings` setup state (T-INS-06); first answer from `conversation_entries` (kind `answer`); TODO counts and merges from `todos` and `todo_events`; terminal edits and person edits from `activity` bursts and `burst_files` (T-COL-04); second-member actions from `activity` actors; sessions from `presence_sessions` (§3, written by T-COL-06); flow revisions from `flow_activations`; measurably helps from `proposals.signature` matched against each TODO's attempt evidence (`todo_attempts`, §10.4.3); outside work from commits on `main` in the GitHub synced store that no TODO PR produced.

## Tests
- C-REL-04: literal weekly counts and attributed effort intervals prove median 12 then 10, exactly-15 failure, rising-median kill, week-2 count below 3 and source_missing. Same-member overlapping intervals count once; two members' simultaneous intervals sum. Changing code-authorship share alone never changes core-value verdict.
- integration (real PostgreSQL) `packages/backend/internal/services/scorecard_test.go` (new): a fixture window with hand-computed answers per measure, including a TODO dropped then reopened, a merge on GitHub, a member removed mid-window, an agent burst beside a person burst on one item branch, and a laptop commit on `main`; output equals the expected JSON field for field.
- integration: on a schema without `burst_files`, the edit-based measures return `source_missing`; with the table present but empty they return 0 honestly. The same holds for `presence_sessions` and the multiplayer measure.
- integration: a week where Ben's and Alice's `presence_sessions` rows overlap on one branch in 3 separate intervals meets the multiplayer target; a week with 2 doesn't.
- integration: measurably helps compares the 5 TODOs before and after a learning proposal's merge on a fixture where the signature's rate drops from 3/5 to 0/5, and reports not helped on a fixture where it stays 3/5.
- integration: a maintainer or a delegated credential gets 403.

## Acceptance
- [C-REL-04](../checks/C-REL-04.md): the scorecard computed from run data equals the hand-computed fixture answers, with honest `source_missing`.

## Risks and notes
- Stage split: the TODO-based measures pass at stage 1; terminal edits and the code-authorship diagnostic need bursts (T-COL-04, stage 2); core value needs complete persisted answer/review/edit effort receipts owned here; multiplayer needs `presence_sessions` (T-COL-06, stage 2); self-improvement needs proposals (T-FLW-06, stage 3). Until then those measures return `source_missing`.
- M-31 moves Smithers' own development onto the stack after J1 and J2 pass; the dogfood measure is only meaningful from that date. The scorecard takes any window, so the owner picks it.

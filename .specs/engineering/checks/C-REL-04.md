# C-REL-04 The alpha scorecard is computed from run data

Proves: mvp.md §10 Success and kill criteria, M-22 · spec.md §20.4, §6.3 (`GET /api/install/scorecard`), §3, §3.0 · Layer: integration · Stage: S1 · Tickets: T-REL-03
Automation: `packages/backend/internal/services/scorecard_test.go` (new) · Runs in: CI (real PostgreSQL)

## Setup
- Real PostgreSQL 18 migrated to head.
- Fixture `packages/backend/internal/services/testdata/scorecard/three-weeks.sql` (new), loaded through the services where possible, describing one install from t0:
  - setup step 1 starts at t0; first answer at t0 + 12 min; first merge at t0 + 48 min;
  - 60 TODOs committed to the stack (accepted) in weeks 1 and 2: 52 merged in that window (2 merged on GitHub, 1 merged after being dropped and reopened), 3 dropped, 3 failed, 1 working, 1 queued;
  - 30 TODOs accepted in each of weeks 1 and 2. Persist attributed answer, review and edit effort intervals in product tables: week-1 per-TODO median 12 person-minutes, week-2 median 10. Sum distinct members' effort; union overlapping answer/review/edit intervals for the same member and TODO. Count delegated human participation against its requesting member; exclude autonomous agent time. Include hand-edited TODOs below 15 minutes and agent-only TODOs above 15 minutes.
  - bursts by a person on 9 of the merged TODOs' item branches (6 with `via` terminal or ssh, 3 via claude-code), and agent-only bursts on the other 43;
  - members A and B each present on branch X for at least 2 min in 4 separate sessions in week 2, with an activity entry by B (not the TODO's owner) in each;
  - 2 flow versions activated, one from a learning proposal with signature `check:lint@review`, which failed 3 of the 5 TODOs before its merge and 0 of the 5 after;
  - 5 commits on `main` in the GitHub synced store without a TODO PR;
  - 11 more TODOs accepted in week 3.
- Hand-computed expectations in `three-weeks.expected.json` (new).

## Steps
1. As the owner, request the scorecard for [t0, t0 + 14 d] and for [t0 + 14 d, t0 + 21 d].
2. Request [t0, t0 + 14 d] on a second database at the stage-1 migration head, where `burst_files` does not exist yet.
3. Load independent effort variants: median exactly 15 (target fails), week-2 accepted count 2 (kill), and medians 10 then 12 (rising, kill). Keeping these values fixed, change only the no-hand-written-code share; the core-value verdict must stay unchanged. Missing answer, review or edit effort sources return `source_missing`.
4. Request as a maintainer and as a delegated credential.
5. Request with a window whose boundaries fall at 23:30 in the install's time zone.

## Pass when
- Step 1 equals the expectations field for field, each measure with value, target, kill signal and verdict: dogfood 52 merged in two weeks (pass, target 50) with 5 of 57 changes to `main` made outside Smithers (8.8 %, under the half kill line); activation 48 min (pass, ≤ 60); core value 30 accepted in each week (pass, ≥ 10/week), medians 12 then 10 person-minutes per TODO (pass, < 15, not rising); no hand-written code 43/52 = 82.7 % (diagnostic only); terminal edits 6; flow revisions 2; multiplayer 4 sessions (pass, ≥ 3); retention 11 (pass, ≥ 10); self-improvement 1 learning-proposed change merged that measurably helps (3/5 → 0/5, pass). The definitions are spec §20.4's. Multiplayer passes only once presence intervals are persisted (T-REL-03 Open); until then it returns `source_missing`.
- Step 2: core value, multiplayer and terminal edits return `source_missing`, never 0 or `pass`; the TODO-based measures match step 1.
- Step 3 matches each literal variant's target and kill result, independent of code authorship.
- Step 4: 403 for both.
- Step 5: week boundaries use UTC timestamps consistently; the result matches the expectation file's boundary case.
- No statement in the scorecard transaction writes (the transaction is read-only), and the result is the same with `$STATE/logs/` empty (product tables only).

## Fail when
- The dropped-then-reopened TODO counts as both dropped and merged, or merges on GitHub are left out (M-22 counts them).
- Agent-authored bursts count as person edits, or a claude-code burst counts as a terminal edit.
- A measure with no source reports 0 and passes.
- Core value rewards the absence of person editing, ignores answers/review effort, fails to sum people's minutes or derives expected effort from production code.

## Evidence
`.artifacts/checks/C-REL-04/<UTC timestamp>/`: test output, actual and expected JSON, commit.

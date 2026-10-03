# QA findings log
| When (PT) | ID | Where | Finding | Routed | Status |
| --- | --- | --- | --- | --- | --- |
| 10-02 15:15 | Q-001 | stk lane todo_state.go (#3433) | needs_you→queued missing (spec §4.1) | 22 + comment #3433 | open |
| 10-02 15:15 | Q-002 | stk lane todo_state.go (#3433) | steer refused from queued/starting/needs_you/paused (spec §10.7.3) | 22 + comment #3433 | open |
| 10-02 15:15 | Q-003 | C-STK-01 step 3 | omits needs_you→queued | 8a | fixed on disk 15:16 (8a) |
| 10-02 15:15 | Q-004 | engineering/README.md:12 | says 108 checks; now 112 | 8a | next 8a landing |
| 10-02 15:17 | Q-005 | spec.md §4.1 | no working/needs_you → merged edge; GitHub merge while PR open but TODO not in_review is refused | 8a | ruled 15:19, adopted; relayed to 22 |
| 10-02 15:17 | Q-006 | spec.md §4.1.0 + stk ProjectItemState | needs_you/paused overlays override landed/cancelled → stale "Needs you" on merged TODO | 8a | ruled 15:19, adopted; relayed to 22 |
| 10-02 15:28 | Q-007 | overview.md T-MCH-02 | INVALID: read a stale copy; main fixed at 2455d1a5 | 8a | closed (QA error) |
| 10-02 15:28 | Q-008 | T-COL-01 spike | C-SPK-03 p95 197ms vs 20; C-SPK-07 1738ms vs 1s (wrong host) | 8a | decision rule adopted: mirror if relay p95>20ms or bridge>1s on idle ref host |
| 10-02 15:28 | Q-009 | tickets/*.md | 11 "Issue: to file"; T-REL-02 links #3465 (T-FLW-10) | 8a | fixed on disk |
| 10-02 15:28 | Q-010 | lanes stk/gh/acc/cap | migration 0104 + 3x install_settings collision; gh owns /api/install of INS-06 | 22 | 22: renumber on landing; first lander owns install_settings |
| 10-02 15:28 | Q-011 | lanes gh/acc | both rewrite GitHub App sign-in | 22 | 22: acc lands first, gh swaps accessor |
| 10-02 15:28 | Q-012 | 4 lanes | parity.test.ts edited by 4 lanes | 22 | 22: order app19→cut2→cat |
| 10-02 15:28 | Q-013 | cut2 lane | deletes repositorySetup.ts named by AGENTS.md | 98 ruling | ruled by 98; in cut2 fix pass |
| 10-02 15:28 | Q-014 | C-GH-01 | GitHub test account needs email verification (person) | 98 | open |
| 10-02 15:28 | Q-015 | gh lane | coverage 9.9% vs 96%; full vitest timeout | 22 | 22: review input |
| 10-02 15:36 | Q-016 | ins lane build-server-bundle.ts:182 | lane guards (GOCACHE go-build-ins, 2 jobs) baked into release build | 22 | open |
| 10-02 16:30 | Q-017 | stk lane GitHub matrix (p2) | 4 bugs: non-member changes-requested moves to working; checks/rebased refused outside in_review; reopen can't restore dropped; pr_merged refuses queued/starting/failed | 22 | open |
| 10-02 16:30 | Q-018 | spec §12.3 | 48 undecided event×state cells | 8a | all 6 cells ruled §12.3.0a 16:50; 8a lands C-GH-13 (owners T-GH-05, T-STK-13) |
| 10-02 16:30 | Q-019 | lanes gh/acc/stk migrations | ownership.csv gaps; acc drops tables still listed | 22 | open |
| 10-02 16:35 | Q-020 | C-SEC-03 step 6 | INVALID: already fixed on main 3a2217f5 (16:17); stale clone | 8a | closed (QA error) |
| 10-02 16:35 | Q-021 | clusters 1-5 | Fable: 4 confirmed, 1 half; fixes: transition TSV+decideGitHubFact; declared-input existence in targetIndex; DB-free migration gate; check receipts to close | 8a routing | in progress |
| 10-02 16:55 | Q-022 | .smithers/workflows/ci.tsx | likely runs on Smithers Cloud per mirror push (parallel factory + GKE spend) | 53 → 3f/2f to confirm | open |
| 10-02 16:58 | Q-023 | stk lane todo_state.go | steer→starting not held; steer→failed refused (should Retry); merged/dropped reason not todo_closed | 22 | row 2 in STK-01; rows 3 in T-STK-13; p1 test lands with T-STK-13 |
| 10-02 16:35 | Q-024 | T-STK-04 (unstarted) | ahead test plan: 21 spec gaps (merge safety S10,S12-16,S18,S20,S22) | 8a | open |
| 10-02 16:40 | Q-025 | T-FLW-11 (unstarted) | ahead test plan: 24 spec gaps; 13 unspecified regression behaviors | 8a | open |
| 10-02 16:55 | Q-026 | #3071 rows 9a,7,12,22,38,39,56 + 42-44 | landed dff26944 (scripts #3093, lazy msb, TUI cut tests); packages/ commit 3ced044f awaits 38 | QA | partly landed |
| 10-02 16:55 | Q-027 | apps/tui/src/app.tsx:363-370,837 | New/Resume status overwritten (#3187); b8 fixes on main, stk lane rebases | b8 | open |
| 10-02 16:55 | Q-028 | flows/issue-sweep/work/flow.ts | 8 fault tags unregistered (row 23); not 22s; QA fixes (orphan Codex sessions work nearby) | QA | queued |
| 10-02 16:55 | Q-029 | burndown-infrastructure.test.ts | row 16: owner 3f; fix = injected-statfs unit seam + host-capable tier + body-failure-first cleanup; land by Sat 12:00 | 3f | owned |
| 10-02 16:55 | Q-030 | mvp.md §12.6 vs §14 | circular release gate | 98 | ruled 6b2a28d3: launch rehearsal; G-MNT-1 |
| 10-02 16:55 | Q-031 | AGENTS.md:202 | Sonnet pepper vs Sol | 98 | ruled 6b2a28d3 |
| 10-02 17:00 | Q-032 | packages/smithers/ui CSS fallbacks | hand-copied tokens in 4 files; generate from tokens.ts (38 suggestion) | 06/38 | follow-up |
| 10-02 17:15 | Q-033 | styleguide --ring-border | 2.1:1 on Paper surfaces; focus needs 3:1 (design) | 06 | #3599 |
| 10-02 17:15 | Q-034 | QA plan | v1.0 landed 62966498 (accepted by product); 8a's 16 changes → v1.1 in progress | QA | in progress |

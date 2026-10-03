# Smithers MVP validation plan

Status: v1.0, lead QA (smithers-4c), 2026-10-02. Product (smithers-98) accepted it as the gate model; the lead engineer's review is folded in; the tech lead's section-numbered review is pending and lands as v1.1. Reviewed by Codex gpt-6.1-sol twice ([v0.2](research/codex-review-v0.2.md): 9 blockers; [v0.3](research/codex-review-v0.3.md): 7 resolved, the last 2 ruled by product at 6b2a28d3).
Contract: [../product/mvp.md](../product/mvp.md), engineering overview/spec/checks/tickets, and `AGENTS.md`. Research: [research/gap-analysis.md](research/gap-analysis.md), [research/test-infra.md](research/test-infra.md), eng-progress (lane snapshot, not retained), [findings.md](findings.md), [research/ci-triage-20261002.md](research/ci-triage-20261002.md), [research/pepper-todo-state.md](research/pepper-todo-state.md) and [research/pepper-github-matrix.md](research/pepper-github-matrix.md). Review: [research/codex-review-v0.2.md](research/codex-review-v0.2.md).
This revision is text only. It creates no harness, executes no check, and certifies no candidate SHA.

The MVP qualifies when every mandatory requirement has evidence for one pinned candidate in its required environment. Triage, implementation reports and dry runs do not qualify it.

## 0. Baseline and status vocabulary

| Area | Current evidence | Qualification consequence |
| --- | --- | --- |
| Main CI | Gate aborts fixed: gofmt e76292bd, actionlint 54737ddd. Reported live backlog: 70 reds; ci-roots and ci-scripts repair batches. | Main is not qualified. Recompute the denominator from completed candidate runs; do not subtract old triage rows by hand. |
| Migration hygiene | f6916c31 landed. Pepper p4 found lane numbering, object and ownership collisions. | Hygiene is one check; it does not prove upgrade or restore. |
| Library changes | smithers-38 reviews every packages/ diff and owns apiBaseline #3485. | Baseline regeneration requires reviewed API evidence. |
| Release harness | QA owns T-REL-02 #3445, C-REL-05 soak and C-REL-03 upgrade. A Codex lane builds scripts/journeys/*; --dry-run works today. | Dry run proves planning/wiring only. Live recordings, soak and upgrade remain unqualified. |
| Resources | Disk freeze: no clones or installs; node_modules copies use copy-on-write. Two heavy fix lanes maximum; load average 45–400. | Queue heavy work; never use this host's contended timings as reference-host evidence. |
| Access and hardware | Ops (smithers-2f) provisions smithers-mvp-canary and three accounts. No reference Mac mini or second Mac yet. | W0/S1 checks that require those devices, release recordings and perf are BLOCKED. |
| Rulings | GitHub facts have defined outcomes in every TODO state (spec §12.3.0a). C-GH-13 (702 cells) drafted by QA; all six open cells ruled by 8a; 8a lands it with owners T-GH-05 and T-STK-13. | Full fact × state × delivery evidence is still required. |
| Admission | Q-020 reported the Member-admits-outsider security error. LOG records correction on main 3a2217f5 and retracts the stale-copy report. | Preserve the negative regression oracle; neither a retraction nor a spec correction is a runtime PASS. |
| Architecture | Fable report in (8a scratchpad fable-arch/REPORT.md): 4 of 5 causes confirmed, cluster 2 half. Ranked fixes: one transition TSV with `noop` plus pure decideGitHubFact (3f; T-STK-13, T-GH-05); declared-input existence in //:targetIndex plus drift at landing (#3071; 38, 22); DB-free migration gate and table ownership at Ready; check receipts required to close a ticket. | Each action gets an issue and manifest dependency; track to landed and requalified. |

Use these result words everywhere, including the manifest and issue receipts:

| Status | Meaning |
| --- | --- |
| PASS | Every expected case ran at the named layer and environment and met the oracle. Durable evidence is retrievable. |
| FAIL | An executed case violated the oracle. Keep the first failure and all later attempts. |
| BLOCKED | A dependency, environment, unresolved oracle or evidence location prevents qualification. Name it and its owner. |
| SKIPPED | A planned case was deliberately not executed. Record the reason and expected case id. It still rejects qualification. |
| NOT IMPLEMENTED | The required product behavior or its runner does not exist. Identify which is missing and its ticket. |
| RESOLVED | Spike only: question answered YES or NO, limitations recorded, fallback selected and accepted. This is not a product PASS. |

Keep implementation progress separate: proposed, on disk, landed, qualified. Partial observations are evidence with case counts, never an extra passing status. Missing results are BLOCKED. Expired or incompatible results are BLOCKED for the new candidate.

## 1. Ownership

| Owner | Responsibility |
| --- | --- |
| QA, smithers-4c | Manifest, independent oracle review, queue, qualification, evidence, recordings/soak/upgrade, C-GH-13, #2290 campaign. Communicates while workers implement. |
| Lead engineer, smithers-22 | Ticket issues and dependency order; implementation assignments; migration/auth composition; repair coordination; host worker limits. |
| Tech lead/architect, smithers-8a | Normative engineering decisions; checks; Fable cluster reviews; architecture actions. |
| Product, smithers-98 | Scope and release decisions, success measures, upgrade calendar, M-31/M-37 exceptions. |
| Backend, smithers-3f | Product backend, install/runtime/security implementation. Backend product code belongs only in packages/backend, never in Plue; Plue composes it and private ports. Product TypeScript lives in apps/app (b8) and packages/* (38). |
| Frontend/CLI, smithers-b8; Design, smithers-06 | Containers/doors and Views respectively; real UI, keyboard and accessibility regressions. |
| Libraries, smithers-38 | Every packages/ diff; API/public-format review and #3485. This review also applies to backend changes under packages/. |
| Docs, smithers-e8 | Build-specific in-app quickstart/reference and preinstall README/install content. |
| Ops, smithers-2f | Hardware, account verification, canary org/repositories, isolated executor availability and durable evidence access. |
| Codex gpt-6.1-sol workers | Implement clear test tasks, harnesses and every discovered product fix with regression evidence. QA reviews quality and results. |
| Sonnet pepper workers | Explore each weak defect class and author adversarial test cases under Will's process ruling. Sol owns resulting fixes and qualification automation. |

Future work claims its issue before starting and refreshes before expiry. Comments, labels and releases use scripts/issue-claim.mjs; exit 75 schedules retry_at. This document does not perform issue writes or launch workers.

## 2. Closed requirement manifest

QA owns `appendices/requirements.json` and its generated `appendices/requirements.md`. These are planned deliverables, not files created by this revision. Their absence blocks qualification.

The manifest is the closed denominator, not a list of convenient checks. It contains every §2 rule (including rule 3), every §9 row, every numbered P0 journey step and nested setup step, every §12 item and inclusion, and every M-xx decision with observable behavior. Include M-01 through M-37 from the current contract, including M-12/19/20/31/34/35/36/37. Add §6 behaviors, Appendix A/B/C policy rows, retained-history obligations and the ten risk criteria below. Preserve the 288 research requirements as aliases; they are not the current denominator.

Each atomic row has these required fields:

```
requirement_id, source_path, section, line, normative_text, source_sha256
first_stage, repeated_stages, check_id, subcase_ids, ticket_issue
implementation_owner, test_worker, qa_runner_owner
layer, runner_path, target_or_exact_argv, environment_profile, dependencies
expected_case_ids, oracle_type, expected_values_or_thresholds, sample_count
artifact_names, durable_uri, candidate_sha, result_id, status
```

A row may have several subcases and layers. It passes only when all required subcases pass. A check shared by several requirements has one unique result per subcase, environment and candidate; stage counts are derived joins, not added prose totals. Every row must resolve to one accountable implementation owner and one assigned worker before dispatch.

Generation and maintenance:
1. A Sol worker implements the manifest generator under QA ownership. Parse the pinned product sections, decision table, engineering check index and ticket index. Expand lists and compound rules into atomic expected ids. Retain exact text, lines and hashes.
2. Join a QA-reviewed mapping overlay for check/subcase, stage, oracle, ownership, executable target and artifact. Import G01–G77, W1–W38, X1–X18 and P1–P17. Resolve aliases to existing checks before inventing C-* ids; research suggestions already collide with C-STK/C-MCH/C-UI ids.
3. Fail generation on unmapped requirements, duplicate ids, missing fields, unindexed check files, missing executable paths, tests outside runner includes, empty expected populations or unreviewed removals. A declared but absent runner gives NOT IMPLEMENTED, not PASS.
4. QA compares the generated inventory to the contract line by line. 8a reviews oracles; 98 approves scope changes. Removal requires a normative decision receipt. Risk changes order, never scope.
5. Regenerate on any product/spec/check/ticket/catalog change and before nominating a candidate. The same change updates mappings, lane test plans and docs. A drift check rejects stale generation. Record source and generator hashes in every run.
6. Re-execute affected results after implementation, check, spec or environment changes. Release qualification runs the full current manifest. No result transfers from a different SHA by assertion.

The generator and durable writer come first. Until they exist, QA maintains the same fields in the persisted queue; that interim record cannot certify a closed stage.

### Normative coverage anchors

These are seed mappings. The generated manifest expands them into individual rows and resolves executable paths before any gate can pass.

| Requirement | First stage / repeats | Check or subcase | Implementation owner | Runner / oracle / artifact |
| --- | --- | --- | --- | --- |
| §2.1, M-21: same typed flow through every door | S1 / R | C-CAT-01..03 + QA-DOORS | b8, reviewed by 38 | Shipped browser button/slash, app-agent tool, installed CLI/skill, HTTP; same tag/payload/principal and durable outcome; dispatch ledger. |
| §2.2, M-07/09/10 | S1 / R | C-CUT-01, C-INS-01/05/06 | 3f + b8 | One install/team/repository; no exposed switching/cloud doors; Apple Silicon install; topology and catalog receipts. |
| §2.3: built is not shipped | S1/S2/S3 / R | All stage manifest rows | 22 | Full vertical-slice evidence and §9 criteria; no component-only substitution; gate receipt. |
| §2.4: chat/cards/maximize | S1, later cards S2/S3 / R | C-UI-08 + QA-CARDS | b8 + 06 | Expected card inventory nonempty; real inline/maximized actions match; card/action ledger and screenshots. |
| §2.5, §9 Honesty | S1, later states S2/S3 / R | C-UI-05 + QA-HONESTY | b8 + 3f | Every card/state/scenario compared to committed events; unresolved launch returns before launch/job finish, chat usable, toast settles only on completion; timeline/DB receipts. |
| §2.6, M-05/22/30/32 | S1 / R | C-ACC-02, C-STK-06..08, G15/G23 | 3f | Exact generation/head approval from eligible session; no agent merge or direct main write; API/GitHub write ledger. |
| §2.7, §9 Copy | S1, later cards S2/S3 / R | C-UI-02 | b8 + 06 | Production visible strings use product vocabulary, no explanatory paragraphs; inventory-based lint report. |
| §9 App agent | S1 / R | C-PERF-01 | b8 | Ref Mac, 100 samples, submit includes preflight: p95 token <1.5 s, cards <8 s; samples and host profile. |
| §9 Branch wake | S2 / R | C-PERF-05 + G76 | 3f | Ref Mac, >=100 warm wakes p95 <5 s; recipe-change cold wake shows real progress; timing/progress receipts. |
| §9 Live updates | S1 projections, S2 disk, S3 typing / R | C-PERF-02..04 + G77 | 3f + b8 | >=200 samples per path/topic; p95 <1 s for projections, agent/terminal writes and viewer keystrokes; operation timestamps. |
| §9 GitHub freshness, M-03 | S1 / R | C-GH-07/08 + W6 | 3f | Real polling with webhooks off/dropped: PR/check/main <=60 s, issues <=5 min; all fact kinds and budget receipts. |
| §9 Durability | S1 host/GitHub, S2 daemon, S3 docs / R | C-DUR-01..04 + G01/G33 | 3f | 10 repetitions per kill point; no completed step replayed; external lookup before retry; saved bytes survive; recovery ledger. |
| §9 Keyboard | S1 available steps, S2/S3 extensions / R | C-UI-01 + G43 | b8 + 06 | All P0 steps in Chromium/WebKit, both themes, keyboard guard active; step ledger/video. |
| §9 Isolation, M-18/29 | S1 boundary, S2 member homes / R | C-SEC-01/02/05, C-MCH-01/06/09/10 | 3f | Real VM default, no host fallback, keys host-only, no sudo, scoped sessions and private homes; confinement receipts. |
| M-34: agent participants | S1 activity, S2 presence/terminals, S3 flags / R | C-J3-01, C-J6-01 + QA-ACTORS | b8 + 3f | Each working agent has own avatar/id and “for Ben”; SSH remains person attribution; actor ledger. |
| M-35: docs | S2 / R | C-UI-09, C-REL-01 | b8 + e8 | /docs uses bundled shared Markdown offline; no standalone docs site; README/install page retained; command/link receipts. |
| M-36: API playground | S2 / R | C-UI-10 + QA-DOORS | b8 | Documented calls only, viewer permissions, second press for mutations, agents refused; refusal/effect ledger. |
| M-31/37: dogfood cutover | S1 J1/J2 / daily, R | QA-DOGFOOD-START, C-REL-04 | 22 + QA | Will's install provenance, side door disabled, real self-change and reported exception shares; cutover/scorecard receipts. |

### All research gaps remain in scope

The oracle is each G row's current-contract-corrected pass condition. The artifact is its binary/numeric result plus raw receipts under §6. All rows repeat at R. Each group below expands to individual subcases, not one pooled PASS.

| Stage | G ids | Implementation owner / named check family |
| --- | --- | --- |
| S1 | G03,G05,G15–G25,G29,G36,G38,G47,G71 | 3f / C-STK-03..08, C-J4/J7/J10 and QA-STACK subcases |
| S1 | G08–G11,G13,G14,G31 | 3f / C-ACC, C-SEC-02/04/05, C-GH, QA-STEER |
| S1 | G27,G28,G33,G35 | 3f / C-STK-08, C-DUR-01/02, C-COL-01; bound ask, start failures, atomic tool writes |
| S1 | G34,G44,G46,G49,G50,G51,G57,G58,G66,G68,G70,G73 | 3f + b8; e8 for G66 / C-REL-04, C-J1-03/06, C-J8-06, C-J10-09, C-CUT/C-CAT |
| S1 | G07,G52,G55,G59,G62,G65,G69,G75 | b8 / C-UI-06, C-J6-01, C-J11-01, QA-CARDS; M-34 supersedes old agent badges |
| S1 then S2 | G26 | 3f / C-STK-01/08: S1 stored-state/answer proof; S2 real safe-idle release, queue position and same-run re-admission |
| S1 then S2/S3 | G43,G45 | b8 / C-UI-01, C-J6-01: selected Claude OR Codex real edit path; S2 viewer reload, S3 live document |
| S2 | G01,G02,G04,G12,G30,G37,G39,G53,G54,G60,G61,G63,G67,G72,G74,G76,G77 | 3f + b8 / C-DUR, C-COL-03..05, C-MCH, C-J3/J8/J10, C-PERF; G77 >=200 real agent-write samples |
| S2 then S3 | G40,G64 | b8 + 3f / C-J11-02: Source/load/typed Plan/Run then source co-edit; draft TODO run cannot propose or write GitHub |
| S3 | G32,G56 | 3f + b8 / C-J3-04 and C-J5-03; stale closed-file recovery and 90-day proposal suppression |
| R | G06,G41,G42,G48 | 3f implementation, QA runner / C-REL-03/05/06, recordings and dogfood |

G17 applies only where drafts are supported. Inspect the operation log at each state commit, not periodic snapshots. G18 separately proves the waiting prefix/label fallback and Smithers-side merge refusal; GitHub can still merge it and must produce order attention. G16 excludes dropped hunks except the intentional fork preservation in G03. G22 runs on both draft capability profiles. G35 tests S1 tool writes and the contract-only HTTP refusal, then S3 live document writes.

W1–W38 each becomes a mandatory repair subcase on its named check at that check's first applicable stage. Split cross-stage checks. Retain exact sample sizes: W2/W17/W34 >=20 races; W12/W13 >=100; W14 50 overlapping external saves with two active typists; W33 >=50 terminal outputs; W36 >=20 per row; W4/W5 10 kills per point. W20 requires a discriminating before/after wiki rule, not citation alone. W37 mixes every required projection topic. W38 fixes the P0 inventory. QA reviews all 38, including fail-when paths that the old steps never exercised.

X1–X18 remain in `appendices/oracle-decisions.md`, with controlling clause, owner, decision receipt and dependent rows. 8a reconciles spec/check/lane tables together; 98 decides product scope. Closed prose conflicts are not discarded until affected checks execute.
Current controlling rules: effective-origin cookies (X1/X2); model changes affect subsequent calls even in active runs (X3); M-34 actor adapters without extra authority (X4); scoped S1 terminal tokens with append-only J6 placement (X5); 7-day reopen (X6); stage-specific fork captures (X7); Address→App→owner→repo→model→squash (X8); person-minutes core value (X9); explicit ids/hashes over version prose (X10); draft fallback (X11); burst recovery, no per-entry Undo (X12); measured defaults (X13); per-machine homes (X14); merge/propose never overridable (X15); no live main branch machine, background machines permitted (X16); one interrupted-state bound to rule before acceptance (X17); role-filtered stack attention and Home counts (X18).

### Safety oracles adopted today

C-GH-13 must enumerate every inbound fact from spec §12.3 × every stored TODO state × poll/webhook/duplicate/reordered/restart delivery. Expand member/non-member, fetched head/main truth, current/stale revision and draft capability. Each cell names transition, recorded no-op or stack attention, with exact effects and actor. No “spec gap” cell can pass.
GitHub merge counts from working/needs_you/paused and all other unmerged states with an open PR when fetched main contains the commit, as current §4.1 requires. Terminal item states win the projection. Duplicate facts are recorded no-ops, not extra transitions or work. Test close→merge, merge→close and reopen ordering against the approved matrix; never create a second TODO to hide an inconsistent projection.
Answer with no new work goes to in_review when no higher-priority fact remains. Starting steers are held. Failed steers invoke Retry with that steer. Merged/dropped steers return todo_closed. Queued/paused steers arrive once at start/resume. A question remains open after a steer; only its first accepted answer settles it. Independent waits retain their precedence.
C-SEC-03: Member→team text is permitted; Member→outsider text is refused before drafting, with zero TODO/run/credential/machine effects. Maintainer-session→outsider is permitted. Test Make TODO, labels, delegated confirmations, webhook/poll races, replay and changed source after approval. The product trust rule controls any conflicting check.

## 3. Additional risk criteria in the manifest

These ten rows are mandatory. QA assigns a Sol test worker before dispatch; 38 reviews packages/ changes. Stage suffixes are separate subcases. R repeats all implemented safety cases. Each row emits result.json plus the named artifacts to the durable store in §6.

| ID / contract | Stage | Owner | Runner / layer | Reject unless | Artifacts |
| --- | --- | --- | --- | --- | --- |
| QA-MIGRATE / M-26, old-history contract | S1 schema/legacy; R upgrade | 3f install/backend | Real PG18 migration fixtures + C-REL-03 journey/fault | Sanitized real pre-MVP journals/cards, issue→TODO state, roles, sealed values, refs and pending effects survive explicit transformations; zero unexplained row loss/orphans. Race two migration starters, kill/restart each boundary. Supported PostgreSQL binary/cluster upgrade works; unsupported major refuses before mutation and remains restorable/runnable on old bundle, with no new empty cluster. | Before/after semantic digests, transformed-row oracle, migration ledger, decryption/ref checks, PG compatibility table. |
| QA-RESTORE / M-26, spec §16.5 | S1 recovery fixture; R C-REL-06 | 3f install/backend | Real quiesce/backup/restore e2e+fault | Concurrent acknowledged wiki/run/branch writes fit one quiescence fence. Completed backup on separate volume restores without live root or old Cellar, offline into stopped clean data dir; final Mac-B receipt required. Members/key/decryption, blobs/wiki revisions, journals/closures, refs, VM homes/uncommitted bytes match. Missing chunk/corrupt manifest/wrong key refuses before destination replacement; partial backup has no completed manifest. | Fence timeline, file hashes, portable manifest, destination-before digest, Mac A/B comparison. |
| QA-LOG-SECRETS / spec §17.4 | S1 host/provider; S2 relay/homes | 3f security | Sentinel scan, integration + fault | Distinct model/App PEM/client secret/OAuth/delegated/bound-secret sentinels through success/failure/retry produce zero raw or common-encoded forbidden matches in logs, journals, headers/URLs, HAR/console, crash diagnostics and uploaded receipts. Positive controls detect leaks. Owner terminal may print all-branches env secrets; that permission never allows shared diagnostics/upload leakage. | Surface inventory, positive controls, redacted scans, ACLs and upload hashes. |
| QA-INJECTION / M-29/30, spec §17.5 | S1 host boundary; S2 teammate isolation | 3f + flow owner under 22 | Real coding-host scripted hostile corpus + live-agent canary | Admitted issue/discussion/review/wiki instructions, changed source and forged identity/tool results cannot execute host/lifecycle code as privileged user, read teammate tokens, reveal provider/App keys, bypass checks, approve or issue unauthorized GitHub effects. Main changes only after real reviewed-revision approval. Runtime permissions enforce this, not model obedience. | Attempted tool calls, refusal receipts, host/guest audit and GitHub effect log. |
| QA-APP-SCOPE / M-03/22 | S1 | 3f GitHub/security | Real App, org and personal repo e2e | Selected installation/token targets configured single repo and exact allowed permissions, including required workflows:write. Other-repo API/git and forbidden org/admin writes fail with zero effect. Suspension/removal/reduced permissions while token cached holds Merge and reports refusal; no PAT/env fallback or silent broadening. | Token-free effective-scope receipt, API/git refusals and effect counts. |
| QA-GH-PAGES / spec §12.2 | S1 | 3f GitHub | githubfake scheduler integration/fault | 150 objects across 3 pages at equal timestamps, reordered duplicates and between-page restart lose none; watermark passes no unapplied page. 403/429 secondary limits, missing modeled header, documented Retry-After forms/reset/low budget/expired token coordinate workers; <=1 scheduler request per installation/stream, one refresh owner, no pre-deadline request. Unaffected authorized streams continue; limited/stale never fresh. | Page/event ledger, watermark, request timestamps, persisted backoff/health. |
| QA-CLOCK / auth, §8.7.3, §20.4 | S1 expiry/scorecard; S2 credential sync | 3f auth/credential + scorecard owner | Injected clocks, unit+integration | ±1 h jumps, suspend/resume, ±24 h host/guest drift, restart, exact expiry and future guest timestamps never revive revoked tokens/expired confirmations or pin credential convergence. Use monotonic durations and persisted UTC deadlines with conservative discontinuity handling. Both DST changes and UTC half-open windows count identical event sets exactly once. | Clock/expiry decisions, timestamp cases, convergence and scorecard tables. |
| QA-ENOSPC / §9 Durability/Honesty | S1 DB/capture; S2 VM; S3 save; R backup | 3f install/durability | Bounded volume/fault hooks, real storage | ENOSPC at DB commit/WAL, temp-write/fsync/rename, VM save, capture/ref update, logs and backup publication gives typed visible failure; no Saved/completed for unpersisted data. All previous durable bytes and last usable backup survive restart. No partial candidate merges or incomplete completed manifest. Space-free retry recovers with no duplicate effects. Low-disk grants refuse independently of capacity arithmetic. | Fault-point ledger, acknowledgement/byte digests, restart/retry/effect and backup receipts. |
| QA-INSTALL-RACE / one install, §16.1 | S1 start; R upgrade/restore | 3f install | 20 concurrent starts, real Mac integration/fault | Same root has exactly one supervisor/PG/migration owner and unchanged key/identity. Losers attach idempotently or get typed busy. Start vs upgrade/restore races preserve exclusion. Second macOS user's occupied-port attempt cannot read/write first user's state. SIGKILL stale locks and path/symlink collisions cannot initialize over data. | PID/lock timeline, key/identity digests, permission and destination checks. |
| QA-DOGFOOD / M-31/37, §10/12.2 | S1 cutover; S2/S3 self-change; R window | 22 + QA | Will's install, real TODO journeys/scorecard | Side-door disabled; real self-change is created/run/reviewed/person-merged on the stack. Old pinned runs survive flow activation and packaged restart; next TODO works. Provenance/laptop fallback and person-minutes recorded from cutover. R counts >=50 distinct genuine squash-merged TODOs in declared 14 days, excludes filler, reports L-spine exceptions and laptop share against >50% kill signal. | Cutover receipt, run/approval/PR provenance, self-change recovery, 14-day scorecard and fallback reconciliation. |

S1 safety fixture subcases do not pull release-command implementation forward. Exercise the existing recovery boundaries and predeclare R cases for T-INS-07; unavailable commands remain NOT IMPLEMENTED at R. Never run disk exhaustion on the live development volume.

## 4. Gates on one pinned candidate

```
main observations -> G-MAIN-TRIAGE (operations only)
candidate SHA + closed manifest + immutable bundle -> G-MAIN -> G-TKT / G-S1 -> G-S2 -> G-S3 -> G-R
                                                     S1 J1/J2 -> G-DOGFOOD-START
release decision = G-REL-1..6 + G-R + unresolved-decision review
```

22 nominates one immutable landed SHA, bundle digest and manifest revision. QA independently runs its mandatory checks and archives one completed qualification. New pushes never retarget/cancel it. A newer candidate needs its own receipts. Mandatory FAIL/BLOCKED/SKIPPED/NOT IMPLEMENTED/missing evidence rejects the gate regardless of severity. No open S1 defect passes a gate; other severities cannot waive required behavior either.

| Gate | Qualification requirement |
| --- | --- |
| G-MAIN-TRIAGE | Every new observation has issue/class/owner in the persisted registry within one 5-minute round. Never marks readiness. |
| G-MAIN | Completed unmasked candidate CI for every declared required target, including exclusive faults and relevant platform suites; no registry entry turns a mandatory red green. Full coverage receipts required. |
| G-TKT | Every ticket bullet and delta mapped to current source/test oracle; all named layers pass after landing on nominated SHA; no remaining delta; updated affected docs; old implementation deleted in same change; backend product code only in packages/backend, never in Plue; durable issue evidence and QA receipt. A check that can only pass at a later stage (e.g. T-DOC-02's C-REL-01 steps 3-5 at R; T-FLW-01's installed C-SEC-02 needing the INS bundle) keeps the issue OPEN with the comment "landed <sha>; awaiting <check> on <ticket>"; it closes on QA's receipt. |
| G-W0 | All indexed experiment questions RESOLVED with exact environment, YES/NO, limitations and accepted fallback; C-GH-01 remains a real e2e PASS obligation. C-SPK-02 NO is preserved. Adopted per-machine homes qualify separately through C-MCH-09/10. Other product budgets remain mandatory even if a spike rejects an approach. |
| G-S1 | All S1 manifest subcases, current indexed checks and repairs pass, including real Mac J1/J2, security, generations/merge fences, state matrix, contract writes, coverage and early telemetry. Thin-path success alone is not full S1 exit. |
| G-S2 | S1 requalification plus S2 rows: actual shared VM, sessions/homes/credentials, SSH, watcher/bursts, release/admission and people-aware rebases. |
| G-S3 | Earlier rows plus S3 live code/wiki documents, Saved recovery, learning and revision-following plans. Delete replaced transports in the same change. |
| G-R | Full release manifest rerun in each original required environment, not Mac substitution for Linux/24-GB/second-device cases; recordings, perf, 24 h soak, upgrade/restore and public package receipts. |

No new reds is effective now: a lander reverts a landing that adds a red within 30 minutes. Preserve cause and revert receipts. Once main first becomes green, Stop-the-line applies: no lane starts while main is red. Only authorized restoration of green proceeds; queue normal work. 22 records the first-green SHA/time. Required PR checks bind at the M-31 cutover, when TODO PRs exist; until then lanes push to main and the no-new-reds rule is the guard. 22 nominates one landed SHA per gate (plus the bundle digest once T-INS-01 lands); the lander records the reds covering its change before and after, and reverts under vcs_lock within 30 minutes.

G-TKT additionally checks migration registry/object/ownership hygiene and actual installed schema/router/runtime composition for Q-010/Q-011/Q-019. Recheck OAuth end to end after acc/gh integration. p3's manually edited generated companions require regeneration/drift evidence; its standalone 15-test report is not landing proof.

### G-REL: release items and recording index

| Item | Owner / evidence |
| --- | --- |
| 1 | QA T-REL-02 #3445: complete J1–J8/J10/J11 recording index in both themes on fresh reference Mac mini, second laptop, real GitHub. Every step has time offsets, actors, expected/actual result and receipt links; G40/W14/W20/G33 mandatory. |
| 2 | QA + 22: C-REL-04 and QA-DOGFOOD live 14-day scorecard, 50 distinct real TODOs, person-minutes/fallback/provenance reconciled. Imported laptop work never becomes factory-created merely because it has a TODO PR. |
| 3 | b8 + 3f: C-CUT-01/C-CAT-01 and G15/G51/G70; remove new product entry points, retain hidden maintainer machinery, supported published libraries/CLI groups and old read-only decoding. |
| 4 | e8 + b8: C-REL-01/C-UI-09; /docs quickstart and flows reference match build; run every quoted command, anchors/offline/not-found; README and one install page work before installation. |
| 5 | 3f + QA: C-REL-02/C-J1-01 fresh public Homebrew install, arm64 release artifact/signing/launchd, no Smithers account/private dependency, offline first VM base image. |
| 6 | QA, implementation 3f: C-REL-03 + QA-MIGRATE/RESTORE/ENOSPC and C-REL-06. Separate prelaunch rehearsal from actual launch-day N→maintainer release at launch+7 days. Actual future receipt stays BLOCKED until observed. |

The executable journey manifest indexes all six §12.1 inclusions: restart mid-run; duplicate launch; simultaneous same-line typing plus recoverable out-of-band stale save; external save while BOTH people actively type; edited wiki decision followed by next related plan; product-visible recovery receipts. Record non-overlap and overlap bytes, saved state vectors, retained external snapshot and Compare/Restore. The wiki case uses incompatible old/new rules and a before-edit control, then proves the plan and change apply the new exact revision. Run W20/C-J8-05's three-of-three check.
C-J11-02 must show Source on the proposing TODO branch, edit, typed Plan and draft Run on scratch with the new graph/custom view. Draft run cannot stack.propose or write GitHub. Component tests supplement this recording, never replace it.
QA also runs C-REL-05's actual 24 h two-machine credential soak with Claude Code, Codex and gh. Retain wake/sleep, token refresh/logout/revocation, prompts and first failures. The J6 journey may select Claude OR Codex; the separately specified soak requires its named tools.
mvp.md was circular here: §12 item 6 required a launch-day install to upgrade in place to the maintainer release before the MVP ships (mvp.md:588-600), while §14 ships that release one week after launch (mvp.md:610-612). QA proposes, for product's ruling: G-REL-6 (launch) requires a prelaunch rehearsal, a launch-candidate install upgraded in place to a later candidate build with all data intact plus backup and restore; a new gate G-MNT-1 on the maintainer release requires the real launch-day-install → maintainer-release receipt, and blocks that release, not launch. Product ruled this at 6b2a28d3: §12 item 6 is the launch rehearsal, and G-MNT-1 gates the maintainer release on the real receipt. Do not build the maintainer features early or rename a synthetic build “maintainer release.” Outside-team activation/retention/self-improvement verdicts also stay pending until their real observation windows.

## 5. Harnesses in dependency order

| Order | Deliverable / owner | Exit evidence / current limitation |
| --- | --- | --- |
| 1 | Manifest generator and minimal immutable result writer / QA Sol | Enumerated expected ids; reject missing rows/empty scans; retrievable raw receipt. No HTML prerequisite. |
| 2 | Reuse testkit/testdb + postgresfixture, fast unit and full-scope coverage / QA Sol + 3f/38 | Real PG18 per-test DB; no services skip; cover state/permission/generation seams before browser expansion. |
| 3 | Minimum githubfake HTTP endpoints / GH lane under 22, QA extends | Access/create/propose/merge REST, GraphQL drafts, smart HTTP and effect log; then ETags/pages/rate/kill hooks. Document engineering's fake-GitHub integration exception. |
| 4 | Single real-VM self-hosted browser J1→J2 driver / QA journeys Sol + b8/3f | INS-01→INS-02→INS-08; ACC-01→ACC-02→ACC-03; STK-01→STK-12→STK-04. Real second-browser access and person merge. No Cloud sign-in or chat stub qualifies. |
| 5 | S1 expansion / QA Sol | Ask/answer/steer/retry, catalog runtime parity, fork/drop/generation races, C-GH-13, real agent/skill and pinned flow activation. Four-run bootstrap does not pass final one-run-per-attempt checks. |
| 6 | Existing kill hooks extended / QA Sol + 3f | Host/PG/GitHub points first; daemon/cgroups/bursts S2; saved document state S3. Reuse durable_crash_restart_test.go. |
| 7 | Real Linux daemon and browser multiplayer / QA Sol + 3f/b8 | Actual inotify/cgroups/session confinement then two-member homes/presence/SSH; Yjs S3. Linux cannot qualify macOS Hypervisor/signing/launchd. |
| 8 | Release perf/journeys/soak/upgrade / QA Sol | scripts/journeys dry-run today is planning evidence; scripts/perf and live runner registration need receipts. Public package and fresh-host checks remain R. |

Provision hardware/accounts alongside orders 1–4, not after CI repair. 2f owns reference 32 GB Apple Silicon Mac mini, second LAN Mac, 24-GB capacity evidence and three verified account roles. Availability dates are unknown; 22/98 must obtain dated commitments. Reference-specific S1 checks remain BLOCKED until then. Current contracts agree on 32 GB; retain any future profile change as a product decision.
Full CI repair runs alongside the thin path under ci-roots/ci-scripts, with 38 reviewing every packages/ diff and apiBaseline #3485. Do not wait for all 70 reds before building the driver. Do not qualify a stage while mandatory CI remains red.

Scheduling is QA-owned and uses existing/manual execution, then the install's durable flow once M-31 cuts over. The persisted queue nominates one candidate nightly and at each gate request, launches its registered runner with cancel-on-new-push disabled and waits for completion before the next candidate. Archive cancellations as incomplete attempts. No parallel GitHub Actions factory is added.
Before first dispatch, `appendices/executors.json` binds each profile to an actual smthrs environment, host id, exact argv/target, toolchain and resource lease. Unbound profiles are BLOCKED. QA + 3f bind Linux inotify/cgroup execution; QA + 2f bind the reference Mac. Existing commands/targets from test-infra.md are starting points, not verified current syntax.
Database integration sets SMITHERS_REQUIRE_DATABASE_TESTS=1 and SMITHERS_TEST_DATABASE_URL to its allocated PG18 fixture. VM execution sets SMITHERS_REQUIRE_MICROVM_TESTS=1, SMITHERS_MICROSANDBOX_BIN to the verified absolute msb binary, and the composition's microVM isolation setting. Record required native FFI/jj-helper paths. A missing prerequisite fails the executor; it cannot silently skip. Explicitly select exclusive fault/browser targets. RPC tests must live in the configured test/ include; real-browser cases must register in the real-tier coverage contract.
Avoid PostgreSQL :55435 collisions between backend and CLI fixtures through separate leases/ports or serial execution. Linux-only CLI targets retain Linux evidence; add the installed Mac door test separately. Chromium and WebKit availability must be bound, not inferred from an env switch.

## 6. Durable evidence and campaigns

Each immutable result records requirement/check/subcase, full candidate SHA, source/check/manifest/generator hashes, install/bundle/flow revision, exact command, tool versions, executor/platform/host profile, environment/flags, timestamps, actors and sanitized fixture identity. Record expected and executed case ids/counts, sample sizes, seed/sequence bounds, first result, all later attempts, skipped/quarantined cases, observed values, oracle, logs/recovery receipts, artifact SHA-256s and issue/worker/QA reviewer.
Local `.artifacts/checks/<id>/<UTC>/` is a working copy. Before PASS, upload redacted logs/JSON/video to an authorized durable artifact store, or attach to the issue through the established evidence workflow. The store must be independent of temporary checkouts, content-addressed, readable by reviewers on another machine and retained through release plus the upgrade receipt. Ops supplies location/ACL/retention; without it the result is BLOCKED. Store manifest/queue snapshots there too. Issue receipts link durable URIs and hashes, never only local paths.
Exclude credentials and private operations data. Preserve token-free actor/access proofs. QA verifies retrieval and hashes before closing a gate. Keep required Linux, reference Mac, 24-GB and second-device receipts distinct. Spike results retain failed measurements and limitations.
Executed coverage is required for the full production scope of every touched package/language, including Go/TS/app/Rust. Enforce AGENTS.md's 100% requirement with meaningful boundary/error/cancellation/recovery/ordering assertions. Existing lower floors are not proof of compliance. No thresholds are lowered, production paths hidden or exclusions added to gain green. Report configured versus executed scope, platform skips and measurement gaps separately. Unit and real-dependency integration must each establish confidence independently.

### Property and fault campaign

QA assigns a Sol worker and registered runner to every row before its stage begins. Go native fuzz, TS fast-check and Rust generators use independent spec reference models. Full case details live in `appendices/campaigns.md`. Required PR qualification: 1,000 seeded sequences per applicable suite, 1–100 operations each, plus exhaustive finite matrices. Nightly: 15 minutes per applicable suite, serial on a leased host; S1 first. Keep seeds, counts, shrinking traces and retained counterexamples as regression corpora. The nightly run may finish after midnight; it is not cancelled by a push.

| Suite | Stage | Independent oracle / owner |
| --- | --- | --- |
| P1 | S1 | 3f: spec transition/precedence/wait model; effects and recorded no-ops distinct; merged absorbing, bounded reopen, failed steer Retry and terminal todo_closed. |
| P2 | S1 | 3f: symbolic patch trees and serial stack model; only Smithers-issued merges constrained to first; external out-of-order merge folds included items and opens attention. Draft/fallback profiles separate. |
| P3 | S1 | 3f: product role/credential/subject matrix across every route; zero refused effects, outsider admission restricted. |
| P4 | S1 startup, S2 scheduler | 3f: current §8.2 formula including zero capacity and 24-GiB boundary. Fresh below-minimum refuses; existing install remains read-only-capable and queues. Never force capacity >=1. |
| P5 | S2 | 3f: independent priority/holder ledger; count all slots grant→confirmed stop; no new grant below any current term, no preemption when capacity falls below held. |
| P6 | S1 | 3f + b8: committed per-topic sequence ledger vs client; gap/reconnect/retention/backpressure lose no committed projection and show none before commit. |
| P7 | S3 | 3f: CRDT convergence plus saved{sv} durable boundary; all covered writes survive daemon/VM/host kill, unacknowledged updates recover, overlap snapshots and epochs preserved. |
| P8 | S2 | 3f: independent burst clock/version/actor model; 1.5 s idle/10 s cap/conflicting-key closure, ignore paths and overflow. |
| P9 | S1 then S2/S3 | 3f: linearization ledger for base_digest tool/contract API then daemon/doc writes; concurrent success cannot overwrite stale bytes. Include outside-writer interleavings. |
| P10 | S1 | 3f: C-GH-13 matrix and durable label/review event identities; duplicates record no-op and never duplicate TODO/run/steer. |
| P11 | S1 | 3f: remote effect ledger for all outbound kinds, two reconcilers, kill points; <=1 effect/key and lookup before uncertain retry. |
| P12 | S1 then S2 SSH | 3f + b8: independent syntax, identity and normalized-signature tables; malformed/unicode/long input and collisions; no unintended GitHub closing keywords. |
| P13 | S1 then S2 | b8 + 3f: independent SQL counts and per-viewer actions, private audiences and honest background outcomes. |
| P14 | S1 telemetry; S3 learning | 3f: event/window/person-minutes model; DST, drop/reopen, genuine provenance and diagnostic-only no-hand-code share. |
| P15 | S1 | 3f: serial-order reference for concurrent inserts/moves/drops; dense unique stable positions. |
| P16 | S1 | Flow owner under 22: closure/load/activation model; valid newest version active, invalid retains previous, existing runs/retries retain digest. |
| P17 | S2 | 3f: credential convergence including ties/logout/revocation/future-clock attacks; only five allowed files leave homes. |

Pepper p1's 4,147,200 guard cases and seeded walks are useful observations, not candidate qualification. Its starting-steer omission and mixed NoNewWork/MachineReleased guard need updated oracles and tests. p2's 48 logged gaps and DB-dependent untested paths cannot count as PASS; C-GH-13 must exercise production admission/follow/project/endRun with real PG. p3 found 21 hygiene hits and lacked generation evidence. p4's regex migration parser misses SQL bodies; retain its regression fixtures and add actual PG migration execution. f6916c31 is landed hygiene evidence only.
QA-CARDS/HONESTY/ACTORS inventories come from spec §14.3.0 plus retained Appendix B cards, shell, forms, confirmations, toasts, background runs and later-stage states. Test every required action inline/maximized, role and failure state; zero expected elements is FAIL. /docs and /debug-api enter the S2 inventory. Old cards remain readable without restoring cut controls.
Accessibility runs production cards in both themes with pinned axe version and WCAG 2.2 A/AA tags, including contrast. Zero violations and zero omitted expected cards; any rule exception needs 06/98 review, exact scope and independent equivalent proof, never waiver of keyboard/contrast requirements. Record browser/version/rules. Exploratory charters are 30 minutes per available journey capability, with attempted case ids and findings; they never substitute for a deterministic gate.
Perf runs exclude unrelated heavy jobs and archive CPU/load/memory pressure/free disk/network samples. A contaminated sample set is BLOCKED, not reclassified as a passing faster retry. Public benchmark claims require M-19's sealed paired method/artifacts/limitations or are absent.

## 7. Ahead-of-time plans and the bug-class loop

When 22 files a ticket's issue, QA writes its test plan before the implementation lane starts. Assign requirement/subcase ids, stage, independent oracles, fixtures/actors, user-facing doors, positive/refusal/error/cancellation/recovery/race cases, runner/environment, coverage scope and expected artifacts. Have Sol write failing tests where the boundary exists. If it does not exist, retain executable fixture/contract cases and the precise future failure condition; status stays NOT IMPLEMENTED. QA and 8a review the oracle before lane launch, including tickets not yet built.
A lane cannot start with an unmapped acceptance bullet or unknown normative behavior. A necessary product decision is BLOCKED and routed, while independent planning continues. 22 attaches the plan to the issue and lane handoff. A landed slice is requalified before the ticket closes; no “80% done” closure.
Every found bug marks a weak defect class. QA records class, minimal repro, issue, owning ticket, first failure and class coverage gap. Route observed class weakness even if the individual report later proves stale; correct the report and keep the intended oracle.

```
bug -> issue + weak class -> Sonnet pepper cases -> Sol test/fix -> QA review and candidate rerun
                    cluster -> smithers-8a -> Fable architecture report -> owned actions -> requalification
```

Initial five clusters: TODO transitions/projection; GitHub fact/state/delivery; migration/schema ownership; catalog/cuts/generated hygiene; execution/credentials/isolation. Track Q-021's actual Fable report, not its requested status. 8a may regroup them from evidence. Each architectural action gets an issue and manifest dependency; code existence alone never closes it. QA reviews pepper breadth and Sol regression quality, then links receipts to #2290 and the owning bug/ticket. The queue schedules this work; this text revision launches none.
Severity routes repairs: S1 = data loss, security/permission breach, wrong main merge or false merge-gating state; S2 = broken required journey even with workaround; S3 = remaining defects. Every mandatory criterion still blocks regardless of severity.
A pass after failure is a reproducibility observation, not a flake diagnosis. Preserve the original seed/timing/operation log. Quarantine needs owner/issue/expiry, keeps mandatory qualification BLOCKED, and appears in expected counts. Only a fixed check or QA/8a-reviewed independent equivalent evidence for the same criterion can clear it. Never erase a first failure or obtain PASS by retries alone.

## 8. Five-minute loop and persisted queue

The loop only ingests, assigns and polls. It never promises to reproduce, fix or finish a suite in five minutes.
1. Ingest completed CI, lane, pepper, architect and qualification receipts. Update candidate-specific statuses and source identities.
2. Deduplicate by issue/class and candidate/check/subcase. Assign owner and next dependency; schedule claim or throttled write separately.
3. Poll durable background jobs. Record real completion/failure; requested launch never means started or completed.
4. Persist the queue checkpoint and report queue age, blockers and status counts. Dispatch is done by the leased background executor.

`appendices/work-queue.json` is the planned persisted queue, mirrored to the durable store and later the install's run records. Rows contain id, issue/claim expiry, class, requirement ids, candidate, dependencies, owner/worker, runner/environment, priority, created/ready/start/last-poll times, state, blocked reason, resource lease, durable job id, attempt/evidence ids and next retry time. States: waiting-dependency, ready, assigned, running, awaiting-review, completed, failed. These are scheduling states, separate from qualification vocabulary. Restart reconciles job ids before relaunch; claim/lease and idempotency keys prevent duplicate dispatch.
One machine lease: smithers-2f's slot table (~6 heavy local lanes; the critical path is paused last). QA holds two rows on it, the thin-path harness slot and the CI-repair slot, and every lane, QA's included, checks the table before starting a heavy job. One active heavy qualification job per test host initially. When harness and repair consume both slots, qualification waits or runs on a separate provisioned host. Perf leases are exclusive. Low disk/load blocks heavy launch with a recorded reason; it does not weaken an oracle. Disk freeze remains: no clones/installs, only approved copy-on-write reuse.
Once main first turns green, Stop-the-line takes precedence over reserved-slot starts while red. Existing green-restoration work remains tracked. No new product lane slips through as “QA.”
QA reports per-stage expected/required/attempted/PASS/FAIL/BLOCKED/SKIPPED/NOT IMPLEMENTED counts and RESOLVED spikes separately, oldest queue age, red regressions/revert deadlines and artifact links. Findings LOG, issue status and wiki receipts are reconciled through existing workflows. HTML can follow the raw receipts; it is not a gate dependency.

## 9. G-DOGFOOD-START (M-31)

Trigger: the S1 portions of J1/J2 qualify on Will's Mac mini. This is earlier than full S1 exit and does not wait for learning/co-editing. 22 owns the cutover; QA owns its receipt. Missing Mac/provenance/required PR protection blocks cutover.
Record install/repository identity, candidate/bundle, qualification links and UTC cutover time. Disable issue-sweep's direct-main path. Show a real Smithers change created, executed, reviewed and person squash-merged on that stack. Collect developer fallback and factory provenance from this first change, including development location, run/attempt, source edit activity, PR and person approval. Establish person-minutes collection before outside-team alpha; 98 defines answers/review/edit active intervals and idle/overlap rules.
Exercise a self-change canary: edit/merge/activate a flow while an old pinned run remains, upgrade/restart a packaged host safely, recover in-flight work and start the next TODO. Preserve receipts from both old/new versions; no duplicate effects or false completion. This bootstrap canary is distinct from the future maintainer-release upgrade.
Apply M-37: after stage 1, every S/M ticket runs on the install. Only L tickets on the S2/S3 spine may use diff-back lanes outside it. Record each permitted exception and report daily outside-stack share. Main stays append-only; stack service writes mythical, people merge. Reverts also follow the authorized landing path.
Declare the 14-day dogfood window, distinct genuine TODO ids and source provenance. Exclude QA filler. Reconcile laptop work even when imported through TODO PRs. Report >=50 merge target, <20 merge kill signal and >50% laptop-change kill signal independently. If the release candidate changes during the window, preserve historical bundle identities and rerun current safety gates; counts do not certify new code. Outside-team week-2/3 outcomes remain pending until observed.

## Appendix A. Planned inventories

These files are specified here for later implementation. This task writes none of them.

| File | Population and completion oracle |
| --- | --- |
| appendices/requirements.json and requirements.md | Closed atomic denominator and generated review table, with all fields in §2. Missing joins/removals reject generation. |
| appendices/oracle-decisions.md | Every X1–X18 plus new normative conflict; controlling clause, 98/8a receipt, check/lane updates and executed verification. |
| appendices/campaigns.md | Every G01–G77, W1–W38 and P1–P17, expanded cases/stages/worker/exact command/oracle/deadline. No low-risk exclusions. Worker and executable binding due before lane start; execution due before its stage exit. |
| appendices/cards-and-security.json | Expected cards/actions/states/roles/routes/credentials/secret surfaces, axe rules and approved equivalent proofs. Empty/incomplete inventory fails. |
| appendices/recordings.json | Every P0 step, both themes/devices, six inclusions, G40/W14/W20/G33, time offsets/receipts/hashes. No missing step qualifies. |
| appendices/executors.json | Actual smthrs environments, host ids, argv/targets, required flags/tools, lease limits and hardware/account availability dates. |
| appendices/work-queue.json | Restart-safe work/dependencies/claims/leases/jobs/results; durable checkpoint and queue ages. |

## Appendix B. Review dispositions

| Finding # | Disposition and reason |
| --- | --- |
| 1 | accepted: triage separated; pinned qualification rejects every missing/nonpassing mandatory criterion, independent of severity. |
| 2 | accepted: closed denominator covers all required clauses, G/W rows and behavioral decisions through M-37. |
| 3 | accepted: step-indexed release recordings include all six cases; actual maintainer upgrade stays pending and launch timing is a product decision. |
| 4 | accepted: shipped-door runtime conformance, authoring and real inline/maximized inventories supplement catalog parity. |
| 5 | changed: outsider refusal oracle adopted; current LOG/check index records Q-020's stale-copy correction, so no still-open spec breach is asserted without evidence. |
| 6 | accepted: current M-34/35/36 control; reconcile every behavior conflict, preserve supported libraries and old decoding. |
| 7 | accepted: writer/PG/minimal fake/real J1→J2 first; S1 write, steer, retry, startup and order cases moved forward. |
| 8 | accepted: five-minute ingestion/assignment/polling with durable queue and leased background workers replaces inline fixing. |
| 9 | accepted: noncancelled candidate jobs and bound executor profiles; absent hardware remains BLOCKED. Current contracts already specify 32 GB. |
| 10 | accepted: finite inventories, seeds/sequence bounds/sample budgets and worker/deadline bindings make campaign results falsifiable. |
| 11 | changed: properties corrected; current spec permits zero capacity, so test that behavior rather than await a positive-capacity ruling. |
| 12 | accepted: rerun success cannot diagnose flakes or erase mandatory failure; quarantine blocks qualification. |
| 13 | accepted: no remaining delta, same-change deletion/docs/backend boundary and composition receipts required. |
| 14 | changed: Sol implements durable test suites, fixes and full coverage gates. Will's instruction to the lead QA session (2026-10-02 ~16:00 PT: "going crazy with sonnet agents peppering those weak points with tests") assigns weak-class exploration tests to Sonnet. AGENTS.md now records it (product, 6b2a28d3). |
| 15 | accepted: immutable retrievable redacted evidence precedes PASS; local ignored paths are only working copies. |
| 16 | accepted: real pre-MVP semantic transformations, pending effects, restart/races and PostgreSQL compatibility added as QA-MIGRATE. |
| 17 | accepted: fenced coherent portable backup and clean independent negative restore added as QA-RESTORE. |
| 18 | accepted: sentinel/positive-control scans enumerate diagnostic/upload surfaces and permitted terminal boundary. |
| 19 | accepted: admitted hostile corpus crosses real credentialed tool boundary with deterministic refusals and live canary. |
| 20 | accepted: effective installation/token scope, revocation and forbidden cross-repo effects qualify real App authority. |
| 21 | accepted: pagination/equal timestamps/restart and coordinated primary/secondary backoff added. |
| 22 | accepted: clock discontinuity, UTC deadlines, future guest writes and DST/window cases added. |
| 23 | accepted: ENOSPC at persistence boundaries rejects false Saved/completed and protects the last usable backup. |
| 24 | accepted: concurrent starts/upgrades/restores, second-user ports and stale/path locks added. |
| 25 | changed: immediate M-31 cutover/provenance/self-change adopted; current M-37 permits only reported L-spine diff-back exceptions. |
| 26 | accepted: explicit ids/content identities replace stale version/count prose and distinguish landed from qualified. |
| 27 | accepted: spike NO remains RESOLVED experiment evidence; adopted homes require separate real product qualification. |
| 28 | accepted: closed acceptance, thin S1 pipeline and real safety/dogfood cutover form the decision procedure. |

## Appendix C. Source identities and limits

Read from qa-repo, not the review's older smithers-qa copy. No git/jj lookup was performed; the current main SHA must be supplied by 22 at nomination. Headers still mix product v2.5 and engineering v2.6 references; hashes identify the text actually used.

| Source | SHA-256 |
| --- | --- |
| .specs/product/mvp.md | fbb80728e1b81aca2705b1997ea794aae5b0622a6ae2acd8b68579845f38723d |
| .specs/engineering/overview.md | 5e356c3147bb5f81216b47eb16eb35761332434c076b21a386ca6082dd6f6d1a |
| .specs/engineering/spec.md | 6fbd5e03615f59a2ed0f511d7ab3eb6a37924428a95e9dcde3504cf23d3dbc05 |
| .specs/engineering/checks/README.md | 7ea2e3f42474b7d617fb08822120d6e4559bc6e73f9179494cd7aca20b1816b8 |
| .specs/engineering/tickets/README.md | b998710ccd94cce1144a938ee72556cadc1b3839627fe72948ecd3a9ee41492b |
| AGENTS.md | 37d8b375b7607c781deadd6cfca9615c9bc3f475ba5bce1cf9360e1b8ff38f0b |
| validation-plan.md v0.2 | c456f595835ac65e934e49eec09c647af2ae93382788ad430bb993000ed153bb |
| codex/review.md | e9ec4bdaa2e589a03744eb71d403995457b554d58e4db41c571ef9332ae3a58a |

Research snapshots and pepper reports supply leads and observations, not current qualification. Their full hashes belong in the generated manifest's source inventory. Today's supplied CI/ownership/process updates supersede older baseline prose. This plan does not infer a green build, landed test corpus, completed architecture review or available reference host.

## Asks for the leads


- Product (98): decide the §12.6 launch-approval timing while keeping the actual launch-day→day-seven maintainer upgrade receipt pending until observed.
- Tech lead (8a): rule the 21 T-STK-04 and 24 T-FLW-11 ahead-of-time plan gaps, and resolve remaining oracle conflicts, including interrupted-state bound and combined answer guards, before affected lanes start.
- Lead engineer (22): confirm candidate nomination, required PR checks and first-green Stop-the-line enforcement, with the lander's 30-minute no-new-red revert obligation.
- Lead engineer (22), with Ops: supply dated commitments for the 32 GB reference mini, second LAN Mac, verified accounts and durable evidence store/ACL/retention.
- Product (98) and lead engineer (22): confirm Will's M-31 cutover owner/time, M-37 L-spine exception ledger and person-minutes/laptop-fallback definitions before telemetry starts.
- Tech lead (8a) and lead engineer (22): file an issue per Fable action (TSV + decideGitHubFact, targetIndex input existence, DB-free migration gate, close-on-receipts) and confirm shared heavy-worker leases and reserved harness capacity.

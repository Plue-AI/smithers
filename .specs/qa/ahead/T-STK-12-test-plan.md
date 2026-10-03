# T-STK-12 ahead-of-time test plan (QA)

> Rulings (tech lead, 2026-10-02 17:25): S5, S6 and S8 adopted as proposed (Propose requires main's tip == the generation's recorded base, else `stale_base`; a fold marks merged only the merged generation's included items; reorder, drop and amend are `rebase_pending` triggers). S4 rides T-FLW-11 gap 4. S1-S3, S7, S9-S16 ruled in the tech lead's Codex pass.


Candidate generations: capture, propose receipts, pending work, the item's prefix. Stage S1, thin path T-STK-01 -> T-STK-12 -> T-STK-04. Wrong-merge risk.
Author: QA, 2026-10-02. Read-only study of `~/qa-repo` and `~/smithers-mvp-stk`. No code run except the skeleton's own oracle-model tests.
Spec = `.specs/engineering/spec.md` (section numbers below). Companion: `T-STK-12/generations_qa_test.go` (package `services`, `qa12` prefix).
Consistent with: `T-STK-04-test-plan.md` (same hook style `MergeHooks`; lock tests I-39..I-46 here are the primitives its I-34..I-37 and C-01/C-02 consume) and `T-FLW-11-test-plan.md` (its gaps 4 and 23 are my S4 and S10; its K6 and K12 are my F-04 and F-05).

Falsifier: C-STK-06 part A fails when T1's PR head tree differs from the tree its check hashed. If I-B1..I-B5 are green and the property P-G1 holds on 500 random stacks, the ticket's goal holds.

Rulings applied: P2 constrains Smithers-issued merges only for the first item; an external out-of-order merge folds (spec 10.6.4). G17 (drafts) only where drafts exist. A refusal records nothing and sends nothing to GitHub.

## 0. Seams requested

The lane exposes these; QA binds to them. Names are proposals. Pure seams get table tests with no database.

| Seam | Signature | Pure? |
| --- | --- | --- |
| `NextGeneration` | `(prev GenerationState, ev GenEvent) GenerationState` | pure |
| `DecideCandidate` | `(f CandidateFacts) CandidateDecision{Capture \| RebasePending{Onto} \| Unavailable}` | pure |
| `DecidePropose` | `(f ProposeFacts) ProposeDecision{Accept \| Refuse{Reason} \| Defer \| Closed}`; the five rules of 10.4.4 in one function; no write fields on the result | pure |
| `SelectPrefix` | `(f PrefixFacts) PrefixChoice{Main \| Item{N, Head}}` | pure |
| `RebaseFanout` | `(s StackFacts, ev StackEvent) []RebasePending{Todo, Onto}` | pure |
| `PendingWork` | `(f PendingFacts) PendingDecision{Signal bool, NewestTree}` | pure |
| `ValidateInputsSeq` | `(prev, maxEvent, claimed int64) error` | pure |
| `Candidate` / `Propose` | as the ticket: `Candidate(todo, inputsSeq) (Generation, error)`, `Propose(todo, generation, evidence) (ProposeReceipt, error)` | integration |
| `CaptureSource` | `Capture(ctx, todo) (Snapshot{Head, Tree}, error)`; two adapters, workspace jj (S1) and daemon `capture()` (S2). This is the one seam with two real adapters, so the abstraction is justified. | integration |
| `CandidateHooks` | `AfterSnapshot, AfterWriteCommit, AfterPin, AfterRow`, each may return `ErrKill` | test-only |
| `ProposeHooks` | `AfterSecondCapture, AfterAccept, AfterPRHeadCommit, AfterPendingOp, AfterPush, AfterPRUpdate`, each may return `ErrKill` | test-only |
| `LockStack(tx)`, `FenceSet(tx, todo)` | as the ticket | integration |
| `Generation` record | must carry `Prefix []{Todo, Head}` (the items the tree contains). Needed for the PR body "Includes T3, T4" (12.5.1), for out-of-order containment (10.6.4, S6) and for tree tests. | data |

Fake-server rule (same as T-STK-04): "no GitHub write" = zero POST, PUT, PATCH, DELETE and zero pushes in the fake's log. GETs and `ls-remote` are allowed.
Tree rule: every tree assertion reads file content (`git ls-tree -r` then `git cat-file`) and compares with the expected-tree model of section 3. Commit ids are never compared.

## 1. Requirement trace

Ids: U unit, I integration (real PostgreSQL), TC tree-content (real PostgreSQL + real jj), F fault, P property, C concurrency. `svc/` = `packages/backend/internal/services/`. Files are QA names; the lane may fold them into the ticket's names.

### 1.1 Ticket bullets

| Ticket text | Test | Layer | File | Spec |
| --- | --- | --- | --- | --- |
| Generation record: `generation`, `candidate_base`, `candidate_head`, `candidate_verified`, `pr_head`, plus `candidate_inputs_seq` | U-G1..G6, I-03, I-47 | unit, integ | svc/todo_candidate_test.go, todo_candidate_db_test.go | 10.4.4 |
| Migration `candidate_inputs_seq bigint NOT NULL DEFAULT 0` | I-47 | integ | migrations test | ticket Changes |
| `stack.candidate` refuses `rebase_pending` off the prefix | U-C1..C8, I-05, I-06 | unit, integ | same | 10.4.4 step 1 |
| `stack.candidate` captures, writes one commit on the prefix head, pins, records g | I-01..I-04, I-09 | integ | svc/todo_candidate_db_test.go | 10.4.4 step 1 |
| Working-copy history never rewritten | I-02 | integ | same | 10.4.4 step 1 |
| `CandidateVerified` reset moves into `Candidate` | I-04, F-03 | integ, fault | same | 10.4.4 |
| `stack.propose`: second capture and five rules | U-P1..P24, I-13..I-19 | unit, integ | same | 10.4.4 step 3 |
| Refusals `stale_generation`, `edited`, `stale_inputs`, `rebase_pending` | U-P2..P5, I-14..I-17, I-20, U-M1..M4 | unit, integ | same | 10.4.4 |
| On acceptance: pin, record, push with lease, open or update PR | I-13, I-22..I-24, F-06..F-10 | integ, fault | same | 10.4.4, 12.5.1, 12.5.2 |
| Item's prefix for admission and `stack.candidate` | U-X1..X14, I-33..I-38, P-G6 | unit, integ, prop | same | 10.3.2 |
| `rebase_pending{onto}` for later items when an earlier verified head changes | U-R1..R10, I-21, I-34, F-13 | unit, integ, fault | same | 10.3.2, 10.5.1 |
| Pending work: compare later capture trees with accepted tree, signal `edited` | U-W1..W9, I-27..I-32, P-G3, F-14 | unit, integ, prop, fault | same + routes test | 10.4.5 |
| `generation` tag on every evidence part; minimal validation | U-P14..P16, I-19 | unit, integ | same | 10.4.3 |
| S1 capture = jj snapshot in the workspace plus the head push | I-01, I-07, I-08, I-10, I-30 | integ | same | 10.4.4, 9.1.2 |
| `LockStack`, `FenceSet`; every stack mutation shares them | I-39..I-46, C-01..C-08 | integ, conc | svc/stack_lock_db_test.go | 10.6.2b, C-STK-07 |
| Held-signal delivery (steer, review comment) | I-41..I-43 | integ | same | 10.6.2b |
| Placements and amends `409 merging`; rebase and propose defer | I-40, I-45, I-46 | integ | same | 10.6.2b |
| `start` launches from the item's prefix, not `TipCommit` (`:1665`) | I-33, I-35, I-36, I-38 | integ | todo_candidate_db_test.go | 10.3.2 |
| `propose` (`:1951`) runs only after `Propose` accepts; keeps pin, record, push order | I-13, F-06..F-09 | integ, fault | same | 10.4.4 |
| `ReportWorkspaceHead` signals `edited` once per new tree for in_review | I-27..I-32 | integ | svc + routes/workspace_head_test.go | 10.4.5 |
| Appendix C row for `stack.candidate` if it registers as a `Flow.make` tag | U-M5 (catalog guard, one test) | unit | catalog test | 6.1.2 |
| `packages/backend/docs/todos.md` | docs gates (not QA-owned) | | | |
| Unit test: acceptance table, each rule fails alone with its reason and no write | U-P2..P5, U-P24, P-G5 | unit, prop | todo_candidate_test.go | 10.4.4 |
| Unit test: prefix selection for no earlier verified, N-1, N-2 and not N-1, first item | U-X1..X6 | unit | same | 10.3.2 |
| Integ: Candidate writes one commit with captured tree, pins | I-01 | integ | todo_candidate_db_test.go | |
| Integ: edit after Candidate makes Propose refuse `edited` | I-14 | integ | same | |
| Integ: edit between snapshot and generation write lands in the next generation | I-10 | integ | same | |
| Integ: steer above `inputs_seq` refuses `stale_inputs` | I-15 | integ | same | |
| Integ: replayed Propose for an old generation refused with no GitHub write | I-17 | integ | same | |
| Integ: head report with a different tree signals once; same tree nothing | I-27, I-28 | integ | same | |
| Integ: T1 planning, T2 starts on main; T1 acceptance writes T2's `rebase_pending` | I-33, I-34 | integ | same | |
| Boundary integration through dispatcher and router | I-B1..I-B10 | integ | svc/todo_candidate_flow_db_test.go | C-STK-06 |

### 1.2 Check steps

| Check step | Test | Expected (restated) |
| --- | --- | --- |
| C-STK-06 A1-3 | I-B1, I-14 | propose refused `edited`; no push, no PR; same run id re-enters candidate; next tree holds the edit |
| C-STK-06 B4 | I-B2, I-10 | generation tree lacks the paused-in edit; its propose is refused `edited`; next one accepted |
| C-STK-06 B (all accepted) | I-B3, I-24, I-25 | check line digests = tree = `git rev-parse <pr_head>^{tree}`; review read exactly `base..head`; evidence names g |
| C-STK-06 C5 | I-B4, I-15 | `stale_inputs`; run re-enters `implement`; next `inputs_seq` >= steer seq |
| C-STK-06 D6 | I-B5, I-16 | `rebase_pending`; next base = new main tip; review not re-run (equal patch-id), PR shows earlier review summary |
| C-STK-06 D7 | I-B6, I-17 | `stale_generation`; zero GitHub writes |
| C-STK-06 keep refs | I-B7, I-25 | every recorded head resolves under `refs/smithers/keep/` |
| C-STK-06 E8 | I-B8, I-33 | T2 `working` while T1 plans; T2 base = main tip |
| C-STK-06 E9 | I-B9, I-34 | T2 gets `rebase_pending{onto: T1.head}`; its next base = T1.head; PR head tree holds T1's change |
| C-STK-06 E10 | I-B10, I-35 | T3 base = T1.head |
| C-STK-07 steps 3,4 (held steers) | I-41..I-43 | recorded, never delivered after merge; delivered once if the merge fails |
| C-STK-07 step 9 (409 merging) | I-40 | Move, Before, amend, Drop refused while fenced |
| C-STK-07 steps 5-8 | owned by T-STK-04 | uses row 7 (pending work) from I-27..I-31 |
| C-J1-04 | journey, no new test | thin path; the first PR's tree is T1's accepted tree (TC-17) |

### 1.3 Gap rows and properties

| Item | Test |
| --- | --- |
| G16 drop rebuilds later candidates | TC-03, TC-18, TC-04, P-G1 |
| G19 reorder rebases | TC-05, U-R7, I-21 |
| G20 earlier item's new revision rebases later | U-R1..R3, I-34, TC-06 |
| G23 Smithers never writes `main` | P-G1 (fake log: zero ref updates to `refs/heads/main`), I-13 |
| G24 "Merged via #n" | T-STK-04; here TC-08, TC-09 pin which items are contained |
| P2 | P-G1, P-G2 (restated in section 4) |
| P11 (reconcile) | F-06..F-10, F-15, P-G4 |

## 2. Oracles from spec text only

### 2.1 Generation

| Fact | Oracle | Spec |
| --- | --- | --- |
| What it is | A candidate is an immutable commit of the working copy; each is a new generation g of the item = `{base: prefix head, head: C, tree: T, inputs_seq}` | 10.4.4 |
| Increments when | Exactly once per accepted `stack.candidate` call. Never on a refusal, on Propose (accepted or refused), on a head report, a steer, or a `rebase_pending` write | 10.4.4 step 1 |
| Number | Per item, strictly increasing, never reused (today's `start` also bumps it per attempt, `:1664`). Retry as a new attempt continues the number | 10.4.4, 4.1 |
| Void rule | Recording g voids `candidate_verified` of every earlier generation, in the same transaction as the row. At most one generation is verified at any time | 10.4.4 |
| Same tree, new base | A new generation (base differs); checks re-run. A rebase that leaves the tree equal still makes g+1 | 10.5.3, mvp 4.2 "checks rerun" |
| Verified head | C of the latest accepted generation | 10.4.4 |
| C | One commit; tree T; parent = prefix head; pinned `refs/smithers/keep/<C>` before the row commits; working-copy history unchanged | 10.4.4 step 1 |
| Evidence | Every entry carries g. A review summary from an earlier g shows only if its diff has the same `git patch-id --stable` | 10.4.3 |

| Event | generation | candidate_verified | pr_head |
| --- | --- | --- | --- |
| Candidate ok | +1 | earlier voided | unchanged |
| Candidate refused | same | unchanged | unchanged |
| Propose accepted | same | set for g | set after the push settles |
| Propose refused | same | unchanged | unchanged |
| Steer, head report, rebase_pending write | same | unchanged | unchanged |
| New attempt | +1 (continues) | void | unchanged |

### 2.2 What each candidate tree contains

Let items be in current stack order. For item N, `chain(N)` = the prefix chain recorded in its generation.

| Rule | Oracle | Spec |
| --- | --- | --- |
| Always | tree(C) = main-at-base + changes of `chain(N)` in current order + N's own change, each exactly once | 10.4.4, 12.5.1 |
| Chain membership | `chain(N)` is a subset of the earlier unmerged items. Never a dropped item, never a later item, never a merged item (main holds it) | 10.3.2, 12.5.1 |
| Dropped exception | A dropped item's change survives only in the first later item forked from it (`forked_from.item`) (gap S7) | 8.5.3a |
| Quiescent | When every earlier unmerged item has an accepted generation on the current prefix and no `rebase_pending` is open, `chain(N)` = all earlier unmerged items | 10.3.2, P2 |
| Partial | With an unverified earlier item, `chain(N)` omits it (nearest verified prefix). Its absence is correct, not a loss (gap S1) | 10.3.2 |
| Base | `base` = `chain(N)` last element's head, else mirror `main` tip | 10.3.2 |
| PR head P | One commit; tree = T; parent = mirror `main` tip at accept; message from title and body | 12.5.1, `:2029` |
| PR card diff | previous item's candidate tree to this one = own change only | 12.5.1 |
| First item | chain empty; base = main tip; PR ready. Others draft (where drafts exist) | 12.5.1 |
| Body | "Includes Tk..." lists exactly `chain(N)` | 12.5.1 |

### 2.3 Propose: acceptance, refusals, receipts

Accept iff all five hold (10.4.4 step 3): (1) g current; (2) second-capture tree = T; (3) no steer or amendment seq above g's `inputs_seq` (a member's review comment counts as a steer); (4) no `rebase_pending` and prefix head still g's base; (5) every check entry names g.

| Outcome | Writes | Run goes to |
| --- | --- | --- |
| Accept | PR head commit written and pinned; intended head recorded (`pending_op`); push with lease on the last accepted remote head; open or update PR; `candidate_verified` set; state `in_review` | wait for stack event |
| `stale_generation` | none (no row, no event, no GitHub call) | `candidate` |
| `edited` | none | `candidate` |
| `stale_inputs` | none | `implement` (steer first) |
| `rebase_pending` | none | wait for `rebased`, then `candidate` |
| Fence set on the item | none yet; call waits until the fence clears | 10.6.2b |

| Receipt rule | Oracle | Source |
| --- | --- | --- |
| Refusal | Records nothing; returns the reason only | 10.4.4 |
| Replay of an older g | `stale_generation`; zero GitHub writes | ticket Tests |
| Replay of the accepted current g | Not in spec (gap S4). QA oracle: same acceptance, same `pr_head`, zero new writes; if the tree changed since, `edited` | T-FLW-11 gap 4 |
| Push key | `push:<ref>:<intended head>`; a retry reuses it; a new generation gets a new key | 12.4.1 |
| Push lease | against the remote head Smithers last accepted; a refused lease is never retried, row `conflict`, `foreign_push` | 12.5.2 |
| Order | pin, then record, then push; recorded push settled from `ls-remote` after a crash: head = intended -> done; head = expected -> repeat; else conflict | 12.4.1b, `:1970-1993` |
| Concurrent duplicate calls for g | One acceptance effect; the stack claim serializes | 10.6.2b, C-STK-07 |
| Evidence naming | Evidence not naming g is a refusal (reason: gap S3) | 10.4.4 rule 5 |

### 2.4 Pending work

| Case | Oracle |
| --- | --- |
| Accepted g exists, head report tree = T | nothing |
| Report tree != T, item in_review | `edited` signal once, state stays in_review, Merge held (row 7 `pending_work`) |
| Same tree reported again | no second signal |
| Different second tree | signals again (once per new tree) |
| Report before g is accepted | no signal (the edit is caught by Propose rule 2) |
| Item working (steer or agent editing) | no signal; newest capture tree is still stored so row 7 is right in every state |
| Item merged or dropped | no signal |
| Where | the head-report route; the signal and the stored newest tree commit in one transaction |
| Never lost | each distinct non-accepted tree reported leaves either an `edited` signal or an accepted generation whose tree equals it |

### 2.5 The item's prefix and `rebase_pending`

| Case | Prefix of N | Spec |
| --- | --- | --- |
| First unmerged item | mirror `main` tip | 10.3.2 |
| Nearest earlier unmerged item with a verified head | that head | 10.3.2 |
| None verified | `main` tip | 10.3.2 |
| Earlier item merged | not a prefix; `main` already holds it | 10.6.3 |
| Earlier item dropped | skipped | 10.7.2 |
| Admission | never waits for a predecessor head; the start base is the prefix at launch | 10.3.2 |

| Event | Who gets `rebase_pending{onto}` | onto |
| --- | --- | --- |
| Earlier item publishes its first or a newer verified head | every later item | that later item's own prefix after the event |
| `main` moves | every unmerged item | new `main` tip (or its prefix) |
| Item merged in order | every later item | `main` |
| Drop, reorder, amend of an earlier item | every later item whose chain changes (10.7.2, 10.2.3; gap S8) | its new prefix |
| Written | in the same transaction as the event that causes it (QA oracle; lost flag is also caught by Propose rule 4) | |

## 3. Tree-content tests (real jj, real PostgreSQL)

Fixture `qa12Stack`: a real jj repo per item workspace, a git store, a fake GitHub. `main` holds `README.md` and `shared.txt` with five sections `## s1..## s5`, each `base`. Item i adds `t<i>.txt` = `T<i> v<k>` and sets section s<i> of `shared.txt` to `T<i> v<k>`. Sections are disjoint, so every expected tree is computable from the chain alone. The model `qa12Tree(main, chain, own)` in the skeleton runs today (U-T1..T4) and refuses an item applied twice, which is the "duplicated change" bug. A scenario's expected tree is `qa12Tree`, and assertions read file content of C and of P.

| Id | Scenario | Assert (by file content) |
| --- | --- | --- |
| TC-01 | N = 1..5, verify in order | Ti = main + T1..Ti-1 + Ti; no later item; own change once |
| TC-02 | Partial verification: T3 verified, T2 not, then T4 starts | T4 = main + T1 + T3 + T4 (no T2). T2 verifies later: T3 and T4 get `rebase_pending`; after recapture all hold T2 once |
| TC-03 | Drop each position, N = 2..5 (14 cases), recapture | no dropped item's file or section text in any later tree; earlier trees unchanged; later chains lose exactly that item |
| TC-04 | Drop Tn while T(k) is forked from Tn | T(k)'s tree keeps Tn's change (8.5.3a); items between lose it |
| TC-05 | Move T(k) up, every adjacent swap, N = 2..5 | moved item's tree loses the item it jumped over; the jumped item gains the moved item; tree of untouched later items equal but base differs, so a new generation exists |
| TC-06 | Amend T2 (V=2), verify, recapture later items | T3, T4 hold `T2 v2` once, never `T2 v1`, never both |
| TC-07 | Merge T1, T2, ... in order (N = 5), squash tree = accepted tree | after each merge, remaining items' trees are unchanged in content; base = new main tip; each merged change once in main and in no candidate twice |
| TC-08 | External out-of-order merge of T3, T1 and T2 in T3's chain | T1, T2, T3 folded; T4 = main + T4; no change twice |
| TC-09 | External merge of T3 when T2 had no verified head | T2 is not folded; T2 rebases onto the new main and keeps its change (gap S6) |
| TC-10 | Outside commit to `README.md` moves main | every item gets `rebase_pending`; next trees hold the outside edit once; P parent = new tip |
| TC-11 | Outside commit into T2's own section | no candidate with conflict markers (`<<<<<<<`) is ever recorded; item parks `rebase_pending`/conflict (T-STK-08) |
| TC-12 | Steer on accepted T2, g2 not yet accepted | T3's prefix stays g1.head until g2 is accepted (gap S2); then T3 `rebase_pending` onto g2.head |
| TC-13 | Edit after accept, `edited`, recapture | next tree = accepted tree + the edit; old generation voided |
| TC-14 | Edit reverted inside the capture window | Propose accepts (accepted limit, 10.4.4). Pins the limit so a later change is deliberate |
| TC-15 | Item's own change empty (agent changed nothing) | gap S15; test records the observed behaviour |
| TC-16 | Deleted file, rename, mode change, symlink, binary file, ignored file (`.smithers-test/`) | all in the tree as in the working copy; ignored paths absent |
| TC-17 | PR head for every item in TC-01 | one commit, parent = main tip, tree = T, `git rev-parse P^{tree}` = T |
| TC-18 | Drop the first item | T2 chain empty, base = main tip; T2's PR becomes ready (cross-check with T-GH) |
| TC-19 | Retry as a new attempt | numbering continues; trees as TC-01 |
| TC-20 | Two items edit neighbouring lines of one file | merged candidate has each line once |

Day-one tracer order: TC-01 (N=1), U-P1..P5, I-01, I-13, I-14, then I-B1..I-B5, TC-03, TC-05, TC-07.

## 4. Property test (P-G1, P-G2)

Driver: `math/rand` with seeds 1,2,3,5,8,13,21,34,55,89 (no new dependency); 500 sequences of up to 40 operations over a stack of at most 5 items. A failing seed is written to `.artifacts/checks/T-STK-12/counterexamples/<seed>.json` and kept as a fixed test.

Operations: append, before Tn, amend Tn, move up and down, drop, candidate(item), propose(item), steer, edit working copy, head report, apply pending rebase, Smithers merge (first item only), external out-of-order GitHub merge, outside commit on `main`, restart.

The model keeps: ordered items, each item's own change (sections and version), `forked_from`, main's files, each item's accepted generation and its chain. It never reads engine state to compute an expectation.

| Id | Invariant (checked after every operation unless "at rest") |
| --- | --- |
| P-G1a | Every recorded generation's tree = `qa12Tree(main at its base, its recorded chain, own)` by file content |
| P-G1b | Its chain is a subset of earlier unmerged items in current order; no dropped item (except an 8.5.3a fold), no later item, no merged item |
| P-G1c | At rest (no `rebase_pending`, every item captured and proposed on its current prefix): chain = all earlier unmerged items, so tree = main + all earlier unmerged + own (spec P2 restated with S1) |
| P-G1d | PR head tree = its item's accepted tree; PR head parent = current mirror main tip at accept; one commit |
| P-G1e | At most one generation per item `candidate_verified`; numbers strictly increase |
| P-G1f | Only the first unmerged item is mergeable by Smithers; an external merge folds exactly the items contained in the merged item's chain (P2, Codex correction) |
| P-G1g | Zero pushes or ref updates to `refs/heads/main` by Smithers (G23) |
| P-G2 | No change lost or duplicated: every non-dropped item's own change is in `main` or in every open later candidate exactly once; a dropped item's change is in neither (unless folded); at rest, `main` plus the open items equals the model's tree |
| P-G3 | Pending work: for any report sequence over {T, X1, X2, X3}, signals = number of transitions into a non-accepted tree not equal to the last signaled tree; none before acceptance |
| P-G4 | Crash property: add a random kill (any hook of section 5) and a restart. Every file written to a workspace and captured by a snapshot appears in the accepted generation tree, or the item shows `pending_work` or `rechecking` so merge is held. The fake GitHub never receives a head that is not an accepted generation's tree. After restart at most one effect per push key |
| P-G5 | Refusal purity: a refused Candidate or Propose leaves a hash of (generation rows, events, outbound_writes, fake log) unchanged |
| P-G6 | `SelectPrefix` equals a 10-line reference model over random stacks |

## 5. Fault cases

Each kills the process at a hook and restarts on the same PostgreSQL and git store. Common oracle: no lost captured work (the next successful Candidate's tree includes every write that existed in the working copy at the kill), and no stale-generation head: every head the fake receives is the tree of a generation Propose accepted. A merge is impossible in the window (row 5 `rechecking` while `pr_head` unset or `pending_op` non-empty).

| Id | Kill point | After restart |
| --- | --- | --- |
| F-01 | after jj snapshot, before commit write | no row; old generation still verified; retry captures again |
| F-02 | after `writeCommit`, before `pin` | no row; every recorded head is pinned |
| F-03 | after `pin`, before row commit | pinned orphan allowed; void and record are one transaction, so the old generation is still verified |
| F-04 | after row commit, before the response | g recorded, earlier voided; retry gives g or g+1 (S10), never two verified |
| F-05 | in Propose, after second capture, before accept | nothing recorded; no GitHub write |
| F-06 | after accept, before PR head commit | `candidate_verified`, `pr_head` empty: `rechecking`; the engine resumes; one push |
| F-07 | after PR head commit and pin, before `pending_op` | same commit recomputed or reused; one push key per intended head |
| F-08 | after `pending_op`, before push | `ls-remote` = expected: push once with lease |
| F-09 | after push, before PR open or update | `ls-remote` = intended: PR opened or updated once; GitHub head tree = T |
| F-10 | after PR update, before settle record | lookup finds it; no second PR; no second body write |
| F-11 | during the machine rebase | working copy is wholly the old or wholly the new base; no recorded half-rebased tree |
| F-12 | after rebase, before the `rebased` signal | `wake_reconcile` re-emits; run re-enters `candidate` once on the new prefix |
| F-13 | earlier item accepted, fan-out flag lost (injected) | later item's Propose refuses `rebase_pending` by prefix compare |
| F-14 | head report stored, `edited` not committed | the same report re-sent yields one `edited` |
| F-15 | kill during reconcile after F-09 | one PR update, one recovery receipt |
| F-16 | restart with a set merge fence, then Candidate | follows S9 ruling; the fence is untouched |

## 6. Spec gaps for the tech lead

| # | Gap |
| --- | --- |
| S1 | P2 and 12.5.1 say "main + earlier unmerged items" but 10.3.2 builds the prefix from verified heads only; a candidate over an unverified predecessor omits it. State the invariant as chain-based, with "all earlier items" only at rest. |
| S2 | "Verified head = latest accepted generation" vs "recording a generation voids earlier verification": while an item recaptures, is its old accepted head still the prefix for later items? QA assumes yes. |
| S3 | Precedence when several rules of 10.4.4 fail (stale_inputs should beat edited because `implement` re-captures); the reason for rule 5 (evidence not naming g); whether zero check entries is legal; code for a merged or dropped item (`todo_closed`?). |
| S4 | Replay of `Propose` for the accepted current g (after a crash): define idempotent success with `pr_head`, zero writes. "Propose receipt" has no field list (same as T-FLW-11 gap 4). |
| S5 | Propose acceptance has no "mirror main tip still equals base" rule; main can move before `rebase_pending` is written. A PR head with tree T on a newer main parent makes GitHub's squash revert the newer main change. Add the rule or make the check atomic with the mirror tip. |
| S6 | 10.6.4 folds "every earlier unmerged item it contained", but an earlier item without a verified head is not in the candidate (10.3.2). Define containment by the generation's recorded chain, or unmerged work is marked merged. |
| S7 | "Never a dropped item" collides with 8.5.3a (fold into the first forked successor); and "once per new tree" is unclear for X1, revert to T, X1 again. |
| S8 | Reorder, drop and amend of an earlier item are not 10.5.1 triggers ("publishes a new revision"), and the ancestor test in 10.4.4 passes for a working copy that still holds a removed item (T4 moved above T3: main is an ancestor, T3's change remains). Require `rebase_pending` on those events and a content check, not ancestry alone. |
| S9 | Does `stack.candidate` wait while a merge fence is set? Only `rebase_pending` and `stack.propose` are listed (10.6.2b); a Candidate voids verification mid-merge. |
| S10 | `stack.candidate` replay with an unchanged tree and inputs: same generation or a new one? Today `SubmitLane` replays idempotently (`:517`) (T-FLW-11 gap 23). |
| S11 | `inputs_seq` bounds: above any existing event, below the previous generation's, and which events count (answers, other items' amendments). |
| S12 | Pending work: which states signal `edited` (ticket: in_review only; 10.4.5: any after accept), and what "newest capture" means when reports arrive out of order (no sequence on the report). |
| S13 | Checks that rewrite tracked files make every propose `edited` forever; the policy is the lead's (ticket). Needed before C-J1-04 on a repository with a formatter check. |
| S14 | While a push settles, GitHub still shows the previous generation's head, and 10.6.2c says a returned-to-working PR stays ready. So "no stale-generation PR head on GitHub" cannot be an invariant; only "Smithers never writes a head that is not an accepted tree". Confirm. |
| S15 | An item whose own change is empty (tree = prefix tree): does it propose, open a PR, or go needs_you? |
| S16 | Is a rebase that leaves the tree equal a new generation with checks re-run? QA assumes yes (base differs, mvp 4.2 "checks rerun"). |

## 7. Counts

| Layer | Count | Ids |
| --- | --- | --- |
| Unit | 85 | U-G1..6, U-C1..8, U-P1..24, U-X1..14, U-W1..9, U-S1..5, U-R1..10, U-M1..5 (U-M5 catalog guard), U-T1..4 (run today) |
| Integration | 57 | I-01..I-47, I-B1..I-B10 |
| Tree-content | 20 | TC-01..TC-20 (TC-03 and TC-05 expand to 14 and 13 subtests) |
| Fault | 16 | F-01..F-16 |
| Property | 6 | P-G1..P-G6 |
| Concurrency | 8 | C-01..C-08 |
| Total | 192 | skeleton: 4 runnable, the rest `t.Skip("waits for T-STK-12 seam: ...")` |

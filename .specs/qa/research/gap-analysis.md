# Smithers MVP: acceptance-check gap analysis

Snapshot: 2026-10-02 22:17 UTC. Files copied to `scratchpad/qa/snap/` because the product, engineering and checks agents were editing during this review (`C-STK-01` gained `needs_you→queued`, and `C-MCH-09`, `C-MCH-10` and `C-REL-05` landed mid-read). Every line number below refers to that snapshot.

Sources: `product/mvp.md` (v2.5, 936 lines), `product/actions.md` (Appendix C), `engineering/spec.md` (v0.4, 1,233 lines), `engineering/overview.md`, `engineering/checks/*.md` (112 check files plus README).

Status codes: **C** covered by a check at a credible layer; **P** partially covered (a case, a layer or a parameter is missing, or the check is weak); **G** no check.

## 0. Summary

```
Requirements traced ........ 288   (§2, §3.1, §4, §5, §6, §7, §8, §9, §10, §12, App. B.3–B.5)
  Covered (C) ............... 196
  Partial (P) ............... 77
  Gap (G) ................... 15
Ranked gaps (section 2) ..... 77   (data loss 7 · security 7 · wrong merge 10 · honesty 10 · races 5 · release 12 · low 26)
Weak checks (section 3) ..... 38
Spec contradictions (4) ..... 18
Property/fuzz targets (5) ... 17
```

Largest holes, by risk:
1. Nothing proves a dropped, reordered or republished item stops riding in later PR candidates. All three paths can squash-merge the wrong content into `main` (G16, G19, G20).
2. Draft PRs are the only GitHub-side guard on merge order. No check covers demotion back to draft, or private repositories on free plans that have no drafts (G17, G18).
3. The `automerge` label merge path (mvp.md B.5 L913) has no check proving it is gone (G15).
4. No fault check kills anything during a rebase, and the host-side rebase of a sleeping branch has no check at all (G01, G02).
5. J11 steps 2–3 (Source, Run on a scratch branch) are in the release gate and have no check (G40).

---

## 1. Coverage matrix

### 1.1 §2 rules, §3 vocabulary, §3.1 actors

| ID | mvp L | Requirement | Checks | St | Gap / note |
| --- | --- | --- | --- | --- | --- |
| R001 | 53 | Every door runs the same typed flow; skill and CLI expose the app agent's catalog | C-CAT-01, C-CAT-02, C-CAT-03 | C | |
| R002 | 54 | One team, one machine, one repository; repository switching hidden | C-CUT-01 | C | |
| R003 | 56 | Chat plus cards; any card can be maximized | C-UI-02, C-UI-06 | C | |
| R004 | 57 | Honest state: seven states distinct; chat never waits | C-UI-05, C-J4-02, C-COL-02 | C | |
| R005 | 58 | A person's approval bound to the reviewed revision is required for `main` | C-ACC-02, C-J4-03, C-J1-04 | P | G15, G23 |
| R006 | 59 | Minimal text | C-UI-02 | C | |
| R007 | 66 | Write access re-checked at sign-in and hourly; loss suspends | C-ACC-03, C-ACC-04 | C | |
| R008 | 67 | `main` is read-only; work reaches it only through a merged PR | C-J10-07 (one scenario) | P | G23; X16 |
| R009 | 69 | TODO id `Tn` from commit; `#n` stays for GitHub | C-J7-01, C-CAT-02 | C | |
| R010 | 109 | App agent runs UI-only flows only on the prompter's screen | C-UI-06 | C | |
| R011 | 109 | App agent can't run anything on a machine (no terminal input, file write or command) | none | G | G08 |
| R012 | 109 | "Run tests on X" becomes a request to that branch's coding agent, shown "Ben via Smithers asked" | none | G | G08 |
| R013 | 109 | App agent can't approve, merge, or manage people or secrets | C-ACC-01, C-ACC-02, C-UI-06 | C | |
| R014 | 110 | Coding agent can't merge, touch other branches, change settings, edit system flows, `sudo` or read homes | C-ACC-01, C-SEC-02, C-MCH-06 | C | |
| R015 | 111 | External agent has the app agent's catalog; merge opens Review & merge | C-CAT-02, C-J6-01, C-J6-02 | P | X5 (stage-1 token is narrower) |
| R016 | 112 | System is the only writer of branch history; every op attributed in activity | C-J7-02, C-J10-04 | P | reorder and merge attribution unasserted; G68 |
| R017 | 94, 743 | One card per flow whoever acts (agent `bash` → Terminal, writes → File/Diff, question → Needs you) | C-J3-10, C-J3-04, C-J2-03 | C | |

### 1.2 §4.1 TODO states and transitions

| ID | mvp L | Requirement | Checks | St | Gap / note |
| --- | --- | --- | --- | --- | --- |
| R018 | 123 | Queued → Starting (machine granted, flow pinned) | C-STK-01, C-MCH-02, C-UI-05 | C | |
| R019 | 123 | Starting → Working (first step) | C-STK-01, C-MCH-02, C-UI-05, C-J4-01 | C | |
| R020 | 123 | Working → Needs you | C-STK-01, C-J2-03, C-J3-09 | C | |
| R021 | 123 | Needs you → Working (first answer, Bring in) | C-STK-01, C-J2-03, C-J10-03, C-J7-03 | C | |
| R022 | 123 | Needs you → Queued (answered after the machine was released) | C-STK-01 (unit only) | P | G26 |
| R023 | 124 | Working → Paused on Stop; machine released at safe-idle | C-STK-01, C-STK-03 | C | |
| R024 | 124 | Paused → Queued on Resume; same run, last finished step | C-STK-03 | C | |
| R025 | 125 | Working → In review (PR opened) | C-STK-01, C-J1-04, C-J2-04 | C | |
| R026 | 125 | In review → Merged | C-J2-05, C-J10-05, C-J4-03 | C | |
| R027 | 126 | In review → Working (changes requested or steer) | C-J10-02, C-STK-05, C-STK-01 | C | app steer from in_review is unit-only |
| R028 | 127 | In review → Needs you (rebase conflict the agent can't resolve) | C-STK-01 (unit only) | P | G29 |
| R029 | 128 | Starting → Failed | C-STK-01 (unit only) | P | G28 |
| R030 | 128 | Working → Failed; failure names the step | C-STK-03, C-DUR-02 | C | |
| R031 | 128 | Failed → Queued on Retry; earlier attempts and evidence kept | C-STK-03, C-DUR-02, C-J4-02 | C | |
| R032 | 129 | Any unmerged state → Dropped | C-STK-01; C-J7-02 (from working); C-J10-08 (in_review, GitHub) | P | G16 |
| R033 | 134 | Queued shows reason and position | C-MCH-02, C-STK-02, C-UI-05 | C | |
| R034 | 137 | Any member answers a question | C-J2-03 | C | |
| R035 | 137 | Approvals that gate a merge: maintainer only | none | G | G10 |
| R036 | 137 | First accepted answer settles; "Ben answered"; draft kept with Send as steer | C-J2-03, C-J3-09 | C | race n=1 (W13) |
| R037 | 137 | A steer while a question is open reaches the agent as context and doesn't settle | C-STK-01 (self-loop, unit) | P | G27 |
| R038 | 137 | Agent may replace its question; only an answer settles | none | G | G27 |
| R039 | 139 | Failed: evidence kept; Retry, steer or drop | C-STK-03 | C | |
| R040 | 142 | Dropped: PR closes, later items rebase | C-J7-02 (PR close), C-J10-08 (GitHub close only) | P | G16 |
| R041 | 144 | Learning is a separate run, never changes Merged; receipt opens pages and proposal | C-J2-05, C-J8-01, C-J5-03, C-STK-01 | C | |

### 1.3 §4.2 placement, rebase and merge

| ID | mvp L | Requirement | Checks | St | Gap / note |
| --- | --- | --- | --- | --- | --- |
| R042 | 149 | Append is the default | C-J9-01, C-J2-02, C-J1-04 | C | |
| R043 | 150 | Before Tn | C-J7-01, C-J2-01 | C | |
| R044 | 151 | Amend Tn: no new TODO; prompt and acceptance updated; same branch and PR; "+1" | C-J7-01, C-J10-01 | P | acceptance amend unasserted (G71) |
| R045 | 152 | Items work in parallel, each on its own branch | C-STK-02, C-MCH-01 | C | |
| R046 | 153 | `main` moves → later items rebase | C-J10-04, C-J7-03 | C | |
| R047 | 153 | An earlier item publishes a new revision → later items rebase | none | G | G20 |
| R048 | 153 | Agent-only branch rebases at the agent's next checkpoint | C-J10-04 | C | |
| R049 | 153 | People present → "Rebase pending"; runs when nobody is present or on Rebase now | C-J10-04, C-PERF-06 | C | |
| R050 | 153 | Snapshot every writer first; never run during a Smithers write | C-PERF-06 (fail-when only) | P | G01 |
| R051 | 153 | "Rebased onto T2" in activity; open cards refresh | C-J7-03, C-J10-04, C-PERF-06 | P | card refresh only in the S3 marker step (G72) |
| R052 | 153 | Rebase changes the revision: checks rerun, approval void | C-J7-03, C-J10-04, C-J4-03 | C | |
| R053 | 153 | Unresolvable conflict → Needs you with Resolve | C-J7-03 | C | |
| R054 | 154 | Only the next item merges; later items read "Merges after Tn" | C-J4-03, C-J4-01 | C | no concurrency (G21) |
| R055 | 154 | Move up, Move down and Drop unblock a stuck item | C-J4-02 (move up only) | P | G19, G16 |
| R056 | 154 | Each PR is the verified candidate, based on `main`, squash-merged | C-J10-01, C-J2-05 | C | |
| R057 | 154 | Only the next PR is ready; later PRs are drafts, so GitHub won't merge them | C-J7-01, C-STK-04 (setup) | P | G17, G18, X11 |
| R058 | 154 | PR card shows only the item's own change | C-J10-01 | C | |
| R059 | 154 | After a merge the next PR is rebased, holds only its change and becomes ready | C-J10-01, C-J10-05, C-STK-04 | P | G22 |
| R060 | 154 | Out-of-order merge → Needs you note, both Merged, `main` folded | C-STK-04 | P | G24 |
| R061 | 155 | No splitting or squashing across TODOs | C-CUT-01 | C | |

### 1.4 §5 journeys

| ID | mvp L | Requirement | Checks | St | Gap / note |
| --- | --- | --- | --- | --- | --- |
| R062 | 163 | J1.1 one-time setup link; setup session can only do setup | C-J1-01, C-SEC-04, C-ACC-04, C-INS-03 | P | G11 |
| R063 | 165 | J1.2.1 Address first | C-J1-02 | C | |
| R064 | 166 | J1.2.2 App by manifest | C-GH-01, C-J1-02 | C | |
| R065 | 167 | J1.2.3 Owner sign-in through the App claims; then choose repo and install App | C-J1-02, C-ACC-04, C-SEC-04 | P | X8 (C-J1-02 order) |
| R066 | 168 | J1.2.4 Fast, coding (key or ChatGPT sign-in) and Jev | C-J1-02, C-J11-03 | P | G46 |
| R067 | 169 | J1.2.5 Squash check links to the fix | C-J1-02 | C | |
| R068 | 170 | J1.3 Questions work once source is readable | C-J1-03 | C | |
| R069 | 171 | J1.4 Source ready and Machine ready separate; no-declaration repo works | C-J1-02, C-J1-06 | P | G44 |
| R070 | 172 | J1.5 Answer with file cards | C-J1-03, C-PERF-01 | C | |
| R071 | 173 | J1.6 First TODO → branch, machine, agent, PR with evidence | C-J1-04, C-J1-06, C-J2-04 | C | |
| R072 | 174 | J1.7 Review and merge in the app | C-J1-04 | C | |
| R073 | 175 | J1.8 Add Maintainer and Member by username; open address; set secrets | C-J1-05, C-MCH-07 | C | |
| R074 | 177 | Unassisted first merge within 60 min | C-J1-04 | P | n=1, one repo type (W10) |
| R075 | 182 | J2.2 Make TODO drafted from discussion, edited, placed, committed | C-J2-01, C-J9-01 | C | |
| R076 | 182 | J2.2 `todo` label commits current text; idempotent; later edits ignored | C-J2-02, C-SEC-03 | C | race not concurrent (W12) |
| R077 | 183 | J2.3 Queues, gets a branch, Working | C-J1-04, C-UI-05 | C | |
| R078 | 184 | J2.4 Question → Needs you; toast to owner and branch; any member answers | C-J2-03 | C | |
| R079 | 185 | J2.5 PR evidence | C-J2-04 | C | |
| R080 | 186 | J2.6 Merged; issue closes iff fixes; learning follows | C-J2-05 | C | |
| R081 | 190 | J3.1 Open the branch from Needs you | C-J3-09, C-J3-01 | C | |
| R082 | 191 | J3.2 Presence with where; "Maya via SSH"; SSH saves attributed | C-J3-01, C-J3-06 | C | |
| R083 | 192 | J3.3 Own terminal; teammate watches | C-J3-02 | C | |
| R084 | 193 | J3.4 `pnpm format` → one entry; cards update; nothing breaks | C-J3-03 | C | |
| R085 | 194 | J3.5 Live co-edit with colours, flags, continuous save | C-J3-04, C-PERF-03 | C | |
| R086 | 195 | J3.6 Input reads "Answer the coding agent"; a steer never settles | C-J2-03, C-J3-05 | P | G27, G62 |
| R087 | 199 | J4.1 Home counts and merged since last look | C-J4-01 | C | |
| R088 | 200 | J4.2 Answer, merge next, move up, retry with steer | C-J4-02 | C | |
| R089 | 201 | J4.3 Toasts report progress; nothing blocks | C-J4-02, C-UI-05 | C | |
| R090 | 205 | J5.1–2 App agent proposes a flow edit as a diff | C-J5-01 | C | |
| R091 | 207 | J5.3 Edit → TODO → merged → Active after sync and load | C-J5-01, C-J5-02 | C | |
| R092 | 208 | J5.4 New TODOs use the new version; running ones keep theirs | C-J5-01, C-DUR-02 | C | |
| R093 | 209 | J5.5 Learning proposal → TODO → next TODO passes lint | C-J5-03 | C | |
| R094 | 213 | J6.1 Terminal signed in as the member, skill installed, own subscription | C-J6-01, C-MCH-10, C-REL-05 | C | Codex unexercised (G59) |
| R095 | 214 | J6.2 Its edits land in the shared working copy, live for teammates | none direct (C-J3-03 is the SSH analog) | P | G45 |
| R096 | 215 | J6.3 Skill reads wiki, answers, places a follow-up; "Ben via Claude Code" | C-J6-01 | P | X4, X5 |
| R097 | 216 | J6.4 Laptop `smthrs login` | C-J6-02 | C | |
| R098 | 217 | J6.5 Teammates watch but can't use the login | C-J3-02, C-MCH-06, C-MCH-09 | C | |
| R099 | 221 | J7.1 Insert before T3; amend T2 shows "+1" | C-J7-01 | C | |
| R100 | 222 | J7.2 Fork starts from T2's current revision | C-J7-02, C-MCH-08 | P | X7 |
| R101 | 223 | J7.3 Add to stack includes T2's work; dropping T2 loses nothing | C-J7-02 | P | G03 (W18) |
| R102 | 224 | J7.4 Stack rebases; agent resolves a conflict and shows it | C-J7-03 | C | |
| R103 | 228 | J8.1 Learning writes a decision page with reason and link | C-J8-01 | C | |
| R104 | 229 | J8.2 Live wiki co-editing | C-J8-02 | C | |
| R105 | 230 | J8.3 Next related plan cites the edited revision and follows it | C-J8-04 | P | "follows" unasserted (W20) |
| R106 | 234 | J9 Ask; cards; Make TODO; Save to wiki | C-J9-01 | C | |
| R107 | 240 | J10.1 PR shape | C-J10-01 | C | |
| R108 | 241 | J10.2 Review comment → steer within 60 s → Working → fix updates PR | C-J10-02, C-STK-05, C-GH-07 | C | |
| R109 | 242 | J10.3 Laptop push → hold; Bring in or Discard | C-J10-03 | C | |
| R110 | 243 | J10.4 Unrelated merge → `main` row; Rebase pending | C-J10-04 | C | |
| R111 | 244 | J10.5 Merge on GitHub → Merged; issue closes with link | C-J10-05 | C | |
| R112 | 245 | J10.6 "synced 40 s ago"; gold on network loss | C-J10-06, C-GH-07 | C | |
| R113 | 249 | J11.1 Inspect: graph, I/O, transcript, retries, wait, tokens and time | C-J11-01 | C | |
| R114 | 255 | J11.2 Source opens the flow in the File card; add a step | none | G | G40 |
| R115 | 256 | J11.3 Run with test input on a scratch branch; new graph live | none | G | G40 |
| R116 | 257 | J11.4 Open the review agent from the step; switch its model | C-J11-03 | P | X3 |

### 1.5 §6 features

| ID | mvp L | Requirement | Checks | St | Gap / note |
| --- | --- | --- | --- | --- | --- |
| R117 | 272 | Install: launchd, PG 18, microVM isolation on, bundled base image, no Docker | C-INS-05, C-J1-01, C-REL-02, C-SEC-02, C-SPK-06 | P | G70 |
| R118 | 273 | Loopback by default; bind and origins; SSH on the same address; plain HTTP works | C-INS-01, C-INS-03 | C | |
| R119 | 274 | Toolchain detection: npm, pnpm, yarn, bun, Go, Rust, uv, pip; others need a declaration | C-J1-06 (pnpm, Go) | P | G44 |
| R120 | 275 | Restart: replay; reconcile; interrupted shown | C-DUR-01..04, C-GH-09 | C | |
| R121 | 281 | GitHub sign-in; members need write access; no separate accounts | C-ACC-04, C-J1-05 | C | |
| R122 | 282 | Roles | C-ACC-01 | C | one route per row (W1) |
| R123 | 292 | `main` moves → rebases; `main` row; follow `main` by default | C-J10-04, C-GH-07, C-GH-08 | C | |
| R124 | 293 | Issue changes update the card; Make TODO | C-GH-07, C-J2-01 | C | |
| R125 | 294 | `todo` label by a member | C-J2-02, C-SEC-03 | C | |
| R126 | 295 | Review or comment → steer; changes requested → Working | C-J10-02 | C | edited/deleted comments unasserted |
| R127 | 296 | Checks update evidence; a failed required check holds Merge, named | C-J2-04, C-J4-03 | C | |
| R128 | 297 | PR merged on GitHub → Merged; out-of-order handled | C-J10-05, C-STK-04 | C | |
| R129 | 298 | PR closed → Dropped "by @x"; reopening restores | C-J10-08 | P | X6 |
| R130 | 299 | Laptop push → hold; Bring in or Discard | C-J10-03 | C | |
| R131 | 300 | `/review` works on any PR | none | G | G50 |
| R132 | 301 | Branch protection respected; GitHub's reason shown | C-J4-03 | C | |
| R133 | 307 | PR on `smithers/<slug>`; body; App; "Requested by"; ready only if next | C-J10-01, C-J7-01 | C | |
| R134 | 308 | Commits reach GitHub at propose and on each update; one squash commit | C-J10-01, C-J2-05 | C | |
| R135 | 309 | Make TODO → label and "Committed as T12" | C-J2-01 | C | |
| R136 | 310 | Squash merge; setup check; fixes → issue closes with link | C-J2-05, C-J10-05, C-J1-02 | C | |
| R137 | 311 | Scratch branches stay off GitHub | C-J7-02 | C | |
| R138 | 318 | Polling targets 1 min and 5 min with no public address | C-GH-07, C-GH-08 | C | sample kinds weak (W6) |
| R139 | 319 | Gold past 2× target; names cause with Settings fix | C-J10-06, C-GH-08 | C | |
| R140 | 320 | App setup in one step | C-GH-01 | C | |
| R141 | 321 | `main` rewritten → owner confirms → rebase | C-J10-07 | C | X18 |
| R142 | 327 | Home card | C-J4-01 | C | |
| R143 | 328 | One shared conversation per branch; private view state; branch tree; ⌘K | C-UI-06 | C | |
| R144 | 329 | No person-to-person chat | C-UI-06 | C | |
| R145 | 330 | Commands list only MVP flows; debug and admin hidden | C-CAT-01, C-CUT-01 | C | |
| R146 | 331 | Toasts with one action; hideable; kept as timeline entries; edge indicators | C-UI-04 | P | "PR ready" toast (G69) |
| R147 | 332 | Timeline summaries, tones, band, pills | C-UI-04 | C | |
| R148 | 333 | Browser notifications; one ask; HTTP hides Allow; "Notifications need HTTPS" | C-UI-03 | P | G53 |
| R149 | 334 | Normal, Vim, dictation; keyboard-only; both themes gate acceptance | C-UI-01, C-UI-02 | P | G55, G42 |
| R150 | 340 | Three model roles; fallback without a fast key | C-J11-03, C-J1-02 | C | |
| R151 | 341 | Answers with cards; Jev picks commands | C-J1-03, C-J9-01 | C | |
| R152 | 342 | Context preflight; chip; Inspect shows it first | C-UI-07, C-PERF-01 | C | |
| R153 | 343 | Same flows through one tool; missing inputs → form card | C-UI-06, C-J9-01 (fail-when) | P | G73 |
| R154 | 349 | Create from chat, issue, label; three placements | C-J9-01, C-J2-01, C-J2-02, C-J7-01 | C | |
| R155 | 350 | TODO card fields; prompt editable while Queued | C-J2-04, C-UI-08 | P | G05 |
| R156 | 351 | Parallel work; later items rebase | C-STK-02 | C | X13 |
| R157 | 352 | Move up, Move down, Drop; only the next merges | C-J4-02, C-J4-03 | P | G19 |
| R158 | 353 | Steer | C-J3-05 | C | |
| R159 | 354 | Stop and Resume from the last finished step | C-STK-03 | C | |
| R160 | 360 | One live branch | C-MCH-01 | C | |
| R161 | 361 | Branch card: presence, machine, item and place ("3rd in stack") or "scratch" | C-J3-01, C-UI-08 | P | G54 |
| R162 | 362 | Fork from `main`, an item or a branch; Add to stack | C-J7-02, C-MCH-08 | C | |
| R163 | 363 | Idle branch sleeps; reads never wake; only work wakes | C-MCH-03, C-PERF-05 | P | idle timers (G61) |
| R164 | 364 | One admission queue; people first; release when safe-idle | C-MCH-02, C-STK-02 | C | |
| R165 | 365 | Cleanup only when settled, captured, no session; history kept | C-MCH-05 | C | |
| R166 | 371 | Presence with where | C-J3-01 | C | |
| R167 | 372 | Live co-editing (Yjs, < 1 s, colours, flags, continuous save, attributed writes) | C-J3-04, C-PERF-03, C-SPK-07 | C | |
| R168 | 373 | No silent overwrite: base version; stale refused; agent retries; bypass writes recoverable | C-COL-01, C-UI-05, C-J3-03, C-J3-04 | P | G35 |
| R169 | 374 | External change attribution (exact through Smithers; single session; else outside) | C-J3-03 | C | |
| R170 | 374 | Grouped burst entry opens the diff | C-J3-03, C-PERF-04 | C | |
| R171 | 374 | Open File card applies live; deleted and renamed states | C-J3-08 | C | |
| R172 | 374 | Moved off → Needs you; Return to Tn; Keep for now | C-J3-09 | C | |
| R173 | 374 | Agent re-reads changed files | C-J3-03 | C | |
| R174 | 374 | Ignored paths never show as edits | C-J3-03 | C | |
| R175 | 374 | Every change recoverable from snapshots | C-DUR-04, C-J3-03 | C | |
| R176 | 375 | Saved within 1 s; survives restart | C-J3-04 | C | |
| R177 | 375 | Outside save on an open file: merge, or live wins with snapshot and Compare | C-J3-04 | P | one typist (W14) |
| R178 | 375 | Bursts end 1.5 s after the last write and at most every 10 s | C-J3-03 (1.5 s only) | P | G04 |
| R179 | 375 | Restore this file | C-J3-03 | C | |
| R180 | 376 | File, Diff and Branch cards update live | C-PERF-04, C-J3-03 | P | Diff card (G74) |
| R181 | 377 | Per-person terminal user; per-machine home; log in once; credential store; watch-only | C-J3-02, C-MCH-06, C-MCH-09, C-MCH-10, C-REL-05 | C | C-MCH-06 L33 stale (X14) |
| R182 | 378 | Agent transcript, steers and runs visible to everyone on the branch | C-J3-05 | P | G75 |
| R183 | 379 | No carets or selections | C-J3-04 | C | |
| R184 | 385 | Coding agent works the TODO flow; reads wiki; cites revisions | C-J1-04, C-J8-04, C-J10-02 | C | |
| R185 | 386 | Owner's model access; recorded per run; personal subscriptions only in terminals | C-J2-04, C-SEC-01 | C | |
| R186 | 392 | PR card; Merge only for the next item; approval of exact revision | C-J2-04, C-J4-03, C-ACC-02 | C | |
| R187 | 394 | No agent credential can merge or move `main` | C-ACC-01, C-ACC-02, C-J6-02, C-SEC-05 | P | G15, G23 |
| R188 | 400 | Wiki editing, co-editing, backlinks, outline | C-J8-02 | P | G67 |
| R189 | 401 | One vault for both agents; planning records revisions | C-J8-04 | C | |
| R190 | 402 | Obsidian two-way sync from Settings | C-J8-03 | C | weak (W19) |
| R191 | 403 | Generated pages refresh after merges; default declaration | C-J1-06 (declaration only) | P | G49 |
| R192 | 409 | Default flows built in; configuration in the install | C-J1-06 | C | |
| R193 | 410 | Flow card tells proposed, merged and active apart | C-J5-01, C-J5-02 | C | |
| R194 | 411 | Only todo, learning, review and repository flows overridable; edits are TODOs; run in a machine | C-J5-01, C-SEC-02 | P | G09 |
| R195 | 412 | Pinned versions; Retry vs Retry with the current flow; "Merged · not active" | C-J5-01, C-J5-02, C-DUR-02 | P | G25 |
| R196 | 413 | Learning writes decisions and proposals; a member decides each | C-J8-01, C-J5-03 | P | G56 |
| R197 | 414 | Repository flows as slash commands with typed forms | C-CAT-01, C-SEC-02 | C | |
| R198 | 420 | Skill carries the catalog | C-CAT-03 | C | |
| R199 | 421 | CLI covers every MVP flow; auto sign-in; delegated; confirmation for person-only | C-CAT-02, C-J6-01, C-J6-02, C-ACC-02 | C | |
| R200 | 422 | API open, documented, the same one the app uses | C-CUT-01, C-REL-01 | C | |
| R201 | 423 | Attribution: person plus agent | C-J3-05, C-J6-01, C-J6-02 | P | X4 |
| R202 | 427 | Advanced one click away; collapsed in `/help`; one hint after first merge | C-CAT-01 | P | G52 |
| R203 | 431 | Monitor, Thrashing flag, read-only replay, custom view | C-J11-01, C-J11-04 | P | G65 |
| R204 | 432 | Write flows: `/flow.new`, Source co-edit, Plan preview, Run on scratch | none | G | G40, G64 |
| R205 | 433 | Configure an agent: instructions via TODO; model applies immediately | C-J11-03 | P | X3 |
| R206 | 436 | Every durable wait visible in the monitor | C-J11-01 | C | |
| R207 | 438 | Raw developer tools hidden | C-CUT-01, C-CAT-01 | C | |
| R208 | 446 | Members card; add, change role, remove; no invitations; take over; role seeding | C-J1-05, C-ACC-03, C-ACC-04 | C | |
| R209 | 447 | Role permissions | C-ACC-01 | C | W1 |
| R210 | 448 | Secrets write-only; two scopes; provider keys on host | C-MCH-07, C-SEC-01, C-ACC-01 | P | G12 |
| R211 | 449 | SSH: one line; GitHub or `ssh-key` keys; lands as self; editors; forwarding | C-J3-06, C-INS-03, C-MCH-06 | P | G63 |

### 1.6 §7 decisions with testable behavior, §8 cuts

| ID | mvp L | Requirement | Checks | St | Gap / note |
| --- | --- | --- | --- | --- | --- |
| R212 | 455 | M-01 done = merged on GitHub | C-J2-05, C-J10-05 | C | |
| R213 | 456 | M-02 live code co-editing, versioned writes | C-J3-04, C-COL-01 | C | |
| R214 | 457 | M-03 no public address | C-GH-01, C-GH-07, C-GH-08 | C | |
| R215 | 458 | M-04 self-improvement only through merged TODOs | C-J5-01, C-J5-03 | C | |
| R216 | 459 | M-05 roster plus live write access; roles | C-ACC-01..04 | C | |
| R217 | 460 | M-06 capacity from the detected host | C-MCH-04, C-SPK-05, C-J1-01 | C | |
| R218 | 461 | M-07 one stack; three placements | C-J7-01 | C | |
| R219 | 462 | M-08 shared conversation; author's authority | C-UI-06 | C | |
| R220 | 463 | M-09 no Cloud or billing | C-CUT-01 | C | |
| R221 | 464 | M-10 Apple Silicon macOS only | none | G | G57 |
| R222 | 465 | M-11 default flows built in | C-J1-06 | C | |
| R223 | 467 | M-13 people first; no preemption | C-MCH-02, C-STK-02 | C | |
| R224 | 468 | M-14 toast recipients | C-J2-03, C-UI-04 | C | |
| R225 | 469 | M-15 learning is a receipt | C-J2-05, C-STK-01 | C | |
| R226 | 470 | M-16 TODO is its own object | C-J2-01, C-J2-02 | C | |
| R227 | 471 | M-17 multi-member; branch locks removed | C-MCH-01, C-CUT-01 | C | |
| R228 | 472 | M-18 personal logins; watch, not type | C-J3-02, C-MCH-06, C-MCH-09, C-MCH-10 | C | |
| R229 | 473 | M-19 no benchmark claim without a sealed run | none | G | G66 |
| R230 | 475 | M-21 any agent through skill and CLI | C-CAT-02, C-CAT-03, C-J6-01, C-J6-02 | C | |
| R231 | 476 | M-22 GitHub merge or close counts | C-J10-05, C-J10-08, C-J7-02 | C | |
| R232 | 477 | M-23 advanced primitives one click away | C-J11-01, C-J11-03 | P | G40 |
| R233 | 478 | M-24 SSH | C-J3-06 | C | |
| R234 | 479 | M-25 secrets; GitHub comments as steers | C-MCH-07, C-J10-02 | C | |
| R235 | 480 | M-26 upgrade, start, stop, status, backup, restore | C-REL-03, C-J1-01 | P | G06 |
| R236 | 481 | M-27 external changes handled and shown | C-J3-03, C-J3-08, C-J3-09, C-DUR-04 | C | |
| R237 | 482 | M-28 any address; plain HTTP | C-INS-01, C-INS-03 | C | |
| R238 | 483 | M-29 no `sudo`; Add to machine image is a change | C-MCH-06 | P | G58 |
| R239 | 484 | M-30 system flows can't be overridden | C-SEC-02 (`merge` only), C-J11-03 | P | G09 |
| R240 | 486 | M-32 stack service is the only writer; jj ops never model output | C-J7-02 | P | G68 |
| R241 | 487 | M-33 never overwrite a person's commit | C-J10-03, C-DUR-03 | C | |
| R242 | 495–518 | §8 cuts absent; deferrals hidden; trust rules enforced | C-CUT-01, C-CAT-01, C-SEC-03 | C | |

### 1.7 §9 quality bar, §10 scorecard, §12 release

| ID | mvp L | Requirement | Checks | St | Gap / note |
| --- | --- | --- | --- | --- | --- |
| R243 | 526 | First token < 1.5 s; answer with cards < 8 s | C-PERF-01 (n=100) | C | |
| R244 | 527 | Warm wake < 5 s; a cold image is progress, not a spinner | C-PERF-05, C-J1-02 | P | later cold wakes (G76) |
| R245 | 528 | Keystroke < 1 s; agent or terminal disk write < 1 s | C-PERF-03, C-PERF-04, C-SPK-07 | P | agent write path untimed (G77) |
| R246 | 529 | GitHub freshness < 1 min | C-GH-07 | C | W6 |
| R247 | 530 | Durability: no completed step re-runs; reconcile; resume or interrupted | C-DUR-01..04, C-GH-09 | P | G01; W4, W5 |
| R248 | 531 | Honesty: no state before it's true; failure names step, retryable | C-UI-05, C-STK-03, C-DUR-02, C-COL-02 | P | no universal invariant test (P1, P6) |
| R249 | 532 | Every P0 journey keyboard-only | C-UI-01 | P | G43 |
| R250 | 533 | Product words only | C-UI-02, C-CAT-03 | C | |
| R251 | 534 | Isolation: microVM per branch; keys on host; agents can't merge; no `sudo` | C-MCH-01, C-SEC-01, C-SEC-02, C-ACC-01, C-MCH-06 | C | |
| R252 | 538–553 | Scorecard measures from run data | C-REL-04 | P | G34, X9 |
| R253 | 585 | J1–J8, J10, J11 end to end, fresh Mac mini, second laptop, both themes | journey layer only C-J1-01, C-J1-04, C-J5-03 | P | G41, G42 |
| R254 | 586 | Recording includes a restart mid-run | C-DUR-01, C-J10-02 | P | G41 |
| R255 | 587 | … a duplicate launch | C-UI-05, C-J2-01, C-J9-01 | P | G41 |
| R256 | 588 | … two typists on one line; out-of-band stale save recorded and recoverable | C-J3-04 | C | |
| R257 | 589 | … an outside save on a file two people are typing in | C-J3-04 step 6 | P | W14 |
| R258 | 590 | … next plan follows the edited wiki revision | C-J8-04 | P | W20 |
| R259 | 591 | … recovery receipts for the restart | C-DUR-03 (GitHub writes only) | P | G33 |
| R260 | 592 | Dogfood target met | C-REL-04 computes; nothing gates on live data | G | G48 |
| R261 | 593 | Every §8 cut gone | C-CUT-01 | C | |
| R262 | 594 | Docs: one quickstart plus flows reference | C-REL-01 | C | |
| R263 | 595 | Public macOS install; no Smithers account | C-REL-02, C-J1-01 | C | |
| R264 | 596 | Launch-day install upgrades in place | C-REL-03 | C | |

### 1.8 Appendix B in-card controls (B.4), coding-agent actions (B.3), system flows (B.5)

| ID | mvp L | Requirement | Checks | St | Gap / note |
| --- | --- | --- | --- | --- | --- |
| R265 | 885 | `todo.return-to-item` | C-J3-09 | C | |
| R266 | 886 | `todo.keep-moved` | C-J3-09 | C | |
| R267 | 887 | `branch.bring-in` / `branch.discard-foreign` (maintainer for Discard) | C-J10-03 | C | race (G37) |
| R268 | 888 | `file.restore` | C-J3-03 | C | |
| R269 | 889 | `file.compare` | C-J3-04, C-J3-03 | C | |
| R270 | 890 | `file.restore-deleted` / `file.follow-rename` | C-J3-08 | C | |
| R271 | 891 | `todo.retry-current-flow` | none | G | G25 |
| R272 | 892 | `branch.rebase-now` | C-J10-04, C-PERF-06 | C | |
| R273 | 893 | `learning.accept` / `learning.dismiss` | C-J5-03 (accept only) | P | G56 |
| R274 | 894 | `terminal.watch` | C-J3-02 | C | |
| R275 | 895 | `notifications.allow` | C-UI-03 | C | |
| R276 | 896 | `todo.takeover` | C-ACC-03 | C | |
| R277 | 897 | `merge.confirm` | C-ACC-02, C-J6-01 | C | |
| R278 | 898 | `order.ok` | C-STK-04 | C | |
| R279 | 899 | `background.retry` / `background.dismiss` | C-J4-01 | C | |
| R280 | 868 | Agent `bash` in its own watchable terminal | C-J3-10 | C | |
| R281 | 869 | `test` bound from toolchain detection | C-J1-06 | P | G44 |
| R282 | 873 | `ask` bound for the implementing agent | C-J2-03 | C | |
| R283 | 913 | Stack merge only after a person's approval at the exact head; `automerge` path removed | C-J4-03 | P | G15 |
| R284 | 914 | Fold; close the issue only when the TODO fixes it | C-J2-05 | C | |
| R285 | 915 | Wiki refresh after merges as a background run | none | G | G49 |
| R286 | 920 | Learning as a background machine run | C-J8-01 | C | |
| R287 | 921 | Timeline summaries | C-UI-04 | C | |
| R288 | 923 | Factory event admission and dispatch keep running, hidden | none | G | G51 |

---

## 2. Gaps ranked by risk

Each row: requirement, reference, suggested check and layer, and one-line pass condition. Layers follow `checks/README.md`.

### 2.1 Data loss

| ID | Requirement | Ref | Suggested check (layer) | Pass when |
| --- | --- | --- | --- | --- |
| G01 | A rebase snapshots every writer first and loses nothing if killed | mvp L153; spec §9.4.1 L694, §21 fault row | C-DUR-05: kill daemon, VM and host at {after capture, mid `jj rebase`, after rebase before head push, after push before activity}, 10 reps each (**fault**) | Every acknowledged write is in the working copy and the captured head; head ref ∈ {pre, post}; held writes are applied or refused with a typed error, never dropped |
| G02 | A sleeping branch rebases on the host without waking; `wake_reconcile` moves `@` | mvp L153, L363; spec §10.5.5 L748, §9.1.2 L637 | C-MCH-11 (**integration**, real jj, runtime start counter) | 0 runtime starts during the rebase; after the next wake `@` descends from the new head and the uncommitted captured file is byte-equal; a conflict raises Needs you with 0 starts |
| G03 | Add to stack includes T2's work, so dropping T2 loses nothing | mvp J7.3 L223 | Extend C-J7-02 with a tree assertion (**integration+e2e**) | After Add to stack and Drop T2, `diff(main, T4 candidate)` contains every hunk of H2 plus the scratch commit |
| G04 | Bursts close at most 10 s after they open | mvp L375; spec §9.3.4 L676 | C-COL-03 (**integration**, real inotify) | A writer appending every 200 ms for 60 s yields 6 ± 1 bursts, each open ≤ 10 s with a stored `snapshot_after`, and each end state restores byte-equal |
| G05 | The prompt is editable while Queued | mvp §6.6 L350 | C-STK-06 (**integration**) | An edit on a queued TODO appends one `todo_revisions` row with author and the run's first prompt equals it; an edit in any other state returns 409 or routes to amend; revision 1 is never mutated |
| G06 | `smthrs host backup` and `restore` stand alone | mvp M-26 L480; spec §16.5 L1146 | C-REL-06 (**integration** + **journey**) | Backup refuses during a burst or merge; restore into a stopped install yields digest = backup digest; the restore reports data written after the backup |
| G07 | Legacy per-member conversations stay readable | spec §14.1.5 L970; AGENTS.md (old sessions readable); mvp L328 status | C-UI-09 (**integration**, migration fixture) | Each legacy conversation appears read-only under "Earlier" for its member only, entries byte-equal to before migration; other members get 404 |

### 2.2 Security and permission

| ID | Requirement | Ref | Suggested check (layer) | Pass when |
| --- | --- | --- | --- | --- |
| G08 | The app agent can't write files, run commands or type in terminals; "run X on branch" becomes a steer | mvp §3.1 L109; spec §15.1.3 L1063 | C-ACC-05 (**integration**) | Tool set T has no write, exec or terminal-input command; prompts "edit retry.ts" and "run the webhook tests on retry-webhooks" produce 0 `write_file`/`open_session` calls with `via=smithers` and exactly 1 steer with `asked_by` "Ben via Smithers" |
| G09 | Every system flow name refuses override; `review` and `learning` overrides run in a machine and are pinned in the `todo` closure | mvp L411, M-30 L484; spec §11.1.1 L786, §11.3.0 | Extend C-SEC-02 (**integration**) | `flows/<n>/flow.ts` for each §11.1.1 name → `reserved_name`, never loaded; a repository `review` override's digest is in the `todo` closure; a running TODO keeps the old `review` digest |
| G10 | Approval-kind Needs you is maintainer-only | mvp L137; spec §5.2 L291 | C-ACC-06 (**integration**) | Member session answer on `needs_you{approval}` → 403 `permission`, wait open; delegated → 403; maintainer session settles it; `question` kind accepts a Member |
| G11 | The setup session can only do setup | mvp J1.1 L163; spec §5.1.0 | Extend C-SEC-04 (**integration**) | The setup-session credential gets 403 on every served route outside `/api/install/setup/*` (enumerated from the router) and dies at the claim |
| G12 | Egress-bound secrets never enter a machine | mvp L448; spec §8.8.0 | Extend C-SEC-01 with a bound-host sentinel (**integration**) | The value is found 0 times in machine files, environments and captures; the relay injects it only toward the declared host |
| G13 | Webhooks are signed and never trusted as state | spec §12.2.4 L904 | C-GH-10 (**integration**) | Unsigned or wrong-HMAC delivery → 401 and 0 fetches; a signed delivery whose payload lies leaves state equal to the fetched truth |
| G14 | A person confirmation expires after 24 h | spec §5.4 L317 | Extend C-ACC-02 with an injected clock (**integration**) | Approve at 24 h + 1 s → 409 `expired`, 0 merge calls |

### 2.3 Wrong merge to `main`

| ID | Requirement | Ref | Suggested check (layer) | Pass when |
| --- | --- | --- | --- | --- |
| G15 | The `automerge` label merge path is gone | mvp rule 6 L58, B.5 L913; actions.md C.23 gap 3 L599 | C-STK-07 (**integration**) | `automerge` applied by a member, a non-member and the App on a first-in-order green TODO PR → 0 merge calls, 0 state change, 0 `todo_approvals` rows |
| G16 | A Smithers Drop from every unmerged state closes the PR and rebuilds later candidates | mvp L129, L142; spec §10.7.2 L764 | C-STK-08 (**integration**) | For drop from queued, starting, working, needs_you, paused, failed and in_review: PR closed once with "Dropped in Smithers by @x", run cancelled, and every later item's next candidate tree excludes the dropped change |
| G17 | A PR returns to draft when its item stops being first | mvp L154; spec §12.5.1 L932 | C-GH-11 (**integration**, fake GraphQL) | Move down of the first item and a Before insert ahead of it each call `convertPullRequestToDraft` once and `markPullRequestReadyForReview` once for the new first; at every sample at most one TODO PR is non-draft |
| G18 | Repositories without drafts get "[waits for Tn]" and `smithers:waiting` | mvp §1.1 L15, L154; spec §12.5.1 L932 | C-GH-12 (**integration** + **e2e** on a private free-plan repo) | Draft-unsupported → later PRs open ready with prefix and label; both removed exactly when the item becomes first; a GitHub merge of a waiting PR opens order attention |
| G19 | Every reorder rebases the affected items | mvp L154, L352; spec §10.2.3 L710 | C-STK-09 (**integration**) | After T4 moves above T3: T4's head tree has no T3 paths, T3's head includes T4; both PRs force-updated once; both approvals cleared; checks re-admitted |
| G20 | An earlier item's new revision rebases later items | mvp L153; spec §10.5.1 L740 | C-STK-10 (**integration**) | T1's new verified head T1′ → T2 gets `rebase_pending{onto: T1′}`; T2's next candidate contains T1′ and not T1; T2's approval is cleared |
| G21 | Concurrent Merge presses merge once | mvp L154, rule 6 | Extend C-J4-03 (**integration**) | 20 concurrent `POST /merge` (two maintainers, same head, distinct keys) → exactly 1 `PUT /merge`, 1 `todo_approvals` row; the rest 409 or replay the first result |
| G22 | The next PR becomes ready after a normal merge | mvp L154 | Extend C-J10-01 and C-J10-05 (**e2e**) | Within 60 s of T1 merging, T2's PR has `draft=false` and T3's `draft=true` |
| G23 | Smithers never writes `main` | mvp §3 L67, rule 6 | P-suite invariant over every integration test's githubfake log (**property**) | 0 pushes or ref updates to `refs/heads/main`; every `PUT /merge` has a `todo_approvals` row at the same sha |
| G24 | An out-of-order merge closes each earlier PR with "Merged via #n (T3)" | spec §10.6.4 L758 | Extend C-STK-04 (**integration**) | T2's PR is closed once with that comment; 0 merge calls for T2 |

### 2.4 Honesty and state

| ID | Requirement | Ref | Suggested check (layer) | Pass when |
| --- | --- | --- | --- | --- |
| G25 | Retry with the current flow pins the Active version | mvp L412, B.4 L891 | Extend C-STK-03 (**integration**) | With T pinned D1 and Active D2: Retry pins D1; `retry-current-flow` pins D2; same TODO number; attempt 1 evidence unchanged; one event each |
| G26 | Needs you → Queued when answered after release | mvp L123; spec §4.1 L215 | C-STK-11 (**integration**) | Answer after a safe-idle release → queued with a position → starting → working on the same run id; finished steps keep 1 attempt row |
| G27 | A steer during an open question doesn't settle it; the agent may re-ask | mvp L137, J3.6 L195; spec §10.7.3 L768 | C-STK-12 (**integration**, scripted agent) | The steer reaches the run within one model turn; the wait stays open; a re-ask replaces the prompt and keeps the wait id; only an answer settles |
| G28 | Starting → Failed names step `start` | mvp L128, L531; spec §4.1 L204 | C-DUR-06 (**fault**: `msb` boot failure, coding host crash) | Failed `{step:"start"}` with Retry within 60 s; Working never shown; Retry re-queues |
| G29 | In review → Needs you on an unresolvable rebase conflict | mvp L127 | Extend C-J7-03 with an in_review start (**integration**) | The PR stays open; Needs you `conflict` with paths; approval cleared; the PR head doesn't move until Done |
| G30 | No machine is released while presence is unknown after a restart | spec §7.3.0 L431 | C-MCH-12 (**integration**) | During the first 30 s after a host restart, 0 releases; branches whose people re-heartbeat stay awake |
| G31 | A steer to a queued or paused TODO arrives exactly once | spec §10.7.3 L768 | C-STK-13 (**integration**) | A queued TODO's steer is the run's first message once; a paused TODO's steer is delivered once on resume |
| G32 | An out-of-band stale save on a file nobody has open is recorded and recoverable | mvp L373, §12.1 L588 | C-J3-11 (**e2e**) | `vim` saving an older buffer over a newer agent write yields an activity entry; Restore this file returns the newer bytes |
| G33 | Recovery receipts exist for run-step reconciliation, not only GitHub writes | mvp §12.1 L591; spec §19.2 L1191 | Extend C-DUR-01 (**fault**) | Each reconciled step writes one receipt (step, lookup, action) visible in Inspect |
| G34 | The scorecard measures core value as mvp §10 defines it | mvp L550; spec §20.4 L1207 | Extend C-REL-04 (**integration**) | Core value = accepted per week ≥ 10 and median person-minutes < 15 (answers, review, edits); the no-hand-written share is reported as a diagnostic only |

### 2.5 Multiplayer races

| ID | Requirement | Ref | Suggested check (layer) | Pass when |
| --- | --- | --- | --- | --- |
| G35 | Compare-and-write is atomic | mvp L373; spec §7.6 L466 | Extend C-COL-01 (**integration**) | 50 concurrent writes with one `base_digest` → exactly 1 success, 49 × `409 stale`; the file byte-equals the winner |
| G36 | Concurrent reorders keep a total order | spec §10.2.3 L710 | C-STK-14 (**integration**) | Concurrent Move up, Move down and Before insert from two members → final order equals some serial order; positions dense; one event per op |
| G37 | Bring in and Discard pressed at once | mvp B.4 L887 | Extend C-J10-03 (**integration**) | Two presses within 10 ms → exactly one applies, the other gets `409 {answered_by}`; no push before settle |
| G38 | Two members commit Make TODO on one issue | spec §10.2.1 L706 | Extend C-J2-01 (**integration**) | 1 TODO, 1 label, 1 comment; the loser gets a conflict naming the TODO |
| G39 | Rebase now pressed twice, or during an open burst | mvp B.4 L892; spec §9.4.1 L694 | Extend C-PERF-06 (**integration**) | One rebase per pending revision; a press during a burst waits for its close, then runs once |

### 2.6 Journeys and release gates

| ID | Requirement | Ref | Suggested check (layer) | Pass when |
| --- | --- | --- | --- | --- |
| G40 | J11.2–J11.3 Source and Run on a scratch branch | mvp L255–256, L432; spec §11.4.3 L812, §11.5b L818 | C-J11-02 (**e2e**) | Source opens `flows/todo/flow.ts` in the File card on the proposing TODO's branch; Run with test input on a scratch branch shows a "draft version" run whose new step appears live within 1 s; that run can't be a TODO run |
| G41 | Journey-layer recordings of J2, J3, J4, J6, J7, J8, J10 and J11 | mvp §12.1 L585–591 | C-JRN-01 (**journey**) | Each journey recorded on a fresh Mac mini from a second laptop, with the five §12.1 inclusions present |
| G42 | Both themes gate acceptance | mvp L334, L585 | Extend C-JRN-01 (**journey**) | Every recording exists in light and dark; zero axe contrast failures on app pages |
| G43 | Keyboard-only for J6, J7, J8, J11 | mvp §9 L532 | Extend C-UI-01 (**e2e**) | Guard active; every step completes in both browsers |
| G44 | Full toolchain envelope | mvp L274 | Extend C-J1-06 (**e2e**) | npm, yarn, bun, cargo, uv and pip fixtures each reach In review with the right checks; an unsupported repo fails with a typed error naming the file to add |
| G45 | J6.2 terminal agent edits are shared live | mvp L214 | Extend C-J6-01 (**e2e**) | Claude Code's write appears in a teammate's File card within 1 s and in the item's diff, attributed to Ben's terminal session |
| G46 | ChatGPT sign-in as coding model access | mvp L168, L386 | C-J1-07 (**e2e**) | Setup completes with ChatGPT and no provider key; the TODO run records "ChatGPT subscription" |
| G47 | Scratch Rebase now and scratch conflict | spec §8.5.2a–b L532–534 | C-MCH-13 (**integration**) | Rebases onto the fork source's tip; a conflict shows paths with Resolve and the branch stays on its pre-rebase head until Done |
| G48 | Dogfood target met | mvp §12.2 L592 | C-REL-07 (**journey**, live install) | Scorecard on Will's install: ≥ 50 merged in 14 days, outside work < 50 % |
| G49 | Generated wiki pages refresh after a merge on a fresh repo | mvp L403, B.5 L915 | C-J8-05 (**e2e**) | After the first merge a background wiki run shows on Home; overview, architecture and per-package pages exist at the merge commit |
| G50 | `/review` on a teammate's PR | mvp L300; spec §12.3 L922 | C-J9-02 (**e2e**) | One background machine admitted and counted against capacity; a findings card returns; no TODO machine is held |
| G51 | Factory event admission keeps running, hidden | mvp B.5 L923; AGENTS.md | C-CUT-02 (**integration**) | GitHub events are admitted to the retained machinery; no member-visible surface |

### 2.7 Cosmetic and low

| ID | Requirement | Ref | Layer | Pass when |
| --- | --- | --- | --- | --- |
| G52 | One dismissible Inspect hint after the first merge | L427 | e2e | Appears once after merge 1; never again after dismiss |
| G53 | "Notifications need HTTPS" line on plain HTTP | L333 | e2e | Line present only on http origins |
| G54 | Branch card place ("3rd in stack", "scratch") | L361 | unit | View model place equals stack index |
| G55 | Vim and dictation input | L334 | e2e | Vim motions and dictation submit a prompt |
| G56 | `learning.dismiss`; 90-day signature suppression | L893; spec §11.8.2 | integration | Dismissed signature not re-proposed for 90 days |
| G57 | Non-Apple-Silicon host refused | M-10 L464 | unit | Typed refusal on Intel and Linux |
| G58 | Add to machine image creates a TODO | M-29 L483; spec §8.6.1 | e2e | TODO seed patch edits `.smithers/machine.json` |
| G59 | "Ben via Codex" | L213; spec §6.4 | integration | `CODEX_*` sets `via=codex` |
| G60 | "unencrypted" marker on http origins | spec §17.6 | unit | Marker on http, absent on https |
| G61 | Idle sleep after 30 min, or 2 min when waiting | L363; spec §8.4.2 | integration | Sleep times ± 5 s on an injected clock |
| G62 | Input reads "Answer the coding agent" | J3.6 L195 | e2e | Label and primary action while a question is open |
| G63 | `smthrs ssh <branch>`; keys from `smthrs ssh-key` | L449 | integration | Both authenticate |
| G64 | `/flow.new` and `/flow.plan` preview | L432 | e2e | Plan renders before any run |
| G65 | Monitor shows a flow's custom view | L431 | e2e | Declared `presentation` renders |
| G66 | No benchmark claim without a sealed run | M-19 L473 | unit (docs lint) | Site and docs contain no unsourced benchmark claim |
| G67 | Wiki backlinks and outline | L400 | e2e | Both render for a linked page |
| G68 | jj operations are never free-form model output | M-32 L486 | unit | Stack-service ops are a closed enum; no model text reaches jj argv |
| G69 | "PR ready" toast | L331 | e2e | Toast on in_review for owner |
| G70 | Docker image deleted | L272 | unit | No Dockerfile or image target remains |
| G71 | Amend updates acceptance criteria | L151 | integration | Revision n+1 holds new acceptance |
| G72 | Open cards refresh after a rebase | L153 | e2e | File and Diff cards show the rebased text without reload |
| G73 | Missing required input opens a form card for every command | L343; spec §6.1.4 | unit over catalog | Every command with required fields returns a form card |
| G74 | Diff card updates live | L376 | e2e | Diff reflects a write within 1 s |
| G75 | Agent transcript visible to every member on the branch | L378 | e2e | Second member reads the same transcript live |
| G76 | A cold wake after a recipe change shows progress | L527 | e2e | Progress rows, no bare spinner |
| G77 | Agent write-tool path reaches an open card < 1 s | L528 | perf | p95 < 1 s, n = 200 |

---

## 3. Weak checks

| # | Check | Line | Weakness | Fix |
| --- | --- | --- | --- | --- |
| W1 | C-ACC-01 | L18–30 | One representative route per matrix row. A route whose handler skips `Authorize` passes if its declared action is right | Run every served route × every credential kind, generated from the router |
| W2 | C-ACC-02 | L45 | Fail-when "a retried approve causes a second merge" has no step; no concurrent approve | Add a concurrent double approve (n=20) |
| W3 | C-COL-01 | L10–13 | Stale write tested sequentially; atomicity unproven | G35 |
| W4 | C-DUR-01 | L9–14, L28 | Each kill point runs once on a timing-dependent kill; "5 min" honesty bound disagrees with C-DUR-02's 60 s | 10 reps per point; one bound (X17) |
| W5 | C-DUR-02 | L10 | One run per kill point | 10 reps per point |
| W6 | C-GH-07 | L17–18 | "PR" freshness sampled only with approved reviews; checks only with commit statuses, not check-runs; merges and closes unsampled | Add merge, close, head push and check-run samples |
| W7 | C-GH-09 | L18 | Single worker; no two-worker race on one key | Add two services reconciling one key concurrently |
| W8 | C-INS-03 | L31 | Expects callback-URL updates through an App API that spec §16.3.3 L1127 says doesn't exist | Assert the Settings one-line fix instead (X2) |
| W9 | C-J1-02 | L16–20, L27 | Setup order and step numbers differ from mvp J1.2 and spec §16.2 | Reorder (X8) |
| W10 | C-J1-04 | L9, L23 | n = 1 on one repo type for the 60-minute target | 3 runs: Node, Go, Python |
| W11 | C-J1-06 | L8–9 | Only pnpm and Go of the §6.1 envelope | G44 |
| W12 | C-J2-02 | L15, L30 | Poll-vs-webhook race is a fail-when, but deliveries are sequential | Deliver concurrently, 100 iterations |
| W13 | C-J2-03 | L25, L36 | First-answer race is one e2e sample; the deterministic proof is an unnamed T-STK-07 test | Name the integration race as a check, n ≥ 100 |
| W14 | C-J3-04 | L15, L18 | One overlapping run; the outside save lands with one typist, but §12.1 L589 needs two | Two typists during step 6; repeat overlap 50× |
| W15 | C-J3-05 | L29 | "Delivered twice after a retried request" never exercised | Retry the steer with the same key |
| W16 | C-J4-02 | L30 | Double-click fail-when never exercised | Double-submit answer and retry |
| W17 | C-J4-03 | L12–21 | No concurrent merge | G21 |
| W18 | C-J7-02 | L27 | "Dropping T2 loses nothing" unasserted | G03 |
| W19 | C-J8-03 | L11, L13, L23 | "One sync interval" unspecified; concurrent Obsidian and app edits never made | State the interval; edit both sides at once |
| W20 | C-J8-04 | L18–23 | Proves citation, not that the plan follows the edited decision | Assert the plan text applies revision 4's rule |
| W21 | C-J10-01 | L19–25 | No draft assertion for T2 while T1 is first; no ready flip after T1 merges | G22 |
| W22 | C-J11-03 | L29, L37 | Pins the model at admission; spec §11.5a L822 says in-progress runs switch | X3 |
| W23 | C-J11-04 | L7 | No case where the same failure differs only in line numbers (spec §11.6.4 normalization) | Add normalized-signature journal |
| W24 | C-MCH-04 | L27 vs L29, L38 | `Clamp(4)` silently returns 3; the setter refuses 4; fail-when forbids silent clamp | State which layer refuses |
| W25 | C-MCH-06 | L33 | Step 8 passes on either outcome; the shared-home branch is now forbidden | Delete step 8 (C-MCH-09 owns it) |
| W26 | C-MCH-07 | L14 | No egress-bound secret; no delete or replace | G12; add delete and replace |
| W27 | C-REL-04 | L25 | Core value is the no-hand-written share with a ≥ 50 % target; mvp L550 says diagnostic only | G34 (X9) |
| W28 | C-SEC-02 | L10 | Only `merge` tests the reserved names | G09 |
| W29 | C-SEC-05 | L11, L15 | Refuses drop and move that mvp B.2 L796 grants X; attributes "Ben's terminal" where J6.3 says "Ben via Claude Code" | X4, X5 |
| W30 | C-STK-03 | L27; README L105 | README says it proves Retry with the current flow; no step does; "Stop lost after restart" has no restart step | G25; add a host restart while paused |
| W31 | C-STK-04 | L18–22 | Doesn't assert earlier PRs closed with "Merged via #n" | G24 |
| W32 | C-UI-01 | L13 | Omits J6, J7, J8, J11 (P0 in mvp L211, L219, L226, L247) | G43 |
| W33 | C-J3-10 | L17 | "First output within 1 s" from one sample | n ≥ 50 |
| W34 | C-J3-09 | L16 | Double Return race is one sample | n ≥ 20 |
| W35 | C-J3-03 | L24 | Burst close and delivery timing from one sample; no 10 s cap case | G04 |
| W36 | C-J1-05 | L28 | "Within 1 s" from one observation per row | n ≥ 20 |
| W37 | C-PERF-02 | L12 | Only `todo` move mutations; branch, run and conversation topics unmeasured | Mix mutation kinds |
| W38 | checks/README.md | L65, L150–157 | Says J6–J8 and J11 are "P1 in mvp.md" (they are P0); the P0 matrix omits them | Fix the header and matrix |

---

## 4. Spec contradictions

| # | Between | Lines | Contradiction | Likely fix |
| --- | --- | --- | --- | --- |
| X1 | spec §5.3 vs §16.3.3 | spec L306 vs L1127; C-INS-01, C-INS-03 | Session cookie "HttpOnly, Secure, SameSite=Lax" always, vs `Secure` only on https | Edit §5.3 to defer to §16.3.3 |
| X2 | spec §16.3.3 vs C-INS-03 | spec L1127 vs C-INS-03 L31 | "GitHub has no API to change an existing App's callback URLs" vs the check expecting callback-URL updates after each settings change | Rewrite C-INS-03's assertion |
| X3 | spec §11.5a and mvp §6.14 vs C-J11-03 | spec L822, mvp L433 vs C-J11-03 L29, L37 | Model change applies to every call started after it, including runs in progress, vs runs admitted before keep the old model | Pick one; spec text is explicit |
| X4 | spec §6.4 and C-J6-02 vs spec §5.3.2, mvp J6.3, C-J6-01, C-SEC-05 | spec L384, C-J6-02 L34 vs spec L313, mvp L215, C-J6-01 L26, C-SEC-05 L15 | "Credential first" and "header must not override via", vs a `via=terminal` credential attributed "Ben via Claude Code" through the header, vs "Ben's terminal" | Rule: the header may refine `terminal` or `cli` to a detected agent; never override `smithers` or a named agent |
| X5 | mvp §3.1 and B.2 vs spec §8.11.1 and C-SEC-05 | mvp L111, L796 vs spec L606, C-SEC-05 L11; C-J6-01 L26 | External agents get the app agent's catalog (drop, move, steer any TODO, place anywhere), vs the stage-1 terminal token allows only answer and steer on its own branch and append-only `todo.new`; C-J6-01 still expects "placed directly after T1" | State the stage-1 limit in mvp §11, or widen the token; make C-J6-01 use append |
| X6 | mvp §6.3 vs spec §4.1, §12.3 | mvp L298 vs spec L220, L918; C-J10-08 L27 | "Reopening the PR restores it", unbounded, vs only within 7 days | Add the 7-day bound to mvp |
| X7 | mvp J7.2 and §11 stage 1 vs spec §8.5.0 | mvp L222, L559 vs spec L526; C-J7-02 L23 | Fork "starts from T2's current revision" with J7 in stage 1, vs the stage-1 fork source is the last verified head, and C-J7-02 asserts uncommitted work is excluded | Note the stage-1 limit in mvp, or gate J7.2 to stage 2 |
| X8 | mvp J1.2 and spec §16.2 vs C-J1-01, C-J1-02, C-J1-04, C-REL-02 | mvp L164–169, spec L1105–1113 vs C-J1-02 L16–20, L27; C-J1-01 L16; C-J1-04 L15; C-REL-02 L17 | Order Address → App → owner sign-in → repo + install → model → squash (steps 1–8), vs C-J1-02 choosing the repo before the App and checking squash before sign-in; three numbering schemes (0–6, 1–6, 1–8) | Renumber checks to §16.2 |
| X9 | mvp §10 vs C-REL-04 and spec §20.4 | mvp L550 vs C-REL-04 L25, spec L1207 | Core value = ≥ 10 accepted per week and median < 15 person-minutes, with the no-hand-written share as a diagnostic, vs the check scoring that share against a ≥ 50 % target; §20.4 defines no person-minutes | Add a person-minutes definition to §20.4; fix C-REL-04 |
| X10 | spec, overview, checks README vs mvp | spec L3, overview L3, README L65 vs mvp L3, L211, L219, L226, L247 | "mvp.md v2.6", "M-01..M-30", J6–J8 and J11 "P1", vs mvp v2.5 with M-31..M-33 and those journeys P0 | Sync version refs and priorities |
| X11 | mvp §4.2 and §1.1 vs spec §12.5.1 | mvp L154, L15 vs spec L932 | "Later PRs are drafts, so GitHub won't merge them" for any repository, vs drafts unavailable on private free-plan repositories, with a label fallback that GitHub doesn't enforce | State the fallback and its weaker guarantee in mvp |
| X12 | overview vs mvp and spec | overview L7 vs mvp L374, L650; spec §9.3.5 L682 | "Every write is … undoable" vs per-entry Undo deferred | Drop "undoable" |
| X13 | mvp §6.6 and §13 vs spec §10.3.1 | mvp L351, L604 vs spec L714 | Status "default 2" and an open question (1 or 2 on 24 GB), vs a decided formula `max(1, capacity − 1)` (= 1 on 24 GB) | Close the mvp question or mark the spec value provisional |
| X14 | C-MCH-06 vs spec §8.7.1, mvp §6.8, C-MCH-09 | C-MCH-06 L33 vs spec L558, mvp L377, C-MCH-09 L28 | Step 8 accepts a shared-home result; spec and mvp now forbid shared homes | Delete C-MCH-06 step 8 |
| X15 | actions.md C.1 vs spec §10.4.1, §11.1.2, mvp rule 6 | actions.md L28, L136, L139, L140 vs spec L730, L788; mvp L58 | Keep rows `coding/fast-forward-vibe`, `coding/merge-vibe-local-pull` ("Merged the change") and `coding/LandVibe` run on the Install as TODO-flow steps, vs merge and propose being system operations outside any overridable flow, which always runs in a machine | Re-mark these rows "replaced by `stack.propose`/Stack: merge" or Internal |
| X16 | mvp §3 vs spec §8.8.2, §11.3.1 | mvp L67 vs spec L579, L800; C-SEC-01 L13 | "`main` … with no machine", vs ephemeral background machines on `main` for main-only secrets and flow load | Say "no live branch machine" |
| X17 | C-DUR-01 vs C-DUR-02 | C-DUR-01 L28 vs C-DUR-02 L24 | A stuck run must show interrupted within 5 min vs within 60 s; spec §19.1 L1189 gives no bound | Put one bound in spec §19.1 |
| X18 | mvp §6.3 vs spec §4.1.2a | mvp L321 vs spec L242; C-J10-07 L21 | Force push "shows Needs you for the owner", vs stack attention that isn't a Needs you; unclear whether it counts in the Home "Needs you" count | Define the Home count's sources |

---

## 5. Property-based and fuzz candidates

| # | Target | Spec section | Generator | Invariants |
| --- | --- | --- | --- | --- |
| P1 | TODO state machine (model-based) | spec §4.1 L200–221, §4.1.0 L226–236, §10.7–10.8 | Random trigger sequences: place, admit, first step, ask, N concurrent answers, steer, stop, resume, fail, retry, retry-current-flow, PR open, review, foreign push, Bring in, Discard, merge event, close, reopen at t, drop, `learning_done` | Each change writes exactly one `todo_events` row with matching from/to; only table edges occur; merged is absorbing; dropped leaves only by reopen ≤ 7 days; earlier attempts immutable; digest changes only on retry-current-flow; a wait settles at most once; the projection is total and deterministic |
| P2 | Stack order, candidates and merge | spec §4.2, §10.2.3, §10.5–10.6, §12.5.1 | Random stacks plus append, before, amend, move up and down, drop, in-order merge, out-of-order GitHub merge, `main` moves | Only the first unmerged item is mergeable; each PR head tree = `main` + earlier unmerged items (current order) + item; PR non-draft iff first; the Smithers diff = previous candidate → this one; no non-dropped change is lost or duplicated across `main` and open candidates |
| P3 | Permission matrix | spec §5.2 L288–298, §15.1.5 L1067 | role (owner, maintainer, member, suspended, removed) × credential (session, delegated(via), run own/other branch, machine, setup session) × every `catalog.mvp.json` action × subject owner | `Authorize` equals a table written from §5.2; refused calls have zero side effects; under random action sequences no delegated, run or machine credential produces a GitHub merge |
| P4 | Capacity formula | spec §8.2.1 L493 | Random memory, P-cores and free disk | Capacity ≥ 1; never above any term; monotone non-decreasing in each input; owner setting ≤ formula; machine memory switches at exactly 24 GiB |
| P5 | Admission scheduler | spec §8.3 L500–508, §8.4 | Random request streams by class, cancellations, safe-idle flips, two scheduler instances | `awake + waking ≤ capacity` at every step; grant order = (class, age); no running step preempted; positions dense 1..n; cancelled requests never granted |
| P6 | Live channel cursors | spec §7.1–7.2, §3.3 L173 | Random drops, reconnect delays, send-budget overflows, retention expiry | Applied deltas equal committed seq per topic, no duplicates; `gap` or old cursor yields a `snap`; no delta precedes its commit |
| P7 | Code co-editing CRDT and disk merge | spec §7.4, §9.2.2–9.2.6 | N clients' random edits plus outside writes (overlapping and not), daemon kills, reconnects | All documents and disk converge after quiescence; no acknowledged keystroke lost; overlapping outside versions exist in a snapshot; the author map is stable |
| P8 | Burst grouping and attribution | spec §9.3.1, §9.3.3, §9.3.4 | Random timelines of writes by sessions with CPU-activity windows | Each path in exactly one burst per write window; close at 1.5 s idle, 10 s max or a conflicting key; single active session → that actor, else outside; ignored paths never appear |
| P9 | Compare-and-write | spec §7.6 L466, §9.1.2 `write_file` | Concurrent writers with random `base_digest` | Linearizable: one success per base; final bytes equal a successful write; never 200 on a stale base |
| P10 | GitHub inbound idempotency | spec §10.2.1 L706, §12.3, §12.4.1 | Fuzzed order and duplication of label, review, comment edit and delete, close and reopen events across webhook, poll and restart | ≤ 1 TODO per (issue, label event id) and ≤ 1 unmerged TODO per issue; one steer per review submission; transitions idempotent |
| P11 | Outbound write reconciliation | spec §12.4.1, §19.2 | Random kill points and interleavings over all write kinds (extends C-GH-09's 27 fixed cases) | At most one effect per key; every repeat preceded by its lookup |
| P12 | Parsers and normalizers | spec §8.1.1, §8.10.1, §5.5.1–5.5.2, §6.4, §11.6.4, §10.5.4, §12.5.1 | Random titles, logins, SSH usernames, `Smithers-Via` headers, failure texts, conflict markers, PR bodies | Slugs ≤ 48 chars and unique; logins match `[a-z0-9_-]{1,32}` and suffixes are stable; SSH resolution is unique or lists candidates; thrash signatures ignore numbers and paths; Done refuses any remaining marker; PR bodies contain no closing keyword and no bare `#n` |
| P13 | Home and timeline projections | spec §7.2.2 L427, §14.5.2 L1015 | Random TODO sets, roles, `last_seen_seq` | Counts equal SQL group-by; the shared payload is identical for every member; the per-viewer action is total and role-correct |
| P14 | Scorecard | spec §20.4 L1207 | Random run histories | Metamorphic: agent-only bursts don't change terminal edits; drop → reopen → merge counts once; time-zone shifts at the window edge don't change counts |
| P15 | Stack position key | spec §10.2.3 L710 | Concurrent random inserts, moves and drops | Order is total and stable; moves swap adjacent items only; no key collision |
| P16 | Flow activation | spec §11.3 L796–804, §11.4 | Random `main` commits with valid and invalid flow versions | Active is the latest loaded version, never empty; pinned runs never change digest |
| P17 | Credential store convergence | spec §8.7.3 L564 | Random `credential_changed` events with clock ties across machines | All awake machines and the store converge to the newest `written_at`; ties go to the later arrival; no non-tracked file syncs |

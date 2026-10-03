# Coverage: product → spec → ticket → check

Status: v0.1 by the engineering agent (smithers-8a), 2026-10-02. Answers Codex Astra A-28. Every journey step (mvp.md §5) and every in-MVP feature row (mvp.md §6, §8 Keep rows) maps to the spec section that states its mechanism, the ticket that builds it, and the check that asserts it at its user-facing layer.

Rules:
- The **owner** is the first ticket listed. The owner makes the check pass and attaches its evidence.
- The **check** column names the assertion, not only the check: a step or condition in that check file proves the behavior itself. A renderer, a tag table or a generic journey recording never stands in for one.
- [D] rows are deferred (spec §0). They have no ticket and no check, and the MVP must not build them.
- A change that adds, removes or renumbers a ticket, a check or a row here updates this file in the same change. The checks index ([checks/README.md](checks/README.md)) and the tickets index ([tickets/README.md](tickets/README.md)) stay the source for titles, layers and stages.

## 1. Journey steps (mvp.md §5)

P0 and P1 follow mvp.md §5: J6 is P0 for steps 1–3, and J9 is P1.

| Step | P | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- | --- |
| J1.1 setup link, setup-only session | P0 | §5.1.0, §16.1.2 | T-INS-05, T-ACC-01 | C-J1-01; C-SEC-04 (nobody without the token claims the install) |
| J1.2 Address, App, owner sign-in, model access, squash check | P0 | §16.2, §12.1, §1.4, §11.5a | T-INS-06, T-GH-01, T-APP-03, T-UI-02 | C-J1-02; C-GH-01; C-ACC-04 |
| J1.3 mirror; questions work once source is readable | P0 | §8.6.3, §16.2 step 7 | T-INS-06 | C-J1-02 (Source ready); C-J1-03 |
| J1.4 Source ready and Machine ready apart; no declarations needed | P0 | §8.6, §11.2 | T-MCH-10, T-FLW-02 | C-J1-02; C-J1-06 |
| J1.5 answer with file cards | P0 | §15.1, §7.6 | T-APP-16, T-APP-16, T-APP-15 | C-J1-03 |
| J1.6 first TODO gets branch, machine, agent and a PR with evidence | P0 | §10.4, §12.5.1 | T-FLW-11, T-GH-03, T-STK-01 | C-J1-04; C-J10-01; C-J2-04 |
| J1.7 review and merge in the app | P0 | §10.6 | T-STK-04, T-APP-04 | C-J1-04; C-J4-03 |
| J1.8 members, public address, secrets | P0 | §5.1.4, §16.3, §8.8 | T-ACC-02, T-APP-06, T-INS-04, T-APP-13 | C-J1-05; C-INS-01; C-INS-03; C-MCH-07 |
| J1 activation target (60 min) | P0 | §16.2 | thin path, T-REL-02 | C-J1-04 |
| J2.1 issue discussion on GitHub | P0 | §3.0, §12.2 | T-GH-02 | C-GH-07 (issues within 5 min) |
| J2.2 Make TODO drafted, edited, placed, committed; `todo` label | P0 | §10.2.1, §14.3 Draft, §14.5.1 | T-STK-09, T-APP-02, T-UI-03 | C-J2-01; C-J2-02 |
| J2.3 queues, gets its branch, starts Working | P0 | §4.1, §8.3 | T-STK-01, T-MCH-06 | C-STK-01; C-J4-01 (Starting); C-UI-05 |
| J2.4 one question → Needs you toast; any member answers | P0 | §10.7.2a, §10.8 | T-STK-01, T-APP-07 | C-J2-03 |
| J2.5 PR evidence | P0 | §10.4.3, §12.5.1 | T-STK-01 | C-J2-04 |
| J2.6 merge → Merged; issue closes; learning follows | P0 | §10.6.2, §11.8 | T-STK-04, T-FLW-06 | C-J2-05 |
| J3.1 see Needs you, open its branch | P0 | §14.4, §14.5.2 | T-APP-07 | C-J2-03; C-UI-04 |
| J3.2 who is where, SSH editor attributed | P0 | §7.3, §8.10.4 | T-COL-06, T-APP-10, T-TRM-03 | C-J3-01; C-J3-06 |
| J3.3 own terminal on the same machine, others watch | P0 | §8.11 | T-TRM-01, T-APP-12 | C-J3-02 |
| J3.4 `pnpm format` → one grouped entry, cards update | P0 | §9.3 | T-COL-04 | C-J3-03 |
| J3.5 two people type in one file live | P0 | §7.4, §9.2 | T-COL-08, T-APP-14 | C-J3-04 |
| J3.6 Answer settles the question, Steer never does | P0 | §10.7.3, §10.8.2 | T-STK-06, T-STK-01 | C-J3-05; C-J2-03 |
| J4.1 Home card counts and merged since last look | P0 | §14.3 Home | T-APP-01, T-UI-06 | C-J4-01 |
| J4.2 answer, merge next, move up, retry with a steer | P0 | §10.2.3, §10.6, §10.7 | T-STK-02, T-STK-05, T-APP-02 | C-J4-02 |
| J4.3 toasts while chatting; nothing blocks | P0 | §14.4.3, §19.3 | T-APP-07, T-COL-02 | C-J4-02; C-UI-04; C-UI-05 |
| J5.1–J5.4 flow edit → TODO → merged → Active; running TODOs keep theirs | P0 | §11.3–§11.5 | T-FLW-05, T-FLW-03, T-FLW-04, T-FLW-11, T-APP-05 | C-J5-01; C-J5-02 |
| J5.5 learning proposal → merged → next TODO passes lint | P0 | §11.8 | T-FLW-06 | C-J5-03 |
| J6.1 terminal signed in to Smithers with the skill; own subscription | P0 | §5.3.2, §8.11.1, §8.7.3 | T-TRM-02 | C-J6-01 (steps 1–2); C-SEC-05; C-MCH-10 |
| J6.2 its edits land in the shared working copy, live | P0 | §9.3.1 | T-COL-04 | C-J3-03 (a terminal tool's writes, attributed and live); C-PERF-04 |
| J6.3 skill reads the wiki, answers, places a TODO as "Claude Code for Ben" | P0 | §6.4, §14.6a, §15.3 | T-TRM-02, T-APP-09, T-CAT-01 | C-J6-01 (step 4); C-CAT-03 |
| J6.4 laptop `smthrs login` | P1 | §5.3.1 | T-ACC-04 | C-J6-02 |
| J6.5 teammates watch but can't use the login | P1 | §8.11.2, §5.5.4 | T-TRM-01, T-MCH-11 | C-J3-02; C-MCH-06 |
| J7.1 insert before T3; amend T2 "+1" | P0 | §10.2.2 | T-STK-02 | C-J7-01 |
| J7.2 fork T2 to scratch from its current revision | P0 | §8.5.1–§8.5.2 | T-MCH-08 | C-J7-02; C-MCH-08 |
| J7.3 Add to stack after T2; drop T2 | P0 | §8.5.3 | T-MCH-08 | C-J7-02 |
| J7.4 `main` moves; the agent resolves one conflict | P0 | §10.5.4 | T-STK-08 | C-J7-03 |
| J8.1 learning writes a decision page linked to the change | P0 | §11.8.1 | T-FLW-06 | C-J8-01 |
| J8.2 two people co-edit the page and change the decision | P0 | §13.2, §7.4 | T-COL-09 | C-J8-02; C-J8-05 (step 2) |
| J8.3 the next plan cites the edited revision | P0 | §13.4 | T-FLW-10 | C-J8-04 |
| J8.3 … and follows it | P0 | §13.4, §10.4.1 | T-FLW-10 | C-J8-05 (the change uses the edited decision; a control run before the edit uses the old one) |
| J9.1–J9.3 ask, answer with file, code and wiki cards; Make TODO and Save to wiki | P1 | §15.1, §15.1.2, §14.5.1 | T-APP-02, T-APP-17 | C-J9-01; C-UI-07 |
| J10.1 PR on `smithers/<slug>`, based on `main`, with body | P0 | §12.5.1 | T-GH-03 | C-J10-01 |
| J10.2 review comment → steer within a minute → fix updates the PR | P0 | §12.3 | T-GH-04, T-MCH-14 | C-J10-02; C-STK-05 |
| J10.3 laptop push → Needs you; Bring in or Discard | P0 | §12.3 | T-GH-06 | C-J10-03 |
| J10.4 unrelated merge → Rebase pending or rebase | P0 | §10.5.2 | T-STK-08 | C-J10-04 |
| J10.5 merge on GitHub → Merged; issue closes | P0 | §12.3 | T-GH-03 | C-J10-05 |
| J10.6 "synced 40 s ago"; gold on network loss | P0 | §4.4, §12.6 | T-GH-07 | C-J10-06; C-GH-07 |
| J11.1 Inspect: graph, I/O, transcript, retries, waits, tokens and time | P0 | §11.6 | T-FLW-07, T-FLW-07, T-APP-07 | C-J11-01; C-J11-04 |
| J11.2 Source opens the flow in the File card; add a step | P0 | §11.5b, §7.6 | T-APP-05, T-FLW-05, T-APP-14 | C-J11-02 (steps 3–4) |
| J11.3 Run with a test input on a scratch branch; new graph live | P0 | §11.4.3, §11.6.2 | T-FLW-04, T-APP-05, T-FLW-07 | C-J11-02 (steps 5–7) |
| J11.4 switch the review agent's model | P0 | §11.5a | T-FLW-08, T-FLW-08 | C-J11-03 |
| Every P0 step keyboard-only | P0 | §14.7 | T-REL-02 | C-UI-01 |

### 1.1 Release recording (mvp.md §12 item 1)

| Recorded event | Check: assertion |
| --- | --- |
| A restart mid-run, with recovery receipts | C-DUR-01; C-DUR-02; C-DUR-03 |
| A duplicate launch | C-UI-05 (step 6: one attempt) |
| Two people typing on one line, both applied | C-J3-04 |
| An out-of-band stale save, recorded and recoverable | C-J3-03 (Restore this file) |
| An outside save landing on a file two people are typing in | C-J3-04 |
| A wiki decision edit that the next related plan follows | C-J8-05 |

## 2. Feature rows (mvp.md §6)

### 6.1 Install and machine

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| Install on a Mac | §1, §16.1 | T-INS-01, T-INS-02, T-INS-03, T-INS-05 | C-INS-05; C-SPK-06; C-REL-02; C-J1-01 |
| Reaching the install | §1.4, §16.3 | T-INS-04 | C-INS-01; C-INS-03 |
| Machine image without declarations | §8.6, §11.2 | T-MCH-10, T-FLW-02, T-APP-03 | C-J1-06; C-APP-03 |
| Restart | §19 | T-FLW-09, T-GH-09, T-REL-04 | C-DUR-01..04; C-GH-09 |

### 6.2 Access

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| Team sign-in | §5.1 | T-ACC-01, T-ACC-02 | C-ACC-04; C-SEC-04; C-J1-05 |
| Roles | §5.2 | T-ACC-03 | C-ACC-01 |

### 6.3 GitHub sync

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| `main` moves | §12.3, §10.5 | T-GH-07, T-STK-08 | C-J10-04; C-GH-07 |
| An issue is opened, edited or commented on | §3.0, §12.2 | T-GH-02 | C-GH-07; C-J2-01 (Make TODO on the issue card) |
| `todo` label from a member | §10.2.1, §17.5 | T-STK-09 | C-J2-02; C-SEC-03 |
| A review or review comment on a TODO's PR | §12.3 | T-GH-04 | C-J10-02 |
| Checks finish on a TODO's PR | §12.3, §10.6.2 | T-GH-03 | C-J2-04; C-J4-03 (failed required check names itself) |
| A TODO's PR is merged on GitHub | §12.3, §10.6.4 | T-GH-03 | C-J10-05; C-STK-04 |
| A TODO's PR is closed without merging | §12.3 | T-GH-03 | C-J10-08 |
| Someone pushes to a TODO's branch from a laptop | §12.3 | T-GH-06 | C-J10-03 |
| A teammate's own branch or PR: `/review` on any PR | §12.3, §8.3.1, §1.3 | T-FLW-01, T-MCH-06 | C-J10-09 (ephemeral machine at the PR head, findings card, no GitHub write, outsider PR refused) |
| GitHub branch protection | §10.6.2 | T-STK-04, T-GH-03 | C-J4-03 (steps 6 and 10: GitHub's text verbatim) |
| A TODO reaches In review; commits reach GitHub | §12.5.1, §12.5.2 | T-GH-03 | C-J10-01 |
| Make TODO on an issue: label and "Committed as Tn" | §10.2.1, §12.4.1 | T-STK-09 | C-J2-01 |
| A TODO merges (squash) | §10.6.2 | T-STK-04 | C-J2-05; C-J4-03 |
| A scratch branch stays in Smithers | §8.5 | T-MCH-08 | C-J7-02 |
| An agent replies to review comments | [D] §12.5.3 | — | — |
| No public address (polling) | §12.2 | T-GH-02 | C-GH-07; C-GH-08 |
| Sync status | §4.4, §12.6 | T-GH-07 | C-J10-06 |
| GitHub App setup | §12.1 | T-GH-01 | C-GH-01 |
| `main` rewritten on GitHub | §12.3 | T-GH-07 | C-J10-07 |

### 6.4 App shell

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| Home card | §14.3 Home | T-APP-01, T-UI-06 | C-J4-01; C-PERF-02 |
| Home card: background runs with Retry and Dismiss | §14.3 Home, §3 (`workflow_runs.dismissed_by`) | T-APP-01 | C-J4-01 (step 10: Retry runs again and Dismiss removes it for every member, after a reload); C-J8-06 (a failed wiki refresh) |
| Branch conversations | §14.1, §14.5.1 | T-APP-16, T-UI-07 | C-UI-06; C-APP-04 |
| No chat between people | §14.1.3 | T-APP-16 | C-UI-06 |
| Commands | §6.1 | T-CAT-01, T-UI-14, T-CUT-01..03 | C-CAT-01; C-CUT-01 |
| Toasts for events | §14.4 | T-APP-07, T-UI-08 | C-UI-04; C-UI-05 |
| Timeline | §14.5 | T-APP-07, T-UI-08 | C-UI-04 |
| Browser notifications | §14.6 | T-APP-18 | C-UI-03 |
| Input and theme | §14.7 | T-REL-02 | C-UI-01 |

### 6.5 App agent

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| Models | §11.5a, §16.2 step 5 | T-INS-06, T-FLW-08 | C-J1-02; C-J11-03 (steps 2 and 7: the turn records F, then the coding-model fallback) |
| Answers | §15.1 | T-APP-16, T-APP-16 | C-J1-03; C-J9-01 |
| Context preflight | §15.1.2 | T-APP-17 | C-UI-07; C-PERF-01 |
| Private entries never enter a turn; a removed author's turns stop | §15.1.2a, §15.1.4a, §14.5.1 | T-APP-16, T-APP-16, T-APP-17 | C-UI-06 (steps 11–12); C-UI-07 |
| Drives the app | §15.1.4, §6.1.4 | T-APP-16, T-APP-16, T-CAT-01 | C-UI-06; C-ACC-02 |

### 6.6 TODOs and the stack

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| Create (chat, issue, label; Append, Before, Amend) | §10.2, §14.3 Draft | T-STK-02, T-STK-09, T-APP-02 | C-J2-01; C-J7-01; C-J9-01 |
| TODO card (prompt editable while Queued = Amend, §10.2.2) | §14.3 TODO | T-APP-02, T-UI-04 | C-J4-02; C-J2-04; C-J7-01; C-APP-02 |
| Parallel work | §10.3 | T-STK-03 | C-STK-02 |
| Order | §10.2.3, §10.6.1 | T-STK-02, T-STK-04 | C-J4-02; C-J4-03 |
| Steer | §10.7.3 | T-STK-06 | C-J3-05; C-J10-02 |
| Stop and resume | §10.7.1 | T-STK-05 | C-STK-03 |

### 6.7 Branches and machines

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| One live branch | §8.1.2 | T-MCH-04 | C-MCH-01 |
| Branch card | §14.3 Branch | T-APP-10, T-UI-15 | C-J3-01; C-J3-03 |
| Fork | §8.5 | T-MCH-08 | C-J7-02; C-MCH-08 |
| Sleep | §8.4 | T-MCH-07 | C-MCH-03; C-PERF-05 |
| Capacity and queue | §8.2, §8.3 | T-MCH-06, T-MCH-01 | C-MCH-02; C-MCH-04 |
| Cleanup | §8.12 | T-MCH-09 | C-MCH-05 |

### 6.8 Multiplayer on a branch

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| Presence | §7.3 | T-COL-06 | C-J3-01 |
| Live co-editing | §7.4, §9.2 | T-COL-08, T-APP-14 | C-J3-04; C-PERF-03 |
| No silent overwrite | §7.6 row 1, §9.3.9 | T-COL-10, T-COL-10 | C-COL-01; C-J3-03 |
| External changes | §9.3 | T-COL-04, T-COL-05, T-APP-11 | C-J3-03; C-J3-08; C-J3-09 |
| Save and recovery guarantees | §9.2.2–§9.2.3a, §9.3.4–§9.3.5 | T-COL-08, T-COL-03 | C-J3-04; C-DUR-04 K7a–K7e (document recovery, lost-edit Reapply and Copy); C-COL-03 (S3 document writes during rebase) |
| Live updates | §9.3.4, §7.2 | T-APP-11, T-COL-04 | C-J3-03; C-PERF-04 |
| Terminals | §8.7, §8.11 | T-TRM-01, T-MCH-11 | C-J3-02; C-MCH-06; C-MCH-09; C-MCH-10; C-REL-05 |
| Shared agent activity | §8.11.2a, §10.7.3 | T-TRM-05, T-STK-06 | C-J3-10; C-J3-05 |
| Carets and selections | Cut | — | — |

### 6.9 Coding agent

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| Works TODOs (reads the wiki, cites revisions) | §10.4, §13.4 | T-FLW-11, T-FLW-02, T-FLW-10 | C-J1-04; C-J1-06; C-J8-04 |
| Model access: every run records the access it used | §15.2 | T-STK-01, T-INS-06 | C-J2-04 (step 4: the run's recorded model access equals the model proxy's usage rows and the TODO card) |
| Model access: keys stay on the host; personal subscriptions only in their owner's terminal | §8.8.3, §15.2, §8.7.2 | T-MCH-12, T-MCH-11 | C-SEC-01; C-MCH-06 (a member's home, which holds their tool login, is unreadable to `agent` and other members) |

### 6.10 Review and merge

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| PR card (TODO card evidence and the Diff card) | §10.6, §12.5.1, §14.3 TODO, Diff | T-STK-04, T-STK-01, T-APP-02 | C-J2-04; C-J4-03 |
| Line comments | [D] §12.5.3 | — | — |
| Agents can't merge | §5.3, §5.4 | T-ACC-04, T-APP-04 | C-ACC-02; C-J6-02 |

### 6.11 Wiki

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| Pages and editing | §13.1–§13.2, §7.4 | T-COL-09 | C-J8-02 |
| One vault for both agents | §13.4, §15.1.2 | T-FLW-10, T-APP-17 | C-J8-04; C-J9-01 |
| Obsidian | §13.3 | T-FLW-12 | C-J8-03 |
| Generated pages refresh after merges | §13.5, §11.2 | T-FLW-02, T-APP-01 | C-J8-06 (a merge adds a function; the package's generated page gets a new revision that names it, as a background run on the Home card) |

### 6.12 Flows and the factory

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| Default flows | §11.1, §11.2 | T-FLW-01, T-FLW-02, T-FLW-11 | C-J1-06; C-SEC-02 |
| Flow card | §11.3.3, §14.3 Flow | T-APP-05, T-UI-10 | C-J5-01 |
| Change the factory | §11.5 | T-FLW-05 | C-J5-01; C-SEC-02 |
| Pinned versions | §11.3, §11.4 | T-FLW-03, T-FLW-04, T-STK-05 | C-J5-01; C-J5-02; C-STK-03 |
| Learning | §11.8 | T-FLW-06 | C-J5-03; C-J8-01; C-J2-05 |
| Run any flow (slash command with a typed form) | §6.1, §6.1.4, §11.1.2 | T-CAT-01, T-APP-05 | C-CAT-01; C-J11-02 (step 1) |

### 6.13 Your own agents, the CLI and the API

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| Smithers skill | §15.3, §6.1.2 | T-CAT-01, T-TRM-02 | C-CAT-03; C-J6-01 |
| CLI | §5.3.1, §6.1 | T-CAT-01, T-ACC-04 | C-CAT-02; C-J6-02 |
| API | §6.2, §6.3 | T-CUT-02 | C-CUT-01 (OpenAPI describes every served route) |
| Attribution | §6.4, §14.6a | T-ACC-04, T-APP-09 | C-J6-01; C-J6-02 |

### 6.14 Advanced: one click away

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| Monitor: graph, I/O, transcript, attempts, waits, journal, cost | §11.6.1–§11.6.2 | T-FLW-07, T-FLW-07 | C-J11-01 |
| Monitor: read-only replay | §11.6.2 | T-FLW-07 | C-J11-01 (step 5: scrubbing sends only reads) |
| Monitor: phases with deterministic titles; model summaries that never block | §11.6.3, §14.5.3 | T-FLW-07, T-APP-07, T-FLW-07 | C-J11-01 (steps 8–9) |
| Monitor: thrashing | §11.6.4 | T-FLW-07 | C-J11-04 |
| Monitor: a flow's custom view | §11.6.2 | T-FLW-07 | C-J11-02 (step 2) |
| Write flows: Source, Plan, draft-version Run on a scratch branch | §11.4.3, §11.5b | T-APP-05, T-FLW-04, T-FLW-05 | C-J11-02 |
| Configure an agent | §11.5a | T-FLW-08, T-FLW-08 | C-J11-03 |
| Triggers; Machine | [D] §11.7 | — | — |
| Signals and approvals visible | §11.6.2 | T-FLW-07 | C-J11-01 (the waits list) |

### 6.15 Access, secrets and SSH

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| Members and maintainers (Take over) | §5.1.4, §5.6 | T-ACC-02, T-ACC-02, T-APP-06, T-APP-02 | C-J1-05; C-ACC-03; C-APP-01 |
| Roles | §5.2 | T-ACC-03 | C-ACC-01 |
| Secrets | §8.8 | T-MCH-12, T-APP-13 | C-MCH-07; C-SEC-01 |
| SSH into a branch | §8.10 | T-TRM-03, T-ACC-02 | C-J3-06 |

## 3. Kept rows (mvp.md §8 "Keep") and decision surfaces

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| Contributor trust rules | §17.5, §10.2.1 | T-STK-09 | C-SEC-03 |
| CLI and Smithers skill | §6.1, §15.3 | T-CAT-01 | C-CAT-02; C-CAT-03 |
| Code intelligence in File cards (hover, definition, diagnostics) | §7.6 row 3, §14.3 File, §9.1.2 | T-APP-15, T-APP-11, T-APP-15 | C-UI-11 (steps 2–4 on an awake branch, rerun on the release build) |
| Webpage reader card | §14.3.0 (retained) | T-APP-15 | C-UI-11 (step 6) |

Decisions with their own surface (mvp.md §7):

| Row | Spec | Owner, other tickets | Check: assertion |
| --- | --- | --- | --- |
| M-35 docs in the app (`/docs`) | §6.1, §14.2.1 | T-APP-20, T-UI-21 | C-UI-09 |
| M-36 API playground (`/debug-api`) | §5.2, §6.2 | T-APP-21, T-UI-22 | C-UI-10 |

## 4. Holes this file closed (A-28)

| Behavior | Before | Now |
| --- | --- | --- |
| Flow Source, Plan and a draft-version Run, with the custom view | no check | C-J11-02 |
| Read-only replay | asserted in C-J11-01 step 5, not indexed | indexed on C-J11-01 |
| Hover, definition and diagnostics | unit tests only; C-J1-03 asserts their absence before a machine exists | C-UI-11 |
| Generated wiki refresh after a merge | only the stored declaration (C-J1-06) | C-J8-06 |
| `/review` on a teammate's PR | no ticket scope, no check | C-J10-09; scope in T-FLW-01 |
| Per-run model-access provenance | asserted in C-J2-04 step 4, not indexed | indexed on C-J2-04 |
| Background Retry and Dismiss | asserted in C-J4-01 step 10, not indexed; Dismiss had no storage | indexed on C-J4-01; `workflow_runs.dismissed_by` (§3) |
| J8: the next plan follows the edited decision | C-J8-04 proves citation only | C-J8-05 |

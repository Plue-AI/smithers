# Checks

A check is a falsifiable acceptance criterion. Each one names what it proves (mvp.md and spec.md references), its layer, its automation path, the steps, a numeric or binary pass condition, and the evidence to retain. A check passes only with evidence from the named layer. A unit test does not pass an end-to-end check, and a fixture-backed run does not pass a reference-host check (AGENTS.md testing quality).

Layers:
- **unit**
- **integration**: real PostgreSQL, jj, inotify and cgroups, with a fake GitHub server
- **e2e**: a real browser against a real install with microVMs and a scratch GitHub repository
- **fault**: kill points
- **perf**: on the reference host
- **journey**: recorded on a fresh Mac mini, mvp.md §12.1
- **spike**: disposable, answers a yes/no question

The reference host is a 32 GB Apple Silicon Mac mini (mvp.md §9), where the performance budgets are measured (C-PERF-01..06). Limits are separate: every install derives them from its detected host (spec §8.2.1, C-MCH-04), and every perf artifact records the host profile. The browsers run on a second Mac on the same network. The scratch repository is `smithers-mvp-canary/<date>` on GitHub, made fresh per journey run.

Evidence goes to `.artifacts/checks/<check-id>/<UTC timestamp>/`: logs, screenshots or video, JSON receipts, and the exact commit and install version. That directory is gitignored. The ticket's issue links to it.

## Index

Stage tags match [spec.md §0](../spec.md). Deferred behavior has no check.

| ID | Proves | Layer | Stage | Tickets |
| --- | --- | --- | --- | --- |
| **Spikes** | | | | |
| [C-SPK-02](C-SPK-02.md) | Answered NO (2026-10-02): two VMs writing one virtiofs home lost data, so homes are per machine (spec §8.7.1); C-MCH-09 and C-MCH-10 carry the two-machine qualification | spike | W0 | T-MCH-02 |
| [C-SPK-03](C-SPK-03.md) | Host↔guest relay round trip p95 < 20 ms on the reference host | spike | W0 | T-COL-01 |
| [C-SPK-05](C-SPK-05.md) | Host swap and memory pressure with 2 (24 GB) and 3 (32 GB) busy machines | spike | W0 | T-MCH-01 |
| [C-SPK-06](C-SPK-06.md) | A Homebrew-built, ad-hoc-signed binary with the hypervisor entitlement boots a microVM | spike | W0 | T-INS-03 |
| [C-SPK-07](C-SPK-07.md) | Yjs keystroke p95 < 1 s browser→host→VM→browser, two browsers on a second Mac | spike | W0 | T-COL-01 |
| [C-SPK-08](C-SPK-08.md) | Daemon sessions carry a recorded VS Code Remote session (edit, terminal, port forward, reconnect); exit status, half-close and flow control hold; revocation leaves no member process within 5 s | spike | W0 | T-TRM-06 |
| **Journeys (P0: J1–J5, J10)** | | | | |
| [C-J1-01](C-J1-01.md) | Fresh Mac: Homebrew install to setup card, no Smithers account | journey | R | T-INS-05, T-INS-08 |
| [C-J1-02](C-J1-02.md) | Setup card: App manifest, repository, squash check, owner sign-in, model access; Source ready and Machine ready separate | e2e | S1 | T-INS-06, T-APP-03, T-UI-02 |
| [C-J1-03](C-J1-03.md) | A question is answered with file cards before Machine ready | e2e | S1 | T-INS-06, T-APP-15 |
| [C-J1-04](C-J1-04.md) | First TODO to merged PR, unassisted, within 60 minutes of starting the install | journey | S1, R | T-INS-08, T-ACC-03, T-STK-12, T-STK-04 (thin path) |
| [C-J1-05](C-J1-05.md) | Add members by username; "needs access on GitHub"; a teammate signs in at the install's public origin | e2e | S1 | T-ACC-02, T-APP-06, T-UI-09 |
| [C-J1-06](C-J1-06.md) | A repository with no Smithers files gets a working machine and checks | e2e | S1 | T-MCH-10, T-FLW-02 |
| [C-J2-01](C-J2-01.md) | Make TODO from an issue: drafted from the discussion, edited, placed, committed, issue labeled and commented | e2e | S1 | T-STK-09, T-APP-02, T-UI-03, T-UI-04 |
| [C-J2-02](C-J2-02.md) | `todo` label: revision 1 frozen, later edits ignored, duplicate delivery idempotent | integration | S1 | T-STK-09 |
| [C-J2-03](C-J2-03.md) | Agent question → Needs you toast to owner and present members; first answer wins | e2e | S1 | T-STK-07 |
| [C-J2-04](C-J2-04.md) | PR evidence: diff, machine checks, GitHub checks, review summary, all for the accepted generation whose tree is the PR head's; the run records its model access, equal to the proxy's usage rows | e2e | S1 | T-STK-10 |
| [C-J2-05](C-J2-05.md) | Merge → Merged; issue closes when the TODO fixes it; learning receipt appears | e2e | S1, S3 | T-STK-04, T-FLW-06 |
| [C-J3-01](C-J3-01.md) | Branch card presence: people, the agent and an SSH editor, each with where | e2e | S2 | T-COL-06, T-APP-10, T-UI-15 |
| [C-J3-02](C-J3-02.md) | Own terminal as own user; others watch read-only; their keystrokes are dropped | e2e | S2 | T-TRM-01, T-APP-12, T-UI-17 |
| [C-J3-03](C-J3-03.md) | Outside change: one grouped entry attributed to the only active session (else "changed outside Smithers"), opens the diff, Restore this file works, open cards update, agent re-reads | e2e | S2 | T-COL-04, T-COL-07, T-APP-10, T-UI-15 |
| [C-J3-04](C-J3-04.md) | Two people co-edit one file, including typing on the same line (both apply): < 1 s, author colours, name flags, saved within 1 s; an outside save merges in, or on overlap shows "Changed outside Smithers · Compare" with the outside version kept, whichever comes first, the watcher or the save | e2e | S3 | T-COL-08, T-APP-14, T-UI-19 |
| [C-J3-05](C-J3-05.md) | A steer appears with its author and the agent continues on the same working copy | e2e | S1 | T-STK-06 |
| [C-J3-06](C-J3-06.md) | SSH to the install host with GitHub keys; exit status and half-close; VS Code Remote edit lands attributed; port forward; removal leaves no member process within 5 s | e2e | S2 | T-TRM-03, T-TRM-04, T-TRM-07, T-COL-04, T-COL-06 |
| [C-J3-10](C-J3-10.md) | The coding agent's commands appear in a Terminal card that members can watch read-only | e2e | S2 | T-TRM-05 |
| [C-J3-08](C-J3-08.md) | File deleted or renamed while open: the card says so; Restore and Follow work | e2e | S2 | T-APP-11, T-UI-16 |
| [C-J3-09](C-J3-09.md) | Hand-run `git checkout main` or `jj new main` → Needs you through the metadata watch; Return to Tn and Keep for now | e2e | S2 | T-COL-05, T-UI-15 |
| [C-J4-01](C-J4-01.md) | Home card counts, filters, merged since last look, sync time, machines vs capacity; a failed background run's Retry and Dismiss act for every member | e2e | S1 | T-APP-01, T-UI-06 |
| [C-J4-02](C-J4-02.md) | Answer, merge next, move up, retry with steer, all while chatting | e2e | S1 | T-STK-02, T-STK-05, T-APP-02, T-UI-04 |
| [C-J4-03](C-J4-03.md) | Only the next item merges; later items say "Merges after Tn" | integration+e2e | S1 | T-STK-04 |
| [C-J5-01](C-J5-01.md) | Flow edit from chat → TODO → merged → Active after sync; running TODOs keep their version, including a retry after a lockfile change | e2e | S1 | T-FLW-03..05, T-FLW-11, T-APP-05, T-UI-10 |
| [C-J5-02](C-J5-02.md) | A broken flow merge leaves the previous version Active and shows the error; every `main` move loads, and a helper or lockfile change outside `flows/` makes a new version | integration | S1 | T-FLW-03 |
| [C-J5-03](C-J5-03.md) | Learning proposal with evidence → TODO → merged → next TODO passes lint first time | journey | S3 | T-FLW-06, T-UI-20 |
| [C-J10-01](C-J10-01.md) | PR on `smithers/<slug>` based on `main`, body with prompt, evidence, included items and requester | e2e | S1 | T-GH-03 |
| [C-J10-02](C-J10-02.md) | GitHub review comment → steer within 60 s → agent pushes a fix that updates the PR | e2e | S1 | T-GH-04 |
| [C-J10-03](C-J10-03.md) | A push from a laptop to a TODO branch holds the agent's push → Needs you; Bring in rebases onto it; Discard, bound to the sha the card shows, keeps it in history and never overwrites a newer push | e2e | S1 | T-GH-06 |
| [C-J10-04](C-J10-04.md) | Unrelated merge on GitHub: `main` row updates; Rebase pending with people present, rebase without | e2e | S2 | T-STK-11 |
| [C-J10-05](C-J10-05.md) | Merge on GitHub → Merged; issue closes with a link | e2e | S1 | T-GH-05 |
| [C-J10-06](C-J10-06.md) | Sync health: "synced Ns ago", gold past 120 s on network loss, Retry | e2e | S1 | T-GH-08, T-UI-06 |
| [C-J10-07](C-J10-07.md) | Force-push to `main` → owner Needs you; nothing changes before confirm | integration | S1 | T-GH-07 |
| [C-J10-08](C-J10-08.md) | PR closed on GitHub → Dropped with actor; reopen restores the generation with no run; a later review comment starts a new attempt that merges; duplicate reopen is a no-op | integration | S1 | T-GH-05, T-STK-05, T-MCH-14 |
| [C-J10-09](C-J10-09.md) | `/review` on a teammate's PR runs the Active review flow in an ephemeral background machine at the PR head and writes nothing to GitHub; an outsider's PR is refused | e2e | S1, S2 | T-FLW-01, T-MCH-06 |
| **Journeys (P0: J6 steps 1–3, J7, J8, J11; P1: J6 steps 4–5, J9; mvp.md §5)** | | | | |
| [C-J6-01](C-J6-01.md) | Claude Code in a branch terminal is signed in with the skill; actions show "Ben via Claude Code" | e2e | S1 | T-TRM-02, T-APP-09, T-UI-01 |
| [C-J6-02](C-J6-02.md) | Laptop `smthrs login` gets a delegated credential that can't merge; merge opens a confirmation | integration | S1 | T-ACC-04, T-ACC-05 |
| [C-J7-01](C-J7-01.md) | Insert before #3; amend #2 shows "+1" with no new TODO | e2e | S1 | T-STK-02 |
| [C-J7-02](C-J7-02.md) | Fork T2 to scratch, Add to stack as a new TODO after T2, drop T2; the new TODO keeps T2's change | e2e | S1 | T-MCH-08 |
| [C-J7-03](C-J7-03.md) | Conflict on rebase: agent resolves once, else Needs you with Resolve | integration | S1 | T-STK-08, T-UI-04 |
| [C-J8-01](C-J8-01.md) | Learning writes a decision page linked to the change | integration | S3 | T-FLW-06, T-UI-20 |
| [C-J8-02](C-J8-02.md) | Two people co-edit a wiki page live | e2e | S1 (today's protocol), S3 | T-COL-09 |
| [C-J8-03](C-J8-03.md) | Edit a page in Obsidian on the Mac's synced folder; it imports as an attributed revision, and app edits appear in the folder | e2e | S2 | T-FLW-12 |
| [C-J8-04](C-J8-04.md) | A plan cites wiki page revisions | integration | S3 | T-FLW-10 |
| [C-J8-05](C-J8-05.md) | After a decision page is co-edited, the next related TODO's plan cites the new revision and its change follows it; a control run before the edit follows the old one (3 of 3 runs) | e2e | S3 | T-FLW-10, T-COL-09 |
| [C-J8-06](C-J8-06.md) | Generated wiki pages refresh after a merge as a background run on the Home card; a failed refresh offers Retry and Dismiss | e2e | S1 | T-FLW-02, T-APP-01 |
| [C-J9-01](C-J9-01.md) | Ask the repository: answer with file and wiki cards; Make TODO and Save to wiki | e2e | S1 | T-APP-02, T-UI-04 |
| [C-J11-01](C-J11-01.md) | Inspect: graph, step I/O, transcript, retries, waits with since, tokens/time/cost, journal, read-only replay; deterministic phase titles stand alone while summaries are pending or failed; an uninspected run gets no summary call | e2e | S1 | T-FLW-07, T-UI-12, T-APP-07 |
| [C-J11-03](C-J11-03.md) | Agent card: the owner switches a factory agent's model (applies immediately); instructions change through a TODO | e2e | S1 | T-FLW-08, T-UI-13 |
| [C-J11-04](C-J11-04.md) | Thrashing: the same failing check 3× in one attempt with no edit in between shows on the TODO card and the Inspect phase; an edit clears it | integration | S1 | T-FLW-07, T-UI-04, T-UI-12 |
| [C-J11-02](C-J11-02.md) | Flow Source opens on the proposing TODO's branch; Plan and a "draft version" Run on a scratch branch show the edited graph live; a repository flow runs from its slash command with a form and shows its custom view | e2e | S2, S3 | T-APP-05, T-FLW-04, T-FLW-05, T-FLW-07, T-UI-10, T-UI-12 |
| **Access and security** | | | | |
| [C-ACC-01](C-ACC-01.md) | Every permission-matrix row is enforced server-side for every credential kind | integration | S1 | T-ACC-03, T-ACC-04 |
| [C-ACC-02](C-ACC-02.md) | Delegated, run and machine credentials can't merge or approve; a confirmation can be approved only from a session, only while `MergeReady` holds, and expires with a new generation | integration | S1 | T-ACC-04, T-ACC-05, T-STK-04, T-UI-05 |
| [C-ACC-03](C-ACC-03.md) | Losing GitHub write suspends within 1 h; removal revokes everything within 5 s | integration | S1 | T-ACC-02, T-ACC-06 |
| [C-ACC-04](C-ACC-04.md) | Sign-in is refused off the roster or without write access, with the reason | integration | S1 | T-ACC-01, T-ACC-02 |
| [C-SEC-04](C-SEC-04.md) | Only the setup token opens setup sessions; concurrent sessions run each step once; the claim is atomic and closes every session; the owner can do only setup until GitHub confirms push | integration | S1 | T-ACC-01, T-INS-06 |
| [C-SEC-05](C-SEC-05.md) | The stage-1 terminal token allows only its scope list; an agent-uid process holding it can't drop, reorder or merge | integration | S1 | T-TRM-02 |
| [C-SEC-01](C-SEC-01.md) | Provider keys, the App PEM and main-only secrets never appear in any branch machine | integration | S2 | T-MCH-12, T-FLW-01 |
| [C-SEC-02](C-SEC-02.md) | The host process never loads or executes repository flows; no fallback to host processes | integration | S1 | T-FLW-01, T-INS-02 |
| [C-SEC-03](C-SEC-03.md) | Issue admission by issue text, role and door: outsider issues become TODOs only by a maintainer; non-member labels are reverted; later outsider text never reaches the run | integration | S1 | T-STK-09 |
| **Machines** | | | | |
| [C-MCH-01](C-MCH-01.md) | Two members and the agent on one branch share exactly one VM and one working copy | integration | S2 | T-MCH-04 |
| [C-MCH-02](C-MCH-02.md) | Admission: person before TODO before background, FIFO within class, positions shown, no preemption | integration | S2 | T-MCH-06 |
| [C-MCH-03](C-MCH-03.md) | Reading a sleeping branch (files, diff, activity) never wakes it | integration | S2 | T-MCH-07 |
| [C-MCH-04](C-MCH-04.md) | Capacity formula on 24, 32 and 64 GB; the owner can lower it but not exceed it; capacity 0 names its fix and a fresh install refuses it | unit | S2 | T-MCH-01 |
| [C-MCH-05](C-MCH-05.md) | Cleanup never deletes uncaptured work or a machine with an active session | integration | S2 | T-MCH-09 |
| [C-MCH-06](C-MCH-06.md) | No sudo or setuid; homes 0700; `agent` and other members can't read a home | integration | S2 | T-MCH-11 |
| [C-MCH-07](C-MCH-07.md) | All-branches secrets present in every session and the coding host; values never readable through the API | e2e | S2 | T-MCH-12, T-APP-13, T-UI-18 |
| [C-MCH-08](C-MCH-08.md) | Fork never stops the source machine and starts from the captured revision | integration | S2 | T-MCH-08 |
| [C-MCH-09](C-MCH-09.md) | Homes are per machine, created at first session (also for a member added while awake), never shared, kept across sleep | integration | S2 | T-MCH-11 |
| [C-MCH-10](C-MCH-10.md) | Log in once per install: the five credential files sync with newest-wins, a logout reaches every machine, history and caches stay local, revocation removes them | integration | S2 | T-MCH-15 |
| [C-MCH-11](C-MCH-11.md) | Every VM holds a slot from grant to confirmed stop; demand coalesces per branch with promotion; a cold boot prepares inside one slot at capacity 1; free disk is re-read before every grant | integration | S2 | T-MCH-06 |
| **Stack** | | | | |
| [C-STK-01](C-STK-01.md) | The projection (item state × open waits × paused → TODO state, ranked by §4.1.0a; terminal states win) is exhaustive, and the engine's guards allow only §4.1's transitions, each with an event row | unit | S1 | T-STK-01 |
| [C-STK-02](C-STK-02.md) | Items admit in stack order up to `parallel`; the parallel setting is clamped by capacity | integration | S2 | T-STK-03 |
| [C-STK-04](C-STK-04.md) | A later item's draft PR un-drafted and merged first: both items marked merged with the note, `main` folds, maintainers see `order` attention | integration | S1 | T-GH-05 |
| [C-STK-05](C-STK-05.md) | A review steer 25 h after the PR opened resumes the same run on the same working copy | integration | S1 | T-MCH-14 |
| [C-STK-03](C-STK-03.md) | Stop → Resume continues from the last finished step; Retry and Retry with the current flow keep the earlier attempt | integration | S1 | T-STK-05, T-FLW-11 |
| [C-STK-06](C-STK-06.md) | The PR head's tree is the tree checks ran on: an edit during capture or check, a steer during check, or a base move refuses `stack.propose`; a new item starts on the available prefix | integration | S1 | T-STK-12, T-FLW-11 |
| [C-STK-07](C-STK-07.md) | One merge predicate and fence: steer, edit, reorder, rebase-pending and `main`-move races against Merge merge nothing stale; concurrent merges make one GitHub call | integration | S1 | T-STK-04, T-STK-12, T-STK-06 |
| [C-STK-08](C-STK-08.md) | Independent waits: question + foreign push, pause + conflict, Stop with open waits, resume after step 1, and merges on GitHub during a steer, a question or a pause each give the §4.1.0a state | integration | S1 | T-STK-07, T-STK-05, T-GH-05, T-GH-06 |
| **GitHub** | | | | |
| [C-GH-01](C-GH-01.md) | The App manifest flow completes from `http://localhost:4000` with no public address | e2e | W0, S1 | T-GH-01 |
| [C-GH-07](C-GH-07.md) | Freshness: PR, checks and `main` within 60 s, issues within 5 min, with ten pending TODO PRs and webhooks off or dropped | e2e | S1 | T-GH-02 |
| [C-GH-08](C-GH-08.md) | Budget: at most 1,000 charged and 1,500 raw GitHub requests/h with ten pending TODO PRs and 100 issues; label events read from a cursor | integration | S1 | T-GH-02 |
| [C-GH-09](C-GH-09.md) | A crash during each outbound write produces no duplicate; writes to one target keep order; superseded and overtaken writes are never replayed | fault | S1 | T-GH-09 |
| **Co-editing contracts** | | | | |
| [C-COL-02](C-COL-02.md) | Live channel: a `gap` or reconnect resubscribes from the cursor with no duplicated or missing delta | fault | S1 | T-COL-02 |
| [C-COL-01](C-COL-01.md) | Stage-1 contracts hold: every file write carries actor + `base_digest` and a stale write gets 409; reserved topics and frame kinds exist, and a browser addresses documents only by topic; the File card renders with CodeMirror 6 | unit+integration | S1 | T-COL-10, T-COL-07, T-APP-15, T-UI-11 |
| [C-COL-03](C-COL-03.md) | The mutation lock: rebase and Return to Tn with every writer active lose no write and let none land mid-rewrite; queued writes revalidate; a stale write never applies | integration | S2, S3 | T-COL-03, T-STK-11, T-COL-05, T-COL-08 |
| [C-COL-04](C-COL-04.md) | Daemon confinement: no path, symlink swap, special file or payload identity gets through; the daemon runs unprivileged | integration | S2 | T-COL-03, T-TRM-07, T-MCH-15 |
| [C-COL-05](C-COL-05.md) | Watcher completeness: overlapping bursts and actor switches keep exact per-file versions; metadata watches catch every move; an overflow resync loses no change | integration | S2 | T-COL-04, T-COL-05 |
| **Catalog and cuts** | | | | |
| [C-CAT-01](C-CAT-01.md) | Slash, palette and `/help` equal mvp.md Appendix A (repository-flow doors asserted against `flows/*/flow.ts`); `in-card` rows equal B.4; each row's actors, minimum role and `agent` equal Appendix B; every tag has a non-Cut, non-Replaced Appendix C row and registers where that row says it runs | unit | S1 | T-CAT-01 |
| [C-CAT-02](C-CAT-02.md) | Every Appendix A row open to external agents has a CLI path whose flags equal the payload schema; every other row has `cli: null` | unit | S1 | T-CAT-02 |
| [C-CAT-03](C-CAT-03.md) | The Smithers skill lists exactly the Appendix A rows open to external agents | unit | S1 | T-CAT-02 |
| [C-CUT-01](C-CUT-01.md) | Cut surfaces are absent from the palette, agent tools, CLI MVP docs, routes and OpenAPI | unit+integration | S1, S2 | T-CUT-01..03, T-MCH-05 |
| **Durability** | | | | |
| [C-DUR-01](C-DUR-01.md) | Killing the host mid-run re-runs no completed step; the run resumes | fault | S2 | T-FLW-09, T-REL-04 |
| [C-DUR-02](C-DUR-02.md) | Killing a machine mid-run resumes the run or shows it interrupted with Retry | fault | S2 | T-FLW-09 |
| [C-DUR-03](C-DUR-03.md) | Killing the host during a GitHub write or push reconciles it without duplication | fault | S1, S2 | T-GH-09, T-FLW-09 |
| [C-DUR-04](C-DUR-04.md) | Killing the daemon, VM or host during a burst, capture or document save loses no acknowledged write and duplicates nothing on reconnect | fault | S2, S3 | T-COL-03, T-COL-08, T-COL-09, T-REL-04 |
| **Performance (reference host, p95)** | | | | |
| [C-PERF-01](C-PERF-01.md) | App agent first token < 1.5 s from submit (preflight included, reported separately); answer with cards < 8 s | perf | R | T-REL-01 |
| [C-PERF-02](C-PERF-02.md) | Projection delta to subscribers < 1 s | perf | S1 | T-COL-02 |
| [C-PERF-03](C-PERF-03.md) | Keystroke to a remote File card < 1 s | perf | S3 | T-COL-08 |
| [C-PERF-04](C-PERF-04.md) | Outside disk write to an open File card < 1 s | perf | S2 | T-COL-04, T-APP-11 |
| [C-PERF-05](C-PERF-05.md) | Warm wake < 5 s | perf | S2 | T-MCH-06 |
| [C-PERF-06](C-PERF-06.md) | Rebase with people present holds writes < 2 s | perf | S2 | T-STK-11 |
| **Install and release** | | | | |
| [C-INS-01](C-INS-01.md) | The app works on localhost, on a plain-HTTP LAN origin and behind an HTTPS proxy; no secure-context API is required | e2e | S1 | T-INS-04 |
| [C-INS-03](C-INS-03.md) | Bind address and public origins are owner settings, applied without a restart; one effective origin per request sets cookies, Origin checks, the OAuth callback and the SSH line; unknown hosts get 421 | integration | S1 | T-INS-04 |
| [C-INS-05](C-INS-05.md) | The bundle runs from a clean checkout's build output with no hand-assembled files | integration | S1 | T-INS-01 |
| [C-INS-06](C-INS-06.md) | `smthrs host start` runs a built bundle as a launchd service: up before any login, restarted after a crash, idempotent, with setup URLs | integration | S1 | T-INS-08 |
| [C-REL-01](C-REL-01.md) | In-app docs are one quickstart plus the flows reference; the site keeps one install page; every quoted command resolves; docs gates pass | unit | R | T-DOC-01..03 |
| [C-REL-02](C-REL-02.md) | `brew install` + `smthrs host start` on a fresh Mac needs no Smithers account | journey | R | T-INS-05, T-INS-08 |
| [C-REL-03](C-REL-03.md) | A launch-day install upgrades to the next release with all data intact, with work in flight | journey | R | T-INS-07 |
| [C-REL-04](C-REL-04.md) | The alpha scorecard (mvp.md §10) is computed from run data | integration | S1 | T-REL-03 |
| [C-REL-05](C-REL-05.md) | 24 h soak with live Claude Code, Codex and `gh` logins on two machines: no login prompt | e2e | R | T-MCH-15, T-REL-02 |
| [C-REL-06](C-REL-06.md) | A backup taken under concurrent work on host A restores on a fresh Mac B and matches its manifest; crashes during quiesce or backup reopen admissions; incomplete backups are refused | e2e+fault | R | T-INS-07 |
| **App** | | | | |
| [C-UI-01](C-UI-01.md) | Every P0 journey (J1–J5, J6 steps 1–3, J7, J8, J10, J11) completes keyboard-only | e2e | R | T-REL-02 |
| [C-UI-02](C-UI-02.md) | Product words and minimal text: no banned terms or explanatory paragraphs in cards | unit | S1 | T-CAT-01, T-UI-14 |
| [C-UI-08](C-UI-08.md) | Every card in the §14.3.0 inventory is a props-only View plus a Container with a schema matching §14.3; Views import no topic, store or command code; the retained cards keep their pinned schemas | unit | S1 | T-APP-19, T-UI-01, T-UI-02, T-UI-03, T-UI-04, T-UI-05, T-UI-06, T-UI-07, T-UI-08, T-UI-09, T-UI-10, T-UI-11, T-UI-12, T-UI-13, T-UI-14, T-UI-15, T-UI-16, T-UI-17, T-UI-18, T-UI-19, T-UI-20 |
| [C-UI-09](C-UI-09.md) | `/docs` opens bundled pages and anchors from the composer and Settings; offline; not-found state | e2e | S2 | T-APP-20 |
| [C-UI-10](C-UI-10.md) | `/debug-api` shows only documented operations, sends with the viewer's own permissions, mutations need a second press, agents refused | integration | S2 | T-APP-21 |
| [C-UI-03](C-UI-03.md) | Hidden tab: Needs you, In review and Failed raise a browser notification on https and localhost; one permission ask by gesture; plain-HTTP origins show toasts only | e2e | S2 | T-APP-18, T-UI-08 |
| [C-UI-04](C-UI-04.md) | Edge map and timeline: tones, states, actions; summaries refresh while live; summarizer failure keeps the last | e2e | S1 | T-APP-07, T-UI-08 |
| [C-UI-05](C-UI-05.md) | Honest state: no state shown before its event; toasts settle only on terminal events | integration+e2e | S1 | T-COL-02, T-APP-08, T-STK-01, T-COL-10 |
| [C-UI-06](C-UI-06.md) | Two members on one branch see the same entries, keep their own scroll and card state; a prompt runs with its author's rights; UI-only flows touch only the author's screen; no private entry reaches any turn; removing a member cancels their queued and running turns | e2e | S1 | T-APP-16, T-UI-07 |
| [C-UI-07](C-UI-07.md) | Every answer has a stored context list and a Context line; Inspect shows preflight first; only selected context and shared entries reach the answer step, never a private entry | integration | S1 | T-APP-17, T-UI-07 |
| [C-UI-11](C-UI-11.md) | Kept capabilities: File-card hover, definition and diagnostics on an awake branch (S1 build and release build), and the webpage reader card | e2e | S1, R | T-APP-15, T-APP-11, T-UI-11 |

## Journey × check matrix (P0)

```
        J1                        J2                  J3                         J4          J5            J10
 C-J1-01..06               C-J2-01..05         C-J3-01..06, 08, 09        C-J4-01..03  C-J5-01..03   C-J10-01..09
 C-INS-01/03/06 C-REL-02   C-SEC-03            C-MCH-01 C-PERF-03/04      C-STK-02/08  C-SEC-02      C-GH-07..09
 C-ACC-04 C-GH-01 C-SEC-04 C-ACC-02            C-ACC-01 C-MCH-06          C-PERF-02    C-DUR-01      C-DUR-03
 C-PERF-01                 C-STK-01/06/07      C-PERF-06 C-DUR-04         C-UI-01/05   C-J11-03
                                             C-COL-03..05

        J6 (steps 1–3)            J7                  J8                         J11
 C-J6-01 C-SEC-05          C-J7-01..03         C-J8-01..06                C-J11-01..04
 C-MCH-10 C-REL-05         C-MCH-08
 C-CAT-03 C-J3-03
```

Every P0 journey: C-UI-01. Step-by-step chains for every journey step and §6 row: [coverage.md](../coverage.md).

## Check file template

```
# C-XXX-NN Title
Proves: mvp.md … · spec.md §… · Layer: … · Tickets: …
Automation: path/to/test (to write) · Runs in: CI | reference host | manual recorded

## Setup               exact preconditions (install version, repo state, members, machines)
## Steps               numbered, each one observable
## Pass when           binary or numeric; p95 targets state the sample size
## Fail when           the most likely wrong outcomes, stated so a reviewer recognizes them
## Evidence            files written to .artifacts/checks/<id>/<ts>/
```

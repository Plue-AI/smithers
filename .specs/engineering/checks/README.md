# Checks

A check is a falsifiable acceptance criterion. Each one names what it proves (mvp.md and spec.md references), its layer, its automation path, the steps, a numeric or binary pass condition, and the evidence to retain. A check passes only with evidence from the named layer. A unit test does not pass an end-to-end check, and a fixture-backed run does not pass a reference-host check (AGENTS.md testing quality).

Layers:
- **unit**
- **integration**: real PostgreSQL, jj, inotify and cgroups, with a fake GitHub server
- **e2e**: a real browser against a real install with microVMs and a scratch GitHub repository
- **fault**: kill points
- **perf**: on the reference host
- **journey**: recorded on a fresh macOS user account on the reference mini, mvp.md §12.1
- **spike**: disposable, answers a yes/no question

The reference host is the team's 64 GB Apple Silicon Mac mini (10 performance cores) (mvp.md §9), where the performance budgets are measured (C-PERF-01..06). Limits are separate: every install derives them from its detected host (spec §8.2.1, C-MCH-04), and every perf artifact records the host profile. The browsers run on a second Mac on the same network. The scratch repository is `smithers-mvp-canary/<date>` on GitHub, made fresh per journey run. A 32 GB host’s p95 is not measured until tested (C-PERF-01–06).

Evidence goes to `.artifacts/checks/<check-id>/<UTC timestamp>/`. One runner records receipts: `scripts/check-run.mjs` (ruling 3 of the minimal-code synthesis, 2026-10-03). A receipt is either CI's own check run at the landed SHA for the check's target, or a `smthrs test` run on the reference host with its log and exit. Command bindings live in `scripts/check-commands.json`; `pendingBinding` retains proposed argv, prerequisites, subcases and expected case IDs without approving execution. Empty case populations and unbound subcases remain blockers. Prose PASS claims are insufficient. The issue links the directory and its logs, screenshots or video.

Run `node scripts/check-run.mjs <check-id>` for an approved CI mapping. Missing automation, unapproved mappings and unavailable hosts are refused; reference-host execution remains blocked until authenticated host provenance is implemented. No runner, install or alternate environment is inferred. Host facts come from the install API. Retain retrievable logs and artifacts with the receipt; prose claims and local execution alone do not establish qualification.

G-THIN remains the built-bundle install → first real TODO → person squash-merge proof in the QA validation plan. Its reviewed dependency and safety closure is recorded with check receipts, rather than a separate qualification command or executable obligation manifest; it does not certify full-stage or release scope.

A ticket closes only with a passing receipt for every check it names, bound to the landed commit.

Which checks stay (ruling 4): journey checks (C-J*), security (C-SEC*), durability (C-DUR*), and checks observed at a boundary no single ticket's tests reach: authorization across the HTTP API (C-ACC-01..04), real GitHub (C-GH-01, C-GH-07), crash points (C-GH-09, C-COL-02), the macOS host, VM isolation and network origins (C-INS-01, C-INS-06, C-COL-04, C-MCH-06, C-MCH-09, C-MCH-10, C-MNT-06, C-REL-02, C-REL-03, C-REL-05, C-REL-06), reference-host timing (C-PERF-*), hardware spikes (C-SPK-*), the merged tree (C-STK-06), keyboard-only journeys (C-UI-01) and View reachability (C-UI-13). Every other check is folded into its owning ticket's own tests; its file keeps the title and names that ticket.

## Index

Stage tags match [spec.md §0](../spec.md). M names the dated maintainer release in mvp.md §14. Its launch trust prerequisites remain S1 checks. Other deferred behavior has no check.

| ID | Proves | Layer | Stage | Tickets |
| --- | --- | --- | --- | --- |
| **Maintainer release: launch + 1 week** | | | | |
| [C-MNT-01](C-MNT-01.md) | Folded into T-MNT-01's tests | integration | M | T-MNT-01 |
| [C-MNT-02](C-MNT-02.md) | Folded into T-MNT-02's tests | e2e | M | T-MNT-02 |
| [C-MNT-03](C-MNT-03.md) | Folded into T-MNT-03's tests | integration | M | T-MNT-03 |
| [C-MNT-04](C-MNT-04.md) | Folded into T-MNT-04's tests | e2e | M | T-MNT-04 |
| [C-MNT-05](C-MNT-05.md) | Folded into T-MNT-05's tests | e2e | M | T-MNT-05 |
| [C-MNT-06](C-MNT-06.md) | Outsider code cannot execute on the host or read teammate tokens | e2e | M | T-MNT-01, T-MNT-02, T-MNT-03, T-MNT-04, T-MNT-05 |
| **Spikes** | | | | |
| [C-SPK-02](C-SPK-02.md) | Answered NO (2026-10-02): two VMs writing one virtiofs home lost data, so homes are per machine (spec §8.7.1); C-MCH-09 and C-MCH-10 carry the two-machine qualification | spike | W0 | T-MCH-02 |
| [C-SPK-03](C-SPK-03.md) | Host↔guest relay round trip p95 < 20 ms on the reference host | spike | W0 | T-COL-01, T-COL-11 |
| [C-SPK-05](C-SPK-05.md) | Host swap and memory pressure with 2 (24 GB) and 3 (32 GB) busy machines | spike | W0 | T-MCH-01 |
| [C-SPK-06](C-SPK-06.md) | Homebrew signing and daemon VM boot decisions with exact plists, commands and LaunchAgent fallback evidence | spike | W0 | T-INS-03 |
| [C-SPK-07](C-SPK-07.md) | Yjs keystroke p95 < 1 s browser→host→VM→browser, two browsers on a second Mac | spike | W0 | T-COL-01, T-COL-11 |
| [C-SPK-08](C-SPK-08.md) | Daemon sessions carry a recorded VS Code Remote session (edit, terminal, port forward, reconnect); exit status, half-close and flow control hold; revocation leaves no member process within 5 s; SIGKILL restart drains old session cgroups before accepting open_session | spike | W0 | T-TRM-06 |
| **Journeys (P0: J1–J5, J10)** | | | | |
| [C-J1-01](C-J1-01.md) | Fresh Mac: built bundle at S1; Homebrew tap at R; setup card, no Smithers account | journey | S1, R | S1: T-INS-08 · R: T-INS-05, T-INS-08, T-REL-02 |
| [C-J1-02](C-J1-02.md) | Setup card: App manifest, repository, squash check, owner sign-in, model access; Source ready and Machine ready separate | e2e+integration | S1 | T-INS-06, T-APP-03, T-GH-01, T-REL-02 |
| [C-J1-03](C-J1-03.md) | A question is answered with file cards before Machine ready | e2e | S1 | T-INS-06, T-APP-15, T-REL-02 |
| [C-J1-04](C-J1-04.md) | First TODO to merged PR, unassisted, within 60 minutes of starting the install | journey | S1, R | T-ACC-01, T-ACC-02, T-ACC-03, T-ACC-04, T-APP-04, T-INS-08, T-APP-01, T-APP-02, T-APP-03, T-APP-05, T-APP-06, T-APP-07, T-APP-08, T-APP-09, T-APP-15, T-APP-16, T-APP-17, T-APP-19, T-APP-22, T-CAT-01, T-COL-02, T-COL-07, T-COL-10, T-DOC-01, T-FLW-01, T-FLW-02, T-FLW-03, T-FLW-04, T-FLW-11, T-GH-01, T-GH-02, T-GH-03, T-GH-09, T-INS-01, T-INS-02, T-INS-03, T-INS-04, T-INS-05, T-INS-06, T-MCH-08, T-MCH-10, T-MCH-14, T-REL-02, T-STK-01, T-STK-02, T-STK-04, T-STK-05, T-STK-06, T-STK-12 |
| [C-J1-05](C-J1-05.md) | Add members by username; "needs access on GitHub"; a teammate signs in at the install's public origin | e2e | S1 | T-ACC-02, T-APP-06, T-REL-02 |
| [C-J1-06](C-J1-06.md) | A repository with no Smithers files gets a working machine and checks | e2e | S1 | T-MCH-10, T-FLW-02, T-REL-02 |
| [C-J2-01](C-J2-01.md) | Make TODO from an issue: drafted from the discussion, edited, placed, committed, issue labeled and commented | e2e | S1 | T-STK-09, T-APP-02, T-REL-02 |
| [C-J2-02](C-J2-02.md) | `todo` label: revision 1 frozen, later edits ignored, duplicate delivery idempotent | integration | S1 | T-STK-09 |
| [C-J2-03](C-J2-03.md) | Agent question → Needs you toast to owner and present members; first answer wins | e2e | S1 | T-STK-01 |
| [C-J2-04](C-J2-04.md) | PR evidence: diff, machine checks, GitHub checks, review summary, all for the accepted generation whose tree is the PR head's; the run records its model access, equal to the proxy's usage rows | e2e | S1 | T-STK-01 |
| [C-J2-05](C-J2-05.md) | Merge → Merged; issue closes when the TODO fixes it; learning receipt appears | e2e | S1, S3 | T-STK-04, T-FLW-06, T-REL-02 |
| [C-J3-01](C-J3-01.md) | Branch card presence: people, the agent and an SSH editor, each with where | e2e | S2 | T-COL-06, T-APP-10, T-REL-02 |
| [C-J3-02](C-J3-02.md) | Own terminal as own user; others watch read-only; their keystrokes are dropped | e2e | S2 | T-TRM-01, T-APP-12 |
| [C-AGT-01](C-AGT-01.md) | Folded into T-AGT-01's tests | unit | S2 | T-AGT-01 |
| [C-AGT-02](C-AGT-02.md) | Folded into T-AGT-02's tests | e2e | S2 | T-AGT-02, T-AGT-03 |
| [C-J3-03](C-J3-03.md) | Outside change: one grouped entry attributed to the only active session (else "changed outside Smithers"), opens the diff, Restore this file works, open cards update, agent re-reads | e2e | S2 | T-COL-04, T-COL-12, T-APP-10 |
| [C-J3-04](C-J3-04.md) | Two people co-edit one file, including typing on the same line (both apply): < 1 s, author colours, name flags, saved within 1 s; an outside save merges in, or on overlap shows "Changed outside Smithers · Compare" with the outside version kept, whichever comes first, the watcher or the save | e2e | S3 | T-COL-08, T-APP-14, T-APP-14a, T-COL-08a, T-COL-08b |
| [C-J3-05](C-J3-05.md) | A steer appears with its author and the agent continues on the same working copy | e2e | S1 | T-STK-06 |
| [C-J3-06](C-J3-06.md) | SSH to the install host with GitHub keys; exit status and half-close; VS Code Remote edit lands attributed; port forward; removal leaves no member process within 5 s | e2e | S2 | T-TRM-03, T-ACC-02, T-TRM-07, T-COL-04, T-COL-06, T-REL-02 |
| [C-J3-10](C-J3-10.md) | The coding agent's commands appear in a Terminal card that members can watch read-only | e2e | S2 | T-TRM-05, T-REL-02 |
| [C-J3-08](C-J3-08.md) | File deleted or renamed while open: the card says so; Restore and Follow work | e2e | S2 | T-APP-11, T-REL-02 |
| [C-J3-09](C-J3-09.md) | Hand-run `git checkout main` or `jj new main` → Needs you through the metadata watch; Return to Tn and Keep for now | e2e | S2 | T-COL-05 |
| [C-J4-01](C-J4-01.md) | Home card counts, filters, merged since last look, sync time, machines vs capacity; a failed background run's Retry and Dismiss act for every member | e2e | S1, S2 | T-APP-01, T-REL-02 |
| [C-J4-02](C-J4-02.md) | Answer, merge next, move up, retry with steer, all while chatting | e2e | S1 | T-STK-02, T-STK-05, T-APP-02 |
| [C-J4-03](C-J4-03.md) | Only the next item merges; later items say "Merges after Tn" | integration+e2e | S1 | T-STK-04, T-REL-02 |
| [C-J5-01](C-J5-01.md) | Flow edit from chat → TODO → merged → Active after sync; running TODOs keep their version, including a retry after a lockfile change | e2e | S1 | T-FLW-03..05, T-FLW-11, T-APP-05, T-FLW-04, T-FLW-05, T-REL-02 |
| [C-J5-02](C-J5-02.md) | A broken flow merge leaves the previous version Active and shows the error; every `main` move loads, and a helper or lockfile change outside `flows/` makes a new version | integration | S1 | T-FLW-03, T-FLW-04, T-FLW-11 |
| [C-J5-03](C-J5-03.md) | Learning proposal with evidence → TODO → merged → next TODO passes lint first time | journey | S3 | T-FLW-06, T-REL-02 |
| [C-J10-01](C-J10-01.md) | PR on `smithers/<slug>` based on `main`, body with prompt, evidence, included items and requester | e2e | S1 | T-GH-03, T-REL-02 |
| [C-J10-02](C-J10-02.md) | GitHub review comment → steer within 60 s → agent pushes a fix that updates the PR | e2e | S1 | T-GH-04 |
| [C-J10-03](C-J10-03.md) | A push from a laptop to a TODO branch holds the agent's push → Needs you; Bring in rebases onto it; Discard, bound to the sha the card shows, keeps it in history and never overwrites a newer push | e2e | S1 | T-GH-06 |
| [C-J10-04](C-J10-04.md) | Unrelated merge on GitHub: `main` row updates; Rebase pending with people present, rebase without | e2e | S2 | T-STK-08 |
| [C-J10-05](C-J10-05.md) | Merge on GitHub → Merged; issue closes with a link | e2e | S1 | T-GH-03 |
| [C-J10-06](C-J10-06.md) | Sync health: "synced Ns ago", gold past 120 s on network loss, Retry | e2e | S1 | T-GH-07 |
| [C-J10-07](C-J10-07.md) | Force-push to `main` → owner Needs you; nothing changes before confirm | integration | S1 | T-GH-07, T-ACC-03 |
| [C-J10-08](C-J10-08.md) | PR closed on GitHub → Dropped with actor; reopen restores the generation with no run; a later review comment starts a new attempt that merges; duplicate reopen is a no-op | integration | S1 | T-GH-03, T-STK-05, T-MCH-14 |
| [C-J10-09](C-J10-09.md) | `/review` on a teammate's PR runs the Active review flow in an ephemeral background machine at the PR head and writes nothing to GitHub; an outsider's PR is refused | e2e | S1, S2 | T-FLW-13, T-MCH-06, T-REL-02 |
| **Journeys (P0: J6 steps 1–3, J7, J8, J11; P1: J6 steps 4–5, J9; mvp.md §5)** | | | | |
| [C-J6-01](C-J6-01.md) | Claude Code in a branch terminal is signed in with the skill; actions show "Claude Code for Ben" | e2e | S1 | T-TRM-02, T-APP-09, T-REL-02 |
| [C-J6-02](C-J6-02.md) | Laptop `smthrs login` gets a delegated credential that can't merge; merge opens a confirmation | integration | S1 | T-ACC-04, T-APP-04, T-REL-02 |
| [C-J7-01](C-J7-01.md) | Insert before #3; amend #2 shows "+1" with no new TODO | e2e | S1 | T-STK-02, T-STK-06, T-REL-02 |
| [C-J7-02](C-J7-02.md) | Fork T2 to scratch, Add to stack as a new TODO after T2, drop T2; the new TODO keeps T2's change | e2e | S1 | T-MCH-08, T-STK-05 |
| [C-J7-03](C-J7-03.md) | Conflict on rebase: agent resolves once, else Needs you with Resolve | integration | S1 | T-STK-08, T-REL-02 |
| [C-J8-01](C-J8-01.md) | Learning writes a decision page linked to the change | integration | S3 | T-FLW-06, T-REL-02 |
| [C-J8-02](C-J8-02.md) | Two people co-edit a wiki page live | e2e | S1 (today's protocol), S3 | T-COL-09 |
| [C-J8-03](C-J8-03.md) | Edit a page in Obsidian on the Mac's synced folder; it imports as an attributed revision, and app edits appear in the folder | e2e | S2 | T-FLW-12 |
| [C-J8-04](C-J8-04.md) | A plan cites wiki page revisions | integration | S3 | T-FLW-10 |
| [C-J8-05](C-J8-05.md) | After a decision page is co-edited, the next related TODO's plan cites the new revision and its change follows it; a control run before the edit follows the old one (3 of 3 runs) | e2e | S3 | T-FLW-10, T-COL-09 |
| [C-J8-06](C-J8-06.md) | Generated wiki pages refresh after a merge as a background run on the Home card; a failed refresh offers Retry and Dismiss | e2e | S1 | T-FLW-02, T-APP-01, T-REL-02 |
| [C-J9-01](C-J9-01.md) | Ask the repository: answer with file and wiki cards; Make TODO and Save to wiki | e2e | S1 | T-APP-02 |
| [C-J11-01](C-J11-01.md) | Inspect: graph, step I/O, transcript, retries, waits with since, tokens/time/cost, journal, read-only replay; deterministic phase titles stand alone while summaries are pending or failed; an uninspected run gets no summary call | e2e+integration | S1 | T-FLW-07, T-APP-07, T-REL-02 |
| [C-J11-03](C-J11-03.md) | Agent card: the owner switches a factory agent's model (applies immediately); instructions change through a TODO | e2e | S1 | T-FLW-08 |
| [C-J11-04](C-J11-04.md) | Thrashing: the same failing check 3× in one attempt with no edit in between shows on the TODO card and the Inspect phase; an edit clears it | integration | S1 | T-FLW-07, T-REL-02 |
| [C-J11-02](C-J11-02.md) | Flow Source opens on the proposing TODO's branch; Plan and a "draft version" Run on a scratch branch show the edited graph live; a repository flow runs from its slash command with a form and shows its custom view | e2e | S2, S3 | T-APP-05, T-FLW-04, T-FLW-05, T-FLW-07 |
| **Access and security** | | | | |
| [C-ACC-01](C-ACC-01.md) | Every permission-matrix row is enforced server-side for every credential kind | integration | S1 | T-ACC-02, T-ACC-03, T-ACC-04, T-APP-04, T-INS-08, T-TRM-02, T-CUT-03, T-STK-06 |
| [C-ACC-02](C-ACC-02.md) | Delegated, run and machine credentials can't merge or approve; a confirmation can be approved only from a session, only while `MergeReady` holds, and expires with a new generation | integration | S1 | T-ACC-04, T-APP-04, T-STK-04 |
| [C-ACC-03](C-ACC-03.md) | Losing GitHub write suspends within 1 h; removal revokes everything within 5 s | integration | S1 | T-ACC-02 |
| [C-ACC-04](C-ACC-04.md) | Sign-in is refused off the roster or without write access, with the reason | integration | S1 | T-ACC-01, T-ACC-02 |
| [C-SEC-04](C-SEC-04.md) | Only the setup token opens setup sessions; concurrent sessions run each step once; the claim is atomic and closes every session; the owner can do only setup until GitHub confirms push | integration | S1 | T-ACC-01, T-INS-06 · T-INS-08 owns the setup-URL stdout handoff and pre-claim restart rotation. |
| [C-SEC-05](C-SEC-05.md) | The stage-1 terminal token allows only its scope list; an agent-uid process holding it can't drop, reorder or merge | integration | S1 | T-TRM-02 |
| [C-SEC-01](C-SEC-01.md) | Provider keys, the App PEM and main-only secrets never appear in any branch machine | integration | S2 | T-MCH-12, T-FLW-01 |
| [C-SEC-02](C-SEC-02.md) | The host process never loads or executes repository flows; no fallback to host processes | integration | S1 | T-FLW-01, T-INS-02, T-INS-08, T-FLW-11, T-STK-12, T-MCH-14 |
| [C-SEC-03](C-SEC-03.md) | Issue admission by issue text, role and door: outsider issues become TODOs only by a maintainer; non-member labels are reverted; later outsider text never reaches the run | integration | S1 | T-STK-09, T-MNT-01, T-MNT-02, T-MNT-03, T-MNT-04, T-MNT-05 |
| **Machines** | | | | |
| [C-MCH-01](C-MCH-01.md) | Folded into T-MCH-04's tests | integration | S2 | T-MCH-04 |
| [C-MCH-02](C-MCH-02.md) | Folded into T-MCH-06's tests | integration | S2 | T-MCH-06 |
| [C-MCH-03](C-MCH-03.md) | Folded into T-MCH-07's tests | integration | S2 | T-MCH-07 |
| [C-MCH-04](C-MCH-04.md) | Folded into T-MCH-01's tests | unit | S2 | T-MCH-01 |
| [C-MCH-05](C-MCH-05.md) | Folded into T-MCH-09's tests | integration | S2 | T-MCH-09 |
| [C-MCH-06](C-MCH-06.md) | No sudo or setuid; homes 0700; `agent` and other members can't read a home | integration | S2 | T-MCH-11 |
| [C-MCH-07](C-MCH-07.md) | Folded into T-MCH-12's tests | e2e | S2 | T-MCH-12, T-APP-13 |
| [C-MCH-08](C-MCH-08.md) | Folded into T-MCH-08's tests | integration | S2 | T-MCH-08 |
| [C-MCH-09](C-MCH-09.md) | Homes are per machine, created at first session (also for a member added while awake), never shared, kept across sleep | integration | S2 | T-MCH-11 |
| [C-MCH-10](C-MCH-10.md) | Tool logins persist per machine across sleep and wake; Smithers never stores or copies tokens between machines | integration | S2 | T-MCH-11 |
| [C-MCH-11](C-MCH-11.md) | Folded into T-MCH-06's tests | integration | S2 | T-MCH-06 |
| **Stack** | | | | |
| [C-STK-01](C-STK-01.md) | Folded into T-STK-01's tests | unit | S1 | T-STK-01, T-STK-13, T-STK-14 |
| [C-STK-02](C-STK-02.md) | Folded into T-STK-03's tests | integration | S2 | T-STK-03 |
| [C-STK-04](C-STK-04.md) | Folded into T-GH-03's tests | integration | S1 | T-GH-05 |
| [C-STK-05](C-STK-05.md) | Folded into T-MCH-14's tests | integration | S1 | T-MCH-14 |
| [C-STK-03](C-STK-03.md) | Folded into T-STK-05's tests | integration | S1 | T-STK-05, T-FLW-11, T-STK-13, T-MCH-14 |
| [C-STK-06](C-STK-06.md) | The PR head's tree is the tree checks ran on: an edit during capture or check, a steer during check, or a base move refuses `stack.propose`; a new item starts on the available prefix | integration | S1 | T-STK-12, T-FLW-11, T-STK-01, T-GH-09, T-MCH-14 |
| [C-STK-07](C-STK-07.md) | Folded into T-STK-04's tests | integration | S1 | T-STK-04, T-STK-12, T-STK-06, T-STK-15 |
| [C-STK-08](C-STK-08.md) | Folded into T-STK-01's tests | integration | S1 | T-STK-07, T-STK-05, T-GH-05, T-GH-06 |
| [C-STK-13](C-STK-13.md) | Folded into T-STK-16's tests | integration | S1 | T-STK-16 |
| **GitHub** | | | | |
| [C-GH-01](C-GH-01.md) | The App manifest flow completes from `http://localhost:4000` with no public address | e2e | W0, S1 | T-GH-01 |
| [C-GH-07](C-GH-07.md) | Freshness: PR, checks and `main` within 60 s, issues within 5 min, with ten pending TODO PRs and webhooks off or dropped | e2e | S1 | T-GH-02 |
| [C-GH-08](C-GH-08.md) | Folded into T-GH-02's tests | integration | S1 | T-GH-02 |
| [C-GH-09](C-GH-09.md) | A crash during each outbound write produces no duplicate; writes to one target keep order; superseded and overtaken writes are never replayed | fault | S1 | T-GH-09, T-GH-01 |
| [C-GH-13](C-GH-13.md) | Folded into T-GH-04's tests | integration | S1 | T-GH-04, T-GH-05, T-GH-06 |
| **Co-editing contracts** | | | | |
| [C-COL-02](C-COL-02.md) | Live channel: a `gap` or reconnect resubscribes from the cursor with no duplicated or missing delta | fault | S1 | T-COL-02 |
| [C-COL-01](C-COL-01.md) | Folded into T-COL-10's tests | unit+integration | S1 | T-COL-10, T-COL-07, T-APP-15, T-COL-03, T-COL-03a, T-COL-03r, T-COL-04a, T-COL-03a, T-COL-03, T-COL-04a, T-COL-04, T-COL-06 |
| [C-COL-03](C-COL-03.md) | Folded into T-COL-03's tests | integration | S2, S3 | T-COL-03, T-STK-11, T-COL-05, T-COL-08, T-COL-03a, T-COL-08a |
| [C-COL-04](C-COL-04.md) | Daemon confinement: no path, symlink swap, special file or payload identity gets through; the daemon runs unprivileged | integration | S2 | T-COL-03, T-TRM-07, T-MCH-11, T-COL-03a |
| [C-COL-05](C-COL-05.md) | Folded into T-COL-04's tests | integration | S2 | T-COL-04, T-COL-05, T-COL-04a |
| **Catalog and cuts** | | | | |
| [C-CAT-01](C-CAT-01.md) | Folded into T-CAT-01's tests | unit | S1 | T-CAT-01, T-CAT-03, T-FLW-11 |
| [C-CAT-02](C-CAT-02.md) | Folded into T-CAT-01's tests | unit | S1 | T-CAT-02 |
| [C-CAT-03](C-CAT-03.md) | Folded into T-CAT-01's tests | unit | S1 | T-CAT-02 |
| [C-CUT-01](C-CUT-01.md) | Folded into T-CUT-01's tests | unit+integration | S1, S2 | T-CUT-01..04, T-MCH-05, T-APP-22, T-CUT-02, T-CUT-03 |
| [C-CUT-02](C-CUT-02.md) | Folded into T-APP-22's tests | unit+e2e | S1 | T-APP-22, T-APP-23, T-CUT-04 |
| **Durability** | | | | |
| [C-DUR-01](C-DUR-01.md) | Killing the host mid-run re-runs no completed step; the run resumes | fault | S2 | T-FLW-09, T-REL-04 |
| [C-DUR-02](C-DUR-02.md) | Killing a machine mid-run resumes the run or shows it interrupted with Retry | fault | S2 | T-FLW-09, T-REL-04 |
| [C-DUR-03](C-DUR-03.md) | Killing the host during a GitHub write or push reconciles it without duplication | fault | S1, S2 | T-GH-09, T-FLW-09, T-REL-04 |
| [C-DUR-04](C-DUR-04.md) | Killing the daemon, VM or host during a burst, capture or document save loses no acknowledged write and duplicates nothing on reconnect | fault | S2, S3 | T-COL-03, T-COL-08, T-COL-09, T-REL-04, T-COL-03a, T-COL-04a, T-COL-04, T-COL-08a, T-COL-08b |
| **Performance (reference host, p95)** | | | | |
| [C-PERF-01](C-PERF-01.md) | App agent first token < 1.5 s from submit (preflight included, reported separately); answer with cards < 8 s | perf | R | T-REL-01 |
| [C-PERF-02](C-PERF-02.md) | Projection delta to subscribers < 1 s | perf | S1 | T-COL-02, T-REL-01 |
| [C-PERF-03](C-PERF-03.md) | Keystroke to a remote File card < 1 s | perf | S3 | T-COL-08, T-COL-08a, T-COL-08b, T-REL-01 |
| [C-PERF-04](C-PERF-04.md) | Outside disk write to an open File card < 1 s | perf | S2 | T-COL-04, T-APP-11, T-REL-01 |
| [C-PERF-05](C-PERF-05.md) | Warm wake < 5 s | perf | S2 | T-MCH-06, T-REL-01 |
| [C-PERF-06](C-PERF-06.md) | Rebase with people present holds writes < 2 s | perf | S2 | T-STK-08, T-REL-01 |
| **Install and release** | | | | |
| [C-INS-01](C-INS-01.md) | The app works on localhost, on a plain-HTTP LAN origin and behind an HTTPS proxy; no secure-context API is required | e2e | S1 | T-INS-04 |
| [C-INS-03](C-INS-03.md) | Folded into T-INS-04's tests | integration | S1 | T-INS-04 |
| [C-INS-05](C-INS-05.md) | Folded into T-INS-01's tests | integration | S1 | T-INS-01, T-INS-09 |
| [C-INS-06](C-INS-06.md) | `smthrs host start` runs a built bundle as a launchd service: selected daemon or automatic-login agent, crash recovery, idempotence and setup URLs | integration | S1 | T-INS-08 |
| [C-REL-01](C-REL-01.md) | Folded into T-DOC-01's tests | unit | R | T-DOC-01..03, T-DOC-02, T-DOC-03, T-DOC-04 |
| [C-REL-02](C-REL-02.md) | `brew install` + `smthrs host start` in a fresh macOS user account on the reference mini needs no Smithers account | journey | R | T-INS-05, T-INS-08 |
| [C-REL-03](C-REL-03.md) | A launch-day install upgrades to the next release with all data intact, with work in flight | journey | R | T-INS-07 |
| [C-REL-04](C-REL-04.md) | Folded into T-REL-03's tests | integration and recorded manual | S1 | T-REL-03 |
| [C-REL-05](C-REL-05.md) | 24 h soak with independently created per-machine Claude Code, Codex and `gh` logins: no repeat login prompt | e2e (release gate) | R | T-REL-02 |
| [C-REL-06](C-REL-06.md) | A backup taken under concurrent work on host A restores in a fresh macOS user account on Mac B and matches its manifest; crashes during quiesce or backup reopen admissions; incomplete backups are refused | e2e and fault | R | T-INS-07 |
| **App** | | | | |
| [C-UI-01](C-UI-01.md) | Every P0 journey (J1–J5, J6 steps 1–3, J7, J8, J10, J11) completes keyboard-only | e2e | R | T-REL-02 |
| [C-UI-02](C-UI-02.md) | Folded into T-CAT-01's tests | unit | S1 | T-CAT-01 |
| [C-UI-08](C-UI-08.md) | Folded into T-APP-19's tests | unit | S1 | T-APP-19, T-APP-19b, T-UI-07, T-UI-08 |
| [C-UI-09](C-UI-09.md) | Folded into T-APP-20's tests | e2e | S2 | T-APP-20 |
| [C-UI-10](C-UI-10.md) | Folded into T-APP-21's tests | integration | S2 | T-APP-21 |
| [C-UI-03](C-UI-03.md) | Folded into T-APP-18's tests | e2e | S2 | T-APP-18 |
| [C-UI-04](C-UI-04.md) | Folded into T-APP-07's tests | e2e+integration | S1 | T-APP-07 |
| [C-UI-05](C-UI-05.md) | Folded into T-COL-02's tests | integration+e2e | S1 | T-COL-02, T-APP-08, T-STK-01, T-COL-10, T-COL-07 |
| [C-UI-06](C-UI-06.md) | Folded into T-APP-16's tests | e2e | S1 | T-APP-16, T-APP-23 |
| [C-UI-07](C-UI-07.md) | Folded into T-APP-17's tests | integration | S1 | T-APP-17 |
| [C-APP-01](C-APP-01.md) | Folded into T-APP-02's tests | e2e | S1 | T-ACC-06, T-APP-02 |
| [C-APP-02](C-APP-02.md) | Folded into T-APP-02's tests | e2e | S1 | T-APP-02, T-STK-15 |
| [C-APP-03](C-APP-03.md) | Folded into T-APP-03's tests | e2e | S1 | T-APP-02, T-APP-03, T-MCH-10 |
| [C-APP-04](C-APP-04.md) | Folded into T-APP-16's tests | integration | S1 | T-APP-16 |
| [C-APP-05](C-APP-05.md) | Folded into T-APP-16's tests | integration | S1 | T-APP-23 |
| [C-UI-11](C-UI-11.md) | Folded into T-APP-15's tests | e2e | S1, R | T-APP-15, T-APP-11 |
| [C-UI-12](C-UI-12.md) | Folded into T-UI-01..T-UI-14's tests | unit | S1, S2, S3 | T-UI-01, T-UI-02, T-UI-03, T-UI-04, T-UI-05, T-UI-06, T-UI-07, T-UI-08, T-UI-09, T-UI-10, T-UI-11, T-UI-12, T-UI-13, T-UI-14, T-UI-15, T-UI-16, T-UI-17, T-UI-18, T-UI-19, T-UI-20, T-UI-21, T-UI-22, T-UI-23 |
| [C-UI-13](C-UI-13.md) | Every `*View.tsx` is reachable from `CardRenderers` (shell Views from `App.tsx`), and no replaced legacy card remains | unit | S1, S2, S3 | T-APP-01, T-APP-02, T-APP-03, T-APP-04, T-APP-05, T-APP-06, T-APP-07, T-APP-16, T-UI-11, T-UI-12, T-UI-13, T-UI-14 |
| [C-PRC-01](C-PRC-01.md) | Folded into T-PRC-01's tests | integration | S1 | T-PRC-01 |
| [C-PRC-02](C-PRC-02.md) | Folded into T-PRC-02's tests | unit, integration | S1 | T-PRC-02 |
| [C-PRC-03](C-PRC-03.md) | Folded into T-PRC-03's tests | integration | S1 | T-PRC-03 |

## Journey × check matrix (P0)

```
        J1                        J2                  J3                         J4          J5            J10
 C-J1-01..06               C-J2-01..05         C-J3-01..06, 08, 09        C-J4-01..03  C-J5-01..03   C-J10-01..09
 C-INS-01/06 C-REL-02      C-SEC-03            C-PERF-03/04 C-MCH-06      C-PERF-02    C-SEC-02      C-GH-07, C-GH-09
 C-ACC-04 C-GH-01 C-SEC-04 C-ACC-02            C-ACC-01 C-PERF-06         C-UI-01      C-DUR-01      C-DUR-03
 C-PERF-01                 C-STK-06            C-DUR-04 C-COL-04                       C-J11-03

        J6 (steps 1–3)            J7                  J8                         J11
 C-J6-01 C-SEC-05          C-J7-01..03         C-J8-01..06                C-J11-01..04
 C-MCH-10 C-REL-05
 C-J3-03
```

Every P0 journey: C-UI-01. Step-by-step chains for every journey step and §6 row: [coverage.md](../coverage.md).

## Check file template

```
# C-XXX-NN Title
Proves: mvp.md … · spec.md §… · Layer: … · Tickets: …
Automation: a `smthrs test` target (to write) · Runs in: CI | reference host | manual recorded

## Setup               exact preconditions (install version, repo state, members, machines)
## Steps               numbered, each one observable
## Pass when           binary or numeric; p95 targets state the sample size
## Fail when           the most likely wrong outcomes, stated so a reviewer recognizes them
## Evidence            files written to .artifacts/checks/<id>/<ts>/
```

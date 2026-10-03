# Smithers MVP engineering overview

Status: draft v0.4 by the engineering agent (smithers-8a, tech lead), 2026-10-02. Product: [mvp.md v2.6](../product/mvp.md). Design: [mock](../design/mock/). Read this page first. Then read [spec.md](spec.md) for the target system, [delta.md](delta.md) for the path from `main`, [tickets/](tickets/) for the work, and [checks/](checks/) for acceptance.

## In one sentence

One Mac runs a Go host service with PostgreSQL. Each awake branch gets one shared microVM, inside which a Rust daemon owns the working copy, so people, terminals, SSH editors and the coding agent can all write to the same branch and every write is seen, attributed and undoable.

## In one paragraph

Most of the MVP already exists as parts: the durable flow engine, the Mythical stack worker with PRs based on `main`, microVMs, the wiki's Yjs merge, terminals, secrets, GitHub App access and the card-based app. The engineering work turns those parts into one shared, multi-member product. The current pieces are built for one owner, one workspace per person and an issue-keyed queue. Four new mechanisms carry the product:
- **One live branch.** A branch has exactly one machine. Everyone joins it through `workspace_shares` grants, and the runtime's VM admission, extended with a people-first FIFO, decides who gets a machine when capacity is full.
- **The machine daemon.** `smithers-machined` watches every write (inotify), attributes it exactly when it came through Smithers and otherwise to the only active session on the branch, groups writes into bursts with a per-file versions commit each (C-COL-05), and in stage 3 hosts the live Yjs documents for code files.
- **The live channel.** One WebSocket per tab, an adapter over the existing `sse.Broker`, carries card updates and, in stage 3, Yjs documents. Terminals keep their own WebSocket.
- **The TODO.** The existing stack item (`mythical_items`) with placement, one projected state, PRs based on `main` and a person-only merge bound to the reviewed head.

## System at a glance

```
 Browser tabs ──wss /api/live──┐        smthrs / Claude Code / Codex ──HTTPS (delegated creds)──┐
 SSH editors ──:2222──────────┐│   (to the install's bind address; HTTPS from any proxy)       │
                              ▼▼                                                               ▼
 ┌──────────────── host service (Go, packaged) ───────────────────────────────────────────────────┐
 │ identity+roles · catalog API · /api/live over sse.Broker (S3: Yjs relay) · SSH gateway         │
 │ stack engine (TODOs, order, rebase, merge) · VM admission · GitHub pollers · flow dispatch     │
 │ wiki doc host (Yrs) · summarizer · host flow runtime (system flows only)                       │
 └──────┬──────────────────────────────┬────────────────────────────────┬────────────────────────┘
   PostgreSQL 18               repo store + blobs                one relay connection per machine
 (all product state)          (mirror, jj, captured                         │
                               branch heads)                                 ▼
                                                   ┌──── microVM: one per awake branch ────────────┐
                                                   │ smithers-machined (root): sessions, inotify,  │
                                                   │   bursts, Yrs code docs, capture, presence    │
                                                   │ working copy (jj) · coding host (pinned flow) │
                                                   │ daemon sessions: member uids, no sudo · agent │
                                                   └───────────────────────────────────────────────┘
 GitHub ◀── App: git + conditional REST polls, every 30–120 s; webhooks optional ──▶ host service
 PRs are based on main: each is the verified candidate for its item; Smithers enforces merge order
```

## Data authority

| Data | Authority | Rebuilt from |
| --- | --- | --- |
| Members (`collaborators`), TODOs (`mythical_items`), stack order, activity, approvals, flow versions | PostgreSQL | Backups (`smthrs host backup`) |
| Run steps, waits, outputs | Flow runtime journal on the executing host or machine | Runtime replay; PostgreSQL holds the projection |
| Working copy bytes while awake | `smithers-machined` on the machine | Last capture in the host repo store |
| Live code documents | `smithers-machined`: the file plus a Yrs state record saved before each acknowledgment (spec §9.2.2, C-DUR-04 K7); ADR 0003 may add a host mirror for fan-out | The state record and the file |
| Live wiki documents | Host service (Yrs, persisted per idle period) | `wiki_page_revisions` |
| `main`, issues, PRs, reviews, checks | GitHub | Polling |
| Presence | Host memory, 30 s leases | Heartbeats |

## Engineering decisions

| ID | Decision | Why | Rejected alternative | Reversible? |
| --- | --- | --- | --- | --- |
| E-01 | A Homebrew tap installs a launchd-supervised host service, PostgreSQL 18 (copied from `brew --prefix postgresql@18` by the existing `bundle-postgres.ts`) and `msb`/libkrun, assembled by `build-native.ts` restored at its old path from `5b77095672`. No Electrobun app and no Docker. | Browsers are the product surface (M-28). Ad-hoc signing with the hypervisor entitlement works from a formula (to be confirmed by spike T-INS-03). | Notarized `.pkg`: an installer outside Homebrew and slower releases. Developer ID notarization inside the formula is T-INS-03's fallback (the identity exists). Docker: no microVMs on macOS. | Yes |
| E-02 | Repository code runs only in machines. Overridable flows (todo, learning, review, repository flows) run in the branch's coding host or an ephemeral background machine. Implemented by c4e325b2d. | M-29 and M-30. An agent steered by issue text must not reach host secrets. | `trusted_process` on the host (ADR 0001): unsafe once the maintainer release admits outside text. | No: a security boundary |
| E-03 | [S2] Members and the agent join a lane's workspace through write grants in the existing `workspace_shares` (consumer `B/services/workspace_access.go:42-110`). No `branches` or `machines` table in S1. Branch locks are deleted. | M-17; "feels like a CRDT". | Grants on per-user workspaces: still two working copies. | Hard |
| E-04 | A Rust daemon, `smithers-machined`, inside each VM owns sessions, the write watcher (inotify; exact attribution for writes through Smithers, session-based otherwise; fanotify deferred by product v2.5), bursts with a per-file versions commit each, the mutation lock and outbox, moved-off detection and capture [S2], as a root broker beside an unprivileged daemon (spec §9.5–§9.6; C-COL-03..05), and live code documents [S3]. | Attribution needs the pid of each write, which only the guest kernel has. Keystroke-rate writes can't afford a `msb exec` per write. Yrs is already in the stack. | Host-side documents with `PUT /files/content`: no attribution, and a process spawn per write. | Medium |
| E-05 | `/api/live` is a WebSocket adapter over the existing `sse.Broker` and `DurableStream` cursors [S1]. The client is the landed `LiveChannel.ts` minus its unread TanStack collection. Terminals keep their WebSocket; documents join in S3. Presence and resumable follow reuse `@smthrs/sync` (`BranchProtocol.ts`, `SyncClient.ts`, `BranchPresence.ts`). | Plain-HTTP browsers allow 6 connections per origin and the broker caps 5 streams per user, so one SSE per topic doesn't fit. | A new live hub, registry and frames: duplicates the broker and `@smthrs/sync`. | Medium |
| E-06 | Card state is one pure function of facts committed in one transaction. Topics use the existing durable-stream cursors. No `projection_events` table. | Honest state (mvp.md §2 rule 5) and gap-free reconnects. | A global `projection_events` table: a second copy of every card-visible write. | Medium |
| E-07 | The existing stack item (`mythical_items`) is the TODO. It gains title, owner, public number, needs-you, failure and merged/dropped columns. One Go function projects the nine product states. | Reuse the stack record; no backfill or sync. | A separate TODO table duplicates item state. | Hard after data exists |
| E-08 | GitHub uses an App made by the manifest flow during install. The existing pollers run at M-03 cadences with ETags and cached scoped tokens (spec §12.2). Webhooks only trigger a fetch and never stretch a cadence (C-GH-07). | M-03: no public address. 304 responses are free. | A new stream scheduler with a GraphQL `pr-state` query and a `github_sync` table. Webhook relay service: needs our infrastructure. | Yes |
| E-09 | Only a browser `session` credential can approve or merge. `delegated` is a non-system PAT in install mode, plus `via` (spec §5.3). Every delegated catalog row is `run`, `confirm` (a one-click card the person presses) or `never` (spec §15.1.5). | §6.13 and M-21. The CLI can't know whether an agent holds its token. | Person PATs with an "agent" flag: trusts the client. | Hard |
| E-10 | Each member has a stable unix uid on every machine and a per-machine home on that machine's disk; tool logins persist in that machine's home across sleep and wake, with no token copying (C-MCH-10). No sudo, for anyone. | M-18 and M-29. Spike T-MCH-02: two VMs writing one virtiofs home lost data. | Shared `developer` user: shared logins. One host home mounted into every machine: lost data. | Medium |
| E-11 | Extend `admitRunningLocked` and `MaxRunningVMs` (`packages/backend/microsandbox/runtime.go:86-87,533-541`) with a typed `capacity` error and a people-first FIFO (person > TODO > background). Capacity comes from the detected host (E-17). No preemption of a working agent. | M-06 and M-13. | A new admission scheduler beside the runtime's VM cap. | Yes |
| E-12 | A TODO pins (flow, source_commit, digest) at Starting. Active is the newest loaded `flow_versions` row; a failed load keeps the previous one. No closure blobs or dependency-environment packing in the MVP. | J5 and §6.12. A per-machine coding host makes #3377 unnecessary. | Load in the host: violates E-02. | Yes |
| E-13 | Origin-agnostic: loopback by default; the owner sets the bind address and public origins. The app works in secure and insecure contexts: no `crypto.randomUUID`, `crypto.subtle` or clipboard dependency. HTTPS comes from any proxy the team uses. | Will (2026-10-02): Tailscale isn't part of the product. Removing the secure-context dependency makes every exposure work. | Tailscale-only (`tailscale serve`): ties the product to one vendor. Install CA plus `smthrs connect`: certificate work for every teammate. | Yes |
| E-14 | The command descriptor is the `app-operations` `Operation`. `catalog.mvp.json` and the CLI mount are generated from it, with an allowlist test against mvp.md Appendices A, B and C. | §2 rule 1 and M-21. Today there are two catalogs. | A new descriptor package beside `Operation`. | Medium |
| E-15 | PRs stay based on `main`, each the verified candidate (main + earlier items + this item), squash-merged. Smithers enforces order. | Stacked bases are deferred (mvp.md §4.2). | Stacked bases with retargeting: about a week, and deferred. | Yes |
| E-16 | Stage 1 requires `base_digest` on every write through Smithers and refuses stale writes (§7.6). The wiki keeps its Yjs text. Other contracts ship at the stage that first uses them. | No silent overwrite. | Reserve unused document protocols and codecs in stage 1. | Hard after stage 2 |
| E-17 | Every limit (capacity, VM memory, vCPUs, layer budget) derives from the detected host profile: memory, performance cores, free disk. | Will: we don't know our users' Mac mini. | Fixed defaults per Mac model. | Yes |
| E-18 | One shared conversation per branch. Agent turns are `chat_turns` rows with `conversation_id`; `app_timelines` is deleted. Prompts run with their author's delegated credential, and a context preflight (not the transcript) feeds the model. | Will's rulings (M-08); keeps `main`'s long conversation usable. | Per-member private chat (today); a new `agent_turns` table. | Medium |
| E-19 | Each attempt pins one flow digest across its launches. The overridable `todo` composition covers route → deliver; verify and review stay engine launches (M-30, spec §10.4.1). | J5 pinning, stop/resume and steering need one pinned version per attempt. | One long-lived `todo` run per attempt: a new composition, wait and watchdog where the engine already sequences launches. | Hard after S1 |
| E-20 | App-agent turns run entirely on the host, including command dispatch, with a host-minted delegated credential. They reuse the `chat_turns` claim, lease and dispatcher. The browser gets only UI-only instructions (spec §15.1.4). | Fable F-04: shared conversations need server-side turns, and the server can't tell agent from person on a browser request. | Browser-side tool execution with a bearer beside the cookie. | Medium |
| E-21 | Design builds Views and visual components. Engineering maps data and catalog actions in the existing card file, mounted only through `CardRenderers.tsx`. Wiring a View deletes its old card rendering in the same commit (§14.2.1). | One implementation per card. | Separate Container, fixture and golden layers duplicate existing files. | Yes |

ADRs: 0002 records E-01, E-02, E-03 and E-09 and supersedes ADR 0001 for the Mac install (T-DOC-02). 0003 records E-16: stage-1 stale-write refusal; other contracts ship at their first use (§7.6).

## Build plan

The stages are mvp.md §11's, and launch needs all three. Each stage ends with its checks passing on the reference host, the team's 64 GB Apple Silicon Mac mini (10 performance cores) (mvp.md §9), where the performance budgets are measured. Limits are separate: every install derives them from its detected host (E-17), and every artifact records the host profile. The first days of stage 1 build one thin end-to-end path, and everything else in the stage widens it. A 32 GB host’s p95 is not measured until tested (C-PERF-01–06).

After stage 1, all of Smithers' own work runs as TODOs on the install by default (M-37). Each exception names an owner, the reason it cannot run through Smithers yet, and an expiry. Report every outside merge and its person effort daily against the product §10 kill signal. Check: C-REL-04.

```
 W0 (days 1–3)   Spikes, in parallel. Each is a yes/no answer with a fallback:
                 T-MCH-02 virtiofs homes (done: shared homes lose data → per-machine homes)   T-MCH-01 VM memory calibration
                 T-COL-01 relay + Yjs keystroke latency + jj snapshot latency
                 T-INS-03 signing + Hypervisor from a launchd daemon   T-GH-01 manifest from a LAN laptop

 Stage 1         Thin path first, in three lanes; it passes C-J1-04 with stage-1 tickets only:
 skeleton        Built bundle: T-INS-01 → T-INS-02 → T-INS-08; the first merge needs the 18 tickets in tickets/README.md "First tickets".
 (J1 J2 J4 J5      access   T-ACC-01 → T-ACC-03 → T-STK-04; T-ACC-02 follows T-ACC-01 + T-STK-01
                 Stack locks and waits: T-STK-01 → T-STK-12 / T-STK-07 → T-STK-04
  J11.1)         The longest chain is T-STK-01 → T-ACC-02 → T-ACC-03 → T-STK-04 (L + 2M + L, about 3–6
                 calendar weeks). T-FLW-11 pins one flow digest per attempt and folds request + vibe into
                 the `todo` composition; verify and review stay engine launches (E-19).
                 Then widen, in parallel:
                   access: roster, roles, delegated creds, run/confirm/never, revocation (first ticket)
                   TODO: object, states incl. Starting, placement, steer, stop/resume/retry, needs-you,
                         Make TODO, one pinned flow digest per attempt (T-FLW-11)
                   jj from the app (M-32): fork from main or an item, Add to stack, Rebase now
                   GitHub: setup Address → App → owner, reviews → steers, checks on every PR, drafts for
                           later PRs, follow main, sync health, `pending_op` writes, Bring in/Discard, force push
                   factory: /flow.edit, versions + activation, Executable.ts:2037 fix, pinned digests,
                            Agent card (restored ModelCards slice), `install_settings` config, toolchain detection,
                            monitor/Inspect
                   app: live channel, branch conversations + preflight, Home, TODO, Draft, Setup,
                        Settings, Confirm, Flow, Members, edge map + timeline, CodeFileView File card
                   catalog: one source with the Appendix A/B/C allowlist; §8 cuts applied
                 design (in parallel, ui-components.md order): T-UI-01 primitives, Setup/Settings, Draft,
                   TODO, Confirm, Home, shell, toasts/timeline, Members, Flow, CodeEditor, monitor, Agent, /help.
                   Each T-APP ticket migrates its legacy card file in place and deletes duplicate rendering.
 Stage 2         One live branch (drop user_id from the 0095 key), presence, member unix users + homes
 multiplayer     (per machine) + per-machine tool logins, no sudo, owner-only terminals, the agent's own terminal, SSH + GitHub keys,
 (J3 no co-edit) secrets in machines, smithers-machined watcher + bursts + Restore this file + moved-off,
                 Branch card, File/Diff reload on change, people-first VM admission, sleep reads, fork from scratch,
                 presence-aware rebase, browser notifications, Obsidian folder sync
 Stage 3         Live code co-editing (daemon documents, outside-save merge and Compare, wiki moves to
 (J3.5, J8)      the live channel), learning flow + proposals + lessons, plan citations of wiki revisions
 Release         Homebrew tap, quiesced smthrs host upgrade/backup/restore, quickstart + flows reference, perf
                 budgets, journey recordings (J1–J8, J10, J11, both themes), fault suite
 Stage M         Launch + seven days: T-MNT-01 passive Incoming and maintainer admission; then
 maintainers     T-MNT-02 issue triage, duplicates and isolated reproduction → T-MNT-03 approved replies,
                 in parallel with T-MNT-04 shared outside-PR review; T-MNT-05 in-place upgrade and release.
                 C-MNT-01..06 gate shipment. Launch trust stays enforced; no outsider event launches work.
 Dogfood         Once stage 1 passes J1 and J2 (M-31): Smithers' own development moves onto the stack on
                 Will's Mac mini, and issue-sweep stops pushing to main (target 50 merged in two weeks)
```

Critical path: T-COL-03a (L) → T-COL-03 (M) → T-TRM-07 (M) → T-COL-04 (M) → T-COL-08 (M) → T-APP-14 (M): L+5M ≈ 15–30 agent-days, with T-MCH-04 and T-MCH-11 in parallel. T-COL-03r precedes the Rust components; T-COL-04a, T-COL-08a, T-COL-08b and T-APP-14a must be ready at their integration seams. T-COL-01 fixes transport; each co-editing contract lands with its first consumer (E-16). C-J3-04 gates stage-3 exit. Will confirmed co-editing for the MVP on 2026-10-02. The second path, stage 1's stateful path, is T-STK-01 → T-FLW-11 → T-STK-06 → T-GH-04 → C-J10-02. The skeleton path is the 18 tickets C-J1-04's steps need (tickets/README.md, First tickets); the rest of stage 1 doesn't block the first merge. Product v2.5 deferred exact kernel attribution, so the fanotify spike is off the critical path. The UI port is on the stage-1 path: T-UI-01 → T-UI-02 → T-APP-03 → C-J1-02 gates J1, and T-UI-03/04/05 → T-APP-02/04 gate J2.

## Top risks

| Risk | Falsified by | If it holds |
| --- | --- | --- |
| T-FLW-11 (one pinned digest per attempt; `todo` composition replaces request + vibe) breaks the engine's launch sequencing | A first pass that runs one TODO end to end with every launch reporting the attempt's digest and the regression list green | Land it before T-STK-05, T-STK-06 and T-FLW-03 |
| **Showing.** Keystroke p95 over browser → host → relay → VM exceeds 1 s. T-COL-01 measured relay busy 4 KiB p95 197 ms (target 20 ms) and bridge 30 Hz p95 1,738 ms (target 1 s), on a contended M3 Max with no second device | T-COL-01 re-run on an idle reference host with a second device (the first, contended run failed both budgets); C-SPK-07 | ADR 0003 adopts the host-side mirror for fan-out by T-COL-10's rule before T-COL-08; the VM stays the disk authority |
| Daemon sessions cannot carry VS Code Remote or 5 s revocation without sshd | T-TRM-06 (C-SPK-08) | Escalate before T-COL-03 starts; no per-member sshd (M-29) |
| Session-based attribution reads "changed outside Smithers" too often to be useful in J3 | C-J3-03 on the reference host, with two members each running a formatter | Product revisits fanotify (parked, `tickets/deferred/T-MCH-03.md`) |
| One catalog from Appendices B and C breaks the 116 Playwright specs, or deletes too much | T-CAT-01 runs both suites; T-CUT-01 lists ambiguous rows for product | Migrate group by group behind the allowlist test (T-CUT-01's first run was discarded for deleting too much) |
| Hypervisor.framework fails from a launchd daemon | T-INS-03 spike | Launchd agent plus automatic login, no sudo (spec §16.1.2) |

Retired: the virtiofs homes risk. T-MCH-02 showed shared homes lose data, so homes are per machine and tool logins stay on their machine (spec §8.7.1, §8.7.3, C-MCH-10). The 24 GB swap risk is now handled by the host-derived capacity formula (§8.2.1), and T-MCH-01 calibrates it.

## Open questions

| Question | Owner | Blocks |
| --- | --- | --- |
| Default `parallel` when capacity is 2 (mvp.md §13); spec §10.3.1 defaults it to 1 until T-MCH-01's measurement | Product, after T-MCH-01 | T-STK-03 |
| Reference host. "William's Mac mini" (Williams-Mac-mini.local, Mac16,11, 64 GiB, 10 performance cores, macOS 26.6.2) had 3.1 GiB free at 17:05 and 208 GiB free at 17:40 on 2026-10-02 (smithers-98). The §8.2.1 disk gate is cleared: capacity is 5 machines, the dogfood capacity row (M-37). Re-check free disk before J1, because §8.2.1 re-reads it before every grant. This MacBook Pro M3 Max 64 GB is the second LAN laptop. | smithers-2f (disk), smithers-a6 (facts) | J1 on the reference host, C-PERF-*, T-COL-11 rerun |

Settled 2026-10-02 and recorded in spec.md: co-editing in the MVP (Will), Tailscale out of the product (Will), sizing from the detected host (Will), branch-shared conversations (Will), Return to Tn / Keep for now (product), the Docker image deleted (tech lead), billing and multi-repository hidden with code kept (product), #3377 not needed (tech lead).

## How to use these documents

- **Engineer:** take tickets in [tickets/README.md](tickets/README.md) order. A ticket is done when each phase’s checks pass and landed-commit receipts are attached (C-PRC-03).
- **Reviewer:** check spec compliance and repo standards separately (CLAUDE.md). The checks are the spec-compliance gate.
- **Product and design:** [spec.md §14.3](spec.md) defines card fields; [ui-components.md](ui-components.md) types them. Home ownership is T-APP-08 (snapshot and decoder) and T-APP-01 (existing card mapping and commands). T-COL-02 owns the `/api/live` adapter; the client is the landed `LiveChannel.ts`. Check: C-COL-02.

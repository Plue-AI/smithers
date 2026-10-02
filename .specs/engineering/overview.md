# Smithers MVP engineering overview

Status: draft v0.4 by the engineering agent (smithers-8a, tech lead), 2026-10-02. Product: [mvp.md v2.6](../product/mvp.md). Design: [mock](../design/mock/). Read this page first. Then read [spec.md](spec.md) for the target system, [delta.md](delta.md) for the path from `main`, [tickets/](tickets/) for the work, and [checks/](checks/) for acceptance.

## In one sentence

One Mac runs a Go host service with PostgreSQL. Each awake branch gets one shared microVM, inside which a Rust daemon owns the working copy, so people, terminals, SSH editors and the coding agent can all write to the same branch and every write is seen, attributed and undoable.

## In one paragraph

Most of the MVP already exists as parts: the durable flow engine, the Mythical stack worker with PRs based on `main`, microVMs, the wiki's Yjs merge, terminals, secrets, GitHub App access and the card-based app. The engineering work turns those parts into one shared, multi-member product. The current pieces are built for one owner, one workspace per person and an issue-keyed queue. Four new mechanisms carry the product:
- **One live branch.** A branch has exactly one machine. Everyone joins it, and an admission queue decides who gets a machine when capacity is full.
- **The machine daemon.** `smithers-machined` watches every write (inotify), attributes it exactly when it came through Smithers and otherwise to the only active session on the branch, groups writes into bursts with a per-file versions commit each (C-COL-05), and in stage 3 hosts the live Yjs documents for code files.
- **The live channel.** One WebSocket per tab carries projection deltas, presence, terminals and, in stage 3, Yjs documents.
- **The TODO object.** A first-class TODO with its own state machine, placement, stacked PRs and a person-only merge bound to the reviewed revision.

## System at a glance

```
 Browser tabs ──wss /api/live──┐        smthrs / Claude Code / Codex ──HTTPS (delegated creds)──┐
 SSH editors ──:2222──────────┐│   (to the install's bind address; HTTPS from any proxy)       │
                              ▼▼                                                               ▼
 ┌──────────────── host service (Go, packaged) ───────────────────────────────────────────────────┐
 │ identity+roles · catalog API · live hub (topics, presence, Yjs relay, terminals) · SSH gateway │
 │ stack engine (TODOs, order, rebase, merge) · admission scheduler · GitHub sync · flow dispatch │
 │ wiki doc host (Yrs) · summarizer · host flow runtime (system flows only)                       │
 └──────┬──────────────────────────────┬────────────────────────────────┬────────────────────────┘
   PostgreSQL 18               repo store + blobs                one relay connection per machine
 (all product state,          (mirror, jj, captured                         │
  projection_events)           branch heads)                                 ▼
                                                   ┌──── microVM: one per awake branch ────────────┐
                                                   │ smithers-machined (root): sessions, inotify,  │
                                                   │   bursts, Yrs code docs, capture, presence    │
                                                   │ working copy (jj) · coding host (pinned flow) │
                                                   │ daemon sessions: member uids, no sudo · agent │
                                                   └───────────────────────────────────────────────┘
 GitHub ◀── App: git + conditional REST and one GraphQL poll, every 30–120 s; webhooks optional ──▶ host service
 PRs are based on main: each is the verified candidate for its item; Smithers enforces merge order
```

## Data authority

| Data | Authority | Rebuilt from |
| --- | --- | --- |
| Members, TODOs, stack order, states, activity, approvals, flow versions, sync state | PostgreSQL | Backups (`smthrs host backup`) |
| Run steps, waits, outputs | Flow runtime journal on the executing host or machine | Runtime replay; PostgreSQL holds the projection |
| Working copy bytes while awake | `smithers-machined` on the machine | Last capture in the host repo store |
| Live code documents | `smithers-machined`: the file plus a Yrs state record saved before each acknowledgment (spec §9.2.2, C-DUR-04 K7); ADR 0003 may add a host mirror for fan-out | The state record and the file |
| Live wiki documents | Host service (Yrs, persisted per idle period) | `wiki_page_revisions` |
| `main`, issues, PRs, reviews, checks | GitHub | Polling |
| Presence | Host memory, 30 s leases | Heartbeats |

## Engineering decisions

| ID | Decision | Why | Rejected alternative | Reversible? |
| --- | --- | --- | --- | --- |
| E-01 | A Homebrew tap installs a launchd-supervised host service, bundled PostgreSQL and `msb`/libkrun, assembled by the restored `build-native.ts` stages. No Electrobun app and no Docker. | Browsers are the product surface (M-28). Ad-hoc signing with the hypervisor entitlement works from a formula (to be confirmed by spike T-INS-03). | Notarized `.pkg`: an installer outside Homebrew and slower releases. Developer ID notarization inside the formula is T-INS-03's fallback (the identity exists). Docker: no microVMs on macOS. | Yes |
| E-02 | Repository code runs only in machines. Overridable flows (todo, learning, review, repository flows) run in the branch's coding host or an ephemeral background machine. | M-29 and M-30. An agent steered by issue text must not reach host secrets. | `trusted_process` on the host (ADR 0001): unsafe once the maintainer release admits outside text. | No: a security boundary |
| E-03 | One branch has one machine, keyed by branch. Members and the agent join it, and branch locks are deleted. | M-17; "feels like a CRDT". | Grants on per-user workspaces: still two working copies. | Hard |
| E-04 | A Rust daemon, `smithers-machined`, inside each VM owns sessions, the write watcher (inotify; exact attribution for writes through Smithers, session-based otherwise; fanotify deferred by product v2.5), bursts with a per-file versions commit each, the mutation lock and outbox, moved-off detection and capture [S2], as a root broker beside an unprivileged daemon (spec §9.5–§9.6; C-COL-03..05), and live code documents [S3]. | Attribution needs the pid of each write, which only the guest kernel has. Keystroke-rate writes can't afford a `msb exec` per write. Yrs is already in the stack. | Host-side documents with `PUT /files/content`: no attribution, and a process spawn per write. | Medium |
| E-05 | One WebSocket per tab (`/api/live`) carries projections [S1], presence and terminals [S2], and Yjs [S3]. The wiki moves onto it with code co-editing, and the POST+SSE wiki path is deleted then. | Under 1 s keystrokes; one co-editing implementation; no per-resource SSE connection limit. | Keep SSE for projections plus new WebSockets for documents: three transports. | Medium |
| E-06 | PostgreSQL is the only read model. Every card-visible mutation writes a `projection_events` row in the same transaction. | Honest state (mvp.md §2 rule 5) and gap-free reconnects. | Client-side reconstruction from events: drifts. | Medium |
| E-07 | A TODO is its own table with an explicit state machine and an event log. `mythical_items` stays the engine's work record, 1:1 with a TODO. | M-16. The 15 internal states project onto the 9 product states. | Keep issues as TODOs: contradicts M-16. | Hard after data exists |
| E-08 | GitHub uses an App made by the manifest flow during install. Repo-wide conditional REST polls plus one GraphQL query for all TODO PRs cost at most 392 requests/h with ten TODO PRs (spec §12.2.2, C-GH-08). Webhooks only trigger a fetch and never stretch a cadence (C-GH-07). | M-03: no public address. 304 responses are free. | Per-PR REST polling: 1,200 check requests/h alone for ten pending PRs. Webhook relay service: needs our infrastructure. | Yes |
| E-09 | Only a browser `session` credential can approve or merge. `smthrs login`, terminal sign-in and the app agent get `delegated` credentials with `via`. Every delegated catalog row is `run`, `confirm` (a one-click card the person presses) or `never` (spec §15.1.5). | §6.13 and M-21. The CLI can't know whether an agent holds its token. | Person PATs with an "agent" flag: trusts the client. | Hard |
| E-10 | Each member has a stable unix uid on every machine and a per-machine home on that machine's disk; a host credential store syncs only five tool credential files (newest write wins). No sudo, for anyone. | M-18 and M-29. Spike T-MCH-02: two VMs writing one virtiofs home lost data. | Shared `developer` user: shared logins. One host home mounted into every machine: lost data. | Medium |
| E-11 | One admission queue with priority person > TODO > background. Capacity comes from the detected host (memory, cores, and free disk re-read before every grant), and every VM holds a slot from grant to confirmed stop (C-MCH-11). No preemption of a working agent. | M-06 and M-13. | Hard refusal at the cap (today). | Yes |
| E-12 | A run pins the flow digest. Activation happens after a background `flow-load` run on the new `main`, and a failed load keeps the previous version. | J5 and §6.12. A per-machine coding host makes #3377 unnecessary. | Load in the host: violates E-02. | Yes |
| E-13 | Origin-agnostic: loopback by default; the owner sets the bind address and public origins. The app works in secure and insecure contexts: no `crypto.randomUUID`, `crypto.subtle` or clipboard dependency. HTTPS comes from any proxy the team uses. | Will (2026-10-02): Tailscale isn't part of the product. Removing the secure-context dependency makes every exposure work. | Tailscale-only (`tailscale serve`): ties the product to one vendor. Install CA plus `smthrs connect`: certificate work for every teammate. | Yes |
| E-14 | One command catalog source feeds the app registry, the CLI, the skill and `catalog.mvp.json`, with an allowlist test against mvp.md Appendices A, B and C. | §2 rule 1 and M-21. Today there are two catalogs. | Hand-sync two catalogs: drifts. | Medium |
| E-15 | PRs stay based on `main`, each the verified candidate (main + earlier items + this item), squash-merged. Smithers enforces order. | It's built, and stacked bases are deferred (mvp.md §4.2). | Stacked bases with retargeting: about a week, and deferred. | Yes |
| E-16 | Co-editing contracts are fixed in stage 1 (spec §7.6): actor + `base_digest` on every write, reserved document topics and frames, CodeMirror 6 as the File card surface, presence in document coordinates, post-write digests in change events. | Will kept co-editing in the MVP so the architecture supports it up front (2026-10-02). | Build stages 1–2 freely and retrofit in stage 3: rewrites the File card, write APIs and change events. | Hard after stage 2 |
| E-17 | Every limit (capacity, VM memory, vCPUs, layer budget) derives from the detected host profile: memory, performance cores, free disk. | Will: we don't know our users' Mac mini. | Fixed defaults per Mac model. | Yes |
| E-18 | One shared conversation per branch. Prompts run with their author's delegated credential, and a context preflight (not the transcript) feeds the model. | Will's rulings (M-08); keeps `main`'s long conversation usable. | Per-member private chat (today). | Medium |
| E-19 | One `todo` run per attempt, from route to merge or drop, replaces today's four launched runs; `stack.propose` is a system operation (spec §10.4.1, T-FLW-11). | J5 pinning, stop/resume and steering need one run to act on. | Keep four runs: overrides and pinning span runs the engine can't tie together. | Hard after S1 |
| E-20 | App-agent turns run entirely on the host, including command dispatch, with a host-minted delegated credential; the browser gets only UI-only instructions (spec §15.1.4). | Fable F-04: shared conversations need server-side turns, and the server can't tell agent from person on a browser request. | Browser-side tool execution with a bearer beside the cookie. | Medium |
| E-21 | Design builds every visual component (`<Card>View`, shell, toasts, timeline, CSS); engineering builds `<Card>Container`s that map topics to props and callbacks to catalog commands. The seam is one zod view model per card (spec §14.2.1, `ui-components.md`, T-APP-19). | Will (2026-10-02). Lets the UI port and the backend proceed in parallel against one contract. | Engineering builds cards from the mock: duplicates design's work and drifts from it. | Yes |

ADRs: 0002 records E-01, E-02, E-03 and E-09 and supersedes ADR 0001 for the Mac install (T-DOC-02). 0003 records E-16, the co-editing contracts (T-COL-10).

## Build plan

The stages are mvp.md §11's, and launch needs all three. Each stage ends with its checks passing on the reference host, a 32 GB Apple Silicon Mac mini (mvp.md §9), where the performance budgets are measured. Limits are separate: every install derives them from its detected host (E-17), and every artifact records the host profile. The first days of stage 1 build one thin end-to-end path, and everything else in the stage widens it.

```
 W0 (days 1–3)   Spikes, in parallel. Each is a yes/no answer with a fallback:
                 T-MCH-02 virtiofs homes (done: shared homes lose data → per-machine homes)   T-MCH-01 VM memory calibration
                 T-COL-01 relay + Yjs keystroke latency + jj snapshot latency
                 T-INS-03 signing + Hypervisor from a launchd daemon   T-GH-01 manifest from a LAN laptop

 Stage 1         Thin path first, in three lanes; it passes C-J1-04 with stage-1 tickets only:
 skeleton          install  T-INS-01 → T-INS-02 → T-INS-08 (launchd service, smthrs host start)
 (J1 J2 J4 J5      access   T-ACC-01 (App credentials from env) → T-ACC-02 → T-ACC-03 → T-STK-04
  J6.1–3 J7        stack    T-STK-01 → T-STK-12 → T-STK-04, and T-STK-01 → T-ACC-02 (projection writer)
  J11.1)         The longest chain is T-STK-01 → T-ACC-02 → T-ACC-03 → T-STK-04 (L + 2M + L, about 3–6
                 calendar weeks). It runs on today's four-run worker; T-MCH-14 → T-FLW-11 replaces that
                 path inside stage 1 and deletes it in the same change.
                 Then widen, in parallel:
                   access: roster, roles, delegated creds, run/confirm/never, revocation (first ticket)
                   TODO: object, states incl. Starting, placement, steer, stop/resume/retry, needs-you,
                         Make TODO, one todo run per attempt (T-FLW-11), long-lived workspaces (T-MCH-14)
                   jj from the app (M-32): fork from main or an item, Add to stack, Rebase now
                   GitHub: setup Address → App → owner, reviews → steers, checks on every PR, drafts for
                           later PRs, follow main, sync health, outbound keys, Bring in/Discard, force push
                   factory: /flow.edit, versions + activation, Executable.ts:2036 fix, pinned closures,
                            Agent card (three model roles), install-stored config, toolchain detection,
                            monitor/Inspect
                   app: live channel, branch conversations + preflight, Home, TODO, Draft, Setup,
                        Settings, Confirm, Flow, Members, edge map + timeline, CodeMirror File card
                   catalog: one source with the Appendix A/B/C allowlist; §8 cuts applied
                 design (in parallel, ui-components.md order): T-UI-01 primitives, Setup/Settings, Draft,
                   TODO, Confirm, Home, shell, toasts/timeline, Members, Flow, CodeEditor, monitor, Agent, /help.
                   Each T-APP container waits for its T-UI view or wires a fixture stub.
 Stage 2         One live branch (drop user_id from the 0095 key), presence, member unix users + homes
 multiplayer     (per machine) + credential store, no sudo, owner-only terminals, the agent's own terminal, SSH + GitHub keys,
 (J3 no co-edit) secrets in machines, smithers-machined watcher + bursts + Restore this file + moved-off,
                 Branch card, File/Diff reload on change, admission queue, sleep reads, fork from scratch,
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

Critical path: W0 spikes → T-MCH-04 ‖ T-MCH-11 → T-COL-03 → T-TRM-07 → T-COL-04 (stage 2 watcher) → T-COL-08 (stage 3 documents) → T-APP-14 → C-J3-04, with T-COL-01 → T-COL-10 fixing the contracts in stage 1. Will confirmed co-editing for the MVP on 2026-10-02. The second path, stage 1's stateful path, is T-STK-01 → T-MCH-14 → T-FLW-11 → T-STK-06 → T-GH-04 → C-J10-02. The skeleton path is the thin path above, which ends at C-J1-04. Product v2.5 deferred exact kernel attribution, so the fanotify spike is off the critical path. The UI port is on the stage-1 path: T-UI-01 → T-UI-02 → T-APP-03 → C-J1-02 gates J1, and T-UI-03/04/05 → T-APP-02/04 gate J2.

## Top risks

| Risk | Falsified by | If it holds |
| --- | --- | --- |
| T-FLW-11 (one `todo` run replacing four launches) is bigger than an L and blocks J5, J10.2 and stop/resume | A first pass that runs one TODO end to end as one run id with the regression list green | Land it before T-STK-05, T-STK-06 and T-FLW-03..05, and give it two lanes |
| **Showing.** Keystroke p95 over browser → host → relay → VM exceeds 1 s. T-COL-01 measured relay busy 4 KiB p95 197 ms (target 20 ms) and bridge 30 Hz p95 1,738 ms (target 1 s), on a contended M3 Max with no second device | T-COL-01 re-run on an idle reference host with a second device (the first, contended run failed both budgets); C-SPK-07 | ADR 0003 adopts the host-side mirror for fan-out by T-COL-10's rule before T-COL-08; the VM stays the disk authority |
| Daemon sessions cannot carry VS Code Remote or 5 s revocation without sshd | T-TRM-06 (C-SPK-08) | Escalate before T-COL-03 starts; no per-member sshd (M-29) |
| Session-based attribution reads "changed outside Smithers" too often to be useful in J3 | C-J3-03 on the reference host, with two members each running a formatter | Product revisits fanotify (parked, `tickets/deferred/T-MCH-03.md`) |
| One catalog from Appendices B and C breaks the 116 Playwright specs, or deletes too much | T-CAT-01 runs both suites; T-CUT-01 lists ambiguous rows for product | Migrate group by group behind the allowlist test (T-CUT-01's first run was discarded for deleting too much) |
| Hypervisor.framework fails from a launchd daemon | T-INS-03 spike | Launchd agent plus automatic login, no sudo (spec §16.1.2) |

Retired: the virtiofs homes risk. T-MCH-02 showed shared homes lose data, so homes are per machine and only five credential files sync (spec §8.7.1, §8.7.3, T-MCH-15). The 24 GB swap risk is now handled by the host-derived capacity formula (§8.2.1), and T-MCH-01 calibrates it.

## Open questions

| Question | Owner | Blocks |
| --- | --- | --- |
| Default `parallel` when capacity is 2 (mvp.md §13); spec §10.3.1 defaults it to 1 until T-MCH-01's measurement | Product, after T-MCH-01 | T-STK-03 |
| Reference host RAM. The host is "William's Mac mini" (Williams-Mac-mini.local, 10.0.0.59; confirmed by Will 2026-10-02), and this MacBook Pro M3 Max 64 GB is the second LAN laptop. Model and RAM come once Will authorizes SSH. If under 32 GB, the §8.2.1 capacity row and the dogfood capacity are re-run. | smithers-a6 (SSH key from Will) | T-MCH-01, C-PERF-*, dogfood capacity |

Settled 2026-10-02 and recorded in spec.md: co-editing in the MVP (Will), Tailscale out of the product (Will), sizing from the detected host (Will), branch-shared conversations (Will), Return to Tn / Keep for now (product), the Docker image deleted (tech lead), billing and multi-repository hidden with code kept (product), #3377 not needed (tech lead).

## How to use these documents

- **Engineer:** take tickets in [tickets/README.md](tickets/README.md) order. A ticket is done when its checks pass and the evidence is attached.
- **Reviewer:** check spec compliance and repo standards separately (CLAUDE.md). The checks are the spec-compliance gate.
- **Product and design:** [spec.md §14.3](spec.md) lists each card's data contract, and [ui-components.md](ui-components.md) types it. A card field missing there is a spec bug.

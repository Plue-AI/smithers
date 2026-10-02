# Smithers MVP engineering overview

Status: draft v0.3 by the engineering agent (smithers-8a, tech lead), 2026-10-02. Product: [mvp.md v2.5](../product/mvp.md). Design: [mock](../design/mock/). Read this page first. Then read [spec.md](spec.md) for the target system, [delta.md](delta.md) for the path from `main`, [tickets/](tickets/) for the work, and [checks/](checks/) for acceptance.

## In one sentence

One Mac runs a Go host service with PostgreSQL. Each awake branch gets one shared microVM, inside which a Rust daemon owns the working copy, so people, terminals, SSH editors and the coding agent can all write to the same branch and every write is seen, attributed and undoable.

## In one paragraph

Most of the MVP already exists as parts: the durable flow engine, the Mythical stack worker with PRs based on `main`, microVMs, the wiki's Yjs merge, terminals, secrets, GitHub App access and the card-based app. The engineering work turns those parts into one shared, multi-member product. The current pieces are built for one owner, one workspace per person and an issue-keyed queue. Four new mechanisms carry the product:
- **One live branch.** A branch has exactly one machine. Everyone joins it, and an admission queue decides who gets a machine when capacity is full.
- **The machine daemon.** `smithers-machined` watches every write (inotify), attributes it exactly when it came through Smithers and otherwise to the only active session on the branch, groups writes into bursts with a jj snapshot each, and in stage 3 hosts the live Yjs documents for code files.
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
                                                   │   Undo, Yrs code docs, capture, presence      │
                                                   │ working copy (jj) · coding host (pinned flow) │
                                                   │ sshd: member uids, no sudo · agent uid        │
                                                   └───────────────────────────────────────────────┘
 GitHub ◀── App: git + conditional REST polls every 30–120 s; webhooks optional ──▶ host service
 PRs are based on main: each is the verified candidate for its item; Smithers enforces merge order
```

## Data authority

| Data | Authority | Rebuilt from |
| --- | --- | --- |
| Members, TODOs, stack order, states, activity, approvals, flow versions, sync state | PostgreSQL | Backups (`smthrs host backup`) |
| Run steps, waits, outputs | Flow runtime journal on the executing host or machine | Runtime replay; PostgreSQL holds the projection |
| Working copy bytes while awake | `smithers-machined` on the machine | Last capture in the host repo store |
| Live code documents | `smithers-machined` (in memory; disk is truth) | The file on disk |
| Live wiki documents | Host service (Yrs, persisted per idle period) | `wiki_page_revisions` |
| `main`, issues, PRs, reviews, checks | GitHub | Polling |
| Presence | Host memory, 30 s leases | Heartbeats |

## Engineering decisions

| ID | Decision | Why | Rejected alternative | Reversible? |
| --- | --- | --- | --- | --- |
| E-01 | A Homebrew tap installs a launchd-supervised host service, bundled PostgreSQL and `msb`/libkrun, assembled by the restored `build-native.ts` stages. No Electrobun app and no Docker. | Browsers are the product surface (M-28). Ad-hoc signing with the hypervisor entitlement works from a formula (to be confirmed by spike T-INS-03). | Notarized `.pkg`: needs an Apple Developer identity and slows launch. Docker: no microVMs on macOS. | Yes |
| E-02 | Repository code runs only in machines. Overridable flows (todo, learning, review, repository flows) run in the branch's coding host or an ephemeral background machine. | M-29 and M-30. An agent steered by issue text must not reach host secrets. | `trusted_process` on the host (ADR 0001): unsafe once the maintainer release admits outside text. | No: a security boundary |
| E-03 | One branch has one machine, keyed by branch. Members and the agent join it, and branch locks are deleted. | M-17; "feels like a CRDT". | Grants on per-user workspaces: still two working copies. | Hard |
| E-04 | A Rust daemon, `smithers-machined`, inside each VM owns sessions, the write watcher (inotify; exact attribution for writes through Smithers, session-based otherwise; fanotify deferred by product v2.5), bursts with a jj snapshot each, moved-off detection and capture [S2], and live code documents [S3]. | Attribution needs the pid of each write, which only the guest kernel has. Keystroke-rate writes can't afford a `msb exec` per write. Yrs is already in the stack. | Host-side documents with `PUT /files/content`: no attribution, and a process spawn per write. | Medium |
| E-05 | One WebSocket per tab (`/api/live`) carries projections [S1], presence and terminals [S2], and Yjs [S3]. The wiki moves onto it with code co-editing, and the POST+SSE wiki path is deleted then. | Under 1 s keystrokes; one co-editing implementation; no per-resource SSE connection limit. | Keep SSE for projections plus new WebSockets for documents: three transports. | Medium |
| E-06 | PostgreSQL is the only read model. Every card-visible mutation writes a `projection_events` row in the same transaction. | Honest state (M-02 rule 5) and gap-free reconnects. | Client-side reconstruction from events: drifts. | Medium |
| E-07 | A TODO is its own table with an explicit state machine and an event log. `mythical_items` stays the engine's work record, 1:1 with a TODO. | M-16. The 15 internal states project onto the 8 product states. | Keep issues as TODOs: contradicts M-16. | Hard after data exists |
| E-08 | GitHub uses an App made by the manifest flow during install. Repo-wide conditional polls cost about 500 REST calls/h. Webhooks only speed things up. | M-03: no public address. 304 responses are free. | Per-PR polling: about 4,300 calls/h. Webhook relay service: needs our infrastructure. | Yes |
| E-09 | Only a browser `session` credential can approve or merge. `smthrs login`, terminal sign-in and the app agent get `delegated` credentials with `via`, and they request a person confirmation. | §6.13 and M-21. The CLI can't know whether an agent holds its token. | Person PATs with an "agent" flag: trusts the client. | Hard |
| E-10 | Each member has a stable unix uid on every machine and a home persisted on the host and mounted into machines. No sudo, for anyone. | M-18 and M-29. | Shared `developer` user: shared logins. | Medium |
| E-11 | One admission queue with priority person > TODO > background. Capacity comes from host memory. No preemption of a working agent. | M-06 and M-13. | Hard refusal at the cap (today). | Yes |
| E-12 | A run pins the flow digest. Activation happens after a background `flow-load` run on the new `main`, and a failed load keeps the previous version. | J5 and §6.12. A per-machine coding host makes #3377 unnecessary. | Load in the host: violates E-02. | Yes |
| E-13 | Origin-agnostic: loopback by default; the owner sets the bind address and public origins. The app works in secure and insecure contexts: no `crypto.randomUUID`, `crypto.subtle` or clipboard dependency. HTTPS comes from any proxy the team uses. | Will (2026-10-02): Tailscale isn't part of the product. Removing the secure-context dependency makes every exposure work. | Tailscale-only (`tailscale serve`): ties the product to one vendor. Install CA plus `smthrs connect`: certificate work for every teammate. | Yes |
| E-17 | Every limit (capacity, VM memory, vCPUs, layer budget) derives from the detected host profile: memory, performance cores, free disk. | Will: we don't know our users' Mac mini. | Fixed defaults per Mac model. | Yes |
| E-18 | One shared conversation per branch. Prompts run with their author's delegated credential, and a context preflight (not the transcript) feeds the model. | Will's rulings (M-08); keeps `main`'s long conversation usable. | Per-member private chat (today). | Medium |
| E-15 | PRs stay based on `main`, each the verified candidate (main + earlier items + this item), squash-merged. Smithers enforces order. | It's built, and stacked bases are deferred (mvp.md §4.2). | Stacked bases with retargeting: about a week, and deferred. | Yes |
| E-16 | Co-editing contracts are fixed in stage 1 (spec §7.6): actor + `base_digest` on every write, reserved document topics and frames, CodeMirror 6 as the File card surface, presence in document coordinates, post-write digests in change events. | Will kept co-editing in the MVP so the architecture supports it up front (2026-10-02). | Build stages 1–2 freely and retrofit in stage 3: rewrites the File card, write APIs and change events. | Hard after stage 2 |
| E-14 | One command catalog source feeds the app registry, the CLI, the skill and `catalog.mvp.json`, with parity tests against Appendix A. | §2 rule 1 and M-21. Today there are two catalogs. | Hand-sync two catalogs: drifts. | Medium |

An ADR is needed for E-02, E-03 and E-09; it supersedes ADR 0001 for the Mac install (T-DOC-02).

## Build plan

The stages are mvp.md §11's, and launch needs all three. Each stage ends with its checks passing on the reference host: the team's Mac mini, whatever its size, since every limit derives from the detected host (E-17). The first days of stage 1 build one thin end-to-end path, and everything else in the stage widens it.

```
 W0 (days 1–3)   Spikes, in parallel. Each is a yes/no answer with a fallback:
                 T-MCH-02 virtiofs /home uids (homes choice)
                 T-COL-01 relay + Yjs keystroke latency          T-MCH-01 VM memory calibration on the host
                 T-INS-03 signing + Hypervisor from a launchd daemon   T-GH-01 (spike part) manifest from a LAN laptop

 Stage 1         Thin path first: T-INS-01 → T-INS-02 → T-ACC-01 (App credentials from env) → T-STK-01 → T-STK-04
 skeleton        (M+M+M+L+M ≈ 3–5 agent-weeks serial; about 2 calendar weeks with three lanes in
 (J1 J2 J4 J5    parallel: install, access, stack). It runs on today's four-run worker; T-FLW-11 replaces
  J6.1–3 J7)     that path inside stage 1 and deletes it in the same change.
  J6.1)          Then widen, in parallel:
                   access: roster, roles, delegated creds, confirmations, revocation (first ticket)
                   TODO: object, states, placement, steer, stop/resume/retry/drop, needs-you, Make TODO
                   GitHub: reviews → steers, checks on every PR, follow main by default, sync health,
                           outbound keys, foreign push → needs-you, force push → needs-you
                   factory: /flow.edit, versions + activation, Executable.ts:2036 fix, pinned closures,
                            Agent card (model), install-stored config, toolchain detection
                   app: live channel, Home, TODO, Draft, Setup, Settings, Confirm, Flow, Members,
                        Secrets, edge map + timeline
                   catalog: one source trimmed to Appendix A; §8 cuts applied
 Stage 2         One live branch (drop user_id from 0084), presence, member unix users + homes,
 multiplayer     no sudo, owner-only terminals, terminal sign-in, SSH + GitHub keys,
 (J3 no co-edit) secrets in machines, smithers-machined watcher + bursts + moved-off, Branch card,
                 File/Diff reload on change, admission queue, sleep reads, fork + add to stack,
                 presence-aware rebase
 Stage 3         Live code co-editing (daemon documents, wiki moves to the live channel), learning
 (J3.5, J8)      flow + proposals + lessons, plan citations of wiki revisions
 Release         Homebrew tap, smthrs host upgrade/backup/restore, quickstart + flows reference, perf
                 budgets, journey recordings, docs/mvp replacement, fault suite
 Dogfood         Once stage 1 passes J1 and J2 (M-31): Smithers' own development moves onto the stack on
                 Will's Mac mini, and issue-sweep stops pushing to main (target 50 merged in two weeks)
```

Critical path: W0 spikes → T-MCH-04 ‖ T-MCH-11 → T-COL-03 → T-COL-04 (stage 2 watcher) → T-COL-08 (stage 3 documents) → T-APP-14 → C-J3-04, with T-COL-01 → T-COL-10 fixing the contracts in stage 1. Will confirmed co-editing for the MVP on 2026-10-02. The second path is T-STK-01 → T-STK-06 → T-GH-04 → C-J10-02. Product v2.5 deferred exact kernel attribution, so the fanotify spike is off the critical path.

## Top risks

| Risk | Falsified by | If it holds |
| --- | --- | --- |
| virtiofs on libkrun doesn't preserve guest uid/mode | T-MCH-02: two uids write to `/home/a` and `/home/b` with mode 0700 and cross-read fails | Per-machine homes; logins persist per branch; tell product |
| Keystroke p95 over browser→host→relay→VM exceeds 1 s | T-COL-01: 2 browsers on a second Mac, 1,000 keystrokes | Host-side document mirror for fan-out; VM stays the disk authority |
| 2 machines × 8 GiB on 24 GB still swaps | T-MCH-01: run 2 TODOs with `pnpm test` on a 24 GB mini and record swap | Lower the machine memory to 6 GiB or capacity 1 on 24 GB; product decides |
| GitHub manifest flow can't redirect to the setup origin | T-GH-01 spike: run the manifest flow from a LAN laptop | Fall back to a manual "paste App credentials" step |
| Merging the two catalogs breaks the 116 Playwright specs | T-CAT-01 runs both suites | Migrate group by group behind the parity test |

## Open questions

| Question | Owner | Blocks |
| --- | --- | --- |
| Default `parallel` when capacity is 2 (mvp.md §13); spec §10.3.1 defaults it to 1 until T-MCH-01's measurement | Product, after T-MCH-01 | T-STK-03 |

Settled 2026-10-02 and recorded in spec.md: co-editing in the MVP (Will), Tailscale out of the product (Will), sizing from the detected host (Will), branch-shared conversations (Will), Return to Tn / Keep for now (product), the Docker image deleted (tech lead), billing and multi-repository hidden with code kept (product), #3377 not needed (tech lead).

## How to use these documents

- **Engineer:** take tickets in [tickets/README.md](tickets/README.md) order. A ticket is done when its checks pass and the evidence is attached.
- **Reviewer:** check spec compliance and repo standards separately (CLAUDE.md). The checks are the spec-compliance gate.
- **Product and design:** [spec.md §14.3](spec.md) lists each card's data contract. A card field missing there is a spec bug.

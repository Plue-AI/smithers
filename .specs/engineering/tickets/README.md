# Tickets

Every ticket ships a vertical slice: code, tests, the docs the change touches, and the checks it names. A ticket is **done** when four things hold:
- its phase’s checks pass on their stated layers with machine-written receipts at the landed commit (C-PRC-03);
- the issue links each required receipt, command log and verified log digest (C-PRC-03);
- nothing in [delta.md](../delta.md) for that ticket remains;
- every old path the ticket replaces is deleted in the same change (AGENTS.md "zero tech debt").

A staged ticket completes each phase independently against that phase’s declared dependencies and checks. Later-phase and release-soak checks do not block an earlier phase. The whole ticket is done only when every phase is done. Leftovers get a new ticket.

Sizes: **S** ≤ 1 day, **M** 2–4 days, **L** 1–2 weeks of one agent. Stages follow mvp.md §11 and [spec.md §0](../spec.md):
- **W0:** spikes, days 1–3;
- **S1:** skeleton;
- **S2:** multiplayer without co-editing;
- **S3:** co-editing and learning;
- **R:** release hardening.
- **M:** maintainer release, exactly seven days after MVP launch (mvp.md §14); built after launch on stages 1–3 and R.

Launch needs W0, S1, S2, S3 and R. Stage M is the dated §14 follow-up; its trust prerequisites ship at launch. Other deferred work (spec.md §0 [D], mvp.md §16) has no ticket. A ticket depends only on tickets of its own or an earlier stage. A ticket that spans stages lists its dependencies and checks per stage (`S1: … · S2: …`).

Before starting a ticket, claim its GitHub issue with `node scripts/issue-claim.mjs claim` (AGENTS.md). Ticket files carry the issue number once filed; the lead engineer (smithers-22) files them as work starts. Each ticket issue has an "Absorbs …" comment listing the older issues it folds in, and implementers read those first. Deferred work is tracked in #3467 (Cloud, billing, plans), #3468 (TUI) and #3469 (triggers and the Machine view). Parked tickets live in `tickets/deferred/`.

**First tickets.** T-ACC-01 starts on day 1 in parallel. The first-merge slice includes install/setup, identity, TODO execution/merge, catalog/live data, app Containers and their S1 View dependencies. Its resolved prerequisite closure is: T-ACC-01, T-ACC-02, T-ACC-03, T-ACC-04, T-ACC-05, T-ACC-06, T-ACC-07, T-APP-01, T-APP-02, T-APP-03, T-APP-04, T-APP-05, T-APP-06, T-APP-07, T-APP-08, T-APP-09, T-APP-15, T-APP-16, T-APP-17, T-APP-19, T-APP-22, T-APP-23, T-CAT-01, T-CAT-02, T-COL-02, T-COL-07, T-COL-10, T-FLW-01, T-FLW-02, T-FLW-03, T-FLW-04, T-FLW-11, T-GH-01, T-GH-02, T-GH-05, T-GH-09, T-INS-01, T-INS-02, T-INS-03, T-INS-04, T-INS-06, T-INS-08, T-MCH-08, T-MCH-10, T-MCH-14, T-STK-01, T-STK-02, T-STK-04, T-STK-05, T-STK-06, T-STK-07, T-STK-10, T-STK-12, T-UI-01, T-UI-02, T-UI-03, T-UI-04, T-UI-05, T-UI-06, T-UI-07, T-UI-08, T-UI-09, T-UI-10, T-UI-11, T-UI-12, T-UI-14, T-UI-23. C-J1-04’s S1 recording starts from a built bundle through T-INS-08 and proves setup, drafting, execution and merge. Estimate this complete closure before scheduling; the former 3–6 week backend-chain estimate does not estimate this journey. Bootstrap App credentials come only from T-GH-01’s setup flow into sealed PostgreSQL.

## Index

Ready requires each new table’s `ownership.csv` row with `planned:<ticket>` and one owner (C-PRC-02). Assign numbers at landing through `scripts/renumber-migration.mjs`; the default Go gate runs without PostgreSQL. Landing runs the five-target drift set from §21.2 before push (C-PRC-01). Closing requires receipts for every named phase check at the landed commit (C-PRC-03).


| ID | Title | Stage | Size | Depends on | Checks |
| --- | --- | --- | --- | --- | --- |
| **Maintainer release: launch + 1 week** | | | | | |
| [T-MNT-01](T-MNT-01.md) | Gate maintainer admission and expose passive incoming items | M | S | T-CAT-01, T-CUT-03, T-ACC-05, T-STK-09, T-GH-02, T-GH-09, T-APP-01, T-APP-19 | C-MNT-01, C-MNT-06, C-SEC-03 |
| [T-MNT-02](T-MNT-02.md) | Triage issues with duplicate and reproduction evidence | M | M | T-MNT-01, T-FLW-03, T-FLW-04, T-MCH-06, T-MCH-11, T-MCH-15, T-UI-19 | C-MNT-02, C-MNT-06, C-SEC-03 |
| [T-MNT-03](T-MNT-03.md) | Approve exact author replies before publishing | M | S | T-MNT-02, T-ACC-05, T-GH-09, T-UI-05, T-APP-04 | C-MNT-03, C-MNT-06, C-SEC-03 |
| [T-MNT-04](T-MNT-04.md) | Review outside PRs with the shared review step | M | M | T-MNT-01, T-FLW-01, T-FLW-04, T-MCH-06, T-UI-19, T-APP-19 | C-MNT-04, C-MNT-06, C-SEC-03 |
| [T-MNT-05](T-MNT-05.md) | Ship the day-seven maintainer upgrade and journey | M | S | T-MNT-03, T-MNT-04, T-INS-07, T-REL-01, T-DOC-03 | C-MNT-05, C-MNT-06, C-SEC-03 |
| **Spikes** | | | | | |
| [T-MCH-02](T-MCH-02.md) | Spike: virtiofs `/home` across two VMs (answered NO: homes are per machine) | W0 | S | — | C-SPK-02 |
| [T-COL-01](T-COL-01.md) | Spike: relay round trip, Yjs keystroke p95, jj capture cost and guest kernel probes in a VM; re-run on an idle reference host decides ADR 0003's topology | W0 | S | — | C-SPK-03, C-SPK-07 |
| [T-MCH-01](T-MCH-01.md) | Measure VM memory on 24 and 32 GB; capacity formula | W0, S2 | M | — | W0: C-SPK-05 · S2: C-MCH-04 |
| [T-INS-03](T-INS-03.md) | Spike: Homebrew ad-hoc signing and Hypervisor.framework from a launchd daemon | W0 | S | — | C-J1-04, C-SPK-06 |
| [T-TRM-06](T-TRM-06.md) | Spike: daemon sessions carry VS Code Remote; revocation in 5 s | W0 | M | — | C-SPK-08 |
| [T-COL-11](T-COL-11.md) | Spike: reference-host rerun and the ADR 0003 topology decision; capture growth, versions commit, kernel probes | W0 | M | T-COL-01 | C-SPK-03, C-SPK-07 |
| **Install and runtime** | | | | | |
| [T-INS-01](T-INS-01.md) | Server bundle assembler from the `build-native.ts` stages at `5b77095672` | S1 | M | — | C-INS-05, C-J1-04 |
| [T-INS-02](T-INS-02.md) | Launcher passes isolation, GitHub, model and public-URL settings; microVM-only | S1 | M | T-INS-01, T-ACC-01, T-ACC-07, T-INS-03 | C-J1-04, C-SEC-02 |
| [T-INS-08](T-INS-08.md) | Launchd service and `smthrs host start/stop/status` from a built bundle | S1 | M | T-INS-01, T-INS-02, T-INS-03 | C-INS-06, C-J1-01, C-J1-04, C-REL-02 |
| [T-INS-04](T-INS-04.md) | Origin-agnostic serving: configurable bind and public origins, one effective origin per request; no secure-context dependency | S1 | M | T-INS-02 | C-INS-01, C-INS-03, C-J1-04 |
| [T-INS-06](T-INS-06.md) | Install setup backend: durable steps, model access API, squash check | S1 | M | T-INS-04, T-GH-01, T-ACC-01, T-MCH-10 | C-J1-02, C-J1-03, C-J1-04, C-SEC-04 |
| [T-INS-05](T-INS-05.md) | Homebrew tap and release bottles; delete the Docker image | R | M | T-INS-01, T-INS-03, T-INS-08 | C-J1-01, C-J1-04, C-REL-02 |
| [T-INS-07](T-INS-07.md) | `smthrs host upgrade`, `backup`, `restore` with quiesce and a backup manifest (M-26) | R | L | T-INS-05, T-INS-08, T-MCH-06, T-MCH-07 | C-REL-03, C-REL-06 |
| **Access** | | | | | |
| [T-ACC-01](T-ACC-01.md) | GitHub sign-in creates the owner; delete the single-owner password path | S1 | M | — | C-ACC-04, C-J1-04, C-SEC-04 |
| [T-ACC-07](T-ACC-07.md) | Structured setup-URL stdout handoff | S1 | S | T-ACC-01, T-INS-01 | C-J1-04, C-SEC-02, C-SEC-04 |
| [T-ACC-02](T-ACC-02.md) | Members roster, access check, hourly recheck, `/api/members` | S1 | M | T-ACC-01, T-STK-01 | C-ACC-03, C-ACC-04, C-J1-04, C-J1-05 |
| [T-ACC-03](T-ACC-03.md) | One authorizer over the permission matrix | S1 | M | T-ACC-01, T-CAT-01 | C-ACC-01, C-J1-04, C-J10-07 |
| [T-ACC-04](T-ACC-04.md) | Delegated credentials with `via`; `smthrs login --agent`; attribution | S1 | M | T-ACC-03 | C-ACC-01, C-ACC-02, C-J1-04, C-J6-02 |
| [T-ACC-05](T-ACC-05.md) | Person confirmations | S1 | M | T-ACC-04, T-CAT-01 | C-ACC-02, C-J1-04, C-J6-02 |
| [T-ACC-06](T-ACC-06.md) | Revocation on removal or suspension within 5 s | S1 | S | T-ACC-02, T-STK-01 | C-ACC-03, C-APP-01, C-J1-04 |
| **Stack and TODOs** | | | | | |
| [T-STK-01](T-STK-01.md) | TODO tables, state machine, events, the `activity` table and topic, projection | S1 | L | — | C-J1-04, C-STK-01, C-UI-05 |
| [T-STK-02](T-STK-02.md) | Placement: append, before, move, drop; stack order | S1 | M | T-STK-01 | C-APP-02, C-J1-04, C-J4-02, C-J7-01 |
| [T-STK-04](T-STK-04.md) | Merge: person session, one predicate and an in-flight fence, sha-bound, squash | S1 | L | T-STK-01, T-ACC-03, T-STK-12, T-ACC-04, T-ACC-05, T-STK-07, T-GH-02, T-GH-05, T-GH-09, T-INS-02 | C-ACC-02, C-J1-04, C-J2-05, C-J4-03, C-STK-07 |
| [T-STK-05](T-STK-05.md) | Stop, resume, Retry and Retry with the current flow, drop, reopen | S1 | M | T-STK-01, T-FLW-11, T-FLW-03, T-STK-04 | C-J1-04, C-J10-08, C-J4-02, C-J7-02, C-STK-03, C-STK-08 |
| [T-STK-06](T-STK-06.md) | Steers at every boundary of the TODO flow | S1 | M | T-STK-01, T-FLW-11, T-STK-12 | C-J1-04, C-J3-05, C-STK-07 |
| [T-STK-07](T-STK-07.md) | Needs you: independent waits, precedence, first answer wins, `ask` bound for implementing seats | S1 | M | T-STK-01 | C-J1-04, C-J2-03, C-STK-08 |
| [T-STK-08](T-STK-08.md) | Rebase now; rebase conflicts: agent once, then Needs you with Resolve (M-32) | S1 | M | T-STK-07, T-UI-23, T-APP-19 | C-J7-03, C-UI-13 |
| [T-STK-09](T-STK-09.md) | Make TODO from an issue; the `todo` label freezes revision 1 | S1 | M | T-STK-01, T-ACC-02, T-GH-02 | C-J2-01, C-J2-02, C-SEC-03 |
| [T-STK-10](T-STK-10.md) | Evidence per attempt | S1 | S | T-STK-01, T-FLW-11 | C-J1-04, C-J2-04 |
| [T-STK-14](T-STK-14.md) | Existing-item backfill and Plue confirmation | S1 | M | T-STK-01 | C-STK-01 |
| [T-STK-15](T-STK-15.md) | Amend a TODO through the durable steer path | S1 | M | T-STK-02, T-STK-06 | C-ACC-01, C-J7-01, C-STK-07 |
| [T-STK-03](T-STK-03.md) | Parallel setting clamped by capacity; admission in stack order | S2 | S | T-STK-02, T-MCH-06 | C-STK-02 |
| [T-STK-11](T-STK-11.md) | Presence-aware rebase: Rebase pending, Rebase now, write hold | S2 | M | T-STK-08, T-COL-06, T-COL-03, T-COL-04, T-MCH-04, T-MCH-07 | C-COL-03, C-J10-04, C-PERF-06 |
| **GitHub sync** | | | | | |
| [T-GH-01](T-GH-01.md) | App manifest flow from localhost; sealed App credentials | W0, S1 | M | W0: — · S1: T-INS-02 | W0: C-GH-01 · S1: C-GH-01, C-J1-04 |
| [T-GH-10](T-GH-10.md) | App manifest prerequisites by stage | W0, S1 | S | T-GH-01 | W0: C-GH-01 · S1: C-GH-01 |
| [T-GH-11](T-GH-11.md) | App setup ordering: Address, account, claim, repository | W0, S1 | S | W0: T-GH-01 · S1: T-GH-01, T-INS-04, T-ACC-01 | W0: C-GH-01 · S1: C-GH-01, C-J1-02 |
| [T-GH-12](T-GH-12.md) | Durable App step and literal manifest boundary tests | W0, S1 | S | W0: T-GH-01 · S1: T-GH-01, T-GH-11, T-INS-04 | W0: C-GH-01 · S1: C-GH-01, C-J1-02 |
| [T-GH-13](T-GH-13.md) | Complete manual App credential fallback on either setup origin | W0, S1 | S | W0: T-GH-01 · S1: T-GH-01, T-GH-11, T-GH-12 | W0: C-GH-01 · S1: C-GH-01, C-J1-02 |
| [T-GH-14](T-GH-14.md) | Expose canonical App identity for outbound attribution | W0, S1 | S | W0: T-GH-01 · S1: T-GH-01 | W0: C-GH-01 · S1: C-GH-01, C-GH-09 |
| [T-GH-02](T-GH-02.md) | Poll scheduler: streams, ETags, token cache, budget, 30–120 s cadences | S1 | M | T-GH-01, T-STK-01, T-ACC-02 | C-GH-07, C-GH-08, C-J1-04 |
| [T-GH-03](T-GH-03.md) | PR shape: slug branch, body, item-only diff; later items' PRs are drafts until next | S1 | M | T-STK-01, T-STK-10, T-GH-09 | C-J10-01 |
| [T-GH-04](T-GH-04.md) | Reviews and comments on TODO PRs become steers | S1 | M | T-GH-02, T-STK-06 | C-GH-13, C-J10-02 |
| [T-GH-05](T-GH-05.md) | Checks on every PR, protection text, closed/reopened, out-of-order merge marks both merged | S1 | M | T-GH-02, T-STK-01, T-STK-07 | C-GH-13, C-J1-04, C-J10-05, C-J10-08, C-STK-04, C-STK-08 |
| [T-GH-06](T-GH-06.md) | Outside push to a TODO branch: hold the agent's push; Needs you with Bring in or Discard (M-33) | S1 | M | T-GH-02, T-STK-07, T-UI-23 | C-GH-13, C-J10-03, C-STK-08 |
| [T-GH-07](T-GH-07.md) | Force-push to `main` becomes Needs you for the owner | S1 | S | T-GH-02, T-STK-07 | C-J10-07 |
| [T-GH-08](T-GH-08.md) | Follow `main` by default; sync health and Retry | S1 | S | T-GH-02, T-UI-06, T-APP-19 | C-J10-06, C-UI-13 |
| [T-GH-09](T-GH-09.md) | Outbound writes: keys, per-target order, supersession and reconcile | S1 | M | T-GH-01, T-STK-01 | C-DUR-03, C-GH-09, C-J1-04 |
| **Flows and the factory** | | | | | |
| [T-FLW-01](T-FLW-01.md) | Overridable flows run only in machines; system flow catalog | S1 | M | — | C-J1-04, C-J10-09, C-SEC-01, C-SEC-02 |
| [T-FLW-02](T-FLW-02.md) | Install-stored default config: checks, wiki pages, seats | S1 | M | T-FLW-01, T-MCH-10 | C-J1-04, C-J1-06, C-J8-06 |
| [T-FLW-03](T-FLW-03.md) | `flow-load`, versions, activation; keep previous on failure (`Executable.ts:2036`) | S1 | L | T-FLW-01, T-GH-02, T-FLW-11 | C-J1-04, C-J5-01, C-J5-02 |
| [T-FLW-04](T-FLW-04.md) | Coding host loads the pinned closure by digest | S1 | M | T-FLW-03, T-STK-01, T-FLW-11 | C-J1-04, C-J11-02, C-J5-01 |
| [T-FLW-05](T-FLW-05.md) | `/flow.edit` with a seed patch | S1 | M | T-FLW-03, T-STK-02, T-CAT-01, T-FLW-11 | C-J11-02, C-J5-01 |
| [T-FLW-11](T-FLW-11.md) | One `todo` run per attempt: composition flow over coding steps, the candidate handshake and the post-propose wait | S1 | L | T-FLW-01, T-STK-01, T-MCH-14, T-STK-12, T-INS-02, T-STK-07, T-GH-09 | C-CAT-01, C-J1-04, C-J5-01, C-STK-03, C-STK-06 |
| [T-FLW-08](T-FLW-08.md) | Agent card and owner model configuration restored from `5b77095672` | S1 | M | T-INS-06, T-ACC-03, T-UI-13, T-APP-19, T-APP-22 | C-J11-03, C-UI-13 |
| [T-FLW-09](T-FLW-09.md) | Reconcile before retry for push, GitHub write and shell steps | S2 | M | T-GH-09 | C-DUR-01, C-DUR-02, C-DUR-03 |
| [T-FLW-06](T-FLW-06.md) | Learning flow, proposals, Proposal card, lessons receipt | S3 | L | T-STK-10, T-FLW-05, T-MCH-06, T-UI-20, T-APP-19 | C-J2-05, C-J5-03, C-J8-01, C-UI-13 |
| [T-FLW-07](T-FLW-07.md) | Monitor: `/monitor`, cost, waits since, interrupted state, no fork filter | S1 | M | T-COL-02, T-UI-12, T-APP-19, T-APP-22 | C-J11-01, C-J11-02, C-J11-04, C-UI-13 |
| [T-FLW-12](T-FLW-12.md) | Obsidian folder sync as a Settings control | S2 | S | T-ACC-03, T-APP-03, T-UI-02, T-APP-19 | C-J8-03, C-UI-13 |
| [T-FLW-10](T-FLW-10.md) | Plans cite wiki page revisions | S3 | S | T-FLW-02, T-APP-17 | C-J8-04, C-J8-05 |
| **Machines** | | | | | |
| [T-MCH-10](T-MCH-10.md) | Toolchain detection, `.smithers/machine.json`, Source and Machine ready | S1 | M | — | C-APP-03, C-J1-04, C-J1-06 |
| [T-MCH-14](T-MCH-14.md) | Keep TODO workspaces until settled; wake before delivering a signal | S1 | S | T-STK-01, T-INS-02, T-FLW-01 | C-J1-04, C-J10-08, C-STK-05 |
| [T-MCH-04](T-MCH-04.md) | One machine per branch: drop `user_id` from the 0084 key; the agent attaches | S2 | L | T-ACC-03, T-STK-01 | C-MCH-01 |
| [T-MCH-05](T-MCH-05.md) | Delete branch locks | S2 | M | T-MCH-04 | C-CUT-01 |
| [T-MCH-06](T-MCH-06.md) | Admission scheduler: slots to confirmed stop, per-branch coalescing, disk re-check, positions, safe-idle release | S2 | L | T-MCH-04, T-MCH-01 | C-J10-09, C-MCH-02, C-MCH-11, C-PERF-05 |
| [T-MCH-07](T-MCH-07.md) | Sleep with final capture; reads never wake | S2 | M | T-COL-03, T-MCH-04 | C-MCH-03 |
| [T-MCH-08](T-MCH-08.md) | Fork from a revision; Add to stack as a new TODO; scratch becomes the item branch (M-32); fork after capture (S2) | S1, S2 | M | S1: T-STK-02, T-UI-23, T-APP-19 · S2: T-COL-03, T-MCH-04 | S1: C-J1-04, C-J7-02, C-UI-13 · S2: C-MCH-08, C-UI-13 |
| [T-MCH-09](T-MCH-09.md) | Cleanup only after settled, captured and quiet | S2 | S | T-MCH-07 | C-MCH-05 |
| [T-MCH-11](T-MCH-11.md) | Member unix users, `team` group, no-sudo image, per-machine homes | S2 | L | T-MCH-02, T-ACC-02 | C-COL-04, C-MCH-06, C-MCH-09 |
| [T-MCH-15](T-MCH-15.md) | Per-member credential store: tool logins carry across machines | S2, R | M | S2: T-MCH-11, T-COL-03 | S2: C-COL-04, C-MCH-10 · R: C-REL-05 |
| [T-MCH-12](T-MCH-12.md) | Secrets into machines; main-only kept out | S2 | M | T-MCH-11, T-COL-03 | C-MCH-07, C-SEC-01 |
| **Live layer and machine daemon** | | | | | |
| [T-COL-10](T-COL-10.md) | Co-editing contracts: ADR 0004 wire contract, golden frames, the Go codec and the topology-neutral stage-1 contracts (spec §7.6) | S1 | L | — | C-COL-01, C-J1-04, C-UI-05 |
| [T-COL-02](T-COL-02.md) | Live channel `/api/live`: topics, cursors, backpressure | S1 | L | T-STK-01, T-ACC-03, T-ACC-04, T-INS-04, T-COL-10, T-FLW-01 | C-COL-02, C-J1-04, C-PERF-02, C-UI-05 |
| [T-COL-03r](T-COL-03r.md) | Rust crate skeleton, golden-frame codec and component hooks | S2 | S-M | T-COL-10 | C-COL-01 |
| [T-COL-03f](T-COL-03f.md) | Fake machined for Go component tests | S2 | S | T-COL-10 |  |
| [T-COL-03a](T-COL-03a.md) | Rust daemon core, broker, capture and durable outbox | S2 | L | T-COL-01, T-COL-10, T-COL-03r, T-TRM-06 | C-COL-01, C-COL-03, C-COL-04, C-DUR-04 |
| [T-COL-03](T-COL-03.md) | Host registry, per-boot credentials, daemon planting and head-reporter replacement | S2 | M | T-MCH-04, T-COL-03a, T-COL-03f, T-COL-10 | C-COL-01, C-COL-03, C-COL-04, C-DUR-04 |
| [T-COL-04a](T-COL-04a.md) | Rust watcher, attribution, versions and overflow resync | S2 | M | T-COL-10, T-COL-03r | C-COL-01, C-COL-05, C-DUR-04 |
| [T-COL-04](T-COL-04.md) | Backend change events, restore and watcher integration | S2 | M | T-COL-03, T-COL-04a, T-COL-03f, T-TRM-07, T-MCH-11, T-COL-10 | C-COL-01, C-COL-05, C-DUR-04, C-J3-03, C-J3-06, C-PERF-04 |
| [T-COL-05](T-COL-05.md) | Moved off the item: detect; Return to Tn; Keep for now | S2 | M | T-COL-04, T-STK-07, T-MCH-04, T-UI-15, T-APP-19 | C-COL-03, C-COL-05, C-J3-09, C-UI-13 |
| [T-COL-06](T-COL-06.md) | Presence map and heartbeats | S2 | M | T-COL-02, T-COL-04, T-COL-10 | C-COL-01, C-J3-01, C-J3-06 |
| [T-COL-07](T-COL-07.md) | Agent write tool checks `base_digest` | S1 | S | T-COL-10 | C-COL-01, C-J1-04, C-UI-05 |
| [T-COL-08b](T-COL-08b.md) | Backend document relay and optional host mirror | S3 | M | T-COL-10, T-COL-02, T-COL-03f | C-DUR-04, C-J3-04, C-PERF-03 |
| [T-COL-08a](T-COL-08a.md) | Daemon Yrs documents and durable disk reconciliation | S3 | L | T-COL-10, T-COL-03r | C-COL-03, C-DUR-04, C-J3-04, C-PERF-03 |
| [T-COL-08](T-COL-08.md) | Live code document integration, fault recovery and reference-host p95 | S3 | M | T-COL-04, T-COL-08a, T-COL-08b, T-APP-14a, T-COL-10, T-COL-11 | C-COL-03, C-DUR-04, C-J3-04, C-PERF-03 |
| [T-COL-09](T-COL-09.md) | Wiki co-editing on the live channel; delete POST+SSE | S3 | M | T-COL-08, T-APP-14a | C-DUR-04, C-J8-02, C-J8-05 |
| **Terminals and SSH** | | | | | |
| [T-TRM-02](T-TRM-02.md) | Terminal auto sign-in and the Smithers skill on machines | S1, S2 | S | S1: T-ACC-04, T-CAT-02 · S2: T-MCH-11, T-TRM-01, T-ACC-05 | S1: C-J6-01, C-SEC-05 |
| [T-TRM-01](T-TRM-01.md) | Terminals run as their owner; only the owner types | S2 | S | T-MCH-11, T-COL-03, T-TRM-07 | C-J3-02 |
| [T-TRM-03](T-TRM-03.md) | SSH gateway: branch usernames, member users, sftp, port forwarding | S2 | L | T-MCH-06, T-MCH-11, T-INS-04, T-COL-03, T-TRM-07 | C-J3-06 |
| [T-TRM-04](T-TRM-04.md) | Import GitHub SSH keys | S2 | S | T-ACC-02 | C-J3-06 |
| [T-TRM-05](T-TRM-05.md) | The coding agent's `bash` runs in its own terminal session, shown in the Terminal card | S2 | M | T-TRM-01, T-COL-03, T-TRM-07 | C-J3-10 |
| [T-TRM-07](T-TRM-07.md) | Session supervisor: broker sessions, the §9.6 protocol, lingering processes, kill and restart rules | S2 | M | T-COL-03, T-TRM-06, T-MCH-11 | C-COL-04, C-J3-06 |
| [T-AGT-01](T-AGT-01.md) | External transcript mapping and Claude Code/Codex adapters | S2 | M | — | C-AGT-01 |
| [T-AGT-02](T-AGT-02.md) | Session-owned transcript tail and branch ingestion | S2 | L | T-AGT-01, T-TRM-07, T-TRM-01, T-COL-02, T-COL-06 | C-AGT-02 |
| [T-AGT-03](T-AGT-03.md) | Read-only external conversations in shared chat | S2 | M | T-AGT-02, T-APP-09, T-APP-16, T-UI-07, T-UI-01 | C-AGT-02 |
| [T-AGT-04](T-AGT-04.md) | Internal /ceo repository flow dogfood | M | S | T-APP-05, T-FLW-01 |  |
| **App** | | | | | |
| [T-APP-08](T-APP-08.md) | Seams move to the live channel; delete per-resource SSE | S1 | M | T-COL-02, T-STK-01 | C-J1-04, C-UI-05 |
| [T-APP-22](T-APP-22.md) | Legacy card decoder: removed card kinds read as titled tombstones | S1 | S | — | C-CUT-01, C-CUT-02, C-J1-04 |
| [T-APP-01](T-APP-01.md) | Home card on the `home` topic | S1 | M | T-COL-02, T-STK-01, T-APP-08, T-APP-16, T-UI-06, T-APP-19, T-APP-22 | C-J1-04, C-J4-01, C-J8-06, C-UI-13 |
| [T-APP-02](T-APP-02.md) | TODO card and Draft card | S1 | L | T-STK-01, T-APP-08, T-UI-03, T-UI-04, T-APP-19, T-STK-02, T-ACC-06, T-APP-16 | C-APP-01, C-APP-02, C-APP-03, C-J1-04, C-J2-01, C-J4-02, C-J9-01, C-UI-13 |
| [T-APP-03](T-APP-03.md) | Setup and Settings cards; Add to machine image | S1 | L | T-INS-06, T-UI-02, T-APP-19, T-MCH-10, T-APP-22 | C-APP-03, C-J1-02, C-J1-04, C-UI-13 |
| [T-APP-04](T-APP-04.md) | Confirm card: one-click confirmations and Review & merge | S1 | M | T-ACC-05, T-STK-04, T-UI-05, T-APP-19 | C-ACC-02, C-J1-04, C-UI-13 |
| [T-APP-05](T-APP-05.md) | Flow card with versions | S1 | M | T-FLW-03, T-APP-16, T-UI-10, T-APP-19 | C-J1-04, C-J11-02, C-J5-01, C-UI-13 |
| [T-APP-06](T-APP-06.md) | Members card | S1 | M | T-ACC-02, T-UI-09, T-APP-19 | C-J1-04, C-J1-05, C-UI-13 |
| [T-APP-07](T-APP-07.md) | Edge toast map, timeline, conversation-entry and monitor summaries | S1 | L | T-COL-02, T-APP-08, T-APP-23, T-UI-08, T-APP-19 | C-J1-04, C-J11-01, C-UI-04, C-UI-13 |
| [T-APP-09](T-APP-09.md) | Actor adapter: participants and "for Ben" (§14.6a, M-34) | S1 | S | T-ACC-04, T-UI-01, T-APP-19 | C-J1-04, C-J6-01, C-UI-13 |
| [T-APP-18](T-APP-18.md) | Browser notifications on secure origins | S2 | S | T-APP-07, T-UI-08, T-APP-19 | C-UI-03, C-UI-13 |
| [T-APP-19](T-APP-19.md) | Card view-model schemas and fixtures from `ui-components.md`: the seam between design's views and engineering's containers | S1 | S | — | C-J1-04, C-UI-08 |
| [T-UI-01](T-UI-01.md) | Primitives: actor chip, state word, tone | S1 | S | T-APP-19 | C-UI-12 |
| [T-UI-02](T-UI-02.md) | Setup and Settings views | S1 | M | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-03](T-UI-03.md) | Draft view | S1 | S | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-04](T-UI-04.md) | TODO view: states, questions, failure, evidence, PR and merge | S1 | L | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-05](T-UI-05.md) | Confirm view | S1 | S | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-06](T-UI-06.md) | Home view with the main sync row | S1 | M | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-07](T-UI-07.md) | Conversation shell: branch tree, entry rows, Context line, Earlier archive | S1 | L | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-08](T-UI-08.md) | Toasts, edge map and timeline | S1 | M | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-09](T-UI-09.md) | Members view | S1 | S | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-10](T-UI-10.md) | Flow view | S1 | M | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-11](T-UI-11.md) | Code editor and Diff views (read-only) | S1 | L | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-12](T-UI-12.md) | Run monitor and Inspect views | S1 | M | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-13](T-UI-13.md) | Agent view and model roles | S1 | S | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-14](T-UI-14.md) | Commands view (/help) | S1 | S | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-23](T-UI-23.md) | TODO view: conflict, moved-off and outside-push forms; Fork and Add to stack | S1 | M | T-UI-04, T-APP-19 | C-UI-12 |
| [T-UI-15](T-UI-15.md) | Branch view with moved-off controls | S2 | L | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-16](T-UI-16.md) | File and Diff live states | S2 | S | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-17](T-UI-17.md) | Terminal view | S2 | S | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-18](T-UI-18.md) | Secrets view | S2 | S | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-19](T-UI-19.md) | Co-editing visuals | S3 | M | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-20](T-UI-20.md) | Proposal view and lessons receipt | S3 | S | T-UI-01, T-APP-19 | C-UI-12 |
| [T-APP-15](T-APP-15.md) | File card on CodeMirror 6 with code intelligence (read-only) | S1 | M | T-COL-10, T-UI-11, T-APP-19 | C-COL-01, C-J1-03, C-J1-04, C-UI-11, C-UI-13 |
| [T-APP-16](T-APP-16.md) | Branch conversations: storage, topics, view state, branch tree, Earlier archive | S1 | L | T-COL-02, T-ACC-02, T-UI-07, T-APP-19, T-APP-22 | C-APP-04, C-J1-04, C-UI-06, C-UI-13 |
| [T-APP-23](T-APP-23.md) | Host turns: the app agent's turns move to the host; cutover to shared conversations | S1 | L | T-APP-16, T-APP-22, T-ACC-04, T-ACC-05, T-ACC-06, T-CAT-02, T-UI-07 | C-APP-05, C-CUT-02, C-J1-04, C-UI-06 |
| [T-APP-17](T-APP-17.md) | Context preflight: selection step, Context line, Inspect | S1 | M | T-APP-23, T-UI-07, T-APP-19, T-UI-12 | C-J1-04, C-UI-07, C-UI-13 |
| [T-APP-10](T-APP-10.md) | Branch card: presence, activity, machine state, terminals, SSH line | S2 | L | T-COL-06, T-COL-04, T-APP-16, T-APP-09, T-MCH-08, T-STK-11, T-UI-15, T-APP-19, T-APP-11, T-APP-22 | C-J3-01, C-J3-03, C-UI-13 |
| [T-APP-11](T-APP-11.md) | File and Diff cards reload on change; deleted/renamed states; Restore this file; language server on the daemon | S2 | M | T-COL-04, T-APP-15, T-UI-16, T-APP-19, T-APP-22 | C-J3-08, C-PERF-04, C-UI-11, C-UI-13 |
| [T-APP-12](T-APP-12.md) | Terminal card ownership UI | S2 | S | T-TRM-01, T-UI-17, T-APP-19 | C-J3-02, C-UI-13 |
| [T-APP-13](T-APP-13.md) | Secrets card | S2 | S | T-MCH-12, T-UI-18, T-APP-19, T-APP-22 | C-MCH-07, C-UI-13 |
| [T-APP-20](T-APP-20.md) | `/docs` flow: in-app docs from one Markdown source per page | S2 | M | T-APP-19, T-UI-21, T-CAT-01 | C-UI-09, C-UI-13 |
| [T-APP-21](T-APP-21.md) | `/debug-api` playground: call the documented API from the app | S2 | M | T-APP-19, T-UI-22, T-CAT-01, T-ACC-03 | C-UI-10, C-UI-13 |
| [T-UI-21](T-UI-21.md) | Docs view | S2 | S | T-UI-01, T-APP-19 | C-UI-12 |
| [T-UI-22](T-UI-22.md) | Debug API view | S2 | S | T-UI-01, T-APP-19 | C-UI-12 |
| [T-COL-12](T-COL-12.md) | The coding agent sees outside changes | S2 | S | T-COL-04, T-COL-07, T-STK-06 | C-J3-03 |
| [T-APP-14a](T-APP-14a.md) | File card client against the TS fake relay | S3 | M | T-COL-10, T-APP-15, T-UI-19, T-APP-19 | C-J3-04, C-UI-13 |
| [T-APP-14](T-APP-14.md) | File card live co-editing | S3 | M | T-COL-08, T-APP-14a | C-J3-04, C-UI-13 |
| **Catalog and cuts** | | | | | |
| [T-CAT-01](T-CAT-01.md) | One command catalog source; `catalog.mvp.json`; allowlist test from mvp.md Appendix B | S1 | L | T-UI-14, T-APP-19 | C-CAT-01, C-J1-04, C-UI-02, C-UI-13 |
| [T-CAT-02](T-CAT-02.md) | CLI doors for Appendix A; skill generated from the catalog | S1 | M | T-CAT-01 | C-CAT-02, C-CAT-03, C-J1-04 |
| [T-CUT-01](T-CUT-01.md) | Delete cut app surfaces; align AGENTS.md scope | S1 | L | — | C-CUT-01 |
| [T-CUT-02](T-CUT-02.md) | Delete cut backend routes with their OpenAPI rows | S1 | M | T-CUT-01 | C-CUT-01 |
| [T-CUT-03](T-CUT-03.md) | Hide deferred surfaces: billing, TUI, multi-repository, triggers; delete the TUI docs site | S1 | M | T-CAT-01 | C-CUT-01 |
| [T-CUT-04](T-CUT-04.md) | Cut card kinds read as tombstones; leftover cut producers in shared files (follow-up of frozen T-CUT-01) | S1 | S | T-CUT-01, T-APP-22 | C-CUT-01, C-CUT-02 |
| **Docs and release** | | | | | |
| [T-DOC-02](T-DOC-02.md) | ADR 0002: Mac install, multi-member, microVM-only, origin-agnostic | S1 | S | — | C-REL-01 |
| [T-STK-12](T-STK-12.md) | Candidate generations: capture, propose receipts, pending work, the item's prefix | S1 | M | T-STK-01, T-INS-02, T-FLW-01 | C-J1-04, C-STK-06, C-STK-07 |
| [T-INS-09](T-INS-09.md) | Bundle references for the built-bundle host lifecycle | S1 | S | T-INS-01 | C-INS-05 |
| [T-CAT-03](T-CAT-03.md) | Reject replaced flow tags after the TODO composition lands | S1 | S | T-CAT-01 | C-CAT-01 |
| [T-STK-13](T-STK-13.md) | TODO projection for independent waits and attached resumed runs | S1 | M | T-STK-01 | C-STK-01 |
| [T-REL-03](T-REL-03.md) | Alpha scorecard instrumentation (mvp.md §10) | S1, S2, S3 | M | S1: T-STK-01, T-INS-06 · S2: T-COL-04, T-COL-06 · S3: T-FLW-06 | S1: C-REL-04 |
| [T-REL-04](T-REL-04.md) | Fault suite: kill points across runs, merges, writes, bursts, rebases | S2, R | M | T-FLW-09, T-COL-04, T-STK-11 | S2: C-DUR-01, C-DUR-02, C-DUR-03, C-DUR-04 |
| [T-DOC-01](T-DOC-01.md) | Quickstart and flows reference as in-app pages; one install page on the site | R | M | T-INS-05, T-APP-20 | C-J1-04, C-REL-01 |
| [T-DOC-03](T-DOC-03.md) | Replace `docs/mvp/*` with the approved specs (M-12) | R | S | T-CUT-01 | C-REL-01 |
| [T-REL-01](T-REL-01.md) | Performance benchmarks on the reference host | R | M | T-APP-01, T-COL-04, T-COL-08, T-APP-14, T-MCH-06, T-MCH-07, T-STK-11, T-INS-06 | C-PERF-01, C-PERF-02, C-PERF-03, C-PERF-04, C-PERF-05, C-PERF-06 |
| [T-REL-02](T-REL-02.md) | Journey recordings J1–J8, J10 and J11 on a fresh Mac mini (mvp.md §12 item 1) | R | M | T-ACC-01, T-ACC-02, T-ACC-03, T-ACC-04, T-ACC-05, T-ACC-06, T-ACC-07, T-AGT-01, T-AGT-02, T-AGT-03, T-APP-01, T-APP-02, T-APP-03, T-APP-04, T-APP-05, T-APP-06, T-APP-07, T-APP-08, T-APP-09, T-APP-10, T-APP-11, T-APP-12, T-APP-13, T-APP-14, T-APP-14a, T-APP-15, T-APP-16, T-APP-17, T-APP-18, T-APP-19, T-APP-20, T-APP-21, T-APP-22, T-APP-23, T-CAT-01, T-CAT-02, T-CAT-03, T-COL-02, T-COL-03, T-COL-03a, T-COL-03f, T-COL-03r, T-COL-04, T-COL-04a, T-COL-05, T-COL-06, T-COL-07, T-COL-08, T-COL-08a, T-COL-08b, T-COL-09, T-COL-10, T-COL-12, T-CUT-01, T-CUT-02, T-CUT-03, T-CUT-04, T-DOC-02, T-DOC-04, T-FLW-01, T-FLW-02, T-FLW-03, T-FLW-04, T-FLW-05, T-FLW-06, T-FLW-07, T-FLW-08, T-FLW-09, T-FLW-10, T-FLW-11, T-FLW-12, T-FLW-13, T-GH-01, T-GH-02, T-GH-03, T-GH-04, T-GH-05, T-GH-06, T-GH-07, T-GH-08, T-GH-09, T-GH-10, T-GH-11, T-GH-12, T-GH-13, T-GH-14, T-INS-01, T-INS-02, T-INS-04, T-INS-06, T-INS-08, T-INS-09, T-MCH-01, T-MCH-04, T-MCH-05, T-MCH-06, T-MCH-07, T-MCH-08, T-MCH-09, T-MCH-10, T-MCH-11, T-MCH-12, T-MCH-14, T-MCH-15, T-PRC-01, T-PRC-02, T-PRC-03, T-REL-03, T-REL-04, T-STK-01, T-STK-02, T-STK-03, T-STK-04, T-STK-05, T-STK-06, T-STK-07, T-STK-08, T-STK-09, T-STK-10, T-STK-11, T-STK-12, T-STK-13, T-STK-14, T-STK-15, T-TRM-01, T-TRM-02, T-TRM-03, T-TRM-04, T-TRM-05, T-TRM-07, T-UI-01, T-UI-02, T-UI-03, T-UI-04, T-UI-05, T-UI-06, T-UI-07, T-UI-08, T-UI-09, T-UI-10, T-UI-11, T-UI-12, T-UI-13, T-UI-14, T-UI-15, T-UI-16, T-UI-17, T-UI-18, T-UI-19, T-UI-20, T-UI-21, T-UI-22, T-UI-23 | C-J1-01, C-J1-02, C-J1-03, C-J1-04, C-J1-05, C-J1-06, C-J10-01, C-J10-09, C-J11-01, C-J11-04, C-J2-01, C-J2-05, C-J3-01, C-J3-06, C-J3-08, C-J3-10, C-J4-01, C-J4-03, C-J5-01, C-J5-03, C-J6-01, C-J6-02, C-J7-01, C-J7-03, C-J8-01, C-J8-06, C-REL-05, C-UI-01 |
| [T-DOC-04](T-DOC-04.md) | Delete the generated library docs sites; one wildcard redirect to package docs | S1 | M | — | C-REL-01 |
| [T-FLW-13](T-FLW-13.md) | Review a member's PR in a background machine | S1 | M | T-FLW-01 | C-J10-09 |
| [T-PRC-01](T-PRC-01.md) | Declared-input existence in //:targetIndex and the drift set at landing | S1 | S | — | C-PRC-01 |
| [T-PRC-02](T-PRC-02.md) | DB-free migration gate and planned table ownership at Ready | S1 | S | — | C-PRC-02 |
| [T-PRC-03](T-PRC-03.md) | Check receipts required to close a ticket | S1 | S | — | C-PRC-03 |

## Dependency spine

```
W0   T-MCH-02 virtiofs   T-COL-01 relay/Yjs   T-MCH-01 memory   T-INS-03 signing   T-GH-01 manifest   T-TRM-06 sessions
                │                │                   │
S1   thin path: INS-01 → INS-02 → INS-08 · ACC-01 → ACC-03 → STK-04; ACC-01 → ACC-02 · STK-01 → STK-12 → STK-04 · STK-01 → ACC-02   (J1 thin, about 3–6 calendar weeks)
     setup:     ACC-01 → ACC-07 → INS-02
     widen:     INS-04,06 · ACC-04..06 · STK-02,05..10 · GH-01..09 · FLW-01..05,07,08,11 · MCH-08,10,14 · COL-02,07,10 · TRM-02
                APP-01..09,15..17,19,22,23 · UI-01..14 · CAT-01..02 · CUT-01..04 · DOC-02 · REL-03
S2   COL-10 → COL-03r → COL-03a ‖ COL-04a; COL-10 → COL-03f; MCH-04 + COL-03a + COL-03f → COL-03
     COL-03 + COL-04a + COL-03f + TRM-07 + MCH-11 → COL-04
     MCH-01 · MCH-04 → MCH-05/06/07 → MCH-08 (S2 half)/09 · MCH-11 → MCH-12/15 · COL-03 → TRM-07 → COL-04 → COL-05/07 · COL-06
     TRM-07 → TRM-01/03/05 · TRM-04 · STK-03/11 · FLW-09/12 · APP-10..13,18 · UI-15..18 · REL-04
S3   COL-10 + APP-15 + UI-19 + APP-19 → APP-14a; COL-03r → COL-08a; COL-10 + COL-02 + COL-03f → COL-08b
     COL-04 + COL-08a + COL-08b + APP-14a → COL-08 → APP-14; COL-08 + APP-14a → COL-09 · UI-19/20 · FLW-06 · FLW-10 · REL-03
R    INS-05 → INS-07 · DOC-01 · DOC-03 · REL-01 · REL-02 · REL-04
```

Critical path: T-COL-10 (L) → T-COL-03a (L) → T-COL-03 (M) → T-TRM-07 (M) → T-COL-04 (M) → T-COL-08 (M) → T-APP-14 (M): 2L+5M ≈ 20–40 agent-days, with T-MCH-04 and T-MCH-11 in parallel. T-COL-03r precedes the Rust components; T-COL-04a, T-COL-08a, T-COL-08b and T-APP-14a must be ready at their integration seams. T-COL-01 fixes transport and T-COL-10 fixes contracts before Wave A. C-J3-04 gates stage-3 exit. Second path: T-STK-01 → T-MCH-14 → T-FLW-11 → T-STK-06 → T-GH-04 → C-J10-02.

## Ticket file template

```
# T-XXX-NN Title
Stage · Size · Depends on · Unblocks · Issue: (to file)
Spec: spec.md §… · Delta: delta.md §… · Product: mvp.md J…, §…, M-…

## Goal                one sentence, observable
## Scope               in / out (name the deferred neighbours this ticket must not build)
## Changes             path → change (from delta.md and research/)
## Tests               unit / integration / e2e / fault, each naming the behavior it proves
## Acceptance          the checks that must pass (link checks/…)
## Risks and notes     falsifiable risks; decisions this ticket must not make alone
```

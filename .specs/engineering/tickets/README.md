# Tickets

Every ticket ships a vertical slice: code, tests, the docs the change touches, and the checks it names. A ticket is **done** when four things hold:
- its checks pass on the stated layer;
- the evidence is attached to the ticket's GitHub issue;
- nothing in [delta.md](../delta.md) for that ticket remains;
- every old path the ticket replaces is deleted in the same change (AGENTS.md "zero tech debt").

Leftovers get a new ticket; there are no "80% done" tickets.

Sizes: **S** ≤ 1 day, **M** 2–4 days, **L** 1–2 weeks of one agent. Stages follow mvp.md §11 and [spec.md §0](../spec.md):
- **W0:** spikes, days 1–3;
- **S1:** skeleton;
- **S2:** multiplayer without co-editing;
- **S3:** co-editing and learning;
- **R:** release hardening.

Launch needs all of them. Deferred work (spec.md §0 [D]) has no ticket. A ticket depends only on tickets of its own or an earlier stage. A ticket that spans stages lists its dependencies and checks per stage (`S1: … · S2: …`).

Before starting a ticket, claim its GitHub issue with `node scripts/issue-claim.mjs claim` (AGENTS.md). Ticket files carry the issue number once filed; the lead engineer (smithers-22) files them as work starts. Each ticket issue has an "Absorbs …" comment listing the older issues it folds in, and implementers read those first. Deferred work is tracked in #3467 (Cloud, billing, plans), #3468 (TUI) and #3469 (triggers and the Machine view). Parked tickets live in `tickets/deferred/`.

**First tickets.** The thin path goes first. T-ACC-01, which mvp.md §11 names as the first engineering ticket, starts on day 1 in parallel, with App credentials from env until T-GH-01 lands. The path installs the launchd service (T-INS-08) and runs one TODO to a merge, so C-J1-04 passes on stage-1 tickets alone:

```
install  T-INS-01 → T-INS-02 → T-INS-08
access   T-ACC-01 → T-ACC-02 → T-ACC-03 → T-STK-04
stack    T-STK-01 → T-STK-12 → T-STK-04, and T-STK-01 → T-ACC-02
         longest chain: T-STK-01 → T-ACC-02 → T-ACC-03 → T-STK-04 (L + 2M + L, about 3–6 calendar weeks)
```

## Index

| ID | Title | Stage | Size | Depends on | Checks |
| --- | --- | --- | --- | --- | --- |
| **Spikes** | | | | | |
| [T-MCH-02](T-MCH-02.md) | Spike: virtiofs `/home` across two VMs (answered NO: homes are per machine) | W0 | S | — | C-SPK-02 |
| [T-COL-01](T-COL-01.md) | Spike: relay round trip, Yjs keystroke p95, jj capture cost and guest kernel probes in a VM; re-run on an idle reference host decides ADR 0003's topology | W0 | S | — | C-SPK-03, C-SPK-07 |
| [T-MCH-01](T-MCH-01.md) | Measure VM memory on 24 and 32 GB; capacity formula | W0, S2 | M | — | C-SPK-05, C-MCH-04 |
| [T-INS-03](T-INS-03.md) | Spike: Homebrew ad-hoc signing and Hypervisor.framework from a launchd daemon | W0 | S | — | C-SPK-06 |
| [T-TRM-06](T-TRM-06.md) | Spike: daemon sessions carry VS Code Remote; revocation in 5 s | W0 | M | — | C-SPK-08 |
| **Install and runtime** | | | | | |
| [T-INS-01](T-INS-01.md) | Server bundle assembler from the `build-native.ts` stages at `5b77095672` | S1 | M | — | C-INS-05 |
| [T-INS-02](T-INS-02.md) | Launcher passes isolation, GitHub, model and public-URL settings; microVM-only | S1 | M | T-INS-01 | C-SEC-02 |
| [T-INS-08](T-INS-08.md) | Launchd service and `smthrs host start/stop/status` from a built bundle | S1 | M | T-INS-01, T-INS-02, T-INS-03 | C-INS-06 |
| [T-INS-04](T-INS-04.md) | Origin-agnostic serving: configurable bind and public origins, one effective origin per request; no secure-context dependency | S1 | M | T-INS-02, T-INS-08 | C-INS-01, C-INS-03 |
| [T-INS-06](T-INS-06.md) | Install setup backend: durable steps, model access API, squash check | S1 | M | T-INS-04, T-GH-01, T-ACC-01, T-MCH-10 | C-J1-02, C-J1-03 |
| [T-INS-05](T-INS-05.md) | Homebrew tap and release bottles; delete the Docker image | R | M | T-INS-01, T-INS-03, T-INS-08 | C-REL-02, C-J1-01 |
| [T-INS-07](T-INS-07.md) | `smthrs host upgrade`, `backup`, `restore` with quiesce and a backup manifest (M-26) | R | L | T-INS-05, T-INS-08, T-MCH-06, T-MCH-07 | C-REL-03, C-REL-06 |
| **Access** | | | | | |
| [T-ACC-01](T-ACC-01.md) | GitHub sign-in creates the owner; delete the single-owner password path | S1 | M | — | C-ACC-04, C-SEC-04 |
| [T-ACC-02](T-ACC-02.md) | Members roster, access check, hourly recheck, `/api/members` | S1 | M | T-ACC-01, T-STK-01 | C-ACC-03, C-ACC-04, C-J1-05 |
| [T-ACC-03](T-ACC-03.md) | One authorizer over the permission matrix | S1 | M | T-ACC-02 | C-ACC-01 |
| [T-ACC-04](T-ACC-04.md) | Delegated credentials with `via`; `smthrs login --agent`; attribution | S1 | M | T-ACC-03 | C-ACC-02, C-J6-02 |
| [T-ACC-05](T-ACC-05.md) | Person confirmations | S1 | M | T-ACC-04, T-CAT-01 | C-ACC-02, C-J6-02 |
| [T-ACC-06](T-ACC-06.md) | Revocation on removal or suspension within 5 s | S1 | S | T-ACC-02, T-STK-01 | C-ACC-03 |
| **Stack and TODOs** | | | | | |
| [T-STK-01](T-STK-01.md) | TODO tables, state machine, events, the `activity` table and topic, projection | S1 | L | — | C-STK-01, C-UI-05 |
| [T-STK-02](T-STK-02.md) | Placement: append, before, amend, move, drop; stack order | S1 | M | T-STK-01, T-STK-06 | C-J7-01, C-J4-02 |
| [T-STK-04](T-STK-04.md) | Merge: person session, one predicate and an in-flight fence, sha-bound, squash | S1 | L | T-STK-01, T-ACC-03, T-STK-12 | C-J4-03, C-ACC-02, C-J2-05, C-STK-07 |
| [T-STK-05](T-STK-05.md) | Stop, resume, Retry and Retry with the current flow, drop, reopen | S1 | M | T-STK-01, T-FLW-11, T-FLW-03, T-STK-04 | C-J4-02, C-STK-03, C-STK-08, C-J10-08, C-J7-02 |
| [T-STK-06](T-STK-06.md) | Steers at every boundary of the TODO flow | S1 | M | T-STK-01, T-FLW-11, T-STK-04 | C-J3-05, C-STK-07 |
| [T-STK-07](T-STK-07.md) | Needs you: independent waits, precedence, first answer wins, `ask` bound for implementing seats | S1 | M | T-STK-01 | C-J2-03, C-STK-08 |
| [T-STK-08](T-STK-08.md) | Rebase now; rebase conflicts: agent once, then Needs you with Resolve (M-32) | S1 | M | T-STK-07, T-UI-04, T-APP-19 | C-J7-03 |
| [T-STK-09](T-STK-09.md) | Make TODO from an issue; the `todo` label freezes revision 1 | S1 | M | T-STK-02, T-ACC-02, T-GH-02 | C-J2-01, C-J2-02, C-SEC-03 |
| [T-STK-10](T-STK-10.md) | Evidence per attempt | S1 | S | T-STK-05 | C-J2-04 |
| [T-STK-03](T-STK-03.md) | Parallel setting clamped by capacity; admission in stack order | S2 | S | T-STK-02, T-MCH-06 | C-STK-02 |
| [T-STK-11](T-STK-11.md) | Presence-aware rebase: Rebase pending, Rebase now, write hold | S2 | M | T-STK-08, T-COL-06, T-COL-03, T-COL-04, T-MCH-04, T-MCH-07 | C-J10-04, C-PERF-06, C-COL-03 |
| **GitHub sync** | | | | | |
| [T-GH-01](T-GH-01.md) | App manifest flow from localhost; sealed App credentials | W0, S1 | M | W0: — · S1: T-INS-02 | C-GH-01 |
| [T-GH-02](T-GH-02.md) | Poll scheduler: streams, ETags, token cache, budget, 30–120 s cadences | S1 | M | T-GH-01 | C-GH-07, C-GH-08 |
| [T-GH-03](T-GH-03.md) | PR shape: slug branch, body, item-only diff; later items' PRs are drafts until next | S1 | M | T-STK-01, T-STK-10 | C-J10-01 |
| [T-GH-04](T-GH-04.md) | Reviews and comments on TODO PRs become steers | S1 | M | T-GH-02, T-STK-06 | C-J10-02 |
| [T-GH-05](T-GH-05.md) | Checks on every PR, protection text, closed/reopened, out-of-order merge marks both merged | S1 | M | T-GH-03, T-GH-02, T-STK-07 | C-J10-05, C-J10-08, C-STK-04 |
| [T-GH-06](T-GH-06.md) | Outside push to a TODO branch: hold the agent's push; Needs you with Bring in or Discard (M-33) | S1 | M | T-GH-02, T-STK-07 | C-J10-03 |
| [T-GH-07](T-GH-07.md) | Force-push to `main` becomes Needs you for the owner | S1 | S | T-GH-02, T-STK-07 | C-J10-07 |
| [T-GH-08](T-GH-08.md) | Follow `main` by default; sync health and Retry | S1 | S | T-GH-02, T-UI-06, T-APP-19 | C-J10-06 |
| [T-GH-09](T-GH-09.md) | Outbound writes: keys, per-target order, supersession and reconcile | S1 | M | T-GH-03 | C-GH-09, C-DUR-03 |
| **Flows and the factory** | | | | | |
| [T-FLW-01](T-FLW-01.md) | Overridable flows run only in machines; system flow catalog | S1 | M | — | C-SEC-02, C-J10-09 |
| [T-FLW-02](T-FLW-02.md) | Install-stored default config: checks, wiki pages, seats | S1 | M | T-FLW-01, T-MCH-10 | C-J1-06, C-J8-06 |
| [T-FLW-03](T-FLW-03.md) | `flow-load`, versions, activation; keep previous on failure (`Executable.ts:2036`) | S1 | L | T-FLW-01, T-GH-02, T-FLW-11 | C-J5-01, C-J5-02 |
| [T-FLW-04](T-FLW-04.md) | Coding host loads the pinned closure by digest | S1 | M | T-FLW-03, T-STK-01, T-FLW-11 | C-J5-01, C-J11-02 |
| [T-FLW-05](T-FLW-05.md) | `/flow.edit` with a seed patch | S1 | M | T-FLW-03, T-STK-02, T-CAT-01, T-FLW-11 | C-J5-01, C-J11-02 |
| [T-FLW-11](T-FLW-11.md) | One `todo` run per attempt: composition flow over coding steps, the candidate handshake and the post-propose wait | S1 | L | T-FLW-01, T-STK-01, T-MCH-14, T-STK-12 | C-J5-01, C-STK-03, C-STK-06, C-CAT-01 |
| [T-FLW-08](T-FLW-08.md) | Agent card and owner model configuration restored from `5b77095672` | S1 | M | T-INS-06, T-ACC-03, T-UI-13, T-APP-19 | C-J11-03 |
| [T-FLW-09](T-FLW-09.md) | Reconcile before retry for push, GitHub write and shell steps | S2 | M | T-GH-09 | C-DUR-01, C-DUR-02, C-DUR-03 |
| [T-FLW-06](T-FLW-06.md) | Learning flow, proposals, Proposal card, lessons receipt | S3 | L | T-STK-10, T-FLW-05, T-MCH-06, T-UI-20, T-APP-19 | C-J5-03, C-J8-01, C-J2-05 |
| [T-FLW-07](T-FLW-07.md) | Monitor: `/monitor`, cost, waits since, interrupted state, no fork filter | S1 | M | T-COL-02, T-UI-12, T-APP-19 | C-J11-01, C-J11-04, C-J11-02 |
| [T-FLW-12](T-FLW-12.md) | Obsidian folder sync as a Settings control | S2 | S | T-ACC-03 | C-J8-03 |
| [T-FLW-10](T-FLW-10.md) | Plans cite wiki page revisions | S3 | S | T-FLW-02, T-APP-17 | C-J8-04, C-J8-05 |
| **Machines** | | | | | |
| [T-MCH-10](T-MCH-10.md) | Toolchain detection, `.smithers/machine.json`, Source and Machine ready | S1 | M | — | C-J1-06 |
| [T-MCH-14](T-MCH-14.md) | Keep TODO workspaces until settled; wake before delivering a signal | S1 | S | T-STK-01 | C-STK-05, C-J10-08 |
| [T-MCH-04](T-MCH-04.md) | One machine per branch: drop `user_id` from the 0084 key; the agent attaches | S2 | L | T-ACC-03, T-STK-01 | C-MCH-01 |
| [T-MCH-05](T-MCH-05.md) | Delete branch locks | S2 | M | T-MCH-04 | C-CUT-01 |
| [T-MCH-06](T-MCH-06.md) | Admission scheduler: slots to confirmed stop, per-branch coalescing, disk re-check, positions, safe-idle release | S2 | L | T-MCH-04, T-MCH-01 | C-MCH-02, C-MCH-11, C-PERF-05, C-J10-09 |
| [T-MCH-07](T-MCH-07.md) | Sleep with final capture; reads never wake | S2 | M | T-COL-03, T-MCH-04 | C-MCH-03 |
| [T-MCH-08](T-MCH-08.md) | Fork from a revision; Add to stack as a new TODO; scratch becomes the item branch (M-32); fork after capture (S2) | S1, S2 | M | S1: T-STK-02, T-UI-04, T-APP-19 · S2: T-COL-03, T-MCH-04 | S1: C-J7-02 · S2: C-MCH-08 |
| [T-MCH-09](T-MCH-09.md) | Cleanup only after settled, captured and quiet | S2 | S | T-MCH-07 | C-MCH-05 |
| [T-MCH-11](T-MCH-11.md) | Member unix users, `team` group, no-sudo image, per-machine homes | S2 | L | T-MCH-02, T-ACC-02 | C-MCH-06, C-MCH-09, C-COL-04 |
| [T-MCH-15](T-MCH-15.md) | Per-member credential store: tool logins carry across machines | S2 | M | T-MCH-11, T-COL-03 | C-MCH-10, C-REL-05, C-COL-04 |
| [T-MCH-12](T-MCH-12.md) | Secrets into machines; main-only kept out | S2 | M | T-MCH-11, T-COL-03 | C-MCH-07, C-SEC-01 |
| **Live layer and machine daemon** | | | | | |
| [T-COL-10](T-COL-10.md) | Co-editing architecture: ADR 0003, the topology-neutral stage-1 contracts (spec §7.6) and the topology decision before T-COL-08 | S1 | M | T-COL-01 | C-COL-01, C-UI-05 |
| [T-COL-02](T-COL-02.md) | Live channel `/api/live`: topics, cursors, backpressure | S1 | L | T-STK-01 | C-PERF-02, C-UI-05, C-COL-02 |
| [T-COL-03](T-COL-03.md) | `smithers-machined`: crate, rootfs, init, root broker and unprivileged daemon, host connection, outbox, mutation lock, capture | S2 | L | T-COL-01, T-MCH-04, T-COL-10, T-TRM-06 | C-DUR-04, C-COL-03, C-COL-04 |
| [T-COL-04](T-COL-04.md) | Watcher (inotify), session-based attribution, ignore rules and metadata watches, bursts with per-file versions, overflow resync, activity | S2 | L | T-COL-03, T-TRM-07, T-MCH-11, T-COL-10 | C-J3-03, C-PERF-04, C-J3-06, C-COL-05 |
| [T-COL-05](T-COL-05.md) | Moved off the item: detect; Return to Tn; Keep for now | S2 | M | T-COL-04, T-STK-07, T-MCH-04, T-UI-15, T-APP-19 | C-J3-09, C-COL-05 |
| [T-COL-06](T-COL-06.md) | Presence map and heartbeats | S2 | M | T-COL-02, T-COL-04, T-COL-10 | C-J3-01, C-J3-06 |
| [T-COL-07](T-COL-07.md) | Agent write tool checks `base_digest` (S1); agent sees outside changes (S2) | S1, S2 | S | S1: T-COL-10 · S2: T-COL-04 | S1: C-COL-01 · S2: C-J3-03 |
| [T-COL-08](T-COL-08.md) | Live code documents: state record and durable acknowledgment; disk reconcile in either order; gone states | S3 | L | T-COL-02, T-COL-04, T-COL-10 | C-J3-04, C-PERF-03, C-DUR-04, C-COL-03 |
| [T-COL-09](T-COL-09.md) | Wiki co-editing on the live channel; delete POST+SSE | S3 | M | T-COL-08 | C-J8-02, C-DUR-04 |
| **Terminals and SSH** | | | | | |
| [T-TRM-02](T-TRM-02.md) | Terminal auto sign-in and the Smithers skill on machines | S1, S2 | S | S1: T-ACC-04, T-CAT-02 · S2: T-MCH-11, T-TRM-01, T-ACC-05 | S1: C-J6-01, C-SEC-05 · S2: C-J6-01 |
| [T-TRM-01](T-TRM-01.md) | Terminals run as their owner; only the owner types | S2 | S | T-MCH-11, T-COL-03, T-TRM-07 | C-J3-02 |
| [T-TRM-03](T-TRM-03.md) | SSH gateway: branch usernames, member users, sftp, port forwarding | S2 | L | T-MCH-06, T-MCH-11, T-INS-04, T-COL-03, T-TRM-07 | C-J3-06 |
| [T-TRM-04](T-TRM-04.md) | Import GitHub SSH keys | S2 | S | T-ACC-02 | C-J3-06 |
| [T-TRM-05](T-TRM-05.md) | The coding agent's `bash` runs in its own terminal session, shown in the Terminal card | S2 | M | T-TRM-01, T-COL-03, T-TRM-07 | C-J3-10 |
| [T-TRM-07](T-TRM-07.md) | Session supervisor: broker sessions, the §9.6 protocol, lingering processes, kill and restart rules | S2 | M | T-COL-03, T-TRM-06, T-MCH-11 | C-J3-06, C-COL-04 |
| **App** | | | | | |
| [T-APP-08](T-APP-08.md) | Seams move to the live channel; delete per-resource SSE | S1 | M | T-COL-02, T-STK-01 | C-UI-05 |
| [T-APP-01](T-APP-01.md) | Home card on the `home` topic | S1 | M | T-COL-02, T-STK-01, T-APP-08, T-APP-16, T-UI-06, T-APP-19 | C-J4-01, C-J8-06 |
| [T-APP-02](T-APP-02.md) | TODO card and Draft card | S1 | L | T-STK-01, T-APP-08, T-UI-03, T-UI-04, T-APP-19 | C-J2-01, C-J4-02, C-J9-01 |
| [T-APP-03](T-APP-03.md) | Setup and Settings cards | S1 | M | T-INS-06, T-UI-02, T-APP-19 | C-J1-02 |
| [T-APP-04](T-APP-04.md) | Confirm card: one-click confirmations and Review & merge | S1 | S | T-ACC-05, T-STK-04, T-UI-05, T-APP-19 | C-ACC-02 |
| [T-APP-05](T-APP-05.md) | Flow card with versions | S1 | M | T-FLW-03, T-APP-16, T-UI-10, T-APP-19 | C-J5-01, C-J11-02 |
| [T-APP-06](T-APP-06.md) | Members card | S1 | M | T-ACC-02, T-UI-09, T-APP-19 | C-J1-05 |
| [T-APP-07](T-APP-07.md) | Edge toast map, timeline, conversation-entry and monitor summaries | S1 | L | T-COL-02, T-APP-08, T-APP-16, T-UI-08, T-APP-19 | C-UI-04, C-J11-01 |
| [T-APP-09](T-APP-09.md) | Actor rendering with `via` badges | S1 | S | T-ACC-04, T-UI-01, T-APP-19 | C-J6-01 |
| [T-APP-18](T-APP-18.md) | Browser notifications on secure origins | S2 | S | T-APP-07, T-UI-08, T-APP-19 | C-UI-03 |
| [T-APP-19](T-APP-19.md) | Card view-model schemas and fixtures from `ui-components.md`: the seam between design's views and engineering's containers | S1 | S | — | C-UI-08 |
| [T-UI-01](T-UI-01.md) | Primitives: actor chip, state word, tone | S1 | S | — | C-J6-01 |
| [T-UI-02](T-UI-02.md) | Setup and Settings views | S1 | M | T-UI-01 | C-J1-02 |
| [T-UI-03](T-UI-03.md) | Draft view | S1 | S | T-UI-01 | C-J2-01 |
| [T-UI-04](T-UI-04.md) | TODO view with Needs you, conflict, failure, evidence, PR and fork controls | S1 | L | T-UI-01 | C-J2-01, C-J4-02, C-J7-03, C-J9-01 |
| [T-UI-05](T-UI-05.md) | Confirm view | S1 | S | T-UI-01 | C-ACC-02 |
| [T-UI-06](T-UI-06.md) | Home view with the main sync row | S1 | M | T-UI-01 | C-J4-01, C-J10-06 |
| [T-UI-07](T-UI-07.md) | Conversation shell: branch tree, entry rows, Context line, Earlier archive | S1 | L | T-UI-01 | C-UI-06, C-UI-07 |
| [T-UI-08](T-UI-08.md) | Toasts, edge map and timeline | S1 | M | T-UI-01 | C-UI-04, C-UI-03 |
| [T-UI-09](T-UI-09.md) | Members view | S1 | S | T-UI-01 | C-J1-05 |
| [T-UI-10](T-UI-10.md) | Flow view | S1 | M | T-UI-01 | C-J5-01, C-J11-02 |
| [T-UI-11](T-UI-11.md) | Code editor and Diff views (read-only) | S1 | L | T-UI-01 | C-COL-01, C-UI-11 |
| [T-UI-12](T-UI-12.md) | Run monitor and Inspect views | S1 | M | T-UI-01 | C-J11-01, C-J11-02 |
| [T-UI-13](T-UI-13.md) | Agent view and model roles | S1 | S | T-UI-01 | C-J11-03 |
| [T-UI-14](T-UI-14.md) | Commands view (/help) | S1 | S | T-UI-01 | C-UI-02 |
| [T-UI-15](T-UI-15.md) | Branch view with moved-off controls | S2 | L | T-UI-01 | C-J3-01, C-J3-03, C-J3-09 |
| [T-UI-16](T-UI-16.md) | File and Diff live states | S2 | S | T-UI-01 | C-J3-08 |
| [T-UI-17](T-UI-17.md) | Terminal view | S2 | S | T-UI-01 | C-J3-02 |
| [T-UI-18](T-UI-18.md) | Secrets view | S2 | S | T-UI-01 | C-MCH-07 |
| [T-UI-19](T-UI-19.md) | Co-editing visuals | S3 | M | T-UI-01 | C-J3-04 |
| [T-UI-20](T-UI-20.md) | Proposal view and lessons receipt | S3 | S | T-UI-01 | C-J5-03, C-J8-01 |
| [T-APP-15](T-APP-15.md) | File card on CodeMirror 6 with code intelligence (read-only) | S1 | L | T-COL-10, T-UI-11, T-APP-19 | C-COL-01, C-UI-11 |
| [T-APP-16](T-APP-16.md) | Branch conversations: shared entries, per-member view state, branch tree, legacy archive | S1 | L | T-COL-02, T-ACC-04, T-UI-07, T-APP-19 | C-UI-06 |
| [T-APP-17](T-APP-17.md) | Context preflight: selection step, Context line, Inspect | S1 | M | T-APP-16, T-UI-07, T-APP-19 | C-UI-07 |
| [T-APP-10](T-APP-10.md) | Branch card: presence, activity, machine state, terminals, SSH line | S2 | L | T-COL-06, T-COL-04, T-APP-16, T-APP-09, T-MCH-08, T-STK-11, T-UI-15, T-APP-19 | C-J3-01, C-J3-03 |
| [T-APP-11](T-APP-11.md) | File and Diff cards reload on change; deleted/renamed states; Restore this file; language server on the daemon | S2 | M | T-COL-04, T-APP-15, T-UI-16, T-APP-19 | C-J3-08, C-PERF-04, C-UI-11 |
| [T-APP-12](T-APP-12.md) | Terminal card ownership UI | S2 | S | T-TRM-01, T-UI-17, T-APP-19 | C-J3-02 |
| [T-APP-13](T-APP-13.md) | Secrets card | S2 | S | T-MCH-12, T-UI-18, T-APP-19 | C-MCH-07 |
| [T-APP-20](T-APP-20.md) | `/docs` flow: in-app docs from one Markdown source per page | S2 | M | T-APP-19, T-UI-21, T-CAT-01 | C-UI-09 |
| [T-APP-21](T-APP-21.md) | `/debug-api` playground: call the documented API from the app | S2 | M | T-APP-19, T-UI-22, T-CAT-01, T-ACC-03 | C-UI-10 |
| [T-UI-21](T-UI-21.md) | Docs view | S2 | S | T-UI-01 | C-UI-08 |
| [T-UI-22](T-UI-22.md) | Debug API view | S2 | S | T-UI-01 | C-UI-08 |
| [T-APP-14](T-APP-14.md) | File card live co-editing | S3 | L | T-COL-08, T-APP-15, T-UI-19, T-APP-19 | C-J3-04 |
| **Catalog and cuts** | | | | | |
| [T-CAT-01](T-CAT-01.md) | One command catalog source; `catalog.mvp.json`; allowlist test from mvp.md Appendix B | S1 | L | T-UI-14, T-APP-19 | C-CAT-01, C-UI-02 |
| [T-CAT-02](T-CAT-02.md) | CLI doors for Appendix A; skill generated from the catalog | S1 | M | T-CAT-01 | C-CAT-02, C-CAT-03 |
| [T-CUT-01](T-CUT-01.md) | Delete cut app surfaces; align AGENTS.md scope | S1 | L | — | C-CUT-01 |
| [T-CUT-02](T-CUT-02.md) | Delete cut backend routes with their OpenAPI rows | S1 | M | T-CUT-01 | C-CUT-01 |
| [T-CUT-03](T-CUT-03.md) | Hide deferred surfaces: billing, TUI, multi-repository, triggers | S1 | S | T-CAT-01 | C-CUT-01 |
| **Docs and release** | | | | | |
| [T-DOC-02](T-DOC-02.md) | ADR 0002: Mac install, multi-member, microVM-only, origin-agnostic | S1 | S | — | C-REL-01 |
| [T-STK-12](T-STK-12.md) | Candidate generations: capture, propose receipts, pending work, the item's prefix | S1 | M | T-STK-01 | C-STK-06 |
| [T-REL-03](T-REL-03.md) | Alpha scorecard instrumentation (mvp.md §10) | S1, S2, S3 | M | S1: T-STK-01, T-INS-06 · S2: T-COL-04, T-COL-06 · S3: T-FLW-06 | C-REL-04 |
| [T-REL-04](T-REL-04.md) | Fault suite: kill points across runs, merges, writes, bursts, rebases | S2, R | M | T-FLW-09, T-COL-04, T-STK-11 | C-DUR-01..04 |
| [T-DOC-01](T-DOC-01.md) | Quickstart and flows reference as in-app pages; one install page on the site | R | M | T-INS-05, T-APP-20 | C-REL-01 |
| [T-DOC-03](T-DOC-03.md) | Replace `docs/mvp/*` with the approved specs (M-12) | R | S | T-CUT-01 | C-REL-01 |
| [T-REL-01](T-REL-01.md) | Performance benchmarks on the reference host | R | M | T-APP-01, T-COL-04, T-COL-08, T-APP-14, T-MCH-06, T-MCH-07, T-STK-11, T-INS-06 | C-PERF-01..06 |
| [T-REL-02](T-REL-02.md) | Journey recordings J1–J8, J10 and J11 on a fresh Mac mini (mvp.md §12 item 1) | R | M | S1–S3 | C-J*, C-UI-01, C-REL-05 |

## Dependency spine

```
W0   T-MCH-02 virtiofs   T-COL-01 relay/Yjs   T-MCH-01 memory   T-INS-03 signing   T-GH-01 manifest   T-TRM-06 sessions
                │                │                   │
S1   thin path: INS-01 → INS-02 → INS-08 · ACC-01 → ACC-02 → ACC-03 → STK-04 · STK-01 → STK-12 → STK-04 · STK-01 → ACC-02   (J1 thin, about 3–6 calendar weeks)
     widen:     INS-04,06 · ACC-04..06 · STK-02,05..10 · GH-01..09 · FLW-01..05,07,08,11 · MCH-08,10,14 · COL-02,07,10 · TRM-02
                APP-01..09,15..17,19 · UI-01..14 · CAT-01..02 · CUT-01..03 · DOC-02 · REL-03
S2   MCH-01 · MCH-04 → MCH-05/06/07 → MCH-08 (S2 half)/09 · MCH-11 → MCH-12/15 · COL-03 → TRM-07 → COL-04 → COL-05/07 · COL-06
     TRM-07 → TRM-01/03/05 · TRM-04 · STK-03/11 · FLW-09/12 · APP-10..13,18 · UI-15..18 · REL-04
S3   COL-08 → COL-09 · APP-14 · UI-19/20 · FLW-06 · FLW-10 · REL-03
R    INS-05 → INS-07 · DOC-01 · DOC-03 · REL-01 · REL-02 · REL-04
```

Critical path: W0 spikes (T-TRM-06 included, C-SPK-08) → T-MCH-04 ‖ T-MCH-11 → T-COL-03 → T-TRM-07 → T-COL-04 → T-COL-08 (after ADR 0003's topology decision) → T-APP-14 → C-J3-04 (co-editing is confirmed for the MVP), with T-COL-01 → T-COL-10 fixing the contracts in stage 1. Second path: T-STK-01 → T-MCH-14 → T-FLW-11 → T-STK-06 → T-GH-04 → C-J10-02.

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

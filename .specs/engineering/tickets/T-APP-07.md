# T-APP-07 Edge toast map, timeline, conversation-entry and monitor summaries

Stage S1 · Size L · Depends on T-COL-02, T-APP-08, T-APP-23, T-UI-08, T-APP-19, T-APP-09, T-FLW-08, T-FLW-07 · Unblocks T-APP-01, T-APP-18, T-REL-02 · Issue: [#3501](https://github.com/smithersai/smithers/issues/3501)
Spec: spec.md §3 (`conversation_entries`, `member_conversation_state`), §4.1, §7.2 (`conversation:<branch>`), §10.8.3, §11.5a (`agent:fast`), §11.6.1, §14.1, §14.4, §14.5, §14.6, §19.3 · Delta: delta.md §8 (Add conversation-entry summarizer job), §9 (Add left-edge toast map + timeline; retire `ChatRunTimeline`) · Product: mvp.md §6.4 Toasts for events, Timeline, J4.3, M-08, M-14

## Goal
The left edge maps the branch conversation a member is viewing: live work in cards above the viewport pins top-left, live work and new entries below pin bottom-left, and on desktop a timeline between them shows one line per entry with a shared title, summary, tone and state, plus at most one action derived for the viewer; notable events also arrive as toasts, which each member can hide.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the `Timeline`, `EdgeMap` and `ToastStack` views, with the CSS, in T-UI-08. This ticket builds no View, CSS or editor presentation. It owns the topic decoder and golden fixture, the adapter, the Container and the commands in Changes ([card-kinds.md §1](../card-kinds.md)), plus the entry fields, the summarizer and the `timeline_visible` lease. The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope

- Summary admission and completion ordering: insert each entry or monitor summary job in the same PostgreSQL transaction as its subject/event change and projection event. Bind it to the entry or phase/cell identity, run id, attempt id and source revision. The worker calls the model only after commit. Accept its result only by compare-and-set against those still-current identities and source revision; discard older or superseded results without changing summary, summary_rev, run_summaries or projections. Checks: C-UI-04, C-J11-01.
In:
- Entry fields on the shared conversation rows that T-APP-16 stores (one conversation per branch; `main`'s holds the stack): `title`, `summary`, `summary_rev`, `tone`, `state`, and the facts the action needs (`needs_you.kind`, first in merge order, TODO number). Every member who sees the entry sees the same values.
- An entry without a run takes its title from its first line (a prompt) or its card title and has no summary (§14.5.1).
- Deterministic derivation in the host (§14.5.2), recomputed in the transaction that changes the subject (§3.1): tone (live, attention, failed, done, quiet) and state (the TODO state word for a TODO or its run, including Starting, §4.1; else null).
- Action per viewer (§14.5.2 table): computed in the viewer's client from the shared facts plus the viewer's role, never stored or published per viewer (§7.2.2). A maintainer sees Merge on the first In review item and a member sees none; Review for `force_push` goes to the owner only and for `order` to maintainers. One shared function in `@smthrs/rpc` serves the rail, the Home card (T-APP-01) and the host's toasts.
- Summarizer (§14.5.3): a host-service job that writes one shared line from the entry's run events (§11.6.1) with the `agent:fast` model (§11.5a) through the host model proxy.
  - While at least one member has the conversation's timeline on screen and the run is live, it refreshes 5 s after the last event and at least every 30 s while events keep arriving.
  - Otherwise it writes once per state change, and nothing in between.
  - The host learns "on screen" from a `timeline_visible` lease each client sets in its view state on `view:<member>:<branch>` (T-APP-16) while its timeline is visible, refreshed every 10 s and expiring after 30 s.
  - A failure keeps the last summary and `summary_rev`. It runs off the run's path (its own job queue, no machine, no call back into the runtime).
  - The same job writes the monitor's phase summaries and cell explanations into `run_summaries` (§3, §11.6.3, §14.5.3), only for runs with a `run:<id>` subscriber: one call per phase fills the missing ones when the monitor opens, a live phase refreshes 5 s after its last event and at least every 30 s, a failed call retries every 30 s while the monitor stays open, and a failure leaves the deterministic title or label alone with no error state. T-FLW-07 renders them.
- The rail (client):
  - desktop: the timeline, one line per entry (glyph, title, summary; a prompt shows its author through T-APP-09); live entries pulse, attention is gold, failed is ember; a band marks the entries on screen; a click scrolls to the entry; live entries above the band pin to the top edge, and live or new entries below pin to the bottom edge;
  - each pinned or listed entry carries the viewer's action inline, which runs the catalog command;
  - narrow screens: no timeline, one pill per edge ("↑ 2 live above", "↓ 1 new below").
- Toasts (§14.4.1): Needs you, an approval, a PR ready for review, a failure, a rebase conflict, and the merge of the viewer's own TODO, each with its one action, on the shared toast stack with its 300 ms law (`state/controller/failures.ts:236-285`), at most three plus "+N more", settled only by the real terminal event (§14.4.3). A toast reaches the TODO's owner, anyone present on its branch from S2 (stage 1 has no presence, §10.8.3), and the prompter for their own runs. Each toast is also a timeline entry and stays one after the toast goes.
- Hiding: `member_conversation_state.toasts_hidden` per conversation plus one global preference (§14.4.2), read from the member's own `view:<member>:<branch>` topic. Hiding never hides the entry, the edge map or the Home card.
- Toast routing is derived in each client from the shared entry and the viewer: the TODO's owner, the prompter for their own runs, and from S2 a viewer present on the branch. No per-member toast row is published on a shared topic.
- On-screen detection: the shell and timeline Views report the entries on screen and whether the timeline is visible through `onView({on_screen, timeline_visible})` (T-UI-07, T-UI-08, using an `IntersectionObserver` in a ref callback, apps/app/AGENTS.md). The Container turns that report into the `timeline_visible` lease.

Out:
- Repository execution, model tools, browser notifications (T-APP-18), participant registration and S2 presence delivery. Summaries consume shared recorded events only; private entries have no summary.
- Conversation storage, per-member scroll and card view state, and the branch tree (T-APP-16); the Context line and Inspect preflight (T-APP-17).
- Browser, email and phone notifications ([D] §14.6); the run card's scrubber and the monitor (T-FLW-07).

## Changes

- `conversation_entries.go` and `conversation_summaries.go`: use the subject transaction for durable job admission and the result transaction for the run/attempt/source-revision compare-and-set plus projection event. A rollback admits no job; committed jobs survive restart. Keep the separate queue and no runtime callback. Checks: C-UI-04, C-J11-01.
- `packages/backend/db/product/migrations/` (new, next free number): `run_summaries` (§3), reserved as `planned:T-APP-07` under §21.3 before implementation. T-APP-16 creates the entry columns and `timeline_visible_until` view-state column; this ticket derives and updates their values, without duplicate column/table creation. smithers-3f accepts the table/column split with T-APP-16 before start. Checks: C-PRC-02, C-UI-04, C-J11-01.
- `packages/backend/internal/services/conversation_entries.go` (new): derivation, `projection_events` row plus `NOTIFY` (§3.1), toast events.
- `packages/backend/internal/services/conversation_summaries.go` (new): the summarizer on `packages/backend/jobs`, calling the model through `internal/services/model_proxy.go`.
- `packages/rpc/src/ConversationEntry.ts` (new): the entry fields and `actionFor(entry, viewer)`, the one §14.5.2 function the Home adapter, the timeline and toast routing call.
- `apps/app/src/mainview/cards/containers/timelineModel.ts` (new): `toTimelineModel(entries, view)` gives lines, the band, pins above and below, and the narrow pills; `toToasts(entries, viewer, hidden)` routes toasts to the TODO's owner, the prompter for their own runs and, from S2, a viewer present on the branch, and caps them at three plus `more`.
- `apps/app/src/mainview/cards/containers/TimelineContainer.tsx` and `ToastContainer.tsx` (new): render `Timeline`, `EdgeMap` and `ToastStack` (T-UI-08). `App.tsx` mounts the TimelineContainer in place of `ChatRunTimeline` (`App.tsx:49`, `:603`). Hiding toasts is a `PUT …/view-state` patch. The toast collection keeps the shared stack's 300 ms law (`state/controller/failures.ts:236-285`).
- Delete `ChatRunTimeline.tsx`, `ChatRunTimeline.test.tsx`, the `.chat-run-timeline*` rules (`styles/chat.css:951-968`), its row in `flows/parity.test.ts:846`, its use in `cards/fixtures/RunTraceBrowser.ts:10,141`, and the dock assertions in `e2e/playwright/chat-run-monitor.spec.ts:62` and `e2e/probes/run-trace-phase-strip.test.ts:46`. T-UI-08 lands ToastStackView.tsx beside the current entry point. T-APP-07 owns deletion of ToastStack.tsx and migration of all its consumers during live cutover; T-UI-08 does not delete it. C-UI-13 proves the live toast/edge/timeline binding after cutover.

## Tests

- Integration, real PostgreSQL and controlled model responses (C-UI-04, C-J11-01): abort the subject transaction and assert no job; restart after commit and assert the job survives. Complete a newer source revision before an older call, then replace the run and attempt while older calls are in flight. Assert literal last-summary bytes and revisions remain unchanged by every stale result for entry, phase and cell summaries; accepted completion writes its projection atomically.
- Boundary (C-UI-04, C-J11-01): submit through the production TODO command dispatcher, consume `/api/live` conversation and run topics, renew visibility through `PUT /api/conversations/{b}/view-state`, and invoke timeline/toast actions through `cardActions` → `flowAction`. Use checked-in event sequences and literal expected tones, labels, actions and timing bounds; no oracle reads spec files or computes expectations with production derivation code.

- C-UI-04: In review has the quiet tone. Needs you and stack attention have the attention tone.

- Unit (`ConversationEntry.test.ts`): `actionFor` for every TODO state × `needs_you.kind` × first in order × role.
- Unit (Go, `conversation_entries_test.go`): tone and state for every TODO state, Starting included; two members' reads of one entry are byte-identical; the action exists only in the client.
- Unit (Go, `conversation_summaries_test.go`, fake clock): with a `timeline_visible` lease held and events every 1 s from 0 to 60 s, no event waits more than 30 s for a refresh and the event at 60 s is summarized by 65 s; one event gives one refresh at 5 s. With no lease, the same run makes exactly one model call per state change. A lease that expires mid-run stops periodic refreshes within 30 s. A model error leaves summary and `summary_rev` unchanged; no refresh after the terminal one.
- Integration (real PostgreSQL): with the model endpoint failing for 60 s, a run's steps finish with the same outcomes and the summarizer creates no `machine_requests` row.
- Unit (Go, fake clock): a run with no `run:<id>` subscriber gets no phase or cell call; opening the monitor fills each finished phase with one call; a model error leaves `run_summaries` unchanged.
- Unit (`timelineModel.test.ts`): pins above and below the band; the pill counts; a line's action carries its command and input; a member who hides toasts gets none while the line stays; three toasts plus `more` past three; routing to the owner, the prompter and, from S2, a present member.
- Unit (`TimelineContainer.test.tsx`): an `onView({timeline_visible})` report sets the lease and renews it every 10 s; `onAction` runs `flowAction`.
- Unit: every `Action.label` and `disabled.reason` the adapter emits passes C-UI-02's `lintText` (engineering's copy; the View's copy is its T-UI ticket's).
- Integration: no toast settles before its terminal event (the C-UI-05 rule, run by T-APP-08).
- e2e: the C-UI-04 script through the T-UI-08 Views.

## Acceptance

- [C-PRC-02](../checks/C-PRC-02.md): planned ownership of `run_summaries`, with no duplicate entry/lease columns or table creation.



- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-UI-04](../checks/C-UI-04.md): shared tones, states and summaries; per-viewer actions; summaries refresh within the 5 s / 30 s rule while the timeline is on screen and once per state change otherwise; a summarizer failure keeps the last summary and does not slow the run; toasts hide per member.
- [C-J11-01](../checks/C-J11-01.md) steps 8–9: phase titles stand alone while the summarizer is blocked, summaries arrive once it returns, and an uninspected run gets no summary call.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- The timeline's 1,180 px breakpoint is T-UI-08's; the Container passes the same lines at every width.
- Risk: summaries cost money per live run. C-UI-04 records event and call times: a watched run follows the 5 s debounce and 30 s maximum wait; an unwatched run makes no call between state changes. A fixed two-calls-per-minute ceiling does not apply to isolated events that each settle after 5 s.
- The `timeline_visible` lease is this ticket's mechanism for "on screen"; §14.5.3 states the rule, not the signal. A lost lease only drops to once per state change, never to no summary.

## Ready checklist
1. Runtime preconditions: existing dependencies supply shared storage, live transport and Views; T-APP-09 supplies actor names, T-FLW-08 supplies fast/coding model routing, and T-FLW-07 supplies stable phase/cell ids and the monitor projection. S2 presence remains a later extension.
2. Exclusions: Out names repository execution, model tools, notifications, presence, conversation storage, preflight and monitor presentation.
3. Boundary tests: C-UI-04 and C-J11-01 use the production dispatcher, authenticated live topics and view-state route with literal fixture expectations; no test reads the spec or calls production code to derive its oracle.
4. Decisions: smithers-06 accepts the Timeline/EdgeMap/ToastStack seam and visible copy; smithers-38 signs off `ConversationEntry` and action derivation exports before landing under §21.1; smithers-3f accepts migrations, job scheduling and model-proxy integration; smithers-b8 accepts shell wiring. smithers-8a resolves cross-owner disagreements; Will decides product changes.
5. Before start: smithers-06: does `onView` supply the band and visibility without View business state? smithers-b8: do rail actions use the production dispatcher and hiding remain private? smithers-38: is `actionFor` the shared exported function with literal fixtures? smithers-3f: do summary jobs preserve transaction ordering and remain independent of run execution? smithers-3f: answered, BLOCKING edits applied (tech lead adopts). smithers-b8: answered 18:23, ok.
6. Security: shipped host code summarizes shared event data with no tools and no repository imports or execution; repository code runs only in machines (§1.3, M-29). smithers-3f reviews model-proxy confinement and private-entry exclusion before start. C-UI-04 proves no summary machine request or run delay; C-UI-06 proves private data stays out of summaries.

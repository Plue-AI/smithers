# T-APP-07 Edge toast map, timeline, conversation-entry summaries

Stage S1 · Size L · Depends on T-COL-02, T-APP-08, T-APP-16, T-UI-08, T-APP-19 · Unblocks T-APP-18 · Issue: to file
Spec: spec.md §3 (`conversation_entries`, `member_conversation_state`), §4.1, §7.2 (`conversation:<branch>`), §10.8.3, §11.5a (`agent:fast`), §11.6.1, §14.1, §14.4, §14.5, §14.6, §19.3 · Delta: delta.md §8 (Add conversation-entry summarizer job), §9 (Add left-edge toast map + timeline; retire `ChatRunTimeline`) · Product: mvp.md §6.4 Toasts for events, Timeline, J4.3, M-08, M-14

## Goal
The left edge maps the branch conversation a member is viewing: live work in cards above the viewport pins top-left, live work and new entries below pin bottom-left, and on desktop a timeline between them shows one line per entry with a shared title, summary, tone and state, plus at most one action derived for the viewer; notable events also arrive as toasts, which each member can hide.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: the left-edge toast map, the timeline, the band and pills, and their CSS. Engineering wires them: `conversation_entries` projection, the summarizer job, the timeline-visible lease, toast routing and hiding. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope
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
- The rail (client):
  - desktop: the timeline, one line per entry (glyph, title, summary; a prompt shows its author through T-APP-09); live entries pulse, attention is gold, failed is ember; a band marks the entries on screen; a click scrolls to the entry; live entries above the band pin to the top edge, and live or new entries below pin to the bottom edge;
  - each pinned or listed entry carries the viewer's action inline, which runs the catalog command;
  - narrow screens: no timeline, one pill per edge ("↑ 2 live above", "↓ 1 new below").
- Toasts (§14.4.1): Needs you, an approval, a PR ready for review, a failure, a rebase conflict, and the merge of the viewer's own TODO, each with its one action, on the shared toast stack with its 300 ms law (`state/controller/failures.ts:236-285`), at most three plus "+N more", settled only by the real terminal event (§14.4.3). A toast reaches the TODO's owner, anyone present on its branch from S2 (stage 1 has no presence, §10.8.3), and the prompter for their own runs. Each toast is also a timeline entry and stays one after the toast goes.
- Hiding: `member_conversation_state.toasts_hidden` per conversation plus one global preference (§14.4.2), read from the member's own `view:<member>:<branch>` topic. Hiding never hides the entry, the edge map or the Home card.
- Toast routing is derived in each client from the shared entry and the viewer: the TODO's owner, the prompter for their own runs, and from S2 a viewer present on the branch. No per-member toast row is published on a shared topic.
- On-screen detection without `useEffect`: an `IntersectionObserver` attached in a ref callback (apps/app/AGENTS.md).

Out:
- Conversation storage, per-member scroll and card view state, and the branch tree (T-APP-16); the Context line and Inspect preflight (T-APP-17).
- Browser, email and phone notifications ([D] §14.6); the run card's scrubber and the monitor (T-FLW-07).

## Changes
- `packages/backend/db/product/migrations/` (new, next free number): the entry columns above on T-APP-16's conversation-entry table.
- `packages/backend/internal/services/conversation_entries.go` (new): derivation, `projection_events` row plus `NOTIFY` (§3.1), toast events.
- `packages/backend/internal/services/conversation_summaries.go` (new): the summarizer on `packages/backend/jobs`, calling the model through `internal/services/model_proxy.go`.
- `packages/rpc/src/ConversationEntry.ts` (new): the entry schema and the per-viewer action function.
- `apps/app/src/mainview/Timeline.tsx` (new) and test; `App.tsx` mounts it in place of `ChatRunTimeline` (`App.tsx:49`, `:603`).
- `apps/app/src/mainview/ToastStack.tsx` (113 lines): keep the stack and its cap (`VISIBLE = 3`, `:15`); add the hide preference; each toast links its timeline entry. Extend `e2e/playwright/toast-stack.spec.ts`.
- Delete `ChatRunTimeline.tsx`, `ChatRunTimeline.test.tsx`, the `.chat-run-timeline*` rules (`styles/chat.css:951-961`), its row in `flows/parity.test.ts:344`, its use in `cards/fixtures/RunTraceBrowser.ts:10,141`, and the dock assertions in `e2e/playwright/chat-run-monitor.spec.ts:62` and `e2e/probes/run-trace-phase-strip.test.ts:46`.

## Tests
- Unit (`ConversationEntry.test.ts`): the action for every TODO state × `needs_you.kind` × first-in-order × role.
- Unit (Go, `conversation_entries_test.go`): tone and state for every TODO state, Starting included; two members' reads of one entry are byte-identical; the action exists only in the client.
- Unit (Go, `conversation_summaries_test.go`, fake clock): with a `timeline_visible` lease held and events every 1 s from 0 to 60 s, no event waits more than 30 s for a refresh and the event at 60 s is summarized by 65 s; one event gives one refresh at 5 s. With no lease, the same run makes exactly one model call per state change. A lease that expires mid-run stops periodic refreshes within 30 s. A model error leaves summary and `summary_rev` unchanged; no refresh after the terminal one.
- Integration (real PostgreSQL): with the model endpoint failing for 60 s, a run's steps finish with the same outcomes and the summarizer creates no `machine_requests` row.
- Unit (`Timeline.test.tsx`): pinning above and below the band, the pill counts, and an action button running its command with its args.
- Unit (`ToastStack.test.tsx`, existing): a member who hides toasts gets none while the timeline entry still appears; "+N more" past three.
- Integration: no toast settles before its terminal event (the C-UI-05 rule, run by T-APP-08).
- e2e: the C-UI-04 script.

## Acceptance
- [C-UI-04](../checks/C-UI-04.md): shared tones, states and summaries; per-viewer actions; summaries refresh within the 5 s / 30 s rule while the timeline is on screen and once per state change otherwise; a summarizer failure keeps the last summary and does not slow the run; toasts hide per member.

## Risks and notes
- Resolved: the timeline shows at widths of 1,180 px and up, matching the mock, until design changes it.
- The mock gives In review the quiet tone (`Rail.tsx:78`); §14.5.2 gives it attention. The ticket follows the spec.
- Risk: summaries cost money per live run. Bounded by the on-screen rule: falsified if C-UI-04 records more than 2 model calls per run-minute while watched, or any call between state changes while nobody watches.
- The `timeline_visible` lease is this ticket's mechanism for "on screen"; §14.5.3 states the rule, not the signal. A lost lease only drops to once per state change, never to no summary.

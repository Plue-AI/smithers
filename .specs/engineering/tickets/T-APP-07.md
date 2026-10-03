# T-APP-07 Edge toast map, timeline, conversation-entry and monitor summaries

Stage S1 · Size M · Depends on T-COL-02, T-APP-16, T-UI-08, T-APP-09 · Summaries only: T-FLW-08, T-FLW-07 · Unblocks T-APP-01, T-APP-18, T-REL-02 · Issue: [#3501](https://github.com/smithersai/smithers/issues/3501)
Spec: spec.md §3 (`conversation_entries`), §4.1, §10.8.3, §11.5a (`agent:fast`), §11.6.1, §14.1, §14.4, §14.5, §14.6, §19.3 · Delta: delta.md §8, §9 · Product: mvp.md §6.4 Toasts for events, Timeline, J4.3, M-08, M-14

## Goal
The left edge maps the branch conversation a member is viewing: live work above the viewport pins top-left, live work and new entries below pin bottom-left, and on desktop a timeline between them shows one line per entry with a shared title, tone and state, plus at most one action derived for the viewer. Notable events also arrive as toasts, which each member can hide.

## Scope
In:
- Entry fields on the `conversation_entries` rows T-APP-16 stores: `title`, `tone`, `state`, and the facts the action needs (`needs_you.kind`, first in merge order, TODO number). Every member sees the same values.
- Deterministic derivation in the host (§14.5.2), recomputed in the transaction that changes the subject: tone (live, attention, failed, done, quiet) and state (the TODO state word, Starting included, §4.1; else null). An entry without a run takes its title from its first line or its card title.
- Per-viewer action, computed in the client from the shared facts plus the viewer's role, never stored. A maintainer sees Merge on the first In review item and a member sees none. One function, `actionFor(entry, viewer)`, serves the rail, the Home card (T-APP-01) and toasts.
- The rail: on desktop, one timeline line per entry (glyph, title; a prompt shows its author through T-APP-09); a band marks the entries on screen; a click scrolls to the entry; live entries above the band pin top, live or new entries below pin bottom; each line carries the viewer's action. Narrow screens show one pill per edge ("↑ 2 live above", "↓ 1 new below").
- Toasts (§14.4.1): Needs you, an approval, a PR ready for review, a failure, a rebase conflict, and the merge of the viewer's own TODO, each with its one action, on the shared toast stack (`state/controller/failures.ts:236-285`, the 300 ms law), at most three plus "+N more", settled only by the real terminal event. Routing is derived in the client: the TODO's owner and the prompter for their own runs; presence recipients start in S2 (§10.8.3). Each toast is also a timeline entry.
- Hiding: a per-conversation `toasts_hidden` flag in the member's view state (T-APP-16) plus one global preference. Hiding never hides the entry, the edge map or the Home card.
- Summaries, pending Will's ruling on model-written summaries: the `agent:fast` summarizer (§14.5.3) for entry summaries and the monitor's `run_summaries` (§11.6.3), with the `timeline_visible` lease. Build them as a separate change after the rest lands, and only once Will rules. Nothing else in this ticket waits on them.

Out:
- Conversation storage and view state (T-APP-16); the Context line and Inspect (T-APP-17); browser notifications (T-APP-18); the monitor and scrubber (T-FLW-07); S2 presence.

## Changes
- `packages/backend/internal/services/conversation_entries.go` (new; no existing service derives entry tone or state): derivation in the subject transaction, published through the existing `sse.Broker` behind `/api/live` (ruling 2). No `projection_events` row.
- `packages/rpc/src/CardPrimitives.ts` and `CardAction.ts`: add `actionFor` beside the existing `ToneSchema`, `TodoStateSchema`, `NeedsYouKindSchema` and `ActionSchema`. No new enum and no second entry schema.
- `apps/app/src/mainview/ToastStack.tsx` stays the toast card file: it maps the shared toast stack (`failures.ts`, unchanged debounce) to `ToastStackView.tsx` props and its own markup is deleted. Deletes the `ToastStack.tsx` markup and `ToastStack.test.tsx` markup assertions (pair: ToastStackView).
- `apps/app/src/mainview/ChatRunTimeline.tsx` stays the timeline card file: it maps entries to `Timeline.tsx` (lines from `cards/views/TimelineLineView.tsx`) and to `EdgeMap.tsx`, and turns the Views' `onView({on_screen})` report into the band. Deletes its old markup, the `.chat-run-timeline*` rules (`styles/chat.css:782-792`) and the matching assertions in `ChatRunTimeline.test.tsx` (pair: Timeline and EdgeMap). Both card files keep their shell mounts (`App.tsx:554`, `:616`); no Container is added beside them.
- Pending Will's ruling: `conversation_summaries.go` on `packages/backend/jobs` through `internal/services/model_proxy.go`, and a `run_summaries` migration. Admit each job in the subject transaction; accept a result only by compare-and-set on run id, attempt id and source revision.

## Tests
- Unit (`CardAction.test.ts`): `actionFor` for every TODO state × `needs_you.kind` × first in order × role; each result parses with `ActionSchema` and carries a `CatalogTag`. A maintainer gets Merge on the first In review item; a member gets no action.
- Unit (Go, `conversation_entries_test.go`): tone and state for every TODO state, Starting included. In review is quiet; Needs you and stack attention are attention; FAIL is failed. Two members' reads of one entry are byte-identical.
- Unit (`ChatRunTimeline.test.tsx`): pins above and below the band; pill counts; a line's action carries its command and input; a click scrolls the ASK card under the band.
- Unit (`ToastStack.test.tsx`): five failures give three toasts plus "+2 more"; no toast settles before its terminal event; under 300 ms no success flashes; a member who hides toasts gets none while the line stays; routing reaches the owner and the prompter and not another member.
- e2e (`apps/app/e2e/real/timeline.spec.ts`), Maya (owner, 1,440 px) and Alice (member, 900 px) on `main`: Maya's live TODO pins top with the live tone and Alice sees "↑ 1 live above"; ASK shows gold and Answer for both; FAIL shows ember and Retry; the first In review item shows Merge for Maya and nothing for Alice. After Alice hides toasts, her own failure toast does not appear but its entry does, and Maya's toasts still arrive. A TODO between admission and its first step reads Starting for both.
- Pending Will's ruling, with the summaries change: real PostgreSQL, controlled model. A rolled-back subject transaction admits no job; a committed job survives restart; a stale result leaves the literal summary bytes and `summary_rev` unchanged. With the lease held and events every 1 s for 60 s, no event waits more than 30 s and the last is summarized within 8 s; with no lease, one call per state change. A blocked model leaves the summary unchanged, the run finishes within 2 s of baseline, and the summarizer creates no `machine_requests` row.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.
- [C-J11-01](../checks/C-J11-01.md) steps 8–9, with the summaries change only.
- [C-UI-13](../checks/C-UI-13.md): `ToastStackView`, `Timeline` and `EdgeMap` are reachable from `CardRenderers`; the old `ToastStack.tsx` and `ChatRunTimeline.tsx` markup and `.chat-run-timeline*` rules are deleted.

## Risks and notes
- The timeline's 1,180 px breakpoint is T-UI-08's; the card file passes the same lines at every width.
- Summaries cost money per live run, which is one reason they wait for Will's ruling.

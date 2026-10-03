# C-UI-04 Edge map and timeline: shared entries, per-viewer actions, live summaries, toasts

Proves: mvp.md §6.4 Toasts for events, Timeline, M-08, M-14 · spec.md §14.1, §14.4, §14.5, §10.8.3, §11.5a (`agent:fast`), §19.3 · Layer: e2e+integration · Stage: S1 · Tickets: T-APP-07
Automation: `apps/app/e2e/real/timeline.spec.ts` (new) · Runs in: reference host · Added integration qualification: `packages/backend/internal/services/conversation_summaries_test.go` (production job worker, real PostgreSQL, controlled model endpoint)

## Setup
- Install at the commit under test. The test `flows/todo/flow.ts` of C-J4-01 is Active, plus `EMIT`, which emits one step event per second for 60 s. None of these flows calls a model, so blocking the summarizer's `agent:fast` model affects nothing else.
- Maya (owner) in a 1,440 px window; Alice (member) in a 900 px window. Both open `main`'s conversation.
- A packet-filter rule ready to block the summarizer model's provider host.

## Steps
1. Maya starts a TODO with `EMIT`. Scroll Maya's transcript so its card is above the viewport; scroll Alice's the same way.
2. Record every `conversation:` delta that changes the entry's `summary_rev`, with its time, until 10 s after the last event.
3. Start TODOs with `ASK`, `FAIL` and `PR` (the PR item first in merge order). Record both members' timeline lines, toasts and actions.
4. Alice hides toasts. Alice starts a `FAIL` TODO, and Maya starts another.
5. Click Maya's timeline line for the ASK TODO.
6. Block the provider host and start another `EMIT` TODO; time it. Unblock and repeat once as the baseline.
7. Start five `FAIL` TODOs at once.
8. In the production summary worker integration harness with real PostgreSQL, roll back a subject/event transaction, then commit another and restart before the worker runs. Hold responses for two source revisions; return the newer one first. Repeat with a replaced run and attempt and with phase/cell summaries.

## Pass when
- The same `ConversationEntry` schema parses literal entries in both topic decoders. `actionFor` results parse with CardAction’s `ActionSchema` and carry catalog tags; CardPrimitives supplies tone, TODO state and Needs you kind without duplicate enums. Attention rows include id/revision. Literal action fixtures bind `order.ok` to `{id, revision}` and `main.reset-to-github` to `{id, old, new}` via T-APP-19b (#3601).


- Step 8 admits no job on rollback and retains the committed job after restart. Only the current run, attempt and source revision can update the summary and its projection. Late results leave the accepted literal bytes and summary_rev unchanged. Phase and cell rows obey the same comparison. The shell mounts T-UI-08’s View through T-APP-07’s Containers and has no legacy ToastStack or ChatRunTimeline import.
- Maya's EMIT entry pins to the top edge with the live tone; Alice, with no timeline, sees a "↑ 1 live above" pill.
- During the 60 s of events, no event waits more than 30 s for a refresh, and the last event is summarized within 8 s (5 s debounce plus model time).
- Title, summary, tone and state are identical for both members on every entry. Compare ASK, FAIL, PR and Starting against checked-in literal fixture values at the recorded cursor; do not derive expected values from spec files or production tone/state functions.
- ASK shows attention (gold) and Answer for both; FAIL shows failed (ember) and Retry; the first In review item shows quiet, with Merge for Maya and no action for Alice.
- In step 3 the Needs you and failure toasts reach the TODO's owner and prompter, Maya, and not Alice (§14.4.1); presence-based recipients start in S2 (§10.8.3). Each toast is also a timeline entry, and the entry stays after the toast settles.
- While a TODO is between admission and its first step, its entry's state reads Starting for both members (§4.1).
- After step 4 Alice gets no toast for her own failure, but its timeline entry appears; Maya gets the toast for hers. Alice's choice is stored in her `member_conversation_state.toasts_hidden` only.
- Step 5 scrolls the ASK card into view under the band.
- In step 6 the summary and `summary_rev` do not change, the run finishes within 2 s of the baseline, and no `machine_requests` row comes from the summarizer.
- Step 7 shows three toasts plus "+2 more"; no toast settles before its terminal event.

## Fail when
- One member sees a different summary, tone or state than another for the same entry.
- Alice sees Merge, or a member sees another member's per-viewer action.
- The summary goes blank or shows an error during the fault, or the run slows.
- Hiding toasts also removes timeline entries, or hides them for another member.
- A summary refresh never happens while events keep arriving (a debounce without a maximum wait).

## Evidence
`.artifacts/checks/C-UI-04/<UTC timestamp>/`: both screen recordings, the `conversation:` delta log with times, the SQL snapshot per step, run timings with and without the fault, the model-call count per run-minute, the commit and install version.

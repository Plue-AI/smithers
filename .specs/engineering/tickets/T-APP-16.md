# T-APP-16 Branch conversations: storage, topics, view state, branch tree, Earlier archive

Stage S1 · Size L · Depends on T-COL-02, T-ACC-02, T-ACC-04, T-UI-07, T-APP-22, T-APP-09, T-CAT-01, T-INS-02, T-FLW-08 · Cutover also on T-APP-04 · Unblocks T-AGT-01, T-AGT-02, T-AGT-03, T-APP-01, T-APP-02, T-APP-05, T-APP-06, T-APP-07, T-APP-10, T-APP-17, T-CUT-04, T-FLW-05, T-FLW-13, T-REL-02, T-REL-03, T-STK-09 · Issue: [#3446](https://github.com/smithersai/smithers/issues/3446), [#3609](https://github.com/smithersai/smithers/issues/3609) (host-turn issue absorbed)
Spec: spec.md §2 (Conversation), §3, §5.6, §6.3 (`/api/conversations`), §7.2, §14.1, §14.1.5, §14.5.1, §15.1.1–15.1.5 · Delta: delta.md §9 · Product: mvp.md §3 Conversation, §6.4 Branch conversations, M-08, M-34, Appendix B.1 (`chat.send`, `chat.stop`, `chat.queue*`) · Engineering: overview.md E-18, E-20

## Goal
Everyone on a branch reads one conversation with the same entries in the same order; each member keeps their own scroll and card state; `main`'s conversation opens on the Home card; every app-agent turn runs on the host with its author's rights, one at a time per conversation, and finishes after its author closes the tab. The browser executes no tool. Every legacy per-member conversation stays readable under Earlier. Storage lands first; the shell cutover lands as one change after it.

## Scope
In:
- Storage: promote `request_payload.conversationId` to indexed `chat_turns.conversation_id`; use existing turn batches for cards/events. Filter history by branch membership, not user_id. Confirm cards stay in `approvals`; uncommitted Drafts stay in browser state.
- Member view state as columns: the global toast preference and a `view_state` map keyed by conversation (scroll anchor, card view, `last_seen_seq`, `toasts_hidden`) on the member's `collaborators` row (ruling 1 already adds columns there). Only that member reads or writes it.
- Agent turns (E-18, E-20) are `chat_turns` rows (`packages/backend/db/product/migrations/0007_chat_turns.sql`) reshaped with `conversation_id` and a `queued` state. The runner is the existing chat runtime: `Store.Claim` (`internal/chat/store.go:472`), its lease, and `Dispatcher` (`internal/chat/dispatcher.go:38`). No second runner. The claim takes the oldest queued turn per conversation under a transaction advisory lock keyed by repository and branch, with a partial unique index allowing one running turn per conversation. It checks the author is still a member, mints `delegated(via=smithers)` (T-ACC-04) and launches `modelhost.LaunchChatHost`.
- Tools run on the host. `packages/smithers/agent/model-host/src/HostTools.ts` (new; the only existing executor, `state/controller/turns.ts:618` `executeForAgent`, runs in the browser without a host credential, so it moves rather than doubles) calls the shared catalog `catalogRequest(descriptor, payload)` (T-CAT-01) with the turn credential and `Smithers-Via: smithers`. A `confirm` row posts the author's private Confirm card (T-APP-04) and returns `202 {confirmation: id, state: "pending"}`. A UI-only row publishes its instruction to the author only.
- Every turn read and preflight input uses `SharedEntries(conversation)`: shared started turns and their outputs; exclude queued prompts, approvals and browser Drafts (§15.1.2a).
- Revocation (§5.6): removing a member cancels their queued turns (`author_revoked`) and stops the running one within 5 s; its credential is revoked and its lease closed.
- Prompt queue (Appendix B.1), caller's own turns only: `POST /api/conversations/{b}/prompt`, `/stop`, `chat.queue.edit` (`PATCH …/turns/{id}`), `chat.queue.remove` (`DELETE …/turns/{id}`) and `chat.queue.restore`. A queued prompt shows only to its author; its shared entry is appended when the turn starts.
- Earlier (§14.1.5): legacy conversations from the browser store (`state/AppStore.ts`) and the existing `GET /api/agent/conversations` and replay routes (`internal/chat/http.go`) open read-only for their member, decoded by T-APP-22. Nothing is migrated.

Out:
- Summaries, tone and the timeline (T-APP-07); preflight (T-APP-17); Confirm card and its command (T-APP-04).
- Repository code on the host, shell or file-write tools for the app agent, archive replay execution, a pause protocol, and person-to-person messages (M-08).

## Changes
- Alter `chat_turns` for conversation_id and its index and `collaborators` for view_state; no conversation tables. Drop uncalled `app_timeline*` tables with their routes and queries.
- Extend `internal/chat/history.go` and the existing turn writer; preserve batch ordering and replay. Publish after commit through the broker. View-state writes update only the authenticated member’s collaborator row.
- `internal/chat/store.go`, `dispatcher.go`, `runtime.go`: claim by conversation, revocation subscriber, answers as entries attributed "Smithers for <author>" through T-APP-09.
- Extend `internal/chat/http.go`: `GET /api/agent/conversations/{branch}`, prompt, view-state and queue operations; update existing OpenAPI rows.
- Deletes `routes/app_timelines.go`, `services/app_timeline.go`, `db/app_timelines.sql.go` and their queries, router, config and rate-limit entries.
- Card files (View: T-UI-07, f21ddd50a): the conversation surface in `App.tsx` with `TranscriptMessage.tsx` maps entries to `EntryRow.tsx` and mounts `BranchTree.tsx` and `EarlierArchive.tsx`; `TranscriptMessage.tsx`'s own markup is deleted (pair: EntryRow). `/branches` opens the tree; deletes `cards/BranchesCard.tsx` and `BookmarksSeam.ts`'s card producer, and `branches` joins the retired kinds (pair: BranchTree).
- Cutover: the composer posts to `…/prompt`. Deletes the browser tool loop (`continueToolLeg` at `state/controller/turns.ts:603` and its continuation posts, `httpTurns.ts`, the `native/WebAgent.ts` turn client; `flows/agentTools.ts` keeps only the UI-only handler); the write routes `/api/agent/turn`, `/cancel`, `/retire`, `/api/chat/turn`, `/api/chat/cancel`, the Bun relay (`bun/server.ts:887-895`), and the `TURN_PATH`, `CANCEL_PATH`, `TURN_RETIRE_PATH`, `CHAT_TURN_PATH`, `CHAT_CANCEL_PATH` exports (`packages/rpc/src/AgentApiRoutes.ts`). Keeps `TURN_REPLAY_PATH`, `CONVERSATIONS_PATH`, `CONVERSATION_REPLAY_PATH`, `TURN_ERASE_PATH`. Moves probe callers (`apps/app/scripts/launch-seam-probe.ts`, `launch-checklist/Rows.ts`, `canary-seam-probe.ts`, `apps/server/scripts/canary/uptime-checks.ts`).

## Tests
Folded from C-APP-04, C-APP-05 and C-UI-06. Real PostgreSQL, production authenticated router and `/api/live`, members Ben (Maintainer) and Alice (Member). Fake only the model endpoint and GitHub.
- Storage: concurrently start turns from Ben and Alice on one branch; both see the same ordered turn/batch replay. A failed append commits no batch or event. PATCH/DELETE of shared output refuses.
- Privacy: Alice’s browser Draft never reaches Ben or model context; Ben’s Confirm reaches only confirmations:Ben. Committing the Draft creates one shared TODO event; foreign view-state reads refuse.
- View state: Ben maximizes a card and scrolls; Alice's state is unchanged and her scroll restores after reload.
- Earlier: with two legacy conversations in Ben's browser store and one in the journal, Ben sees three read-only archives with every entry decoded; Alice sees none; opening one never starts a turn.
- Queue: two dispatchers race for two queued turns in one conversation; one launches. Crash after mint and after lease, then restart: every old credential is refused and no lease survives. The same idempotency key queues one turn. Alice's `/stop` does not stop Ben's turn; Alice's `PATCH` of Ben's queued prompt gets 403 `permission`; Ben's edit to "list changed tests" runs.
- Host tools: a fake model calling `todo.stop T2`, `todo.drop T2` and `/theme dark` runs all three on the host with `Smithers-Via: smithers`; T2 pauses; Ben alone gets a Confirm card for the drop; the theme reaches only Ben; no browser request carries a command. "merge T1" yields a Confirm card, and no merge reaches GitHub; Alice's delegated merge gets 403 `permission`. HostTools and the CLI produce the same literal method, path and body for each fixture.
- Close the tab: Ben closes his tab mid-turn; the turn completes once, Alice sees the answer live, and Ben finds it on return.
- Private data: with Alice's uncommitted Draft "canary-7Q4" and Ben's pending Confirm, no model request of Ben's turn contains either.
- Revocation: removing Alice during her 60 s `SLOW` turn ends it `cancelled` (`author_revoked`) within 5 s and her queued turn never starts; no command with her credential succeeds after the commit; Ben's queued turn then runs.
- Cutover: the five legacy write routes answer 404 and write nothing; legacy history and replay still read; `chat.queue.resume` and the five exports are absent; `Architecture.test.ts` finds no `executeForAgent` call for a non-UI-only command. An untrusted repository's host-execution canary never runs in the model host.

## Acceptance
- [C-APP-04](../checks/C-APP-04.md): passes for this ticket’s phase at its stated layer.
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.
- [C-UI-13](../checks/C-UI-13.md): `EntryRow`, `BranchTree` and `EarlierArchive` are reachable from `CardRenderers`; `cards/BranchesCard.tsx` and `TranscriptMessage.tsx`'s markup are deleted.

## Risks and notes
- Risk: a browser-only tool has no host equivalent. Each one becomes a catalog row first (T-CAT-01).
- Will decides whether `chat.queue.resume` stays with defined host semantics before cutover; until then it is removed.
- The `app_timelines` drop waits on smithers-3f's Plue consumer check; the private repository was not read.
- Cutover safety: nothing is migrated, the new columns are additive, and a tab on the old build gets 404 and writes nothing.

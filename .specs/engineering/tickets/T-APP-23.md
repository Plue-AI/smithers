# T-APP-23 Host turns: the app agent's turns move to the host; cutover to shared conversations

Stage S1 · Size L · Depends on T-APP-16, T-APP-22, T-ACC-04, T-ACC-05, T-ACC-06, T-CAT-02, T-UI-07 · Unblocks T-APP-07, T-APP-17, T-REL-02 · Issue: [#3609](https://github.com/smithersai/smithers/issues/3609) (split from [#3446](https://github.com/smithersai/smithers/issues/3446))
Spec: spec.md §6.3 (`/api/conversations`), §14.1, §14.1.5, §14.5.1, §15.1.1, §15.1.2a, §15.1.3–15.1.5, §5.6 · Delta: delta.md §9 · Product: mvp.md §3 Conversation, §6.4 Branch conversations, M-08, M-34, Appendix B.1 (`chat.send`, `chat.stop`, `chat.queue*`)

## Goal
Every app-agent turn runs on the host with its author's rights, one at a time per conversation, and finishes after its author closes the tab; the browser executes no tool. One release switches the shell from per-member conversations to shared branch conversations, with nothing migrated and nothing lost.

## Ownership
Engineering only. Turn progress and answers render in T-UI-07's entry rows.

## Scope
In:
- The queue and runner (§15.1.4, §15.1.4a) on the existing chat runtime (`packages/backend/internal/chat`). The runner claims the oldest `queued` `agent_turns` row of each conversation, one running turn per conversation. It checks that the author is still an active member, then mints a `delegated(via=smithers)` credential for the author (T-ACC-04) and launches the model host for the turn (`packages/backend/modelhost`, `LaunchChatHost`). A failed check ends the turn `refused` and mints nothing.
- Tools run on the host. The model host executes each tool call through the CLI's command→API mapping (the `packages/smithers/src` command definitions that T-CAT-02 generates from the catalog) with the turn credential and `Smithers-Via: smithers`. The tool list is the catalog rows that list `app_agent` and aren't `never`. A `confirm` row posts the author's private Confirm card (T-ACC-05) and returns `{id, state}`. A UI-only row (§14.1.4) returns an instruction that the runner publishes on the author's `view:<member>:<branch>`, never on shared state.
- Every read inside a turn uses T-APP-16's `SharedEntries`; the turn credential can't subscribe to `view:*` or `confirmations:*` (§15.1.2a).
- When a turn starts, the runner appends its prompt entry (with `author_actor`) to the shared conversation; the answer and its cards follow as entries (T-APP-16), attributed "Smithers, for <author>" (M-34, §14.6a). A turn survives its author's socket closing.
- Revocation (§5.6): on the revocation event the runner cancels the member's queued turns (`cancelled`, reason `author_revoked`) and, within 5 s, stops the running one: the credential is revoked, the model host's lease is closed, and the turn writes nothing more. The conversation's next turn then starts.
- The prompt queue (Appendix B.1 `chat.queue*`, the single-user prompt queue AGENTS.md keeps), each for the caller's own turns only: `/stop` (`POST /api/conversations/{b}/turns/{id}/stop`) stops the running one; `chat.queue.edit` (`PATCH …/turns/{id} {prompt}`) and `chat.queue.remove` (`DELETE …/turns/{id}`) work until the turn starts; `chat.queue.restore` withdraws the caller's queued prompts into their composer.
- Cutover, in one change:
  1. `App.tsx` mounts T-APP-16's Containers; the composer posts to `POST /api/conversations/{b}/prompt`; ⌘K is scoped to the current conversation; `/branches` opens the branch tree, so `cards/BranchesCard.tsx` and `BookmarksSeam.ts`'s card producer go and `branches` joins `LEGACY_CARD_KINDS` (card-kinds.md).
  2. Every legacy per-member conversation is listed under Earlier, read-only (T-APP-16, §14.1.5).
  3. Browser tool execution is deleted: `apps/app/src/mainview/flows/agentTools.ts` keeps only the UI-only instruction handler; `state/controller/turns.ts` and `state/controller/httpTurns.ts` lose the tool loop and the continuation posts; `native/WebAgent.ts` loses its turn client. The browser holds no bearer.
  4. The legacy write routes `POST /api/agent/turn`, `/api/agent/turn/cancel` and `/api/agent/turn/retire` (`packages/backend/internal/chat/http.go`: `TurnPath`, `CancelPath`, `RetirePath`), the Bun relay (`apps/app/src/bun/server.ts:887-895`) and their OpenAPI rows are deleted. The read routes `GET /api/agent/conversations`, `/api/agent/conversations/replay`, `/api/agent/turn/replay` and `POST /api/agent/turn/erase` stay for Earlier.
  5. Every other caller of the deleted routes (`rg "TURN_PATH|CANCEL_PATH|TURN_RETIRE_PATH"`; today `apps/app/scripts/canary-seam-probe.ts` and `apps/server/scripts/canary/uptime-checks.ts`) moves to the prompt route in the same change.
- Why the cutover is safe: nothing is migrated (§14.1.5), so reverting the release brings back the per-member conversations intact, and the new tables are additive. A tab still on the previous build gets 404 from the deleted routes and writes nothing. A turn running when the host restarts for the upgrade ends `interrupted`, as today, and its committed output stays readable under Earlier.

Out:
- Storage, topics, the prompt route, Containers and Earlier (T-APP-16); preflight (T-APP-17); summaries and the timeline (T-APP-07).
- Minting and `Smithers-Via` (T-ACC-04); confirmations (T-ACC-05); the revocation event (T-ACC-06).

## Changes
- `packages/backend/internal/services/agent_turns.go` (new): claim (`SELECT … FOR UPDATE SKIP LOCKED`, one running per conversation), author check, mint, launch, stop, cancel, edit and remove; the revocation subscriber.
- `packages/backend/internal/chat/runtime.go` and `host_client.go`: run a turn from an `agent_turns` row with the delegated credential; publish UI-only instructions; write answer entries through T-APP-16's service.
- `packages/smithers/agent/model-host/src/` (new module `HostTools.ts`): execute tool calls over the CLI command definitions with the turn credential.
- `packages/backend/internal/routes/conversations.go` (T-APP-16): the turn routes in Scope, with rows in `docs/api/openapi/conversations.yaml`.
- The cutover deletions and moves in Scope, with their tests and OpenAPI rows; regenerate `packages/backend/apiclient/client.gen.go` and `packages/smithers/src/internal/backend/ProductApi.ts`.
- `apps/app/src/mainview/Architecture.test.ts` (existing): no module under `src/mainview` calls `executeForAgent` for a command that isn't UI-only, and nothing imports the deleted turn client.

## Tests
- Integration (real PostgreSQL, fake model): two members' turns on one branch run in order, the second after the first ends; Alice's `/stop` doesn't stop Ben's turn.
- Integration: Ben's turn runs with a host-minted delegated credential, and no response or frame to any browser contains it. "merge T1" yields a `review_merge` confirmation, never a merge; "stop T2" runs at once; "drop T2" posts a one-click Confirm card; "dark theme" reaches only `view:<ben>:<branch>`.
- Integration: Ben's socket closes mid-turn; the turn completes, and Alice receives the answer live.
- Integration: removing Alice cancels her queued turn and stops her running turn within 5 s; no command call with her credential succeeds after the removal commits; Ben's queued turn then starts. An author removed between claim and start (a test hook pauses the runner) gets `refused` and no credential.
- Integration: a turn's conversation reads and its preflight inputs hold no private entry, its author's own included.
- Integration: Ben edits his queued prompt before it starts, and the turn runs the edited text; Alice's edit or removal of Ben's queued prompt gets 403 `permission`; a removed prompt never runs.
- Integration (Go): the deleted routes answer 404 and are absent from `docs/api/openapi.yaml`; the read routes still serve a legacy conversation.
- Unit: the architecture rule above.
- e2e: the C-UI-06 script; the archive steps of C-CUT-02.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-UI-06](../checks/C-UI-06.md): shared entries, the author's rights, UI-only flows local, a turn that completes after its author closes the tab, no private entry in any turn, a removed author's turns cancelled, and queued prompts editable by their author only.
- [C-APP-05](../checks/C-APP-05.md): the cutover.
- [C-CUT-02](../checks/C-CUT-02.md) steps 3 to 6: legacy conversations open under Earlier after the cutover.

## Risks and notes
- Risk: a browser-only tool has no host equivalent. Confirmed if `rg` over `agentTools.ts` finds a non-UI-only tool without a catalog API mapping. Each one becomes a catalog row first (T-CAT-01).
- `chat.queue.resume` (Appendix B.1, Keep) has no meaning for a host queue that never pauses. It stays hidden until product drops the row or defines a pause.
- A model host launch per turn adds to the first token. C-PERF-01 (T-REL-01) measures it with preflight included.

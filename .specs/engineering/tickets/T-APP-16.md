# T-APP-16 Branch conversations: shared entries, per-member view state, branch tree, legacy archive

Stage S1 · Size L · Depends on T-COL-02, T-ACC-04, T-UI-07, T-APP-19 · Unblocks T-APP-01, T-APP-05, T-APP-07, T-APP-17, T-APP-10 · Issue: [#3446](https://github.com/smithersai/smithers/issues/3446)
Spec: spec.md §2 (Conversation), §3, §7.2, §14.1, §14.5.1, §15.1.1, §15.1.4–15.1.5 · Delta: delta.md §9 · Product: mvp.md §3 Conversation, §6.4 Branch conversations, M-08

## Goal
Everyone on a branch sees one conversation with the same entries in the same order. Each member keeps their own scroll and card state, `main`'s conversation opens on the Home card, and every app-agent turn runs on the host with its author's rights, so it finishes even if the author closes the tab.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: the conversation shell, the branch tree, prompt rows with their author, and the Earlier archive node. Engineering wires them: conversation storage, host-side turns, per-member view state, prompt queueing. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope
In:
- `conversations` (1:1 with a branch, created with the branch), `conversation_entries` (shared, ordered by `seq`) and `member_conversation_state` (§3).
- Topics (§7.2.2): `conversation:<branch>` carries only shared entries, identical for every subscriber. Each member's view state (scroll anchor, card view, `last_seen_seq`, toast hiding) and their private entries live on `view:<member>:<branch>`, which only that member can subscribe to.
- Entries are append-only: nobody deletes a prompt from a shared conversation (§14.5.1).
- Private entries (`audience_member_id`, §14.5.1): a Confirm card (§5.4, §15.1.5) and a Draft card until its author commits it. Unsent composer text never leaves the browser.
- Host turns (§15.1.4). Posting a prompt records `author_actor` and queues a turn on the host. The turn runner:
  - runs the whole turn on the host, including command dispatch, through the same command→API mapping the CLI uses (§6.1);
  - acts with a host-minted `delegated(via=smithers)` credential for the author (T-ACC-04), never sent to a browser, so "Ben via Smithers" has exactly Ben's non-person rights;
  - applies the catalog's `agent: run | confirm | never` (§15.1.5): `confirm` posts the author's private Confirm card, `never` commands are absent from the tool list;
  - sends UI-only flows (§14.1.4) to the author's own browser as instructions on `view:<member>:<branch>`; they never write shared state.
- One turn at a time per conversation, FIFO, queued server-side. A turn survives its author closing the tab. `/stop` stops only the caller's own turn, and queued prompts stay editable by their author until they start.
- The queue is `agent_turns` (§3, §15.1.4a). The runner mints the author's turn credential only when the turn starts, after checking that the author is still an active member; a removed or suspended author's turn ends `refused` and runs nothing.
- Revocation (§5.6, §15.1.4a): the runner subscribes to the revocation event and, within 5 s, cancels the member's queued turns and stops their running turn (credential revoked, model stream aborted, no later write).
- Audience filter (§15.1.2a): every conversation read inside a turn returns shared entries only, leaving out the author's own private entries too, and the turn credential can't subscribe to `view:*` or `confirmations:*`.
- The branch tree: a branch, its fork parent and its children. `main` sits at the root and opens on the Home card.
- Legacy per-member conversations become read-only archives that only their member sees, under "Earlier" (§14.1.5).

Out:
- Summaries, tone, the timeline and toast hiding preferences (T-APP-07). Preflight (T-APP-17).
- Person-to-person messages, which never exist (M-08).

## Changes
- Storage, decided by a one-day evaluation recorded in the ticket's issue. First choice: build on the shared event log `packages/backend/internal/services/app_timeline.go` (`AppTimelineService`), keyed one timeline per branch, with membership derived from install membership. Otherwise new migrations for the §3 tables. Either way, delete the path you don't use.
- `packages/backend/internal/services/app_agent_turns.go` (new): the host turn runner behind `POST /api/agent/turn`, serialized per conversation, dispatching through the catalog's API mapping (T-CAT-01).
- `apps/app/src/mainview/flows/agentTools.ts`: browser-side execution of agent tools is deleted; only UI-only flow handlers remain, driven by host instructions (zero tech debt).
- `apps/app/src/mainview/state/controller/turns.ts`: posts prompts and renders turn progress from the topics; it no longer runs tools or holds a bearer.
- `apps/app/src/mainview/state/AppStore.ts`: the transcript becomes a projection of `conversation:<branch>` plus `view:<member>:<branch>`. Local OPFS keeps unsent drafts only (ADR 0001 data authority). Today's per-member transcript rows become the archive collection.
- `apps/app/src/mainview/App.tsx`: the current-branch context, the branch tree (`/branches` with tree layout) and ⌘K scoped to the current conversation.
- `packages/rpc/src/Cards.ts`: entries carry `author_actor`; `TranscriptMessage.tsx` renders the author with the `via` badge (T-APP-09).
- `docs/api/openapi/*.yaml`: `GET /api/conversations/{branch}`, `POST …/prompt`, `PUT …/view-state`.

## Tests
- Integration (real PostgreSQL): two members' prompts on one branch produce one ordered entry list. The second turn starts after the first finishes. Alice's `/stop` doesn't stop Ben's turn.
- Integration: a prompt by Ben runs with his delegated credential minted on the host; no response or frame to any browser contains that credential. Asking it to merge yields a `review_merge` confirmation for Ben, never a merge.
- Integration: Ben's turn keeps running and posts its answer after his socket closes mid-turn; Alice sees the answer live, and Ben sees it on return.
- Integration: Alice's subscription to `view:<ben>:<branch>` is refused; a private entry never appears on `conversation:<branch>`.
- Unit: view state round-trips per member. Alice's maximize doesn't change Ben's card state.
- e2e (`apps/app/e2e/playwright/branch-conversation.spec.ts`, new): the C-UI-06 script.
- Migration test: a legacy per-member transcript opens read-only under "Earlier" for its member only.
- Integration (real PostgreSQL): removing Alice cancels her queued turn and stops her running turn within 5 s; no command call with her turn credential succeeds after the removal commits; Ben's queued turn then starts.
- Integration: an author removed between dequeue and start (a test hook pauses the runner between the two) gets `refused`, and no credential is minted.
- Integration: a turn's `GET /api/conversations/{b}` and its preflight inputs contain no private entry, its author's own included.

## Acceptance
- [C-UI-06](../checks/C-UI-06.md): shared entries, per-member state, the author's rights, UI-only flows local, a turn that completes after its author closes the tab, no private entry in any turn, and a removed author's turns cancelled.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- Risk: `AppTimelineService` was built for xstate event logs with fork branches. Confirm that its write model fits ordered prompt, answer and card entries without fork semantics, using the evaluation's two-member integration test. If it doesn't fit, build the §3 tables and leave app timelines unchanged.
- Risk: a browser-only tool has no host equivalent. Confirmed if `rg` over `agentTools.ts` finds a non-UI-only tool without a catalog API mapping. Each one becomes a catalog row first (T-CAT-01).

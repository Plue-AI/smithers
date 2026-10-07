# Conversation recovery

The composer persists a prompt request before calling
`POST /api/conversations/{branch}/prompt`. Its idempotency key survives reload;
a repeated admission does not create a second turn. The browser records the
admission receipt and reconnects to shared replay. The existing host dispatcher
owns model calls, tool execution, leases and cancellation after the tab closes.

`SharedEntries` contains started turns and outputs in journal order. Queued
prompts, drafts, confirmations, UI instructions and member view state remain
private. The author alone receives UI instructions through their private view,
and executes them through the typed UI flow once. Backend commands execute
through the host catalog under the author's delegated credential.

Reload reads the current branch conversation. The author's persisted prompt
request stays pending until replay contains its actual terminal receipt.
Failures remain visible and retryable. Removing an author cancels queued turns,
stops their running turn within five seconds and revokes its credential.

`native/ConversationHistory.ts` reads private legacy conversation indexes and
bounded replay pages for Earlier. The existing decoder checks owner identity,
cursor order, hashes and terminal boundaries before hydration. It grants no
execution authority. Persisted browser history remains readable, including
interrupted output; it cannot retry, resume or execute a legacy turn.

The retired `/api/agent/turn`, cancel and retire routes and the `/api/chat/turn`
and cancel routes return 404. The timeline tables and write API are removed.

Evidence lives in `ConversationHistory.test.ts`, `HttpTurn.test.ts`,
`SharedConversationApp.test.tsx`, `C-APP-04.spec.ts` and `C-APP-05.spec.ts`.
`internal/compose/working_together_conversation_integration_test.go` exercises
real authenticated PostgreSQL admission, the packaged model host, ordering,
private-context canaries, author revocation and retired-route refusal. Its
Chromium rehearsal closes the author's tab while the model is held, then proves
completion and replay for two members through the composed install.

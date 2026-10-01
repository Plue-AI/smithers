---
title: Chat stream authorization
description: Revocation and reconnection for live chat responses.
---

## Revocation

Deleting a personal access token or suspending its account ends its live chat
response when the backend receives the revocation. The backend
checks revocation state when attaching the stream and before each delivery.
Unrelated accounts and tokens keep their streams.

Revocation ends delivery without cancelling or deleting the saved response. A
later request with valid credentials can retrieve its committed conversation
through the account history routes below. The original device proof also remains
available through `/api/agent/turn/replay`.

Direct hosts that mount the chat handler must supply `Handler.Revocations` from
their revocation bus. The shared backend composition supplies its process bus.

## Live provider check

`TestLiveProviderChatPersistsAndReplays` in `internal/compose` sends one chat
turn to a real provider through the local composition. It saves a built-in
provider key, selects it as the default model, streams the answer, and replays
it from PostgreSQL. It requires an identical hash chain, a completed turn, and
no key in the stream, replay, logs, or database rows. It runs only when
`SMITHERS_LIVE_MODEL` holds a model record and the environment holds the key
that record names:

```sh
SMITHERS_TEST_DATABASE_URL="$TEST_POSTGRES_URL" SMITHERS_REQUIRE_DATABASE_TESTS=1 \
SMITHERS_LIVE_MODEL='{"protocol":"openai-chat","modelId":"gpt-oss-120b","credential":"CEREBRAS_API_KEY","baseUrl":"https://api.cerebras.ai"}' \
  go test ./packages/backend/internal/compose -run TestLiveProviderChatPersistsAndReplays -count=1
```

The default suite skips it; a skip is not a pass.

## Account conversation history

`GET /api/agent/conversations` lists the authenticated account's saved conversation
and turn identifiers, completion observations, and committed public run references.
It does not return prompts, instructions, model context, tool outputs, or journal
capabilities. Pages contain at most 50 turns (`limit=1..50`); `next` is an opaque
keyset cursor supplied as `after` on the next request. A turn with more than 64
public run references refuses with the existing typed `limit` response rather
than silently omitting references. Reference extraction verifies committed batches.

`POST /api/agent/conversations/replay` accepts `runId`, `legId`, and an optional
committed `after` cursor. It uses the authenticated account, without an originating
device token. It returns the original visible user message and a verified replay
page of at most eight batches. Instructions, private context and function-call
outputs remain absent. Non-conversation model purposes are refused. Retired and
erased turns cannot be listed or replayed; the existing retirement and erasure
contracts are unchanged.

New app turns carry the existing branch identifier as optional `conversationId`.
Older requests without it group by their logical `runId`; no speculative branch
association is inferred. A fresh signed-in Cloud browser reads these pages and
restores the existing conversation/frame projection. It does not re-admit a turn
or restart model/tools. Account replacement, disposal, a new prompt, draft,
queued input, navigation or another user action prevents late hydration from
replacing the current conversation. Unfinished saved turns remain visibly
unfinished. Opening a public run reference invokes the existing authorized run
read; listing a reference does not grant run access.

The local integration suite uses real HTTP and PostgreSQL with a deterministic
model fixture and executes the actual Bun app controller as a second client with
an empty journal. It establishes restoration and isolation, not a live provider
campaign or a graphical browser qualification.

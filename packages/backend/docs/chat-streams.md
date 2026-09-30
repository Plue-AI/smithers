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
later request with valid credentials and the original journal proof can retrieve
that response through `/api/agent/turn/replay`.

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

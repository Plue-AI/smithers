---
title: "Live streams"
description: "Every long-lived response the backend serves, who may open it, and what it delivers."
---

## Inventory

`TestLiveStreamInventoryMatchesTheRouter` fails when a served handler streams
and has no row here, or a row names a route that does not stream.
`TestLiveStreamsServeOnlyTheirSubscribersPostgres` and
`TestLiveChatStreamsServeOnlyTheirSubscribersPostgres` open every row as its
owner, as another account and anonymously through the composed backend.

| Stream | Transport | Who may open it | Delivery | Test composition |
| --- | --- | --- | --- | --- |
| `GET /api/live` | WebSocket | install members with a browser session from the install's origin | shared topic snapshots (`home`, `todo:<n>`, `flows`) at per-topic cursors; `smithers.live.v1` | refused 404: install-only; the J4 and J11 rehearsals open it on the install |
| `GET /api/notifications` | SSE | the signed-in account, its own notifications | live hints; no replay | opens |
| `GET /api/notifications/events/stream` | SSE | the signed-in account, its own notifications | durable facts; `Last-Event-ID` cursor | opens |
| `GET /api/github/import/{id}` | SSE with `Accept: text/event-stream` | the account that started the import | polled import snapshots until terminal | opens |
| `POST /api/agent/turn` | NDJSON | the signed-in account, its own chat responses | durable batches; journal proof replays through `/api/agent/turn/replay` | opens |
| `POST /api/model/stream` | NDJSON | the signed-in account, its own model | relayed model output; no replay | opens |
| `GET /api/repos/{owner}/{repo}/changes/events` | SSE | repository readers | live hints; no replay | opens |
| `GET /api/repos/{owner}/{repo}/mythical/events` | SSE | repository readers | live hints; clients refetch the stack | opens |
| `GET /api/repos/{owner}/{repo}/issues/state-events/stream` | SSE | repository readers | durable facts; `Last-Event-ID` cursor | opens |
| `GET /api/repos/{owner}/{repo}/wiki/{slug}/stream` | SSE | repository readers of the page | page revisions; `Last-Event-ID` revision cursor | opens |
| `GET /api/repos/{owner}/{repo}/runs/{id}/logs` | SSE | repository readers | persisted log lines; `Last-Event-ID` replay | opens |
| `GET /api/repos/{owner}/{repo}/runs/{id}/events` | SSE | repository readers | persisted log lines; `Last-Event-ID` replay | opens |
| `GET /api/repos/{owner}/{repo}/workflows/runs/{id}/events` | SSE | repository readers | persisted log lines; `Last-Event-ID` replay | opens |
| `GET /api/repos/{owner}/{repo}/runs/{id}/status/stream` | SSE | repository readers | status snapshot, then live changes | opens |
| `GET /api/repos/{owner}/{repo}/agent/sessions/{id}/stream` | SSE | repository readers with agent access | persisted messages; `Last-Event-ID` replay | opens |
| `GET /api/repos/{owner}/{repo}/workspaces/{id}/stream` | SSE | the workspace's owner and share members | live status; no replay | opens |
| `GET /api/repos/{owner}/{repo}/workspace/sessions/{id}/stream` | SSE | the session's owner | live status; no replay | opens |
| `GET /api/repos/{owner}/{repo}/workspace/sessions/{id}/terminal` | WebSocket | the session's owner with repository write | interactive terminal; no replay | refused 500: no sandbox machine backs the seeded workspace; `TestWorkspaceRuntimeProcessRequestPath` opens one |
| `GET /api/repos/{owner}/{repo}/workspace/sessions/{id}/lsp` | WebSocket | the session's owner with repository write | interactive language server; no replay | refused 500: no sandbox machine backs the seeded workspace |

Byte relays are not streams of their own: the workspace desktop relay, workspace
previews and the model provider proxy forward the upstream connection.

## Resume, lost wakeups and revoked access

`TestLiveStreamResiliencePostgres` drives every stream above that replays past
events (and the run status and import snapshots) through three failures:

- A `Last-Event-ID` the stream did not issue, or whose record was pruned, is
  refused with `409` and `details: {"reason":"cursor_unknown","resync":true}`
  before the stream starts. The client drops its position and reloads; a
  stream never resumes past events it cannot prove were delivered.
- A row committed without a wakeup still arrives: durable streams re-read
  the database every 5 seconds, the run status stream re-reads the run, and
  the import stream polls. A reconnect catches up from its cursor.
- Deleting the credential a stream is open under ends it with a `revoked`
  event, and the credential cannot reopen it.

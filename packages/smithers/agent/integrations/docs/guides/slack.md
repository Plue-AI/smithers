---
title: "Slack"
description: "Run a Slack app over Socket Mode: owner-only intake from direct messages, threaded replies under role personas, Block Kit approval buttons, durable post/update/reconcile actions, and the Events API door."
sidebar:
  order: 4
---

How to wire one Slack app into a host application. Each section is a recipe;
the [API reference](../api.md#slack) has the full signatures.

## Create the app

One app is enough, even for a host that speaks as several roles. In the Slack
app settings:

- **Socket Mode:** on. Generate an app-level token with the
  `connections:write` scope (it starts with `xapp-`).
- **Bot token scopes:** `chat:write`; `chat:write.customize` to post under a
  role's name and icon; `im:history` and `im:write` for direct messages;
  `app_mentions:read` and `channels:history` for a channel the app is
  mentioned in; `users:read`.
- **Event subscriptions:** `message.im` and `app_mention`.
- **Interactivity:** on. Under Socket Mode no request URL is needed.

Install the app to the workspace and copy the bot token (`xoxb-`).

## Configure from the environment

A host configured only by variables needs no code to decide who may reach it:

| Variable                        | Meaning                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SMITHERS_SLACK_BOT_TOKEN`      | The bot token. Every Web API call except `apps.connections.open` carries it.                            |
| `SMITHERS_SLACK_APP_TOKEN`      | The app-level token. Only Socket Mode uses it.                                                          |
| `SMITHERS_SLACK_SIGNING_SECRET` | The Events API signing secret, for the HTTP door only.                                                  |
| `SMITHERS_SLACK_TEAM_IDS`       | Comma-separated workspace ids admitted. Required.                                                       |
| `SMITHERS_SLACK_USER_IDS`       | Comma-separated people who may reach the host. Their direct messages are admitted without listing them. |
| `SMITHERS_SLACK_CHANNEL_IDS`    | Comma-separated conversations admitted, such as one team channel.                                       |
| `SMITHERS_SLACK_SELF_USER_IDS`  | Further user ids that are this app, refused as echoes.                                                  |
| `SMITHERS_SLACK_API_BASE_URL`   | A fixture server, for tests.                                                                            |

`Config.resolve` holds each token as `Redacted`, so a logged config prints
`<redacted>`. `Config.policy` reads the four id lists and refuses a policy
that would admit nothing: it needs a workspace and at least a person or a
conversation.

## Receive the owner's messages

```ts
import { Slack } from "@smthrs/integrations"
import { Effect } from "effect"

const policy = Slack.Config.policy()
const source = Slack.SocketSource.make({ policy })

const intake = source.run((events) =>
  Effect.forEach(events, (event) => routeToFlow(event, Slack.SocketSource.idempotencyKey(event)))
)
```

Replace `routeToFlow` with your own dispatch, typically `Control.signal` or a
flow start with the idempotency key as its dedupe key.

Admission is fail-closed, in this order: the workspace must be listed; the
conversation must be listed, or be a direct message (`D…`) while
`allowedUserIds` is set; a bot's or this app's own message is refused as an
echo; and when `allowedUserIds` is set the author, or the person who pressed
a button, must be one of them. Everything refused is acknowledged and dropped,
so Slack does not redeliver it.

The envelope is acknowledged only after your handler succeeds. A handler that
fails ends `run` without acknowledging, and Slack delivers the event again. A
redelivery carries the same `slack:<team>:<event id>` key; the source drops
one it already handled in this process, and the durable deduplication is the
key you pass on. Slack's `disconnect` frames reconnect at once; a dropped
connection reconnects after a pause; `link_disabled` ends `run` with
`permission-denied`.

## Reply in the thread, as a role

Durable replies run as actions over a connection. For one app configured from
the environment:

```ts
const connections = Slack.Connections.layerFromEnvironment({ containers: ["*"] })
const actions = Slack.Actions.layer.pipe(Layer.provide(connections))
```

`containers: ["*"]` lets the actions post to any conversation, including an
owner's direct message whose id is not known in advance. List channel ids
instead to confine them.

Inside a flow:

```ts
yield * Slack.Actions.PostMessage.call({
  connectionId: "slack",
  channel: message.channel,
  threadTs: message.ts,
  text: "On it.",
  key: `${runId}/ack`,
  persona: { username: "Lead", iconEmoji: ":compass:" }
})
```

`persona` shows the post under that name and icon; it needs
`chat:write.customize`. `key` is stamped into the message metadata. The post
is irreversible and Slack takes no idempotency key, so a post whose answer
was lost fails with `outcomeUnknown: true` and is not repeated. Before
posting again, run `Slack.Actions.Reconcile` with the same key: only
`absent` makes a resend safe; `inconclusive` means the page budget ran out.

## Ask for approval with buttons

```ts
const token = Slack.Approval.token(`${runId}/merge`)

yield * Slack.Actions.PostMessage.call({
  connectionId: "slack",
  channel,
  threadTs,
  text: "Merge?",
  blocks: Slack.Approval.blocks({ mode: "approve", token, allowedUserIds: policy.allowedUserIds }),
  key: `${runId}/merge-prompt`
})
```

A press arrives on the same source as an `integration:slack:block_actions`
event. `Approval.pressedToken(payload)` names the prompt it belongs to, and
`Approval.decision(payload, spec)` answers `Decided` only for an allowed
person's press of an offered button; any other press is `Ignored` and the
approval stays pending. Update the prompt afterwards with
`Slack.Actions.UpdateMessage`.

## Credentials from the broker

A host that keeps tokens in the control plane's credential store builds the
connection with `Slack.Connections.fromConnection`: the bot token is the
connection's `credential`, the app token an optional `appCredential`. Each
call resolves its token through `Connection.resolveSecret`, so the host's
`authorize` decision runs before the broker and a revoked credential takes
effect on the next call.

## The Events API door

A host with a public URL can take deliveries over HTTP instead:
`Slack.Webhook.channel({ policy, … })` verifies the `v0` signature and the
timestamp skew before decoding, answers `url_verification`, and derives the
same idempotency keys. Block Kit interactions still need Socket Mode or the
app's interactivity URL.

## Conversation history as records

`Slack.Sync.make({ channel, … })` is a `Core.Sync` adapter over
`conversations.history` and `conversations.replies`. It writes messages as
source records scoped by conversation type, tracks recent threads, and maps
`message_changed` and `message_deleted` events to new versions and
tombstones through `Slack.Sync.eventRecord`.

## Chat threads are backend issues

`Slack.IssueSync` connects the shared backend issue API to this integration.
It owns no messages or runtime. Apply product migrations 38 and 39 and use the existing
issue routes under `/api/repos/{owner}/{repo}/issues`:

| Request                                          | Payload or result                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `POST /`                                         | `{title, kind:"chat", idempotency_key}` creates an owner-private thread.                                     |
| `POST /{number}/comments`                        | `{body, idempotency_key, persona?}` posts a message.                                                         |
| `PATCH /comments/{id}`                           | `{body}` edits a message.                                                                                    |
| `DELETE /comments/{id}`                          | Deletes a message; its delivery identity survives.                                                           |
| `GET /{number}/comments`                         | Cursor pagination, including personas and request keys.                                                      |
| `GET /{number}/events`                           | Paged timeline, including message changes and reactions.                                                     |
| `PUT /{number}/sync`                             | `{provider:"slack", connection_id, scope_id, conversation_id, thread_id?, external_user_id?}` maps a thread. |
| `GET /{number}/sync`                             | Mapping plus `state`, `error`, and unsettled `delivery_id`.                                                  |
| `PUT /sync/channels`                             | `{provider:"slack", connection_id, scope_id, conversation_id, external_user_id?}` admits new Slack roots.    |
| `GET/PUT /{number}/comments/{comment}/reactions` | Read attribution; write `{name,active}`.                                                                     |

Chat issues retain repository authorization and are visible only to their
authenticated author. Repository search, jobs, watchers, mentions,
change links and external issue integrations do not expose them. Comment facts
in the existing state feed are additionally filtered by their stored private
owner, including deletion receipts. Persona is
display attribution, never authorization. RPC and app seams expose these fields
through existing issue cards and persisted transitions. The host/UI composes
the main chat views. A writable selected repository is required for app chat.

Each Slack root maps to an issue, each message to a comment. Configure DM
admission with `conversation_id:"direct"` and `external_user_id` before the channel is
known. A DM maps to one private issue per connection, workspace, user and
channel. An explicit DM mapping also requires `external_user_id`. Settings contain
routing identities; secrets remain in the connection credential broker.

Register `IssueSync.Post`, `Update`, `Delete`, `React`, and `Reconcile` with the
host's existing Flow runtime and `Slack.Actions.layer`. Supply their bound
`execute` methods as the adapter's executor; retain the provided execution ID.
The runtime must be durable: a claim held for over 10 minutes is re-executed
under that ID, which replays the journaled result instead of posting again.
The `request` port calls the backend authenticated as the issue owner:

```ts
const sync = Slack.IssueSync.make({
  owner,
  repo,
  connectionId: connection.id,
  policy,
  request,
  execute,
  onMessage: async ({ issueId, event }) => {
    await dispatchIssueMessage(issueId, event, event.dedupeKey)
  }
})
const intake = sync.run(Slack.SocketSource.make({ client, policy }))
await sync.drain()
```

Compose intake and repeated drains with the host's existing lifecycle.
`onMessage` runs after the issue transaction commits and before Socket Mode
acknowledges. Its host admission must durably deduplicate `event.dedupeKey`.
This callback wakes the agent conversation without another agent loop.

Events the backend refuses, such as an unmapped channel or a disallowed user,
are acknowledged and return `"ignored"`.

Outgoing changes have PostgreSQL claims and random reconcile keys. Lost answers
remain `outcome_unknown`; restart searches metadata and never blindly reposts.
An absent lookup cannot prove a crashed request is no longer in flight, so it
also retains the unknown claim. Delivery reads use ascending batches of100
with `after_id`; the adapter follows every page so earlier unresolved work
does not hide independent conversations. A known refusal is `failed`; an explicit
`PUT /sync/deliveries/{id}` with `{state:"pending"}` retries only that state.
Deleted comments retain request-key tombstones and external message links.

Enable `message.channels`, `message.groups`, `message.im`, `reaction_added`, and
`reaction_removed` for the conversation types being mirrored, plus corresponding
history scopes for reconciliation. `app_mention` is accepted too. Slack limits
bots to editing/deleting messages their credential may change. Outbound reactions
belong to the bot. Missing `reactions:write` produces `unsupported` and permits
subsequent messages. See Slack's [delete permissions](https://docs.slack.dev/reference/methods/chat.delete/)
and [reaction scopes](https://docs.slack.dev/reference/methods/reactions.add/).

## Issue sync verification

`test/SlackIssueSync.test.ts` covers ingress, echoes, lost responses, restart
reconciliation and host dispatch identities. Backend `TestIssueSlackDurableRoundTrip`
uses real isolated PostgreSQL for atomic ingress, edits, deletions and claims.

Opt-in backend `TestIssueSlackLive` invokes `test/SlackIssueLive.ts`. Supply
`SMITHERS_SLACK_LIVE=1`, `SMITHERS_SLACK_ENV_FILE`, `SMITHERS_SLACK_LIVE_TEAM`,
`SMITHERS_SLACK_LIVE_CHANNEL`, `SMITHERS_SLACK_LIVE_USER`, and the normal test DB
URL. It creates only a thread marked “sync test” and never logs tokens. Human
reply/edit/delete receipts are distinct from outbound bot evidence. Without
those receipts, the live test fails by default. Set
`SMITHERS_SLACK_LIVE_HUMAN_REQUIRED=0` only for an explicitly outbound-only check;
it does not establish a human round trip. `SMITHERS_SLACK_LIVE_THREAD_TS` reuses
an existing test thread and `SMITHERS_SLACK_LIVE_WAIT_MS` sets the human wait.
The runner also records an explicit unsupported receipt when reaction scope
is missing.

Both Slack and Telegram use `core/IssueSync` and the connector-neutral
`/issues/sync` API. Mapping keys are `provider:"slack"`, `connection_id`,
`scope_id` (workspace), `conversation_id` (channel), `thread_id` (timestamp), and
`external_user_id`. Canonical events and receipts use `message_id`; the transport
uses `/sync/events` and `/sync/deliveries`. Migration 38 creates the generic
`issue_sync_*` and `issue_external_*` tables directly; migration 39 adds comment
facts to the existing journal.

`GET …/issues/{number}/comments?idempotency_key=<key>` looks up the authenticated
comment author's request, returning the current comment, 404 for an unknown key,
or 409 for a deleted key. `GET …/issues/state-events` and its `/stream` SSE route
now include `issue_comment` facts (`created`, `updated`, `deleted`). The post-image
contains persona and request key; deletion has only identity. Persist the page
cursor when consuming owner-filtered pages: hidden positions are skipped. Comment
coverage begins with the comment-facts migration, so list existing comments for
an initial snapshot. The underlying issue journal continues its existing history.

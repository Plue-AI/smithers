---
title: "Telegram"
description: "Configure the Telegram adapter: bot token, smart sends with chunking and fallback, the long-poll source with durable cursors, inline-keyboard approvals, Mini App initData, and the send action."
sidebar:
  order: 3
---

How to wire the Telegram adapter into a host application. Each section is a
recipe; the [API reference](../api.md) has the full signatures.

## Configure the bot token

The client and the source read the token from explicit configuration first,
then `SMITHERS_TELEGRAM_BOT_TOKEN`.

```bash
export SMITHERS_TELEGRAM_BOT_TOKEN=TOKEN
```

Replace `TOKEN` with the token from BotFather. Building a client or source
without a token throws `SmithersError` with code `INVALID_INPUT`, naming the
two ways to supply one. The token appears in the Bot API request path, so the
client strips it from every error it raises, including a transport error that
quotes the URL.

## Send messages

`sendMessageSmart` is the send path. It chunks at Telegram's 4096-character
limit on paragraph, sentence, and word boundaries, converts standard markdown
to MarkdownV2, and resends a chunk as plain text when Telegram rejects the
entities, so a formatting failure costs formatting rather than the message.

```ts
import { Telegram } from "@smthrs/integrations"
import { Effect } from "effect"

const client = Telegram.TelegramClient.make({})

const program = Effect.gen(function*() {
  const sent = yield* client.sendMessageSmart(chatId, "**Run finished.** Details: [journal](https://example.com)")
  return sent.messageIds
})
```

Replace `chatId` with a numeric chat id or an `@channel` username.

`SendOptions`: `parseMode` (the default `markdown` converts; `MarkdownV2` and
`HTML` send as-is; `none` sends raw text), `replyToMessageId` (first chunk
only), `messageThreadId` (every chunk, for forum topics), `inlineKeyboard`
(last chunk only), `typing` (a typing action before the first chunk, on by
default and never fatal), and `disableNotification`.

The result names every chunk it sent: `messageIds` in send order,
`chunkCount`, and `usedPlainTextFallback`. A failure after earlier chunks
landed is not silent: the `TelegramApiError` carries `deliveredMessageIds`,
the ids the chat already shows, so a resend decision is made against what the
reader has rather than a guess.

Also on the client: `editMessageSmart` (same fallback, so fresh content
replaces a stale message), `sendDocument` (URL, `file_id`, or raw bytes),
`answerCallbackQuery`, `answerWebAppQuery`, and `call` for any other Bot API
method. A 429 is retried, waiting the server's `retry_after` capped at 30
seconds by default.

## Poll for updates

Telegram bots that cannot receive webhooks long-poll `getUpdates`.
`Telegram.Source` is that poll, with the safety contract in the right place:
confirming an offset tells Telegram to forget those updates, so the cursor is
committed only after your handler has processed the batch. A process that
dies mid-batch re-polls it, and the redelivery is dropped downstream on the
event's dedupe key.

```ts
import { Core, Telegram } from "@smthrs/integrations"
import { Effect } from "effect"

const source = Telegram.Source.make({ allowedChatIds: [chatId] })

const program = source.run((events) =>
  Effect.gen(function*() {
    for (const event of events) {
      // route the event: start a flow, signal a run, queue a notification
    }
  })
).pipe(Effect.provide(Core.CursorStore.layerMemory))
```

`run` returns `Effect<void, IntegrationError | E, R | CursorStore>`.
The default schedule polls forever with 250 milliseconds between turns. A transient `getUpdates` failure (a network error, a timeout, an exhausted 429, or a Bot API 5xx) is logged and retried with exponential backoff from 250 milliseconds up to 30 seconds, so it never ends `run`. A permanent failure such as a 401, an unusable cursor, or an undecodable batch still fails `run`.
Pass `{ schedule }` as the second argument to change the schedule. A
caller-supplied finite schedule ends polling normally and succeeds with
`undefined`, discarding the schedule's result.

Replace `chatId` with the chat the bot serves. `allowedChatIds` is required
and must be non-empty; missing or empty configuration throws `invalid-config`
before the source polls. Updates from other chats and updates whose chat the
source cannot determine are dropped: an allowlist that admits what it
cannot classify is not one. The offset still advances past every dropped
update once the rest of the batch is handled.

`layerMemory` keeps the cursor for the life of the process. For a source that
must survive restarts, use `Core.CursorStore.layerSql` over
`Core.Migrations.layer`, which applies the `smithers_integration_cursors`
table migration through [the database API](/api/database)'s ladder. A stored
cursor that does not parse as an offset fails the poll with `invalid-config`
rather than replaying Telegram's whole retained backlog.

Each delivered event carries one correlation: `chat:<id>`, or
`chat:<id>:thread:<id>` for a forum topic, which emits a second,
thread-scoped event with its own dedupe key. `Telegram.Source.idempotencyKey(event)`
returns the event's dedupe key for a host that routes these events through
`Channels.ingest`. Source options: `sourceId` (the cursor key and dedupe
scope), `pollTimeoutSeconds` (defaults to 25), `allowedUpdates`, and `client`
for an already-built client.

## Ask for approval with an inline keyboard

`Telegram.Approval` is the codec behind approve/reject and selection prompts.
Telegram caps `callback_data` at 64 bytes, so a press carries a compact code
and nothing else. It also carries no trust: any member of the chat can press
a button. `decision` resolves a press only when its `from.id` is in the
spec's `allowedChatIds`, compared as strings. Missing or empty lists authorize
nobody, even when the callback token matches. Pass the same allowlist to the
source and the approval spec. Include individual user ids for approvers; a
negative group chat id admits that chat but does not authorize its members.

```ts
import { Telegram } from "@smthrs/integrations"

const approvalToken = Telegram.Approval.token(approvalId)
const allowedChatIds = [chatId, approverUserId]
const spec: Telegram.Approval.KeyboardSpec = { mode: "approve", token: approvalToken, allowedChatIds }
const keyboard = Telegram.Approval.keyboard(spec)

// send the prompt with the keyboard attached
const sent = yield* client.sendMessageSmart(chatId, "Deploy?", { inlineKeyboard: keyboard })

// later, when a callback_query event arrives
const outcome = Telegram.Approval.decision(callbackQuery, spec)
if (outcome._tag === "Decided") {
  // resolve the approval from outcome.decision.approved
}
// an Ignored outcome leaves the approval pending
```

Replace `approvalId` with a stable id for the prompt, and `callbackQuery`
with the delivered callback query payload.

The token namespaces the prompt's buttons. Only an authorized press of an
option this prompt offered returns `Decided`. Every other press returns
`Ignored` with a `reason` and must leave the approval pending:
`foreign-prompt` for another prompt's token or unrecognized data,
`unauthorized` for an unlisted sender, and `unknown-option` for a choice this
prompt never offered. A prompt built with no token matches nothing at all, so
two tokenless prompts cannot resolve each other. The token is a 32-bit
namespace, not a secret; two approval ids can collide. `isOwnPress` checks
only the prompt token; `decision` also checks the sender.

In `select` mode, pass `options: [{ key, label }, ...]`. `keyboard` throws
`INVALID_INPUT` for an empty option list, and `callbackData` throws for an
option key that is empty, contains a colon, or pushes the data past 64 bytes.

## Verify Mini App initData

`initData` is the signed query string a Mini App exposes as
`window.Telegram.WebApp.initData`. Verify it before trusting the user;
`initDataUnsafe` on the Telegram side is named that for a reason.

```ts
import { Telegram } from "@smthrs/integrations"

const data = await Telegram.InitData.verifyWithBotToken(initData, botToken)
console.log(data.user?.id)
```

Replace `initData` with the query string from the Mini App and `botToken`
with your token. The promise resolves with the parsed fields or rejects:
`TELEGRAM_INIT_DATA_INVALID` for a bad, stale, or future-dated payload,
`INVALID_INPUT` for a missing token or bad options, and `UNSUPPORTED` when
the runtime has no Web Crypto.

Freshness is bounded at both ends. `maxAgeSeconds` defaults to 3600, `0`
disables the age check, and anything above 86400 is a configuration error. A
correctly signed `auth_date` dated far ahead is refused as well.

For a third party that must authenticate a Mini App user without holding the
bot token, `verifySignature(initData, botId)` checks Telegram's Ed25519
signature against the production public key. Pass
`publicKeyHex: Telegram.InitData.ED25519_PUBLIC_KEY_TEST` against the test
datacenter. `Telegram.InitData.parse` reads the fields without verifying;
verification is what makes them trustworthy.

## Send a message from a flow

`Telegram.Actions.SendMessage` makes a send a durable step, so a restart
replays the recorded message ids instead of sending the text twice.

```ts
import { Telegram } from "@smthrs/integrations"

const body = (input: typeof Telegram.Actions.SendMessagePayload.Type) => Telegram.Actions.SendMessage.call(input)
```

`chatId` is a string in the payload, because Telegram uses both numeric ids
and `@channel` usernames, and a numeric id exceeds the range JSON round-trips
exactly. Wire it like the GitHub action in the
[quickstart](../quickstart.md), with `Telegram.Actions.layer` and
`Telegram.TelegramClient.layer({})`.

Two properties matter at the journal. The step is not atomic: text over the
limit is several `sendMessage` calls, and a partway failure journals
`deliveredMessageIds`, the chunks the chat already shows. And Telegram
failures keep their classification across the journal: an exhausted rate
limit reads `retryable: true`, a chat that does not exist reads
`decode-failed`, and a blocked bot reads `permission-denied`.

A response body read failure after success headers is `delivery-failed`.
For writes it carries `outcomeUnknown: true`: Telegram may have applied the
request before the connection failed. A fully received malformed success
body is `decode-failed`. Multi-chunk failures preserve this classification
and name the messages already delivered in `deliveredMessageIds`.

## Mirror issue conversations

`Telegram.IssueSync` and `Slack.IssueSync` are connectors over
`core/IssueSync`: the same authenticated issue API, PostgreSQL delivery claims,
receipt states and host-scheduled drain. Neither connector starts a worker or
stores another copy of messages.

Configure routing in product settings through the owner's issue API:

```json
{
  "provider": "telegram",
  "connection_id": "telegram-main",
  "scope_id": "123456",
  "conversation_id": "-1001234567890",
  "thread_id": "7",
  "external_user_id": "42"
}
```

`scope_id` is the bot's numeric ID; `conversation_id` is the numeric chat ID;
`thread_id` is an optional forum topic ID. Omit the topic for a whole chat.
`external_user_id` optionally restricts ingress to one sender. Persist admission
with `PUT /api/repos/{owner}/{repo}/issues/sync/channels`. A configured topic
admits only that topic; omission admits the whole chat and its topics. Attach an existing
private issue with `PUT …/issues/{number}/sync`. Each chat or topic maps to one
issue, including replies. The mapping is immutable and one connector destination
is supported per issue. No credentials enter these settings or flow payloads.

Register `Telegram.IssueSync.Post`, `Update`, and `Delete` in the existing host's
durable engine, using `Telegram.Actions.layerIssueSync(resolveClient)`.
`resolveClient(connectionId, chatId)` checks the configured connection's provider,
principal and containers through `Core.Connection`, resolves its token through
`Core.Connection.resolveSecret`, and returns the existing `TelegramClient`.
Build that client with explicit credentials and an empty environment, so ambient
credentials cannot select another bot. The resolver runs at dispatch time.

```ts
const sync = Telegram.IssueSync.make({
  owner,
  repo,
  connectionId: connection.id,
  botId,
  allowedChatIds: [chatId],
  allowedUserIds: [userId],
  request,
  runtime,
  onMessage: ({ issueId, event }) => admitMessage(issueId, event, event.dedupeKey)
})
const intake = sync.run(source)
await sync.drain()
```

`runtime` is the registered `FlowRuntime` service from `EngineStore.layer`
(or `NodeRuntime`/`BunRuntime`) over persistent storage. Construction refuses
`FlowEngine.layerMemory` or an unmarked runtime. The connector preserves the
claim's execution identity: a claim held for over
10 minutes is re-executed under that identity, which replays the journaled
result instead of sending again. `request` is authenticated as the issue owner.
Events the backend refuses, such as an unmapped chat, are acknowledged and
return `"ignored"`.
Use the existing Source with its SQL cursor store. Admission is checked again
at the connector; bot messages never become comments. Chat and topic variants
of one update share a canonical key. The backend atomically deduplicates updates
with the comment change. Same-second edits use the source update ID to break
ties. The host must also deduplicate `onMessage` admission by `event.dedupeKey`.

Personas appear as a name line in the message text, since ordinary bots cannot
select a different sender per message. Long comments retain all chunk IDs.
Edits update, add or remove chunks; deletion removes every known chunk subject
to Telegram permissions and time limits. Partial changes and unreadable success
receipts stay `outcome_unknown`, including the known chunk IDs. Restart never
reposts them. Telegram has no arbitrary-message history lookup or send request
key: confirming delivery as sent requires actual provider or durable flow evidence.

Ordinary Bot API updates do not report message deletions, so deleting a human
message in Telegram cannot delete its issue comment. Business-account deletion
updates are a separate integration capability. Reactions currently settle as
`unsupported` ([tracked work](https://github.com/smithersai/smithers/issues/2110)).
The [Bot API reference](https://core.telegram.org/bots/api#update) defines these
provider limits; fixture tests are not a live Telegram receipt.

The issue card's **Resolve** action lets its owner mark an unconfirmed delivery
sent with message IDs and evidence, skip it with a reason, or explicitly retry
accepting duplicate risk. Each action resolves one delivery through the existing
receipt endpoint and records evidence in the issue history. Skipped deliveries
remain visible and allow later comments to proceed.

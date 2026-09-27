---
title: "Troubleshooting"
description: "The failure modes @smthrs/integrations raises: credentials, webhook verification, reconciliation conflicts, write ambiguity, and polling cursors."
---

Every failure an integration raises carries a machine-readable handle. Effect
calls fail with an `IntegrationError` whose `reason` classifies the failure;
durable actions journal an `IntegrationFailure` with the same `reason` plus
`retryable`, and sometimes `outcomeUnknown` or `deliveredMessageIds`. Branch
on those fields, not on message text. The [API reference](./api.md) lists
every reason.

This page covers the failure modes the package actually raises, grouped by
where they surface.

## Credentials

### `credentials-missing` on a client call

A call that needs a credential found none. The Linear client fails its first
`query` this way when neither `config.apiKey` nor `SMITHERS_LINEAR_API_KEY`
is set. Set the documented variable or pass the field explicitly.

### `INVALID_INPUT`: "No Telegram bot token configured"

`TelegramClient.make` or `Source.make` threw at construction time. Pass
`botToken` in config or set `SMITHERS_TELEGRAM_BOT_TOKEN`. This is a throw,
not an Effect failure, because a missing token is a bug in the caller, not a
runtime condition.

### A call ran as the wrong account

Every `make` and `layer` takes an `env` argument that replaces the ambient
environment rather than layering over it. If you pass a partial record
expecting the ambient variables to fill the gaps, they do not: an ambient
`GITHUB_TOKEN` is invisible to a call built with an explicit `env`. Pass the
whole record the call should see, or omit the argument to use the host
environment.

## Webhook ingress

### Deliveries fail `Unauthorized`

The signature did not verify. The two common causes are a wrong secret and a
re-serialized body: the signature covers the exact delivered bytes, so
parsing the JSON and stringifying it again before verification breaks every
check. Hand `Channels.ingest` the raw request body. For Linear, the same
refusal covers a stale `webhookTimestamp`: the freshness window defaults to
60 seconds around the receiving clock, so check clock skew on the host, and
widen `maxTimestampSkewMs` only within the one-hour cap.

### Deliveries fail `InvalidInput` after verifying

The provider's own headers or payload are missing or unreadable, which in
practice means something other than the provider is POSTing to the endpoint.
Check what is actually sending the traffic.

### Redeliveries start second flows

The `RawInbound` reached `ingest` without an `idempotencyKey`. Nothing
derives one for you. Build the key with the provider's helper:
`Linear.Webhook.idempotencyKey(raw, payload)` or
`Telegram.Source.idempotencyKey(event)`.
[How adapters sit on the control plane](./concepts/control-plane.md) shows
the wiring.

## Writes and ambiguous outcomes

### `outcomeUnknown` is set on a failure

A 5xx or a dropped connection interrupted a write, and the provider may have
applied it and lost the answer. Neither the engine nor the client repeated
the call, on purpose. "This did not happen" and "nobody knows" are different
answers; this one is the second. Check the provider (does the comment exist?
was the issue filed?) before running the step again. For a partially
completed Telegram send, `deliveredMessageIds` names the chunks the chat
already shows.

### A Telegram send lost its formatting

`usedPlainTextFallback` came back `true`. Telegram rejected the converted
markup's entities on at least one chunk, so that chunk was resent as plain
text. The message arrived; only the formatting was lost. Simplify the markdown
near constructs `Telegram.Markdown.toTelegram` does not convert, or send with
`parseMode: "none"`.

### A paginated GitHub result is `truncated`

The page budget ran out with more pages outstanding, so `items` is a prefix
of the resource. Raise `maxPages` (at most 1000) or narrow the query. Never
reconcile against a truncated list: you would plan work for resources you did
not see.

## Linear names and ids

### `decode-failed`: over-specified

The client refuses ambiguous input rather than guessing: `teamKey` with
`teamId`, `stateName` with `stateId`, or `labels` with `labelIds`. Pass one
form. Passing neither team field fails the same way, because the team is
required.

### `decode-failed`: a state or label was not found

The message names the known states or the missing labels for the team. The
lookup caches are per client, so a state created mid-run needs a new client
to be seen.

## Telegram polling and approvals

### `invalid-config`: the stored cursor is not an update offset

A cursor the source cannot parse fails the poll rather than being dropped,
because dropping it would send `getUpdates` with no offset and replay
Telegram's whole retained backlog. Inspect the
`smithers_integration_cursors` row for the source and repair or clear it.

### The source receives nothing, or receives other chats

`allowedChatIds` is required: `Source.make` throws `invalid-config` when it is
missing or empty, so a source that polls at all has an allowlist. Updates from
chats outside it are dropped, and so is an update whose chat the source cannot
determine, such as a button press on an inaccessible message. That is the
allowlist failing closed. A silent source means the chat id is not in the list,
or the update kind is not in `allowedUpdates`: the default set is `message`,
`edited_message`, and `callback_query`.

### An approval prompt never resolves

A prompt built without a token matches nothing at all, by design, so two
tokenless prompts cannot resolve each other. Give the spec a
`Telegram.Approval.token(id)`. In `select` mode, a press on a key the spec
did not offer resolves to an empty selection.

### `TELEGRAM_INIT_DATA_INVALID`, `UNSUPPORTED` from `InitData`

The payload failed verification: a bad HMAC or Ed25519 signature, a stale
`auth_date`, or a date too far in the future. `UNSUPPORTED` means the runtime
has no Web Crypto or no Ed25519; run on a supported Node. `INVALID_INPUT`
means the arguments, not the payload: a missing token or bot id, a
`maxAgeSeconds` outside 0 to 86400, or a malformed `publicKeyHex`.

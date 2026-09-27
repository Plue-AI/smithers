---
title: "Linear"
description: "Configure the Linear adapter: API key, the name-resolving GraphQL client, verified webhook ingress with the replay window, and the create-issue action."
sidebar:
  order: 2
---

How to wire the Linear adapter into a host application. Each section is a
recipe; the [API reference](../api.md) has the full signatures.

## Configure the API key

The client reads its key from explicit configuration first, then
`SMITHERS_LINEAR_API_KEY`.

`Linear.Config.resolve` reads `SMITHERS_LINEAR_WEBHOOK_SECRET` when no
explicit secret is supplied. The webhook channel requires an explicit secret
resolver: the host must pass the resolved non-empty `webhookSecret` through
`Core.Channel.constantSecret`, or use `Core.Channel.credentialSecret` with
its credential store.

```bash
export SMITHERS_LINEAR_API_KEY=KEY
export SMITHERS_LINEAR_WEBHOOK_SECRET=SECRET
```

Replace `KEY` with a personal API key and `SECRET` with the webhook signing
secret. A personal key is sent raw in the `Authorization` header; an OAuth
token arrives already prefixed. The key reaches that header and nothing else.

As with every client in this package, an `env` record passed to `make`,
`layer`, or `resolve` replaces the ambient environment rather than layering
over it.

## Write names, not ids

Linear's mutations take ids. Humans and workflows write `ENG`, `In Progress`,
`bug`, and `ENG-123`. `LinearClient` resolves the names into ids and caches
every lookup per client, so a workflow that touches ten issues on one team
resolves its team, states, and labels once.

```ts
import { Linear } from "@smthrs/integrations"
import { Effect } from "effect"

const client = Linear.LinearClient.make({})

const program = Effect.gen(function*() {
  const issue = yield* client.createIssue({
    teamKey: "ENG",
    title: "Triage the new webhook",
    stateName: "In Progress",
    labels: ["bug"],
    priority: "high"
  })
  return issue.url
})
```

The rules the resolver enforces:

- Exactly one of `teamKey` and `teamId` is required. Supplying both fails
  `decode-failed` rather than silently filing on the team `teamId` names.
  Team keys are matched case-insensitively.
- Supply `stateName` or `stateId`, and `labels` or `labelIds`, not both.
  Both fail `decode-failed`. An empty `labels` array clears the issue's
  labels; omitting the field leaves them alone.
- `priority` accepts a number from 0 to 4 or a name: `none`, `urgent`,
  `high`, `normal`, `medium`, `low`.

`updateIssue(idOrIdentifier, fields)` takes the same fields and accepts an
`ENG-123` identifier or a UUID. `commentOnIssue(idOrIdentifier, body)` does
the same. `getIssue` fetches by either form. `query(gql, variables)` is the
raw GraphQL escape hatch, resolving with the `data` payload.

## What gets retried, and what does not

A 429 is retried up to five attempts for every operation, waiting
`Retry-After` or `X-RateLimit-Requests-Reset` capped at 30 seconds. A refused
request was not performed, so repeating it is safe.

Only received 429 and query 5xx responses are retried. Fetch rejections and
response body read failures are not retried, including on queries.
Unread response bodies are cancelled before retry backoff or failure.

A 5xx is not retried on `issueCreate`, `issueUpdate`, or `commentCreate`.
Linear may have applied the mutation and lost the answer. These failures,
fetch rejections, and body read failures after success headers report
`outcomeUnknown: true` in `details` for writes. Check Linear before running
the step again. A fully received malformed JSON body is `decode-failed`.

## Receive webhooks

Linear signs the raw body with HMAC-SHA256 and sends the bare hex digest in
`Linear-Signature`. Verification also checks the `webhookTimestamp` inside
the body against a freshness window, because a valid signature never expires
and a captured delivery would otherwise be replayable forever. The window
defaults to 60 seconds, is bounded at both ends, and is capped at one hour; a
skew of `Infinity` would disable the check, so such a value is refused rather
than honored.

Register the channel with `Channels` and hand every incoming POST to
`Channels.ingest`. The example uses a Node HTTP server with a 1 MiB
(1,048,576 byte) body limit. It counts streamed bytes before ingestion,
including chunked requests, and responds 413 above the limit. It stops
reading, clears buffered chunks, and destroys the request after flushing the
response. Aborted and failed requests also release their buffered chunks. Any
transport must bound the raw body before calling `Channels.ingest`.

```ts
import * as Channels from "@smthrs/control/Channels"
import { Core, Linear } from "@smthrs/integrations"
import { Effect, Redacted } from "effect"
import { createServer } from "node:http"

const channel = Linear.Webhook.channel({
  credential: Redacted.make({ id: "linear-webhook", name: "linear-webhook" }),
  secret: Core.Channel.constantSecret(Redacted.make(webhookSecret)),
  route: Core.Channel.startFlow("triage")
})

const maxBodyBytes = 1024 * 1024
const server = createServer((request, response) => {
  const chunks: Array<Uint8Array> = []
  let receivedBytes = 0
  let stopped = false
  const discard = () => {
    stopped = true
    chunks.length = 0
  }
  request.on("aborted", discard)
  request.on("error", () => {
    discard()
    response.destroy()
  })
  request.on("data", (chunk: Uint8Array) => {
    if (stopped) return
    receivedBytes += chunk.byteLength
    if (receivedBytes > maxBodyBytes) {
      discard()
      request.pause()
      response.writeHead(413, { Connection: "close" }).end(() => request.destroy())
      return
    }
    chunks.push(chunk)
  })
  request.on("end", () => {
    if (stopped) return
    const body = Buffer.concat(chunks)
    discard()
    let payload: unknown
    try {
      payload = JSON.parse(body.toString("utf8"))
    } catch {
      payload = undefined
    }
    const program = Effect.gen(function*() {
      const channels = yield* Channels.Channels
      const raw = {
        body,
        headers: request.headers as Record<string, string | undefined>
      }
      return yield* channels.ingest({
        channel: "linear",
        raw: { ...raw, idempotencyKey: Linear.Webhook.idempotencyKey(raw, payload) }
      })
    })
    Effect.runPromise(Effect.provide(program, channelsLayer)).then(
      () => response.writeHead(200).end(),
      () => response.writeHead(401).end()
    )
  })
})
```

Replace `webhookSecret` with the non-empty secret from
`Linear.Config.resolve().webhookSecret`, and `channelsLayer` with the layer
that provides `Channels` over your control plane (see
[the control API](/api/control)).

Three details are load-bearing:

- The body is the exact bytes Linear sent. The signature covers those bytes,
  so parsing first and re-serializing breaks verification.
- `Linear.Webhook.idempotencyKey(raw, payload)` reads the `Linear-Delivery`
  header and falls back to the delivery's own identity (webhook id, entity,
  action, and timestamp) when the header is absent. `ingest` drops a replayed
  key, which is what makes a redelivery safe to accept. Leave it unset and a
  redelivery starts a second flow.
- A refused delivery fails `Unauthorized` before the decoder or the control
  plane runs. Only the refusal crosses; the digest detail stays in the log.

A stale or unsigned delivery fails `Unauthorized` before anything downstream
runs. To widen the window for a slow clock, pass `maxTimestampSkewMs` on the
channel options; values above one hour are refused.

## File an issue from a flow

`Linear.Actions.CreateIssue` files an issue as a durable step, so a restart
replays the recorded issue instead of filing a second one.

```ts
import { Linear } from "@smthrs/integrations"

const body = (input: typeof Linear.Actions.CreateIssuePayload.Type) => Linear.Actions.CreateIssue.call(input)
```

The payload schema carries `title` plus optional `teamKey`, `teamId`,
`description`, `stateName`, and `labels`; the client resolves the names and
enforces the same either-or rules as a direct call. Wire it exactly like the
GitHub action in the [quickstart](../quickstart.md), with
`Linear.Actions.layer` and `Linear.LinearClient.layer({})` in place of the
GitHub layers. Failures journal as `Core.ActionFailure.IntegrationFailure`;
`outcomeUnknown` means Linear may have created the issue, so search for the
title before filing again.

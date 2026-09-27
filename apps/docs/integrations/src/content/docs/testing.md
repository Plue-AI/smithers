---
title: "Testing"
description: "Test code that uses the GitHub, Linear, and Telegram adapters: a real fixture server instead of a mock, a signed webhook delivery, an in-memory cursor, and a flow run with no durability."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/integrations/docs/testing.md"
---

Every seam this package exposes is testable without a mocking library and
without a live credential. Each client takes an API base URL, so you point it
at an HTTP server you started. Each webhook verifier takes the exact bytes and
the secret, so you sign a delivery yourself. Each polling source takes a
cursor store, so you hand it the in-memory one.

## Point a client at a fixture server

The clients speak HTTP to whatever origin they are configured with. Start a
`node:http` server on an ephemeral port, pass its origin as `apiBaseUrl`, and
assert on the requests it received:

```ts
import { GitHub } from "@smthrs/integrations"
import { Effect, Schema } from "effect"

const client = GitHub.GitHubClient.make(
  { token: "test-token", apiBaseUrl: fixtureOrigin },
  {}
)

const viewer = await Effect.runPromise(
  client.request("GET", "/user", undefined, { schema: Schema.Struct({ login: Schema.String }) })
)
```

Replace `fixtureOrigin` with your server's origin, for example
`http://127.0.0.1:53421`.

The second argument, `{}`, is the environment the client sees. It replaces the
ambient environment rather than layering over it, so an ambient `GITHUB_TOKEN`
on the developer's machine or on CI cannot leak into the run and decide which
account the test authenticates as. Pass `{}` in every test, even when you also
pass an explicit token.

`Linear.LinearClient.make` takes the same pair, with `apiBaseUrl` reading
`SMITHERS_LINEAR_API_BASE_URL`. `Telegram.TelegramClient.make` takes
`apiBaseUrl` too, so a fixture stands in for `api.telegram.org`.

A fixture server also lets you test the paths that are hard to provoke
against a real API: a 429 with a `Retry-After` header proves the retry
schedule, a 500 on a POST proves the client reports `outcomeUnknown` instead
of repeating the write, and a `Link: rel="next"` header proves pagination
stops at `maxPages` and reports `truncated`.

## Sign a webhook delivery

`Core.Signature.computeHmacSha256Hex` is the signing half of the verifier, and
it is public so your tests can produce a delivery the adapter accepts:

```ts
import { Core, Linear } from "@smthrs/integrations"

const secret = "shared-secret"
const text = JSON.stringify({
  action: "update",
  type: "Issue",
  data: { id: "issue-uuid", identifier: "ENG-123", team: { key: "ENG" } },
  webhookId: "hook-1",
  webhookTimestamp: Date.now()
})

const raw = {
  body: new TextEncoder().encode(text),
  headers: {
    "linear-delivery": "delivery-1",
    "linear-signature": Core.Signature.computeHmacSha256Hex(text, secret)
  }
}
const delivery = { ...raw, idempotencyKey: "linear:delivery-1" }

Linear.Webhook.verify(delivery, secret) // true
const event = Linear.Webhook.decode(delivery, JSON.parse(text))
```

In an ingress the key comes from `Linear.Webhook.idempotencyKey(raw, payload)`,
which returns exactly `linear:<Linear-Delivery>` when the header is present;
a test that writes the literal keeps the delivery it controls readable.

Sign the same bytes you send. Signing a string and then delivering a
re-serialized copy of the parsed object is the mistake the verifier is built
to catch, and a test that makes it fails the way production would.

Two negative cases are worth writing once per ingress: a delivery signed with
the wrong secret, which must not verify, and the same delivery submitted
twice, which `Channels.ingest` must drop on the repeated `idempotencyKey`.
For Linear, add a third: a `webhookTimestamp` outside the freshness window.

## Run a polling source without a database

`Core.CursorStore.layerMemory` keeps the cursor for the life of the process,
which is exactly one test. Provide it in place of `layerSql` and the source
needs no database and no migration:

```ts
import { Core, Telegram } from "@smthrs/integrations"
import { Effect } from "effect"

const program = source.run(handleBatch).pipe(Effect.provide(Core.CursorStore.layerMemory))
```

Replace `source` with a `Telegram.Source.make(...)` pointed at a fixture
origin, and `handleBatch` with the handler under test. Because the store is
real and only its backing is in memory, the ordering contract still holds: the
cursor is committed after the batch is handled, so a handler that fails leaves
the offset where it was and the next poll returns the same batch.

## Run an action without durability

An action is a flow step, so testing one means running a flow.
`FlowEngine.layerMemory` from [the engine](https://engine.smithers.sh/reference/api/) executes the plan with
no journal and no database, which is what a unit test wants:

```ts
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { GitHub } from "@smthrs/integrations"
import { Layer } from "effect"

const layer = Layer.mergeAll(GitHub.Actions.layer, Interpreter.layer(CommentFlow)).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(
    Layer.mergeAll(
      FlowEngine.layerMemory,
      GitHub.GitHubClient.layer({ token: "test-token", apiBaseUrl: fixtureOrigin }, {})
    )
  )
)
```

Replace `CommentFlow` with the flow under test and `fixtureOrigin` with your
server's origin. The [quickstart](/quickstart/) shows the full composition,
including the crypto layer a real run needs.

To assert on a journaled failure rather than a success, have the fixture
answer the write with a 500 and check the fields of the
`Core.ActionFailure.IntegrationFailure` the step produces: `reason`,
`retryable`, and `outcomeUnknown`. Those fields are the contract an operator
reads after a restart, so they are worth asserting on directly rather than
through message text.

## Check against the live API

Fixtures prove your wiring. They cannot prove the provider still serves the
shape the fixture imitates. Keep a small number of read-only tests that run
against the real API when a credential is present and skip when it is absent,
and run them on a schedule rather than on every commit. A read-only token is
enough: fetch the authenticated user, read one issue, call `getMe`.

## Related pages

- [Troubleshooting](/troubleshooting/) lists every `reason` an assertion
  can expect.
- [Durable actions](/concepts/durable-actions/) explains what the journal
  records, and why `outcomeUnknown` crosses it.

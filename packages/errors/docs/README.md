---
title: "@smthrs/errors"
description: "One error class and five closed codes for the Smithers integration adapters: classify a failure by code, show a person a summary, and log context that carries no credential."
---

`@smthrs/errors` is a single error class, `SmithersError`, and a closed
vocabulary of five codes. Smithers is a durable-execution engine for agent
workflows. Its GitHub adapter raises `SmithersError` when
an integration call fails, and a caller decides what to do by reading
`error.code` rather than by matching on message text.

## Why you would reach for it

One integration failure has three readers, and each needs something different
from it:

- A person needs a sentence naming what to fix.
- Code needs a stable value to branch on, one that survives a reworded message.
- A log needs a record that is safe to keep.

`SmithersError` carries all three at once. `code` is a string literal from a
closed union, which makes an
[explicit exhaustiveness check](./quickstart.md#check-exhaustiveness-explicitly)
possible. With that check, adding a code without a matching case is a type
error. `summary` is the message without the documentation URL the constructor
appends, which is what you put in a chat reply or a form field. `details` is the
context the raise site attached, copied and frozen at construction so it cannot
change under you. Only those fields
serialize: `name` and `stack` stay out of `JSON.stringify`.

The class never redacts. It stores `details` and `cause` exactly as it received
them, so the code that constructs the error removes bot tokens, API keys, and
webhook secrets first.
[The shape of a SmithersError](./concepts/error-shape.md) states that contract
in full.

Reach for this package when you are wrapping somebody else's API and its
failures cross into an HTTP handler, a webhook route, and a log line. For a
failure inside your own code, an Effect `Schema.TaggedError` on the effect that
can fail is the better tool, and
[The closed code vocabulary](./concepts/error-codes.md) explains where Smithers
draws that line.

## Install

At `1.0.0-rc.0` this package is not on npm. It ships inside the Smithers
repository, where `@smthrs/integrations` is its only consumer. Handling a
`SmithersError` you caught needs no install: every field, code, and raise site
is on this site, and the source is
[on GitHub](https://github.com/smithersai/smithers/tree/main/packages/errors).
[Installation](./installation.md) has the dependency declaration, the root
entry point, the two module subpaths, and the paths the exports map refuses.
The package has no runtime dependencies and needs Node.js 26.4.0 or later.

## A small example

A helper refuses an argument, and the caller classifies the refusal without
reading a word of prose:

```ts
import { isSmithersError, SmithersError } from "@smthrs/errors"

const MAX_MESSAGE_LENGTH = 4096

const requireChunkLength = (maxLength: number): number => {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > MAX_MESSAGE_LENGTH) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Chunk maxLength must be an integer between 1 and ${MAX_MESSAGE_LENGTH}.`,
      { maxLength }
    )
  }
  return maxLength
}

try {
  requireChunkLength(0)
} catch (error) {
  if (!isSmithersError(error)) throw error
  error.code // "INVALID_INPUT"
  error.summary // "Chunk maxLength must be an integer between 1 and 4096."
  error.details // { maxLength: 0 }
  Object.keys(error) // ["code", "summary", "docsUrl", "details"]
}
```

`error.code` narrows to the five documented literals. A switch can keep a
fallback or [check exhaustiveness explicitly](./quickstart.md#check-exhaustiveness-explicitly).
[Quickstart](./quickstart.md) shows both forms and runs the same failure the
whole way through, from the raise site to a log line.

## The five codes

`smithersErrorDefinitions` is the runtime table every code is derived from, and
nothing widens it at runtime:

- `INVALID_INPUT`: the call is wrong, and no retry makes it right.
- `INTEGRATION_ERROR`: a provider call, a webhook read, or a listener
  reconciliation failed. `details.reason` says which, and whether to retry.
- `TELEGRAM_API_ERROR` and `TELEGRAM_INIT_DATA_INVALID`: retained for
  historical failure decoding. The Telegram adapter is outside the MVP.
- `UNSUPPORTED`: the runtime lacks a primitive the call needs, such as Web
  Crypto.

[Error code reference](./reference/error-codes.md) names every raise site, the
`details` each one attaches, and the caller's move.

## Where this sits in Smithers

`@smthrs/errors` is the bottom of its own dependency tree. It imports nothing
from Smithers and nothing from npm, so it is a root you can read on its own.
The packages built on top of it are how you get from here into the rest of the
system:

- [`@smthrs/integrations`](/api/integrations) is the only package that depends
  on this one. Its `Core.IntegrationError` carries a classified `reason`.
  Historical error codes remain readable after their adapters are retired.
- Those adapters answer webhooks through the Smithers control plane,
  [`@smthrs/control`](/api/control), and expose their provider calls as durable
  actions built with [`@smthrs/flow`](/api/flow). A durable action is the
  boundary where an error class has to become a schema the journal can store.
- [`@smthrs/cli`](/api/cli) is the `smithers` command line at the top of that
  tree, and the entry point most people meet Smithers through.

## Where to go next

- [Quickstart](./quickstart.md): raise, catch, classify, and log one failure.
- [Handle a failed integration call](./guides/handle-a-failure.md): the
  caller's side, including retries and transport statuses.
- [Raise a SmithersError from an adapter](./guides/raise-an-error.md): the
  raising side, including subclasses and redaction.
- [Detect an error across module copies](./guides/detect-an-error-across-module-copies.md):
  when `instanceof` is not enough.
- [API reference](./api.md): every export with its signature.
- [Troubleshooting](./troubleshooting.md): symptom, cause, and fix.

---
title: "Handle a failed integration call"
description: "Classify a caught failure by code and reason, decide whether to retry, map it onto a transport status, and log it without leaking a credential."
sidebar:
  order: 1
---

You called an integration helper or client and it failed. This guide is the
caller's side: how to classify what you caught, what to do with each class, and
what is safe to write down.

## Narrow before you branch

Integration helpers throw, so wrap the call and refuse to guess about anything
you did not recognize:

```ts
import { isSmithersError } from "@smthrs/errors"

try {
  await send(chatId, text)
} catch (error) {
  if (!isSmithersError(error)) throw error
  // error.code is now one of the five documented literals.
}
```

Rethrow what you did not recognize. An error you cannot classify is not yours
to summarize, and swallowing it hides a defect somewhere else.

If the error may have crossed a module boundary, use `hasSmithersErrorShape`
instead of `isSmithersError`. See
[Detect an error across module copies](./detect-an-error-across-module-copies.md).

## Branch on the code, never on the message

```ts
switch (error.code) {
  case "INVALID_INPUT":
    return badRequest(error.summary)
  case "TELEGRAM_INIT_DATA_INVALID":
    return unauthorized()
  case "UNSUPPORTED":
    return serverError("This runtime lacks a required primitive.")
  case "TELEGRAM_API_ERROR":
  case "INTEGRATION_ERROR":
    return classifyProviderFailure(error)
}
```

The union is closed, so this `switch` is exhaustive and the compiler will find
it again the day a sixth code is added. A message is prose an adapter may
reword between releases; a code is a checked literal.

`INVALID_INPUT`, `TELEGRAM_INIT_DATA_INVALID`, and `UNSUPPORTED` are all
terminal. Retrying any of them repeats the same computation on the same input
and gets the same answer.

## Read the reason on a provider failure

Current provider failures use `INTEGRATION_ERROR`. Its code alone does not
authorize retrying a write: inspect the reason and any unknown outcome.

For `INTEGRATION_ERROR`, use the refinement and the helpers that
[`@smthrs/integrations`](/api/integrations) exports rather than reading
`details` by hand:

```ts
import { Core } from "@smthrs/integrations"

if (Core.IntegrationError.isIntegrationError(error)) {
  if (Core.IntegrationError.isRetryable(error)) return retryLater(error)
  if (error.reason === "permission-denied") return forbidden(error.summary)
  if (error.reason === "invalid-signature") return Core.IntegrationError.toUnauthorized(error)
}
```

`isIntegrationError` accepts an instance that crossed a module-instance
boundary and refuses one whose `reason` this build cannot encode, which
`instanceof` alone does neither of. `isRetryable` reads `details.retryable`,
the key the clients set on the responses a retry can plausibly clear.
`toUnauthorized` and `toInvalidInput` build the control plane's typed errors
from `summary`, so no documentation URL reaches the transport.

`TELEGRAM_API_ERROR` is retained for decoding historical failures. The Telegram
adapter is outside the MVP; new GitHub calls report `INTEGRATION_ERROR` directly.

## Fail an action, do not throw inside one

Inside a durable action the failure has to survive a restart, so it cannot be a
class. Convert at the boundary:

```ts
import { Core } from "@smthrs/integrations"

const failure = Core.ActionFailure.fromIntegrationError(error)
```

`IntegrationFailure` carries the same `reason`, a message capped at 512
characters so a journal row stays a row, and `retryable`. The conversion is
total: a value it cannot classify becomes a non-retryable `delivery-failed`
rather than a defect. `toIntegrationError` converts back when a caller wants
the class again.

## Log the summary and the details

```ts
logger.warn("integration call failed", {
  code: error.code,
  summary: error.summary,
  details: error.details
})
```

Log `summary` rather than `message`: the documentation URL is a constant, and
repeating it on every line costs bytes and tells an operator nothing new.

`details` from a Smithers integration adapter is provider-safe by construction.
The clients redact tokens, API keys, and webhook secrets before the record
reaches the constructor. `details` on an error you built yourself is only as
safe as you made it, because the class stores what you pass verbatim. See
[The redaction contract](../concepts/error-shape.md#the-redaction-contract).

Attach `cause` only where you control what is in it. A `cause` from a provider
library can quote a URL that carries a credential.

## Show a person the summary

`summary` is the message with the documentation URL removed, which is what you
want in a chat reply, a form field, or an approval prompt:

```ts
await reply(chatId, `Could not post that: ${error.summary}`)
```

For a stack trace, a crash report, or an operator log, use `message`, which
keeps the pointer at the end.

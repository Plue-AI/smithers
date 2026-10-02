---
title: "Quickstart"
description: "Raise a SmithersError from a helper, catch it in a caller, branch on its code, and print a log line that carries no credentials."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/errors/docs/quickstart.md"
---

This walkthrough runs one failure the whole way through: a helper refuses an
argument, a caller classifies the refusal by code, and a log line records it.
It needs no network and no credentials.

## Raise the error

This example helper validates a chunk size and throws a typed refusal. It uses
only `@smthrs/errors`; no provider adapter is needed.

```ts
import { SmithersError } from "@smthrs/errors"

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
```

The three arguments are the whole constructor contract: the code, a summary a
person can read, and an optional `details` record. Everything else is optional
and lives in a fourth options argument.

## Catch it and branch on the code

Classify by `code`. Never match on message text: a message is prose an adapter
may reword, and a code is a string literal the type system checks.

```ts
import { isSmithersError } from "@smthrs/errors"

const parseChunkLength = (raw: unknown): number | string => {
  try {
    return requireChunkLength(raw as number)
  } catch (error) {
    if (!isSmithersError(error)) throw error
    switch (error.code) {
      case "INVALID_INPUT":
        return `Fix the request: ${error.summary}`
      case "UNSUPPORTED":
        return "Run this on a runtime with Web Crypto."
      default:
        return `Integration failure (${error.code}): ${error.summary}`
    }
  }
}

parseChunkLength(0)
// "Fix the request: Chunk maxLength must be an integer between 1 and 4096."
```

`error.code` narrows to the five documented literals. This example deliberately
keeps a fallback branch: any code without its own case returns the integration
failure message. Adding a code does not make this switch fail type checking.

`summary` is the message without the appended documentation URL. Use it
wherever the URL would be noise, such as a form field or a chat reply.
`message` keeps the URL, which is what a stack trace and an operator want.

## Check exhaustiveness explicitly

A closed union makes an explicit exhaustiveness check possible. Handle every
code and assign the remaining value to `never` in the default branch:

```ts
import type { SmithersErrorCode } from "@smthrs/errors"

const describeCode = (code: SmithersErrorCode): string => {
  switch (code) {
    case "INVALID_INPUT":
      return "The request is invalid."
    case "INTEGRATION_ERROR":
      return "An integration call failed."
    case "TELEGRAM_API_ERROR":
      return "A Telegram Bot API call failed."
    case "TELEGRAM_INIT_DATA_INVALID":
      return "Telegram Mini App initData did not authenticate."
    case "UNSUPPORTED":
      return "The runtime lacks a required primitive."
    default: {
      const unhandled: never = code
      return unhandled
    }
  }
}
```

The two Telegram cases handle historical failures; their adapter is outside
the MVP. After all five cases return, `code` narrows to `never`. If a code is added to
`SmithersErrorCode` without a matching case here, the assignment to `unhandled`
fails type checking. The explicit `never` check provides that guarantee; the
closed union alone does not.

## Log it without leaking a credential

`SmithersError` serializes to its own enumerable fields, and `name` is not one
of them:

```ts
const error = new SmithersError("INTEGRATION_ERROR", "poll failed", { reason: "poll-failed" })

Object.keys(error) // ["code", "summary", "docsUrl", "details"]
console.log(JSON.stringify(error))
```

```json
{
  "code": "INTEGRATION_ERROR",
  "summary": "poll failed",
  "docsUrl": "https://smithers.sh/docs/reference/errors",
  "details": { "reason": "poll-failed" }
}
```

`message`, `stack`, and `name` stay out of that object: the first two are
non-enumerable on `Error`, and the constructor installs `name` as a
non-enumerable own property for the same reason.

`details` appears only when the constructor received one, so a log line never
carries `details: undefined`.

The class writes `details` verbatim. If the record you attach could hold a bot
token, an API key, or a webhook secret, remove it before you construct the
error, not after. See
[The shape of a SmithersError](/concepts/error-shape/#the-redaction-contract).

## Look up what a code means at runtime

The definitions table is exported, so a diagnostic command can print the
meaning of a code it received:

```ts
import { getSmithersErrorDefinition, smithersErrorCodes } from "@smthrs/errors"

for (const code of smithersErrorCodes) {
  console.log(code, getSmithersErrorDefinition(code)?.when)
}
```

`getSmithersErrorDefinition` answers `undefined` for anything outside the five
codes, including inherited property names such as `toString`.

## Next

- [Handle a failed integration call](/guides/handle-a-failure/) covers
  retries, the `IntegrationError` subclass, and the durable action boundary.
- [Error code reference](/reference/error-codes/) lists every raise site.

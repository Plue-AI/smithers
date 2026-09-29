---
title: "The shape of a SmithersError"
description: "The five fields a SmithersError carries, the guarantee attached to each, and the redaction contract that makes details and cause safe to write into a log."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/errors/docs/concepts/error-shape.md"
---

`SmithersError` extends `Error` and adds four own fields. Every one of them
exists because a different reader needs it, and each carries a guarantee the
constructor enforces.

## The fields

| Field     | Type                                               | Guarantee                                                                                                   |
| --------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `code`    | `SmithersErrorCode`                                | One of five string literals; any other value throws a `TypeError`. The classification a caller branches on. |
| `summary` | `string`                                           | The message with every trailing documentation URL removed.                                                  |
| `docsUrl` | `string`                                           | Always `ERROR_REFERENCE_URL`.                                                                               |
| `details` | `Readonly<Record<string, unknown>>` or `undefined` | An own property only when the constructor received one. Copied and frozen at the top level.                 |
| `name`    | `string`                                           | A non-enumerable own property, like `Error.prototype.name`. Defaults to `"SmithersError"`.                  |

`message` and `cause` are inherited from `Error`. `message` is `summary` plus
the documentation URL; `cause` is present only when the caller supplied one.

## message, summary, and the documentation URL

The constructor appends `" See https://smithers.sh/docs/reference/errors"` to the
summary and stores the un-suffixed text as `summary`.

The append is idempotent by construction. Before appending, the constructor
strips every trailing copy of the suffix, tolerating trailing whitespace and
whitespace between copies. Whitespace the summary itself ends with is kept.
Wrapping an error's `message` in a new `SmithersError` therefore produces the
same `message` and `summary` rather than a growing tail:

```ts
const first = new SmithersError("INVALID_INPUT", "no bot token")
first.message // "no bot token See https://smithers.sh/docs/reference/errors"

const wrapped = new SmithersError("INVALID_INPUT", first.message)
wrapped.message // "no bot token See https://smithers.sh/docs/reference/errors"
wrapped.summary // "no bot token"
```

Only a trailing suffix is stripped. A URL quoted in the middle of a sentence is
prose, so it stays and the pointer is still appended.

Two cases suppress the URL:

- `{ includeDocsUrl: false }` leaves it out, and still strips a suffix the
  summary already carried.
- A summary that is empty or entirely whitespace gets no suffix, because a
  message of just a URL tells a reader nothing.

Use `summary` when you render a failure somewhere the URL is noise. Use
`message` in a log or a stack trace, where the pointer is the point.

## details is copied, frozen, and shallow

`details` is caller-supplied context. The constructor copies the top-level
record and freezes the copy:

```ts
const details = { reason: "poll-failed", context: nested }
const error = new SmithersError("INTEGRATION_ERROR", "poll failed", details)

details.reason = "changed" // does not reach error.details
error.details // { reason: "poll-failed", context: nested }
Object.isFrozen(error.details) // true
```

The freeze is one level deep. Nested values are shared by reference, so
mutating an object you already attached does change what the error reports.
Attach values you will not touch again.

When the constructor receives no `details`, the instance has no own `details`
property at all. That is why `util.inspect` and `JSON.stringify` never print
`details: undefined` for an error that carries none.

## cause is stored verbatim, and absent when undefined

A `cause` of `undefined` is treated as no cause, so the instance has no own
`cause` property and inspection prints no `[cause]` line. A subclass can
therefore always spell the key and let the caller decide:

```ts
class IntegrationError extends SmithersError<"IntegrationError"> {
  constructor(options?: { readonly cause?: unknown }) {
    super("INTEGRATION_ERROR", "poll failed", undefined, {
      cause: options?.cause,
      name: "IntegrationError"
    })
  }
}
```

A supplied cause is stored as given. Non-`Error` causes are kept as-is, and a
cause chain is preserved unchanged.

## The redaction contract

`SmithersError` never redacts. It copies `details`, it stores `cause`, and it
inspects neither. The obligation sits with the constructor caller, and it is
the reason this package exists next to integration adapters rather than inside
them.

An adapter must remove credentials before it constructs the error:

- Bot tokens, API keys, and webhook secrets must not appear in the summary, in
  `details`, or in `cause`.
- Provider text is the dangerous case, because a message from `fetch` or the
  platform may quote a URL your code never formatted. The Telegram client in
  [`@smthrs/integrations`](https://integrations.smithers.sh/reference/api/) exports `redactBotToken` and runs
  it over every provider string before it reaches a constructor. It replaces
  both the literal token and any `/bot<id>:<secret>` path segment.
- Verification failures must not describe why they failed beyond the fact that
  they did. The init-data verifier reports `initData HMAC signature does not
  match.` and nothing about which bytes differed, because a more specific
  message is a verification oracle.

The consequence for a caller: `details` from a Smithers integration adapter is
already provider-safe and can go straight into a log. `details` on an error you
constructed yourself is only as safe as you made it.

## Subclasses keep working

The constructor restores the subclass prototype through `new.target`, so
`instanceof` holds for a subclass even under a transpiled target, where `Error`
would otherwise reset it:

```ts
class AdapterError extends SmithersError {}

const error = new AdapterError("TELEGRAM_API_ERROR", "bad request")
error instanceof AdapterError // true
error instanceof SmithersError // true
```

The reported `name` is a separate decision. A subclass that passes
`{ name: "AdapterError" }` reports that name and its stack starts with it; one
that passes nothing reports `"SmithersError"`. Either way the name stays
non-enumerable, so it never shows up in `Object.keys` or `JSON.stringify`.

## The tag is the name

`SmithersError` is an Effect tagged error. Its `_tag` is the reported `name`,
installed as a non-enumerable own property, so `Effect.catchTag` routes each
adapter's failures to their own handler:

```ts
Effect.fail(error).pipe(
  Effect.catchTag("IntegrationError", (e) => Effect.succeed(e.reason)),
  Effect.catchTag("SmithersError", (e) => Effect.succeed(e.code))
)
```

A subclass passes its tag as the type argument and the same string as
`name`: `class AdapterError extends SmithersError<"AdapterError">` with
`{ name: "AdapterError" }`. The type argument defaults to `string`, so
`SmithersError` alone still means any instance, subclasses included.

[Raise a SmithersError from an adapter](/guides/raise-an-error/) shows the
two real subclasses and what they add.

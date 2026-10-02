---
title: "The closed code vocabulary"
description: "Why SmithersErrorCode holds five codes instead of a registry: the definitions table is the runtime source of truth, the union is derived from its keys, and every other package states its failures as tagged errors."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/errors/docs/concepts/error-codes.md"
---

`SmithersErrorCode` is a union of five string literals, and nothing widens it
at runtime. That closure is the design, not an accident of the current code
count.

## One table, two derived things

`smithersErrorDefinitions` is the runtime source of truth. Everything else in
the module reads from it:

```ts
export type SmithersErrorCode = keyof typeof smithersErrorDefinitions

export const smithersErrorCodes: ReadonlyArray<SmithersErrorCode> = Object.keys(
  smithersErrorDefinitions
) as Array<SmithersErrorCode>
```

The type comes from the table's keys and the runtime list comes from the same
keys, so the two cannot drift. `isSmithersErrorCode` answers from
`Object.hasOwn` against the same table, which is why it rejects inherited
names such as `toString`, `hasOwnProperty`, and `__proto__`.

The table, each definition inside it, and the code list are all frozen at
module load. A consumer cannot add a sixth code by assigning to the table.

## What closure buys the caller

A closed union permits an explicit exhaustiveness check in a `switch` over
`error.code`. A default branch that assigns the remaining code to `never`
fails type checking when a new code lacks a case. A returning fallback alone
does not provide that check. See the
[quickstart example](/quickstart/#check-exhaustiveness-explicitly).

The closed union also makes `hasSmithersErrorShape` meaningful across package
copies: the refinement validates the code against the documented vocabulary,
so an error carrying a code this build has never heard of is refused rather
than narrowed. See
[Detect an error across module copies](/guides/detect-an-error-across-module-copies/).

The cost is that adding a code is a deliberate edit in two files, not a string
literal typed at a throw site. That is the intended friction:
[Add an error code](/guides/add-an-error-code/) is the procedure.

## Why five and not one hundred and eighty

Smithers 0.x carried a registry of 180 codes for an orchestrator engine that no
longer exists. Under the 1.0 release policy the registry was trimmed to the
five integration codes. Two Telegram codes remain for historical decoding
after that adapter's MVP retirement.

The rest of Smithers does not use codes at all. A Smithers package states
each failure it can produce as a `Schema.TaggedError` class on the effect that
can fail, so the failure channel of an `Effect` is itself the list of things
that can go wrong, checked by the compiler and encodable for the journal. A
central registry of string codes is the opposite arrangement: every caller can
name every code, and the type system knows nothing about which ones a given
call can produce.

Integration adapters are the exception because they are not written as Effect
failure channels all the way down. Several of their helpers are plain
synchronous functions that throw, and their failures cross into an HTTP
handler, a webhook route, and a journal row. One class with a stable code is
what those three readers can agree on.

The rule that follows: a new code belongs in this package only when an
integration adapter raises it. Everything else gets a tagged error in the
package that owns the failure.

## The definition record

Each row of the table is a `SmithersErrorDefinition`:

```ts
interface SmithersErrorDefinition {
  readonly when: string
  readonly details?: string
}
```

`when` is the condition that raises the code. `details` describes the shape of
the `details` record the raise sites attach, and it is absent for a code that
attaches none. Both fields are prose for a human, not a schema: nothing
validates a constructed error against them. The
[Error code reference](/reference/error-codes/) is the expanded form, with
the raise site of each condition named.

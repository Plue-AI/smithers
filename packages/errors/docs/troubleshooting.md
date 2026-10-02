---
title: "Troubleshooting"
description: "Symptoms you will actually hit with @smthrs/errors: a failing instanceof, a missing details property, a summary that lost its URL."
---

Each entry names the symptom, the cause in the source, and the fix.

## isSmithersError returns false for an error you know is one

**Symptom.** A `catch` block skips an error that plainly came from a Smithers
integration adapter, and `isSmithersError(error)` is `false`.

**Cause.** `isSmithersError` is `instanceof`, which compares prototypes. Two
copies of `@smthrs/errors` resolved in one process have two different
`SmithersError` classes, so an instance from one fails the check against the
other. A duplicated dependency, a bundled build loaded beside a source build,
or a plugin with its own `node_modules` all produce this. Mixed ESM/CommonJS
loading does too: the published `import` and `require` entry points have
distinct constructors, even with one installed package version.

**Fix.** Use `hasSmithersErrorShape` at the boundary where the value arrives.
It validates the fields instead of the prototype, and still refuses a plain
`Error`, an object that is not an `Error`, and a code outside the documented
five. See
[Detect an error across module copies](./guides/detect-an-error-across-module-copies.md).

If duplicate installations are in your own dependency tree, deduplicate them
as well: two copies also mean two frozen definition tables that can drift.
Deduplication does not merge the ESM and CommonJS constructors; use the
structural check when errors cross between these entry points.

## Reading error.details throws a TypeError

**Symptom.** `error.details["reason"]` fails with "Cannot read properties of
undefined".

**Cause.** `details` is an own property only when the constructor received one.
An error raised without context has no `details` at all, which is deliberate:
it keeps `details: undefined` out of every log line and JSON payload.

**Fix.** Read it optionally: `error.details?.["reason"]`. The type already says
`Readonly<Record<string, unknown>> | undefined`, so this is a compile error
under `strict` before it is a runtime one.

## Mutating the record I passed does not change error.details

**Symptom.** You built a details record, constructed the error, then updated
the record, and the error still reports the old values.

**Cause.** The constructor copies the top-level record and freezes the copy.
Adding, removing, or replacing a top-level key on your object afterwards cannot
reach the error.

**Fix.** Pass the final record. If you need the error to carry a value you do
not have yet, construct the error later.

The inverse trips people the other way: the freeze is one level deep, so
mutating a nested object you attached **does** change what the error reports,
because nested values are shared by reference. Attach values you will not touch
again.

## Assigning to error.details or error.name is a type error

**Symptom.** `error.name = "MyError"` fails to compile.

**Cause.** Both fields are readonly, and the package pins that with a type test
so it cannot regress.

**Fix.** Set the name at construction: `new SmithersError(code, summary,
details, { name: "MyError" })`. A subclass does the same through `super`.

## The message has no documentation URL

**Symptom.** `error.message` equals `error.summary`, with no
`See https://smithers.sh/docs/reference/errors` at the end.

**Cause.** One of two rules suppressed it. Either the caller passed
`{ includeDocsUrl: false }`, or the summary was empty or entirely whitespace. A
message that is nothing but a URL tells a reader nothing, so the constructor
does not produce one.

**Fix.** Pass a non-empty summary. If you are matching on the message in a
test, match on `summary` instead: it is the field that does not move.

## The message has the URL twice

**Symptom.** A message ends with the pointer repeated.

**Cause.** Not the constructor. Before appending, it strips every trailing copy
of the suffix, including copies separated by whitespace, so wrapping
`error.message` in a new `SmithersError` is idempotent. A doubled URL means
something concatenated it into the string after construction, or an adapter
wrote the suffix into the middle of its summary, where it is prose and is left
alone.

**Fix.** Never write the URL into a summary. The constructor appends it.

## A string will not type check as a code

**Symptom.** `new SmithersError(code, summary)` fails with "Argument of type
'string' is not assignable to parameter of type 'SmithersErrorCode'".

**Cause.** The union is closed over the keys of `smithersErrorDefinitions`, and
the constructor's first parameter is that union. A code read from JSON, an
environment variable, or a database column is a `string` until something
narrows it.

**Fix.** Narrow it with `isSmithersErrorCode`, and decide what to do when it is
not one:

```ts
import { isSmithersErrorCode, SmithersError } from "@smthrs/errors"

if (!isSmithersErrorCode(code)) throw new Error(`unknown error code: ${String(code)}`)
throw new SmithersError(code, summary)
```

If you meant to add a code rather than accept an arbitrary one, see
[Add an error code](./guides/add-an-error-code.md).

## Looking up a definition returns undefined for a name that exists on Object

**Symptom.** You expected `getSmithersErrorDefinition("toString")` to find
something, or you are surprised that `isSmithersErrorCode("constructor")` is
`false`.

**Cause.** Both functions ask `Object.hasOwn(smithersErrorDefinitions, code)`,
not `code in smithersErrorDefinitions`. Inherited property names are not codes,
and treating them as codes is how a prototype-pollution style input becomes a
lookup hit.

**Fix.** Nothing to fix. `undefined` and `false` are the correct answers for
every value outside the five documented codes.

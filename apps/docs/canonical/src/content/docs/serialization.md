---
title: "The serialization contract"
description: "Every rule that fixes the bytes @smthrs/canonical emits: member ordering, number and string forms, JSON.stringify parity, two deliberate divergences, the depth bound, and idempotence."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/canonical/docs/serialization.md"
---

This page is the contract. Every rule on it fixes the bytes the serializer
emits, and a change to any of them is a change to every digest derived from
it.

The input domain is wider than JSON. `canonicalize` accepts any JavaScript
value, applies `JSON.stringify` semantics to reduce it to JSON data, and emits
that data in the form
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) requires. A value that
cannot be reduced is refused rather than approximated.

## Members and ordering

Object members are the own enumerable string-keyed properties, sorted ascending
by UTF-16 code unit, at every level of the document. Symbol-keyed properties
are not members and never appear.

```ts
canonicalize({ "2": 0, "10": 1, a: 2, A: 3, "€": 4, "😀": 5 })
// => '{"10":1,"2":0,"A":3,"a":2,"€":4,"😀":5}'
```

Three consequences follow, and all three are the format working as specified:

- **No locale collation.** RFC 8785 sorts `péché` before `pêche` because
  `é` precedes `ê`, which is the wrong order for French. Locale is
  not consulted.
- **No Unicode normalization.** A precomposed name (U+00E9) and its
  decomposed spelling (`e` followed by U+0301) render identically and are two
  different members of the same object. They sort by code unit, so the
  decomposed spelling comes first, because `e` is U+0065.
- **No special property names.** `__proto__`, `constructor`, and `prototype`
  are ordinary members. A document parsed from text and a literal built with
  computed keys canonicalize to the same bytes.

Arrays keep their order, including duplicate values:

```ts
canonicalize([3, 1, 3, 2])
// => '[3,1,3,2]'
```

## Numbers

Finite numbers are serialized exactly as `JSON.stringify` serializes them,
which is the shortest form that round trips through the ECMAScript number
parser. RFC 8785 section 3.2.2.3 defers to that same definition.

| Value                    | Output                    |
| ------------------------ | ------------------------- |
| `0`                      | `0`                       |
| `-0`                     | `0`                       |
| `1e-7`                   | `1e-7`                    |
| `1e-6`                   | `0.000001`                |
| `1e20`                   | `100000000000000000000`   |
| `1e21`                   | `1e+21`                   |
| `333333333.33333329`     | `333333333.3333333`       |
| `5e-324`                 | `5e-324`                  |
| `1.7976931348623157e308` | `1.7976931348623157e+308` |

Negative zero loses its sign, because the JSON number grammar has no way to
carry it. `NaN`, `Infinity`, `-Infinity`, and every `bigint` are refused.

## Strings

Strings are escaped exactly as `JSON.stringify` escapes them, per RFC 8785
section 3.2.2.2:

- `"` and `\` take their short escapes.
- Backspace, form feed, line feed, carriage return, and tab take `\b`, `\f`,
  `\n`, `\r`, and `\t`.
- Every other code point below U+0020 becomes `\u00xx` with lowercase
  hexadecimal digits, so U+000F is `\u000f`.
- Every other code point is emitted as text. `é`, `€`, `￿`, and `😀` appear in
  the document as themselves, not as escapes.

Strings are never normalized, so two spellings of the same rendered text stay
two different strings.

A string carrying an unpaired surrogate is refused wherever it appears, as a
member name, as a value, or as a string a `toJSON` method mints during
serialization. See
[why the serializer refuses](/concepts/refusals/#a-lone-surrogate-is-not-text).

## Parity with JSON.stringify

For everything the two agree on, `canonicalize(value)` differs from
`JSON.stringify(value)` only by member order.

| Input                                                      | Output                          | Rule                                                                                                 |
| ---------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Member whose value is `undefined`, a function, or a symbol | omitted                         | `{ kept: true, dropped: undefined }` becomes `{"kept":true}`                                         |
| Array element that is `undefined`, a function, or a symbol | `null`                          | `[1, undefined, () => 1]` becomes `[1,null,null]`                                                    |
| Hole in a sparse array                                     | `null`                          | `new Array(3)` with index 2 set becomes `[null,null,"end"]`                                          |
| Symbol-keyed property                                      | omitted                         | not an own enumerable string key                                                                     |
| Object with a `toJSON` method                              | the serialization of its result | the method receives the exact key: the member name, the array index as a string, or `""` at the root |
| `new Date(0)`                                              | `"1970-01-01T00:00:00.000Z"`    | `Date` inherits `toJSON`, which runs before any other check                                          |
| `new Number(1)`, `new String("ab")`, `new Boolean(true)`   | `1`, `"ab"`, `true`             | wrappers unbox                                                                                       |
| An object with a null prototype                            | walked as plain data            | `Object.keys` sees its members and nothing is inherited                                              |

## Two deliberate divergences

Both trade byte parity with `JSON.stringify` for a digest that cannot be moved
by the object under it.

**A `toJSON` result is canonicalized recursively.** `JSON.stringify` serializes
the first result as-is, so a chained `toJSON` stops after one level and
`{ toJSON: () => ({ toJSON: () => 42 }) }` stringifies to `{}`. This serializer
keeps applying its own rules and emits `42`.

**A wrapper unboxes from its internal slot.** `JSON.stringify` consults an
overridden `toString` or `valueOf`, so a mutated `new String("ab")` can
stringify as `"xy"`. This serializer reads the primitive the wrapper was
constructed with and emits `"ab"`, so mutating a wrapper cannot change the
digest of the value it boxes.

## Observable semantics

The serializer reads the value through whatever the value exposes, and it does
so in a fixed order.

- **Keys are snapshotted, then read in sorted order.** A getter that deletes a
  later sibling means that sibling reads as `undefined` and is omitted, and its
  getter never runs.
- **Proxies are serialized through their traps.** A trap that throws, including
  a `get` on an array's `length`, surfaces as `canonical_getter_threw` at the
  path where it threw, never as the raw error.
- **A value reachable twice is walked twice.** Two members pointing at one
  object are not a cycle; the object is serialized and validated at each
  occurrence, so a refusal fires whichever occurrence reaches it first. Work
  and output grow with the expanded tree, which a chain of shared references
  makes exponential, exactly as with `JSON.stringify`. `canonicalize` bounds
  depth only; run `BoundedJson.admitStrict`, which refuses repeated references
  and bounds nodes and bytes, before serializing a value it did not build.
- **A `toJSON` that throws** surfaces as `canonical_tojson_threw` at that
  value's path, carrying the original error as `cause`.

## Depth

The root value is depth 0, and every member, element, and `toJSON` result is
one level deeper. The serializer supports 10,000 levels below the root and
refuses 10,001 with `canonical_depth_exceeded`, naming both numbers:

```text
canonical_depth_exceeded: depth 10,001 exceeds 10,000 at $.child.child...
```

The walk is iterative rather than recursive, so the bound belongs to this
package and not to the host's call stack. Two runtimes with different stack
sizes accept and refuse exactly the same documents.

## Idempotence and the round trip

A canonical document re-enters the serializer and comes out byte-identical:

```ts
canonicalize(JSON.parse(canonicalize(value))) === canonicalize(value)
```

That is what makes a digest taken over a document stable across a host that
re-serializes it on the way through. The `Canonical` schema's encode direction
is the same round trip in reverse: it parses a document back into a plain JSON
value.

## Values with no canonical form

These are refused, each with a stable code and the path of the offending value:
non-finite numbers, `bigint` (boxed or not), unpaired surrogates, cycles,
nesting past the depth bound, throwing getters and `toJSON` methods, and
non-plain built-ins whose `JSON.stringify` forms collide (`Map`, `Set`,
`WeakMap`, `WeakSet`, `ArrayBuffer`, typed arrays, `RegExp`, `Error` and its
subclasses, and class instances that define no `toJSON`). A top-level
`undefined`, function, or symbol is refused too, because the serializer must
return a string.

[Troubleshooting](/troubleshooting/) lists each code with its cause and its
fix, and [Convert a value the serializer refuses](/guides/prepare-a-value/)
shows what to send instead.

## Pin the bytes you depend on

Output changes are digest changes, so treat this contract the way you treat a
wire format. Two tests are worth keeping in any project that hashes canonical
documents:

- **A golden document.** Assert the exact string for one representative value.
  A diff on that string is the earliest warning that persisted digests are
  about to stop matching.
- **Order independence.** Assert that a value and a reordered copy of it
  produce the same document. Over your own shapes that catches a member you
  accidentally made order dependent, such as an array you meant to be a set.

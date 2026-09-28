---
title: "What the cache admits"
description: "The boundary every cache argument crosses: the key grammar, the bounded inert JSON budget, detachment and freezing, and why a cached result is never redacted."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/step-cache/docs/concepts/admission.md"
---

A cached result is executable state. A hit is handed back to a flow as the
step's own result, so the store must return exactly the value the step
produced, and must never be talked into storing something it cannot return. The
admission boundary is where both promises are kept.

Every input is checked before a statement or a request is issued, and the SQL
tier and the HTTP tier run the same checks, so an input one refuses is not
accepted by the other.

## The rules

| Rule                              | Value                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `keyDigest` grammar               | `[A-Za-z0-9_-]`, 1 to `maximumKeyDigestLength` (256) characters                                  |
| `result` and `meta` size          | `maximumJsonBytes`, 4 MiB, which also bounds any single string                                   |
| `result` and `meta` shape         | `maximumJsonDepth` 128, `maximumJsonNodes` 100,000, `maximumJsonMembers` 100,000                 |
| Object keys                       | 16 KiB each                                                                                      |
| `recordedRunId`                   | non-empty, NUL-free, well-formed text of at most `maximumRecordedRunIdLength` (1,024) code units |
| `createdAtMs`, `recordedEventSeq` | non-negative safe integers                                                                       |

## Why the key grammar is that narrow

The cache key is accepted at two boundaries: it becomes a bound SQL parameter,
and it becomes a URL path segment under a shared tier's `/ac/` namespace.
Restricting it to URL-safe letters, digits, underscores, and hyphens makes `.`,
`..`, path separators, control characters, and ill-formed Unicode
unrepresentable before either boundary is touched. A key can neither escape the
remote namespace nor reach SQL as anything but one opaque token, and the
grammar is the reason rather than an escaping pass that has to be right
everywhere.

## Bounded, inert JSON

Admission copies each `result` and `meta` tree rather than trusting the object
it was handed. The copy invokes no getter and no `toJSON` hook, walks property
descriptors instead of reading properties, and freezes what it produces. A
hostile or merely mutable argument therefore cannot change value between
validation and the write, and cannot run caller code inside the store.

The copy refuses, with `invalid_cache` and a complaint naming the field:

- values JSON cannot represent, including `undefined`, functions, symbols, and
  non-finite numbers;
- cycles;
- sparse arrays, accessor array members, and enumerable non-index array
  members;
- non-plain objects, accessors, and enumerable symbol keys;
- text with lone surrogates;
- anything past the byte, depth, node, or member budget.

The byte count matches what the canonical encoder actually emits, escape for
escape, so a value whose encoded form fits the budget is never refused for
being over it.

`snapshotEntry` applies the same discipline to the entry shell itself. It reads
the six expected fields through their descriptors, refuses any other enumerable
own property, and freezes the decoded result. The shell's prototype is not
inspected, so a class instance holding the six fields as own values is accepted
and none of its methods run, while the nested `result` and `meta` trees still
have to be plain. `CombinedCacheStore` takes that snapshot once, before either
tier is called: forwarding the caller's object let a mutation between the two
writes persist one value locally and publish a different one under the same
digest, with `Inserted` answered for both.

On the wire the entry is one JSON object, and the HTTP tier admits it under
the same field budgets plus the envelope itself: one nesting level above
`result` and `meta`, the five nodes of the shell, and `maximumJsonBytes`
bounding the whole encoding. That keeps publication symmetric with lookup. A
tier can return an entry whose `result` and `meta` each sit at their own node
or depth budget, and `encodeEntryCanonical` puts that same entry back instead
of charging both fields against one shared budget.

## Selectors are decoded, not copied

`recordedBy`, `ifRecordedBy`, and the age bounds take the other path. Each
operation schema-decodes its selector once and then reads only the value that
decoding returned, so a caller-owned accessor runs at most one time and cannot
change what the statement is issued with. The guarantee there is one read, not
no read. Provenance schemas are decoded the same way, which is why
`validateRecordedBy` returns the detached copy rather than a `void`.

## Cached results are never redacted

Journal payloads are redacted; the stores that hold resumable state are not. A
redactor that replaced a field because its name ended in `token` or `secret`
would hand the flow a `"[REDACTED]"` string where it expected its own value,
and a non-string value replaced by a placeholder string breaks schema decoding
on resume. `result` and `meta` round-trip through canonical JSON and come back
as the values the step produced.

The same bytes are what a shared tier stores: publication sends `result` and
`meta` verbatim to every host and operator with access to it. Steps whose
results contain secrets must not be cached on a shared tier.

## Reusing the boundary

The checks are exported, so an adapter implementing this contract elsewhere,
for example a shared-tier server, refuses exactly what the store refuses:
`validateKey`, `validateRecordedBy`, `validateFence`, `validateAge`,
`snapshotEntry`, `encodeCanonical`, and `encodeEntryCanonical`, alongside the
`KeyDigest`, `RecordedRunId`, `RecordedBy`, and `CacheEntry` schemas. Their
signatures are on the [API reference](/reference/api/).

## Related

- [The head and the ledger](/concepts/head-and-ledger/): why canonical form decides a
  recording's outcome.
- [Implement a shared cache server](/guides/implement-a-shared-tier/): the
  same boundary on the wire.
- [Troubleshooting](/troubleshooting/): the complaint text each refusal
  carries.

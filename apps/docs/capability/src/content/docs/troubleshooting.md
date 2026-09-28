---
title: "Troubleshooting"
description: "The refusals @smthrs/capability returns: what each symptom means, why the package refuses instead of guessing, and what to change."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/capability/docs/troubleshooting.md"
---

Most surprises from this package are the same surprise: it refused to guess.
Find your symptom, and the section says what it refused and what to write
instead. The full signatures are in the [API reference](/reference/api/).

## `Error: Invalid capability action: fs`

**What happened.** `Capability.format` was called with an action outside the
closed vocabulary, usually because the value was assembled from parts or cast.
The text `format` produces is identity rather than display, so it validates
instead of rendering a string that could collide with a real one.

**What to change.** Pass a real `Action` or `PatternAction`. If the value came
from outside, parse it first with `Capability.parse` or
`Capability.parsePattern` and handle the `Option`.

## `Capability.parse` returns `Option.none()` for a string that looks fine

**What happened.** One of four rejections. The input had fewer than three
colon-separated components, so it carries no resource (`fs:read`). The action
is not in the vocabulary (`fs:delete:/a`). The input starts with a colon
(`:fs:read:x`). Or the resource is longer than `Capability.maxResourceLength`,
which `format` will happily render but `parse` will not read back.

**What to change.** An empty resource is spelled `fs:read:`, with the trailing
colon. For an overlong resource, shorten or summarize it in the adapter before
you build the capability. For anything else, treat the `Option.none()` as the
rejection it is and refuse the input.

## Constructing a capability throws `Schema validation failed`

**What happened.** The resource exceeded `Capability.maxResourceLength` (4096
UTF-16 code units). `Capability.make`, `new Capability.Capability`, and
`new Capability.CapabilityPattern` all enforce the bound, as does decoding.

**What to change.** Bound the value at the host boundary. A command line or URL
that long is a sign the adapter is passing raw host input into authorization;
reject or summarize it there, where the value is understood.

## `patternFromCapability` returns `Option.none()`

**What happened.** The resource contains `*` or `?`, or it is overlong. The
glob grammar has no escape, so any pattern derived from such a resource would
grant more than the request. A URL with a query string (`/v1?k=1`) is the
common case.

**What to change.** Ask again next time, canonicalize the resource before you
build the `Capability`, or widen deliberately. The procedure is in
[Grant a capability safely](/guides/grant-a-capability-safely/).

## A grant matches the request, but the run keeps asking

**What happened.** The grant is written with `*` where the check needs `**`.
`Capability.matches` accepts `/workspace/*` against `/workspace/src/a.ts`,
because `*` crosses path separators. `Capability.subsumes` cannot prove that
coverage: it recognizes only an identical resource, `**`, and a `prefix/**`
form. A capability envelope is checked with `subsumes`, so a `*` grant proves
only the identical `*` pattern and the run re-asks for every other resource.

**What to change.** Write `/workspace/**`. Any pattern that has to prove
coverage uses the recursive form.

## A grant never matches, and the resource looks identical

**What happened.** Matching compares UTF-16 code units exactly. It does not
normalize paths and does not fold case, so all of these are non-matches:

- `/workspace/**` against `/workspace\evil`: a backslash is an ordinary
  character and never matches `/`.
- `/workspace/**` against `/workspace/../etc/passwd` or `/workspace/./a`: an
  absolute `fs:*` resource with a `.` or `..` segment, or a relative one that
  climbs out with `..`, is never matched, and `Permission.evaluate` denies it.
- `src/**` against `src/a/../../etc`: a relative dot resource must match in
  its lexical normal form (`etc`) too.
- `/Work/**` against `/work/a`: no case folding, on any platform.
- `/workspace/**` against `/workspace`: the pattern requires the separator, so
  it does not cover the root itself.
- `src/**` against `source/a.ts`: the prefix must end at a separator.

**What to change.** Canonicalize the resource once, in the adapter that builds
the `Capability`, and grant the canonical form. Do not add normalization to the
pattern: slash rewriting is what once let `C:/x\..\..\etc\passwd` slip inside a
`C:/x/**` grant.

## `evaluate` returns `deny` and no deny rule seems to apply

**What happened.** Two causes, and both are the model failing closed.

A rule somewhere in the rulesets could not be matched inside
`Capability.maxMatchWork`, so the whole decision is `deny`. This needs a
structural input that evaded the length bound, since the budget is the square
of `maxResourceLength`. `Capability.withinMatchBudget` tells you which pattern
and capability pair is undecidable.

Or configured policy (`rulesets[0]`) reduced to `deny`, which no later ruleset
can lift. Note that it is the reduced answer that vetoes: a configured `deny`
followed by a configured `allow` for the same request is not a veto.

**What to change.** For the first, bound the resource where it enters the
system. For the second, edit configured policy; a session grant cannot fix it.
Both are explained in
[The authorization model](/concepts/authorization-model/).

## Every write classifies as `irreversible`

**What happened.** The `workspaceRoot` you passed normalizes to `.` or to the
empty string (`"."`, `""`, `"work/.."`). Such a root has no lexical boundary,
so `Capability.tierOf` cannot call any write undoable and fails closed.

**What to change.** Pass an absolute workspace root. A relative root that
survives normalization, such as `..`, works, but an absolute root is the one
that says what you meant.

## A write outside the workspace classifies as `compensable`

**What happened.** Containment is lexical. `tierOf` never touches the
filesystem, so a resource whose first segment is really a symlink pointing
outside the workspace still looks inside.

**What to change.** Resolve real paths before classifying, in the caller that
materializes workspace snapshots. This is a known limit of lexical
classification, not something the package can detect.

## `isPermissionError` returns `false` for a value that looks correct

**What happened.** The refinement validates the whole enumerable shape, not the
`_tag`. It rejects an object with any extra field, a wrong-typed field (a
numeric `requestId` or `runId`), a missing `meta` on a `PermissionRequired`, a
`meta` holding a non-JSON value, an unknown `GrantStoreError` code, or a nested
capability whose resource is overlong.

**What to change.** Fix the producer. If you are constructing the value
yourself, use `Permission.permissionRequired` and
`Permission.permissionDenied`, which build the exact shape. The strictness is
deliberate: the package is published dual CommonJS and ESM, so class identity
is not usable here and the shape is the only check.

## Constructing `PermissionRequired` throws and names a `meta` key

**What happened.** `meta` reaches the grant journal, so only
JSON-representable values are accepted, and the failure is raised at the
construction site rather than later at persistence. A `bigint`, a `Date`, a
`Map`, a class instance, an `undefined` array element, or a cycle all fail
here. An `undefined` object property does not fail; it is dropped, mirroring
`JSON.stringify`.

**What to change.** Convert the value before you pass it: a timestamp as an ISO
string, a `Map` as an object, a `bigint` as a string. Keep `meta` to the
context a person needs to answer the request.

## `fromPlatformError` returns `Option.none()`

**What happened.** The reason tag is not `PermissionDenied`, or the cause
failed `isPermissionError`. Recovery validates structure and the reason tag,
not origin. A foreign error with a complete structural cause is accepted even
if `toPlatformError` was never called.

**What to change.** Make sure the guarded call is the one you think it is. If
you are projecting failures yourself, go through `toPlatformError` so the
reason tag and the structured cause both land where the recovery expects them.
Across a trust boundary, establish producer or request identity separately.
The recovered value is a data-only `PermissionErrorPayload`; use
`decodePermissionError` when class or Effect operations are required.

## A log line ends in `…[truncated]`

**What happened.** `Permission.formatError` caps each rendered field at
`Permission.maxDisplayFieldLength` (256 UTF-16 code units, marker included) and
escapes C0 and C1 control characters. The rendering is for an operator's log,
where an agent-chosen resource must not be able to forge a second line.

**What to change.** Nothing, for the log. When you need the full value, read
the structured failure: `capability`, `reason`, `requestId`, and `tier` are all
intact on the error itself.

## Decoding a stored capability fails on its action

**What happened.** The payload names an action outside the vocabulary the
installed version defines. The action set is closed, so decoding rejects an
unknown member rather than reading it as something adjacent. A row written by a
build whose vocabulary is newer than the reader's fails here instead of
quietly changing meaning.

**What to change.** Read the payload with a version whose vocabulary includes
the action, or discard the row. `Schema.is(Capability.Action)` tells you
whether a bare string is in the vocabulary before you decode the payload around
it, which is the check to run when you accept capability text from a store you
did not write.

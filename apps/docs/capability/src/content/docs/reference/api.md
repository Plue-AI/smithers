---
title: "API reference"
description: "Every public export of @smthrs/capability: the Capability value and its glob pattern, the closed action vocabulary, effect tiers, policy rules and evaluate, and the three typed permission failures."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/capability/docs/api.md"
---

`@smthrs/capability` exports `decodePermissionError` and two modules from its
root entry point. Each module is also importable from
`@smthrs/capability/<Module>`:

```ts
import { Capability, decodePermissionError, Permission } from "@smthrs/capability"
// or
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
```

`@smthrs/capability/internal/*` and `@smthrs/capability/*/index` are not
public. `@smthrs/capability/package.json` is exported.

Every export is a value, a schema, or a pure function. Enforcement, the
`GrantStore`, the decorating layers, and the journal live in
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/). This package's one runtime dependency is
[`@smthrs/canonical`](https://canonical.smithers.sh/reference/api/), which itself depends only on the shared
`effect@4.0.0-rc.115` peer. Both the kernel and [`@smthrs/jj`](https://jj.smithers.sh/reference/api/) can
therefore depend on it without a cycle, and a protected service names
permission failures in its own interface.

:::note
The schema ids (`@smthrs/capability/Capability`, `@smthrs/capability/PermissionDenied`, and the rest) and the `action:resource` text `format` renders are identity, not display text: a stored decision keeps those exact strings and is read back through them. Render capability text with `format` rather than assembling it yourself.
:::

## Example

```ts
import { Capability, Permission } from "@smthrs/capability"

const pattern = new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/**" })
const policy = [new Permission.Rule({ effect: "allow", pattern })]

Permission.evaluate([policy], Capability.make("fs:write", "/workspace/out.txt"))
// "allow"
Permission.evaluate([policy], Capability.make("net:post", "https://api.example.test/deploy"))
// "ask"
```

## Entry points

| Import                          | Source                                                                                                                     | Platform |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------- |
| `@smthrs/capability`            | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/capability/src/index.ts)           | any      |
| `@smthrs/capability/Capability` | [src/Capability.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/capability/src/Capability.ts) | any      |
| `@smthrs/capability/Permission` | [src/Permission.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/capability/src/Permission.ts) | any      |

## Capability

Capability values, wildcard patterns, the text form both render into, matching,
and effect tiers.

### Capability.Action

```ts
type Action =
  | "fs:read"
  | "fs:write"
  | "net:get"
  | "net:post"
  | "net:private"
  | "model:call"
  | "memory:read"
  | "memory:write"
  | "proc:spawn"
  | "jj:status"
  | "jj:diff"
  | "jj:snapshot"
  | "jj:restore"
  | "jj:workspace-add"
  | "jj:workspace-forget"
  | "jj:root"
  | "jj:revert"
  | "jj:op-restore"

const Action: Schema.Literals<[...]>
```

The closed vocabulary of host operations the permission kernel can authorize.
Exported as both a type and a schema value, so a consumer can validate a bare
selector at an RPC, config, or persistence boundary instead of copying the
list. The set grows by addition and an existing action does not change meaning,
so a stored payload naming an action outside it fails to decode rather than
being read as something adjacent.

`net:private` permits private HTTP destinations for the standard web tools.
Its resource is a normalized URL origin, such as `http://127.0.0.1:8080`, and
it supplements the ordinary request permission. Only an exact `net:private`
action can allow it; wildcard action denies still apply.

### Capability.PatternAction

```ts
type PatternAction = Action | "fs:*" | "net:*" | "model:*" | "memory:*" | "proc:*" | "jj:*" | "*"

const PatternAction: Schema.Literals<[...]>
```

Every action selector a pattern may carry: an exact action, a namespace family,
or the whole-authority `*`.

### Capability.Capability

```ts
class Capability extends Schema.Class<Capability>("@smthrs/capability/Capability")({
  action: Action,
  resource: Schema.String // at most maxResourceLength UTF-16 code units
}) {}
```

One exact adapter request subject to authorization. Construction, parsing, and
decoding all reject a resource longer than
[`maxResourceLength`](#capabilitymaxresourcelength).

### Capability.CapabilityPattern

```ts
class CapabilityPattern extends Schema.Class<CapabilityPattern>("@smthrs/capability/CapabilityPattern")({
  action: PatternAction,
  resource: Schema.String // at most maxResourceLength UTF-16 code units
}) {}
```

An action selector and a resource glob, naming a family of capabilities. The
grammar and its edges are in [Resource globs](/concepts/resource-globs/).

### Capability.make

```ts
const make: (action: Action, resource: string) => Capability
```

Constructs an exact capability. Throws when the resource exceeds
`maxResourceLength`.

### Capability.format

```ts
const format: (
  capability: { readonly action: Action | PatternAction; readonly resource: string }
) => string
```

Renders a capability or a pattern as `action:resource`. One renderer serves
both, because they are structurally identical records and this text is identity
rather than display: a stored decision keeps these exact bytes and is read back
through them.

Throws an `Error` naming the action when it is outside the closed vocabulary,
so an invalid structural input cannot be rendered into a string that collides
with a valid one.

```ts
Capability.format(Capability.make("net:get", "example.test:8443/api:v1"))
// "net:get:example.test:8443/api:v1"
```

### Capability.parse

```ts
const parse: (input: string) => Option.Option<Capability>
```

Reads back an exact capability. The action is the first two colon-separated
components; every remaining character, colons included, is the resource.
Returns `Option.none()` for a missing component, an unknown action, or an
overlong resource. An empty resource is legal (`fs:read:`); a missing one is
not (`fs:read`).

### Capability.parsePattern

```ts
const parsePattern: (input: string) => Option.Option<CapabilityPattern>
```

Reads back a pattern, with one single-token exception. The whole-authority
action `*` occupies the first component alone, so the bare string `*` parses to
`{ action: "*", resource: "**" }`. That is how a source declaring no
capabilities of its own is written down, and the string is stored and read back
verbatim rather than rewritten, so this reader owns its meaning. The resource is
`**` rather than `*` because `subsumes` proves that `**` covers every resource,
while `*` proves only an identical `*`. Every other missing component is a
rejection, not a default.

```ts
Capability.parsePattern("*")
// Option.some(CapabilityPattern { action: "*", resource: "**" })
Capability.parsePattern("fs:read")
// Option.none()
```

### Capability.isLiteralResource

```ts
const isLiteralResource: (resource: string) => boolean
```

Reports whether the grammar reads a resource as literal text, so it selects
that resource and nothing else. Returns `false` for any resource carrying `*`
or `?`. Ask here instead of scanning for those two characters: this predicate
is where the set of metacharacters is defined, so a caller cannot fall behind
the grammar.

### Capability.patternFromCapability

```ts
const patternFromCapability: (capability: Capability) => Option.Option<CapabilityPattern>
```

Derives the exact pattern for a request. Returns `Option.none()` when the
resource is overlong or contains `*` or `?`, because the grammar has no escape
for those characters and any pattern returned would silently widen the grant.
Quotes, spaces, and newlines are accepted. The derived pattern matches that
resource and nothing else. This is the only safe conversion from a request to a
grant; see [Grant a capability safely](/guides/grant-a-capability-safely/).

### Capability.matches

```ts
const matches: (pattern: CapabilityPattern, capability: Capability) => boolean
```

Tests whether a pattern selects an exact capability. The action must match
exactly, by namespace family, or by `*`, and the resource glob is matched
against the whole resource byte-exactly over UTF-16 code units, with no path
normalization and no case folding.

Returns `false` rather than throwing when the pattern-length times
resource-length product exceeds [`maxMatchWork`](#capabilitymaxmatchwork),
because a grant must never widen. Also returns `false` for an `fs:*`
capability whose absolute resource has a `.` or `..` segment, or whose
relative resource climbs above its start with `..`: text matching would let
`/w/**` select `/w/../etc/passwd`, so canonicalize before constructing it. A
relative declared scope such as `.`, `./src`, or `src/a/../b` matches only
when the pattern selects both its text and its lexical normal form, so
`src/**` does not select `src/a/../../etc`.

### Capability.subsumes

```ts
const subsumes: (left: CapabilityPattern, right: CapabilityPattern) => boolean
```

Conservatively determines whether every capability selected by `right` is also
selected by `left`. Returns `false` for any relationship its syntactic checks
cannot prove, and for a `right` that can select a filesystem action and whose
resource has a `.` or `..` segment.

An action is subsumed when `left` is `*`, the two are equal, or `left` is a
namespace family covering `right`. A resource is subsumed when the two are
equal, `left` is `**`, or `left` ends in `/**` and `right` starts with that
prefix and a separator. A single `*` proves only the identical resource, so an
envelope entry that must prove coverage of any other resource is written `**`.

### Capability.mayOverlap

```ts
const mayOverlap: (left: CapabilityPattern, right: CapabilityPattern) => boolean
```

Conservatively determines whether the two patterns can select a common
capability. Returns `false` only when disjointness is provable: actions no
capability satisfies at once, two literal resources that differ, or literal
prefixes that disagree over their shared span. Every relationship the syntactic
checks cannot settle answers `true`, and the question is symmetric in its
arguments.

The unprovable case answers the opposite way from
[`subsumes`](#capabilitysubsumes), which is the point. Ask `subsumes` before
widening a grant, where an unprovable answer must not grant. Ask `mayOverlap`
before dropping a restriction, where an unprovable answer must keep the
restriction. Reading "cannot prove coverage" as "does not apply" is how a
`deny` rule falls through to a later `allow`.

### Capability.withinMatchBudget

```ts
const withinMatchBudget: (pattern: CapabilityPattern, capability: Capability) => boolean
```

Reports whether `matches` can decide this pair inside `maxMatchWork`. An action
mismatch is decidable without any resource work. Use it to tell "not granted"
apart from "undecidable" when `Permission.evaluate` returns `deny`.

### Capability.maxResourceLength

```ts
const maxResourceLength = 4096
```

The maximum UTF-16 length of an exact or patterned resource. Exact requests and
authored patterns share the bound, so permission failures, journal payloads,
matching work, and exact-pattern derivation all have one finite input contract.
An adapter must reject or summarize a larger host value before constructing a
capability.

### Capability.maxMatchWork

```ts
const maxMatchWork = maxResourceLength * maxResourceLength
```

The maximum pattern-length times resource-length work one match may perform,
the square of `maxResourceLength`. An ordinary short grant such as
`/workspace/**` still decides a resource well over a million units long, so the
budget only bites on a structural input that evaded the length check.

### Capability.EffectTier

```ts
type EffectTier = "sealed" | "compensable" | "irreversible"

const EffectTier: Schema.Literals<["sealed", "compensable", "irreversible"]>
```

The durability and retry semantics of an effect. See
[Effect tiers](/concepts/effect-tiers/).

### Capability.TierOptions

```ts
interface TierOptions {
  readonly workspaceRoot: string
}
```

`workspaceRoot` is the lexical boundary used to classify file writes. A root
that normalizes to `.` or the empty string has no boundary and fails closed to
`irreversible`, so pass an absolute root.

### Capability.tierOf

```ts
const tierOf: (capability: Capability, options: TierOptions) => EffectTier
```

Classifies an exact capability.

| Tier           | Actions                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `sealed`       | `fs:read`, `net:get`, `model:call`, `memory:read`, `jj:status`, `jj:diff`, `jj:root`                                                         |
| `compensable`  | `jj:snapshot`, `jj:restore`, `jj:workspace-add`, `jj:workspace-forget`, `jj:revert`, `jj:op-restore`, and an `fs:write` inside the workspace |
| `irreversible` | `net:post`, `proc:spawn`, `memory:write`, and an `fs:write` that escapes the workspace                                                       |

Workspace containment is lexical, so symlinks are invisible: a caller that
materializes workspace snapshots resolves real paths before classifying a
write. A resource with a drive letter, any backslash, or a leading `~` is never
inside the workspace.

### Capability.requiresIdempotencyKey

```ts
const requiresIdempotencyKey: (tier: EffectTier) => boolean
```

Reports whether retrying an effect requires an idempotency key. Only
`irreversible` does.

## Permission

Typed permission failures, policy rules, and the `PlatformError` projection.

### Permission.RuleEffect

```ts
type RuleEffect = "allow" | "deny" | "ask"

const RuleEffect: Schema.Literals<["allow", "deny", "ask"]>
```

The decision a matching rule applies.

### Permission.Rule

```ts
class Rule extends Schema.Class<Rule>("@smthrs/capability/Rule")({
  effect: RuleEffect,
  pattern: CapabilityPattern
}) {}
```

A capability pattern and the decision it applies.

### Permission.evaluate

```ts
const evaluate: (
  rulesets: ReadonlyArray<ReadonlyArray<Rule>>,
  capability: Capability
) => RuleEffect
```

Reduces ordered rulesets to one decision for one exact capability.

Matching rules are last-match-wins across all rulesets, and the default is
`ask`. `rulesets[0]` is the configured policy ruleset: it is first reduced with
the same last-match rule, and its effective denial is then a hard veto, so a
configured `deny` superseded by a later configured `allow` or `ask` is not a
veto.

`net:private` requires an allow rule naming that exact action. Wildcard action
allows are skipped for it; wildcard denies retain the normal precedence.

A rule the matcher cannot decide within `Capability.maxMatchWork` vetoes the
decision and `evaluate` returns `deny`, because skipping it could let an
undecidable `deny` fall through to a later `allow`. The kernel turns that
`deny` into a `PermissionDenied`. An `fs:*` capability whose resource has a `.`
or `..` segment is `deny` for the same reason.

[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/) supplies four rulesets in this order:
configured policy, the patterns approved for a run before it starts, the grants
the run holds, and the grants a person chose to remember. See
[The authorization model](/concepts/authorization-model/).

### Permission.PermissionRequired

```ts
class PermissionRequired extends Schema.TaggedError<PermissionRequired>()(
  "@smthrs/capability/PermissionRequired",
  {
    code: Schema.Literal("permission_required"),
    requestId: Schema.String,
    runId: Schema.optional(Schema.String),
    capability: Capability,
    tier: EffectTier,
    meta: Schema.Record(Schema.String, Schema.Json)
  }
) {}
```

A permission request that must be resolved by an attended surface. The
operation did not happen.

| Field        | Meaning                                            |
| ------------ | -------------------------------------------------- |
| `requestId`  | The identity a surface resolves the request by.    |
| `runId`      | The run the request belongs to, when there is one. |
| `capability` | The exact adapter request. Never a wildcard.       |
| `tier`       | What performing the operation would cost to undo.  |
| `meta`       | Journal-safe context for the person answering.     |

`meta` accepts only JSON-representable values. Construction takes a cycle-safe,
deep-frozen snapshot and does not retain the caller's object; an
`undefined` object property is dropped, mirroring `JSON.stringify`, while an
`undefined` array element is rejected because serialization would change it to
`null`. A value the journal could not encode fails at the construction site
naming the key. Own `__proto__` data properties are preserved at every depth.
The limits are depth 16 (the metadata root is depth 0), 1024 object properties
and array elements in total, and 64 KiB of UTF-8 JSON after dropping undefined
properties. Omitted properties still count toward the member limit. Shared
references reuse one frozen copy, but each occurrence counts toward depth,
members and serialized bytes. Cycles and exceeded limits raise a field-specific
schema error before journal encoding.

The error retains a defensive copy of the capability, and its
`capability` and `meta` slots are non-writable.

### Permission.PermissionDenied

```ts
class PermissionDenied extends Schema.TaggedError<PermissionDenied>()(
  "@smthrs/capability/PermissionDenied",
  {
    code: Schema.Literal("permission_denied"),
    capability: Capability,
    reason: Schema.String
  }
) {}
```

A capability rejected by policy or by the current capability ceiling. `reason`
says which. Like `PermissionRequired`, it retains a defensive copy of the
capability in a non-writable slot.

### Permission.GrantStoreErrorCode

```ts
type GrantStoreErrorCode =
  | "duplicate_request"
  | "request_not_found"
  | "journal_failed"
  | "store_closed"
  | "invalid_resolution"

const GrantStoreErrorCode: Schema.Literals<[...]>
```

The stable grant-store failure codes callers branch on.

### Permission.GrantStoreError

```ts
class GrantStoreError extends Schema.TaggedError<GrantStoreError>()(
  "@smthrs/capability/GrantStoreError",
  {
    code: GrantStoreErrorCode,
    message: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect())
  }
) {}
```

A failure to register, persist, or resolve a grant request. Treat it as
unavailable rather than as a denial. `message` and `cause` are optional
operation context for persistence adapters; branch on `code`.

### Permission.PermissionError

```ts
type PermissionError = PermissionRequired | PermissionDenied | GrantStoreError

const PermissionError: Schema.Union<[...]>
```

Every failure the capability kernel can add to a guarded host call, as both a
union type and a schema value. A protected service names it in its own
interface, so a caller that holds the service cannot forget that an operation
may be suspended, denied, or left undecided by a broken grant store.

### Permission.permissionRequired

```ts
const permissionRequired: (options: {
  readonly requestId: string
  readonly runId?: string | undefined
  readonly capability: Capability
  readonly tier: EffectTier
  readonly meta?: Readonly<Record<string, unknown>> | undefined
}) => PermissionRequired
```

Constructs a permission request for an exact capability. `meta` defaults to
`{}`.

### Permission.permissionDenied

```ts
const permissionDenied: (capability: Capability, reason: string) => PermissionDenied
```

Constructs a denied permission failure.

### Permission.isPermissionError

```ts
const isPermissionError: (input: unknown) => input is PermissionErrorPayload
```

Refines an unknown value to `PermissionErrorPayload`, a union of data fields.
It accepts complete structural records and instances from another copy of the
package. It rejects excess enumerable fields, missing required fields, invalid
field types, overlong capability resources, accessors on known fields, and
non-JSON or cyclic metadata. Metadata descriptors are checked at every depth
without invoking getters. Required fields must be own data properties. Optional
fields cannot be inherited, except the empty default `Error.message` on a
schema-identified grant-store error. The grant-store `cause` is opaque context;
its own property must be data, but its contents are not inspected.

### Permission.PermissionErrorPayload

```ts
type PermissionErrorPayload =
  | { readonly _tag: "@smthrs/capability/PermissionRequired" /* request data */ }
  | { readonly _tag: "@smthrs/capability/PermissionDenied" /* denial data */ }
  | { readonly _tag: "@smthrs/capability/GrantStoreError" /* store data */ }
```

The fields of the corresponding error schemas, with structural
`{ action, resource }` capabilities and optional grant-store `message` and
`cause`. This type has no Error methods, Effect iterator, or schema brand.
It is suitable for rendering and branching on `_tag`.

### decodePermissionError

```ts
import { decodePermissionError } from "@smthrs/capability"

const decodePermissionError: (input: unknown) => Option.Option<PermissionError>
```

Validates with `isPermissionError`, then constructs a yieldable error instance
and any nested capability. Returns `Option.none()` for an invalid payload or
metadata exceeding the `PermissionRequired` constructor limits. Accepts
instances from another copy of the package without relying on `instanceof`.
Metadata is copied and frozen by the constructor; grant-store causes remain
opaque context.

### Permission.maxDisplayFieldLength

```ts
const maxDisplayFieldLength = 256
```

The maximum UTF-16 length of one field in a permission-error rendering, marker
included. It bounds unattended log output while preserving ordinary Unicode.

### Permission.formatError

```ts
const formatError: (error: PermissionErrorPayload) => string
```

Renders a permission failure as the one-line `description` a `SystemError`
carries, which is the string a log line or an unattended report shows:

```text
permission_required: <action:resource> (tier <tier>, request <requestId>)
permission_denied: <action:resource>: <reason>
grant store <code>: <message>
```

Every field escapes C0 and C1 controls, is limited to `maxDisplayFieldLength`
UTF-16 code units, and ends with a visible `…[truncated]` marker when cut, so
an agent-chosen resource cannot forge extra log lines. Ordinary non-ASCII text
is unchanged.

### Permission.toPlatformError

```ts
const toPlatformError: (options: {
  readonly module: string
  readonly method: string
  readonly pathOrDescriptor?: string | number | undefined
  readonly error: PermissionError
}) => PlatformError
```

Projects a permission failure into Effect's `PlatformError` channel. Effect
owns `FileSystem` and `ChildProcessSpawner`, and their tags fix the error
channel to `PlatformError`, so the kernel decorates those tags in place rather
than minting a second tag whose only difference is a wider error type.

Nothing is lost. The normalized reason is always `PermissionDenied`, meaning
the operation did not happen because the capability kernel refused, suspended,
or could not decide it; `description` carries the `formatError` rendering; and
`cause` carries the structured failure itself.

### Permission.fromPlatformError

```ts
const fromPlatformError: (error: PlatformError) => Option.Option<PermissionErrorPayload>
```

Returns the original cause as a data-only payload when the reason tag is
`PermissionDenied` and the cause passes `isPermissionError`. Returns
`Option.none()` otherwise. Foreign errors with complete structural causes are
accepted even if `toPlatformError` was never called. Recovery validates
structure and the reason tag, not origin. Across a trust boundary, callers must
establish producer or request identity separately. Use `decodePermissionError`
when a yieldable error instance is required.

## Related

- [The `@smthrs/kernel` reference](https://kernel.smithers.sh/reference/api/): the grant store, the
  decorating layers, and grant handling.
- [Handle a permission failure](/guides/handle-a-permission-failure/): the
  procedure these three failures are built for.

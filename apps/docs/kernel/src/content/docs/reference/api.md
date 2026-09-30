---
title: "API reference"
description: "Every public export of @smthrs/kernel: the closed host service list, the guarded decorators over each port, the grant store and its durable events, process containment, and the public test subpaths."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/kernel/docs/api.md"
---

The root entry point re-exports every module as a namespace, and each module is
also importable from `@smthrs/kernel/<Module>`:

```ts
import { CapabilitySet, GrantStore, HostServices, Workspace } from "@smthrs/kernel"
// or
import * as GrantStore from "@smthrs/kernel/GrantStore"
```

`@smthrs/kernel/internal/*` and `@smthrs/kernel/*/index` are not public.
`@smthrs/kernel/package.json` is exported.

:::note
Schema ids (`@smthrs/kernel/GrantEvent/RunGrant` and its siblings), journal event types (`flows.kernel.grant.*`, `flows.host.process-*`), and the `HostServiceIds` slot ids are durable identity rather than internal names. They are written to the journal and read back on replay, so code that reads grant or process history can match on them. They change only when the service behind the id changes.
:::

## Example

```ts
import { GrantStore, HostServices, Workspace } from "@smthrs/kernel"
import * as TestHost from "@smthrs/testing/TestHost"
import { Effect, FileSystem, Layer } from "effect"

const raw = Layer.mergeAll(TestHost.layer({ files: { "/w/a.txt": "hi" } }), Workspace.layer("/w"))
const read = Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString("/w/a.txt"))
// Refused with permission_required: no rule authorizes fs:read.
Effect.runPromise(
  read.pipe(
    Effect.provide(HostServices.layer),
    Effect.provide(Layer.orDie(GrantStore.layer({ attended: false }))),
    Effect.provide(raw),
    Effect.scoped
  )
)
```

## Entry points

| Import                               | Source                                                                                                                                   | Platform |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `@smthrs/kernel`                     | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/kernel/src/index.ts)                             | any      |
| `@smthrs/kernel/test/TestGrantStore` | [src/test/TestGrantStore.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/kernel/src/test/TestGrantStore.ts) | any      |
| `@smthrs/kernel/test/contract`       | [src/test/HostContract.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/kernel/src/test/HostContract.ts)     | Node.js  |

## Capability and Permission

`Capability` and `Permission` are namespace re-exports from
[`@smthrs/capability`](https://capability.smithers.sh/reference/api/). That package owns the vocabulary, the
pattern grammar, policy evaluation, effect tiers, and the typed failure
contract; their deep import paths are `@smthrs/capability/Capability` and
`@smthrs/capability/Permission`. This page documents how the kernel applies
that contract at host boundaries.

Rules are ordered and last-match-wins, except that an effective configured deny
is a hard veto. The default decision is `ask`. `CapabilitySet` supplies the
ambient authority ceiling, and its public operations can only preserve or
narrow authority.

```ts
import { Capability, Permission } from "@smthrs/kernel"

const readWorkspace = new Permission.Rule({
  effect: "allow",
  pattern: new Capability.CapabilityPattern({
    action: "fs:read",
    resource: "/workspace/**"
  })
})

const decision = Permission.evaluate(
  [[readWorkspace]],
  Capability.make("fs:read", "/workspace/src/main.ts")
)
```

## CapabilitySet

The fiber's monotone authority ceiling.

### CapabilitySet.CapabilitySet

```ts
interface CapabilitySet {
  readonly groups: ReadonlyArray<ReadonlyArray<CapabilityPattern>>
}
```

A normalized conjunction of any-of pattern groups: a capability is allowed only
when **every** group contains a pattern matching it. Groups and patterns are
sorted, deduplicated, and frozen on construction. An empty inner group denies
everything, and any set containing one collapses to that.

### CapabilitySet.fromPatterns

```ts
const fromPatterns: (patterns: ReadonlyArray<CapabilityPattern>) => CapabilitySet
```

Authority described by one any-of group.

### CapabilitySet.none

```ts
const none: CapabilitySet
```

Empty authority. Its single empty any-of group rejects every capability.

### CapabilitySet.allows

```ts
const allows: (set: CapabilitySet, capability: Capability) => boolean
```

Whether every group contains a pattern matching the capability.

### CapabilitySet.intersect

```ts
const intersect: (left: CapabilitySet, right: CapabilitySet) => CapabilitySet
```

Concatenates the two group lists and renormalizes. Globs are never synthesized
or simplified, so intersection cannot invent authority.

### CapabilitySet.equals

```ts
const equals: (left: CapabilitySet, right: CapabilitySet) => boolean
```

Structural equality between normalized sets.

### CapabilitySet.current

```ts
const current: Effect.Effect<CapabilitySet>
```

The current fiber's ceiling. A fiber that never passed through `attenuate`
allows every capability, because unrestricted authority is the identity element
of `intersect`. The backing reference is module-private, so no caller can
replace the ambient set with a wider one.

### CapabilitySet.attenuate

```ts
const attenuate: (
  patterns: ReadonlyArray<CapabilityPattern>
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
```

Runs the effect with the parent ceiling **intersected** with one more any-of
group. This is the only way authority moves, and it only narrows.

## GrantStore

The decision service every decorator consults.

### GrantStore.Service and GrantStore.GrantStore

```ts
interface Service {
  readonly check: (
    capability: Capability,
    meta?: Record<string, unknown>
  ) => Effect.Effect<void, PermissionRequired | PermissionDenied | GrantStoreError>
  readonly reply: (
    requestId: string,
    resolution: Resolution,
    pattern?: CapabilityPattern
  ) => Effect.Effect<void, GrantStoreError>
  readonly list: Effect.Effect<ReadonlyArray<PendingRequest>>
  readonly grantEnvelope: (options: EnvelopeGrantOptions) => Effect.Effect<void, GrantStoreError>
}

class GrantStore extends Context.Service<GrantStore, Service>()("@smthrs/kernel/GrantStore") {}
```

`check` consults, in order: whether the store is open, the fiber's ceiling, and
the rulesets. `allow` returns void; `deny` fails `permission_denied`; `ask`
fails `permission_required` on an unattended store and parks the fiber on an
attended one. `meta` is display metadata for an attended surface and is
snapshotted, never interpreted.

`list` is a frozen snapshot whose `meta` values are the frozen snapshots taken
at check time. `reply` and `grantEnvelope` persist their decision before
activating it. The journal write never holds the store's mutation permit: a
slow or dead journal stalls only the admission that issued it, and a write
exceeding `maximumPersistMillis` fails with `journal_failed`, leaving the
request parked for a retry. A concurrent reply to a request whose decision is
mid-write fails fast with `request_not_found`; a concurrent identical envelope
admission adopts the in-flight outcome. Admissions reserve rule and envelope
signature capacity before writing, so distinct concurrent decisions cannot
exceed either ceiling. Failed or interrupted writes release their reservations;
successful writes convert them to active grants.

### GrantStore.PendingRequest

```ts
interface PendingRequest {
  readonly requestId: string
  readonly capability: Capability
  readonly tier: EffectTier
  readonly meta: Record<string, unknown>
}
```

One parked request. `tier` is `Capability.tierOf` for the capability, resolved
against the workspace root.

### GrantStore.Resolution

```ts
type Resolution = "once" | "run" | "remembered" | "deny"
```

`once` authorizes the request alone. `run` adds an allow rule for the run and
requires a `planDigest`. `remembered` adds a rule a journal-backed store
replays into later processes. `deny` fails the parked request. Adding a rule
also resolves every other parked request the new rule allows.

### GrantStore.EnvelopeGrantOptions

```ts
interface EnvelopeGrantOptions {
  readonly planDigest: string
  readonly patterns: ReadonlyArray<CapabilityPattern>
  readonly scope?: "run" | "remembered" | undefined
}
```

A bulk approval. `scope` defaults to `"run"`.

### GrantStore.MakeOptions

```ts
interface MakeOptions {
  readonly attended?: boolean | undefined
  readonly rules?: ReadonlyArray<Rule> | ReadonlyArray<ReadonlyArray<Rule>> | undefined
  readonly runRules?:
    | ReadonlyArray<
      Rule | {
        readonly rule: Rule
        readonly ceiling: ReadonlyArray<ReadonlyArray<CapabilityPattern>>
      }
    >
    | undefined
  readonly envelope?: EnvelopeGrantOptions | undefined
  readonly envelopeSignatures?: ReadonlyArray<string> | undefined
  readonly runId?: string | undefined
  readonly planDigest?: string | undefined
  readonly persist?: Persist | undefined
}
```

`attended` defaults to `true`. A flat `rules` value is the configured policy; a
nested one has configured policy first and replayed remembered grants after.
`envelopeSignatures` names envelopes that are already durable, so a matching
construction envelope activates without being persisted again.

### GrantStore.Persist

```ts
type Persist = (event: GrantEvent) => Effect.Effect<void, GrantStoreError>
```

A hook that durably records a decision **before** it becomes active. A
persistence failure leaves the decision inactive. One write may take at most
`maximumPersistMillis`; a write that never returns is interrupted at the
deadline and reported as `journal_failed`.

### GrantStore.make and GrantStore.layer

```ts
const make: (
  options?: MakeOptions
) => Effect.Effect<Service, GrantStoreError, Scope.Scope | Workspace>

const layer: (options?: MakeOptions) => Layer.Layer<GrantStore, GrantStoreError, Workspace>
```

Builds an in-memory store. It is scoped: closing the scope rejects every waiter
with `permission_denied` and `"grant store closed"`, clears the pending map,
and fails every later call with `store_closed`. Invalid options fail with
`invalid_resolution`.

### GrantStore.makeNoop and GrantStore.layerNoop

```ts
const makeNoop: Service
const layerNoop: Layer.Layer<GrantStore>
```

An explicit allow-all seam for tests and boot paths. Not a production policy.

### GrantStore.canonicalEnvelopePatterns

```ts
const canonicalEnvelopePatterns: (
  patterns: ReadonlyArray<CapabilityPattern>
) => ReadonlyArray<CapabilityPattern>
```

Deduplicates an envelope's predicates and sorts the survivors by the code-unit
order of `Capability.format(pattern)`. An envelope is a set, so canonicalizing
makes idempotency structural rather than dependent on caller discipline.

### GrantStore.envelopeSignature

```ts
const envelopeSignature: (
  planDigest: string,
  scope: "run" | "remembered",
  patterns: ReadonlyArray<CapabilityPattern>
) => string
```

The canonical identity of an approval. Two envelopes with the same plan digest,
scope, and predicate set produce the same signature regardless of order or
repetition, which is how the store and journal replay recognise an envelope
that is already durable.

### GrantStore.isValidGrantPattern

```ts
const isValidGrantPattern: (
  pattern: CapabilityPattern,
  capability: Capability,
  tier: EffectTier,
  workspaceRoot: string
) => boolean
```

Whether a request-scoped grant pattern stays within the request. It refuses a
different action, a more dangerous effect tier than the request displayed, and
a wildcard-bearing pattern identical to the resource, which is ambiguous
because the grammar has no escape.

### GrantStore.isValidEnvelopePattern

```ts
const isValidEnvelopePattern: (pattern: CapabilityPattern, workspaceRoot: string) => boolean
```

Whether a bulk envelope pattern preserves exact action and filesystem
effect-tier boundaries.

### GrantStore limits

```ts
const maximumRules = 1_024
const maximumEnvelopePatterns = 256
const maximumPendingRequests = 1_024
const maximumMetadataDepth = 16
const maximumMetadataMembers = 1_024
const maximumMetadataBytes = 65_536
const maximumEventBytes = 262_144
const maximumPersistMillis = 30_000
const maximumIdentityLength = 4_096
const maximumCapabilityResourceLength: number // Capability.maxResourceLength
```

Every bound failure uses `invalid_resolution` and occurs before state or
journal authority changes. `maximumPersistMillis` instead bounds time: a
journal write that exceeds it fails the admission with `journal_failed`
without activating the decision.

## GrantEvent

The durable wire shapes a decision is persisted as. The union has exactly five
members and no other event type is replayed.

### GrantEvent.GrantTier and GrantEvent.GrantScope

```ts
const GrantTier: Schema.Literals<["sealed", "compensable", "irreversible"]>
const GrantScope: Schema.Literals<["once", "run", "remembered"]>
```

### GrantEvent.OnceGrant

```ts
class OnceGrant extends Schema.TaggedClass<OnceGrant>()("@smthrs/kernel/GrantEvent/OnceGrant", {
  eventType: Schema.Literal("flows.kernel.grant.once.v1")
  requestId: Schema.String
  runId: Schema.String
  planDigest: Schema.optional(Schema.String)
  capability: Capability
  pattern: CapabilityPattern
  scope: Schema.Literal("once")
  tier: GrantTier
}) {}
```

Durable audit evidence, deliberately never replayed as active authority.

### GrantEvent.RunGrant

```ts
class RunGrant extends Schema.TaggedClass<RunGrant>()("@smthrs/kernel/GrantEvent/RunGrant", {
  eventType: Schema.Literal("flows.kernel.grant.run.v2")
  requestId: Schema.String
  runId: Schema.String
  planDigest: Schema.String
  capability: Capability
  pattern: CapabilityPattern
  ceiling: Schema.Array(Schema.Array(CapabilityPattern))
  scope: Schema.Literal("run")
  tier: GrantTier
}) {}
```

Replayed as active authority only for its own run and the current plan digest.
`ceiling` stores the requesting fiber's normalized conjunction of any-of pattern
groups. An empty outer array is unrestricted; an empty inner group denies all.
Replay intersects this ceiling with the constructor's ceiling. Trusted legacy
`flows.kernel.grant.run.v1` entries fail construction with `invalid_resolution`
because their captured ceiling cannot be recovered.

Both `RunGrant` and `EnvelopeGrant` require `planDigest`; other members make it optional.

### GrantEvent.RememberedGrant

```ts
class RememberedGrant extends Schema.TaggedClass<RememberedGrant>()(
  "@smthrs/kernel/GrantEvent/RememberedGrant",
  { eventType: Schema.Literal("flows.kernel.grant.remembered.v1") /* as OnceGrant, scope "remembered" */ }
) {}
```

Lives in the dedicated policy run and is replayed into later processes.

### GrantEvent.DeniedGrant

```ts
class DeniedGrant extends Schema.TaggedClass<DeniedGrant>()("@smthrs/kernel/GrantEvent/DeniedGrant", {
  eventType: Schema.Literal("flows.kernel.grant.denied.v1") /* as OnceGrant */
}) {}
```

Audit evidence for a refusal. Like `OnceGrant`, it activates nothing on replay.

### GrantEvent.EnvelopeGrant

```ts
class EnvelopeGrant extends Schema.TaggedClass<EnvelopeGrant>()("@smthrs/kernel/GrantEvent/EnvelopeGrant", {
  eventType: Schema.Literal("flows.kernel.grant.envelope.v1")
  runId: Schema.String
  planDigest: Schema.String
  patterns: Schema.Array(CapabilityPattern)
  scope: Schema.Literals(["run", "remembered"])
}) {}
```

Not attached to any request. `planDigest` binds the decision to the plan shown
to the approver.

### GrantEvent.GrantEventSchema, decode, and encode

```ts
const GrantEventSchema: Schema.Union<[OnceGrant, RememberedGrant, RunGrant, DeniedGrant, EnvelopeGrant]>
type GrantEvent = typeof GrantEventSchema.Type

const decode: (input: unknown) => Result<GrantEvent, Schema.SchemaError>
const encode: (input: unknown) => Result<unknown, Schema.SchemaError>
```

`decode` is strict about excess properties: an unknown field is a decode
failure, not something to ignore.

## JournalGrantStore

A `GrantStore` that persists to and replays from a
[`@smthrs/journal`](https://journal.smithers.sh/reference/api/) journal.

### JournalGrantStore.JournalGrantStoreOptions

```ts
interface JournalGrantStoreOptions {
  readonly runId: string
  readonly policyRunId: string
  readonly sourceId: string
  readonly planDigest: string
  readonly attended?: boolean
  readonly rules?: ReadonlyArray<ReadonlyArray<Rule>>
  readonly envelope?: {
    readonly patterns: ReadonlyArray<CapabilityPattern>
    readonly scope?: "run" | "remembered" | undefined
  }
}
```

`policyRunId` is a dedicated run holding remembered-policy events; the journal
has no global grant projection, so keep the id stable to keep remembered grants
across runs. `sourceId` is checked during replay, so events from other
producers cannot activate kernel authority. `planDigest` binds run grants and
run envelopes to the active plan. `runId` and `policyRunId` must differ, and
every identity must be non-empty, well-formed, and within
`GrantStore.maximumIdentityLength`.

### JournalGrantStore.make and JournalGrantStore.layer

```ts
const make: (
  options: JournalGrantStoreOptions
) => Effect.Effect<GrantStore.Service, GrantStoreError, Scope.Scope | Journal | Workspace>

const layer: (
  options: JournalGrantStoreOptions
) => Layer.Layer<GrantStore, GrantStoreError, Journal | Workspace>
```

Each decision commits before it is activated. A journal failure is
`journal_failed` and leaves the decision inactive.

Replay accepts only the configured producer and the five known event types,
rejects malformed or mis-scoped events, treats once and denied events as audit
evidence only, activates a run grant only for its run and current plan digest,
and rechecks every replayed pattern for safety. Remembered rules come from the
policy run and are deduplicated by formatted pattern identity. A policy history
past the 1,024-rule ceiling, or past the 1,024-envelope-signature ceiling,
fails closed with a message naming the policy run and the relevant counts. A
construction envelope is refused rather than persisted once the replayed
signatures already fill that ceiling, so the history a later process must
replay cannot outgrow what it will accept.

The journal is authoritative permission storage: `SqlJournal` must use the
`reject` overflow policy, because a dropped grant decision cannot safely be
treated as persisted.

## HostServices

The closed port list and the aggregate decorator.

### HostServices.HostService

```ts
type HostService =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | Jj
  | HttpClient
```

Everything that touches the outside world enters Smithers through exactly one
of these tags: no ambient `node:fs`, no bare `spawn`, no global `Date.now()`.
A service not on the list cannot be attenuated, denied, or audited.

### HostServices.HostServiceTags

```ts
const HostServiceTags: readonly [
  FileSystem.FileSystem,
  Path.Path,
  ChildProcessSpawner,
  Jj,
  HttpClient
]
```

The tags themselves, in slot order.

### HostServices.HostServiceIds

```ts
const HostServiceIds: readonly [
  "effect/FileSystem",
  "effect/Path",
  "effect/process/ChildProcessSpawner",
  "@smthrs/jj/Jj",
  "effect/HttpClient"
]
```

Stable slot identifiers, each the tag key of its slot's service. These are the
names a slot carries in durable records, so they change only when the service
behind a slot changes.

### HostServices.layer

```ts
const layer: Layer.Layer<
  HostService,
  PlatformError,
  HostService | Workspace | GrantStore
>
```

The five decorators merged. Every member both requires and provides its own
slot's tag, so composing this over a raw platform bundle makes the guarded
implementation shadow the raw one for everything downstream:

```text
raw platform service
        |
kernel decorator -> GrantStore
        |
flow-visible service
```

`Workspace` is a requirement so the exact same root service reaches both the
grant store and the filesystem decorator.

## FileSystem

The `fs:read` and `fs:write` decorator over Effect's own `FileSystem` tag, plus
the confinement extensions a host must attach.

### FileSystem.systemTemporaryDirectoryName

```ts
const systemTemporaryDirectoryName = "<system-temp>"
```

The sentinel an implicit temporary directory is named with. An implicit
`makeTempDirectory`, `makeTempDirectoryScoped`, `makeTempFile`, or
`makeTempFileScoped` is authorized as `fs:write` on
`path.resolve(workspace.root, "..", systemTemporaryDirectoryName)`. That path
is outside the workspace root by construction, so granting an ordinary
workspace write does not grant system temporary-directory access.

### FileSystem.AtomicFileSystemTypeId, AtomicRoot, AtomicRequest, Resolution, AtomicBatchRequest, AtomicBatchValue, AtomicBatchResponse, AtomicResults, AtomicResult, AtomicHandlers, AtomicFileSystem, AtomicHostFileSystem

```ts
const AtomicFileSystemTypeId: unique symbol

interface AtomicRoot {
  readonly boundaryRoot?: string | undefined
  readonly logicalRoot?: string | undefined
  readonly rootIdentity?: string | undefined
}

type AtomicRequest =
  | (AtomicRoot & { readonly operation: "exists"; readonly path: string })
  | (AtomicRoot & {
    readonly operation: "glob"
    readonly pattern: string
    readonly root: string
    readonly options?: { readonly exclude?: ReadonlyArray<string> | undefined } | undefined
  })
  | (AtomicRoot & { readonly operation: "rename"; readonly from: string; readonly to: string })
  | (AtomicRoot & { readonly operation: "resolve"; readonly path: string })
  | (AtomicRoot & { readonly operation: "batch"; readonly requests: ReadonlyArray<AtomicBatchRequest> })
// ...one member per operation: makeDirectory, readDirectory, readFile,
// readFileString, readLink, realPath, remove, stat, writeFile, writeFileString

interface Resolution {
  readonly path: string
  readonly target: string | null
}

type AtomicBatchRequest = BatchRequest | { readonly operation: "resolve"; readonly path: string }
type AtomicBatchValue = BatchValue | { readonly operation: "resolve"; readonly resolution: Resolution }
// AtomicBatchResponse: BatchResponse whose entries carry AtomicBatchValue

interface AtomicResults {
  readonly exists: boolean
  readonly glob: Array<string>
  readonly readFile: Uint8Array
  readonly stat: FileSystem.File.Info
  readonly rename: void
  readonly resolve: Resolution
  readonly batch: AtomicBatchResponse
  // ...one entry per operation
}

type AtomicResult<R extends AtomicRequest> = AtomicResults[R["operation"]]

type AtomicHandlers = {
  readonly [K in keyof AtomicResults]: (
    request: Extract<AtomicRequest, { readonly operation: K }>
  ) => Effect.Effect<AtomicResults[K], PlatformError>
}

interface AtomicFileSystem {
  readonly noFollowAuthorization?: true | undefined
  readonly execute: <R extends AtomicRequest>(request: R) => Effect.Effect<AtomicResult<R>, PlatformError>
  readonly isolated?: FileSystem.FileSystem | undefined
}

type AtomicHostFileSystem = FileSystem.FileSystem & {
  readonly [AtomicFileSystemTypeId]: AtomicFileSystem
}
```

The host-private extension for race-free, descriptor-relative operations. A
plain path-based filesystem cannot provide confinement, because an attacker can
replace any checked component before the delegate resolves it. `isolated` is
the escape hatch for a filesystem already confined by an enforceable boundary,
used for methods not expressible as one descriptor-relative request.

A request is discriminated by `operation` and carries exactly the operands that
operation needs, and `execute` answers the result that operation names rather
than a type its caller picked. The wire shape is unchanged: every member is the
same flat JSON object, so a journaled or serialized request still decodes. An
executor that dispatches in process can be written as an `AtomicHandlers`
record, which does not compile while an operation is unimplemented.

An executor that sets `noFollowAuthorization` answers `resolve`, alone and as
a batch member, and the guarded layer authorizes through it instead of host
pathnames. `resolve` walks from the pinned root without following any link. When
`target` is `null`, `path` is the whole request in on-disk spelling, with a
missing component and its descendants as requested. Otherwise `path` is the
first link on the way and `target` is its text.

### FileSystem.withAtomicFileSystem

```ts
const withAtomicFileSystem: (
  fileSystem: FileSystem.FileSystem,
  atomic: AtomicFileSystem
) => AtomicHostFileSystem
```

Attaches a trusted platform's descriptor-relative executor to its service. The
executor is attached to the supplied object and the same identity is returned,
so a host attaches exactly once at its boundary and retains no undecorated
alias.

### FileSystem.withIsolatedFileSystem

```ts
const withIsolatedFileSystem: (fileSystem: FileSystem.FileSystem) => AtomicHostFileSystem
```

Attests that a filesystem is confined as a whole, for browser and test volumes
that cannot address the host filesystem at all. **Throws** on a filesystem that
already carries a descriptor-relative executor: that executor is the stronger
guarantee, and a path-delegating attestation would route `access`, `copy`,
`chmod`, `link`, `symlink`, `open`, `watch`, `sink`, `stream`, and every
`makeTemp*` call back through pathnames after the capability check.

### FileSystem.FileSystemFault

```ts
class FileSystemFault extends Schema.TaggedError<FileSystemFault>()("@smthrs/kernel/FileSystemFault", {
  code: "executor_already_present" | "isolated_operation_unsupported" | "workspace_identity_changed"
  message: string
})
```

The tagged failure of a broken composition. `withIsolatedFileSystem` throws
`executor_already_present`. A guarded batch whose root no longer names the
authorized descriptor reports `workspace_identity_changed` as the `cause` of a
`Busy` `PlatformError`. `isolated_operation_unsupported` is a defect: an
attested volume never advertises `resolve` or `batch`.

### FileSystem.confined

```ts
const confined: (
  fileSystem: FileSystem.FileSystem,
  root: string
) => Effect.Effect<FileSystem.FileSystem, PlatformError, Path.Path>

const isConfinable: (fileSystem: FileSystem.FileSystem) => boolean

const requireConfinable: (fileSystem: FileSystem.FileSystem, root: string) => Effect.Effect<void, PlatformError>

const confinedRoot: (fileSystem: FileSystem.FileSystem) => string | undefined
```

A filesystem view confined to `root` without capability checks, for engine
machinery that must not ask a grant store about its own bookkeeping but must
never be redirected outside the workspace. Every path operation is one
`AtomicRequest` against `root`, pinned when the view is built by canonical path
and `device:inode` identity: the same request the guarded `layer` sends, minus
the grant check. A symlink on the path, a hard-linked file, `..` traversal, or
a replaced root is refused by the host, never followed. The root must exist.

An isolated volume, or the guarded `layer` service rooted at the same
workspace, is returned as it is. A path-based host fails with
`PermissionDenied`, as do `open`, `stream`, `sink`, `copy`, `link`, `symlink`,
`watch`, `truncate`, `utimes`, `access`, and every `makeTemp*` call.
`isConfinable` and `requireConfinable` answer the same question at composition
time, before the root is known to exist.
`confinedRoot` names the root a filesystem is already confined to (a
`confined` view's pinned root, or the guarded `layer` service's workspace
root), and is `undefined` for any other filesystem, so machinery sharing a
filesystem with its caller confines to the root the caller's paths resolve
against.

### FileSystem.canonicalResource

```ts
const canonicalResource: (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  workspaceRoot: string,
  value: string
) => Effect.Effect<string, PlatformError>
```

Resolves a path through every existing ancestor and maps a canonical path
inside the workspace back to the stable logical workspace root, so an existing
symlink cannot turn an inside-workspace grant into outside authority while
resources stay stable when the root itself is a symlink.

### FileSystem.layer

```ts
const layer: Layer.Layer<
  FileSystem.FileSystem,
  PlatformError,
  FileSystem.FileSystem | Path.Path | Workspace | GrantStore
>
```

The decorator. Before a grant check it resolves the canonical resource and
refuses unsafe hard-linked files. After any grant suspension it resolves the
resource again and refuses if the path now names something else. Open handles
bind authorization to the descriptor's `device:inode` identity and recheck it
on guarded handle operations. Option records, nested arrays, and maps are
snapshotted before any suspension. A host declaring neither extension fails
every relevant path, directory, stream, glob, and handle operation closed.

Refusals are `PlatformError` with reason `PermissionDenied`, carrying the
kernel failure on `cause`; `Permission.fromPlatformError` reads it back.

## ChildProcessSpawner

The `proc:spawn` decorator over Effect's own spawner tag.

### ChildProcessSpawner.ChildProcessSpawner and make

```ts
export { ChildProcessSpawner, make } from "effect/unstable/process/ChildProcessSpawner"
```

Effect's tag and constructor, re-exported unchanged so the kernel namespace
stays one-stop. `make` derives the full six-method surface from one `spawn`, so
`exitCode`, `string`, `lines`, and both `stream` helpers can never bypass what
`spawn` was given.

### ChildProcessSpawner.makeNoop and layerNoop

```ts
const makeNoop: (overrides?: Partial<ChildProcessSpawner["Service"]>) => ChildProcessSpawner["Service"]
const layerNoop: (overrides?: Partial<ChildProcessSpawner["Service"]>) => Layer.Layer<ChildProcessSpawner>
```

An unavailable spawner. Every derived helper reports the missing host as a
`NotFound` `PlatformError` naming the command line, so an unconfigured
capability answers rather than vanishing.

### ChildProcessSpawner.layer

```ts
const layer: Layer.Layer<
  ChildProcessSpawner,
  never,
  ChildProcessSpawner | GrantStore | Path.Path | Workspace
>
```

The decorator. The check is suspended into the spawn itself, so building a
`Command` or a stream neither requests permission nor starts a process. The
check runs once per pipeline stage, left to right, before any stage starts.
Each stage's resource is `CommandLine.resource(stage, context)`: the rendered
line, with a `shell: true` line that holds shell control syntax marked as
`sh -c '<line>'`, environment overrides the child would not inherit named in an
`env <NAME>… --` prefix, and a working directory outside `Workspace.root`
named in a `cwd <path> --` prefix. When the host filesystem is in the layer's
context, both are compared by real path: a symlink inside the workspace that
leads out of it is named as its target, and a root reached through
`/private` on macOS still counts as inside. The spawner passes this process's
environment as `context.ambient`. Pipeline `from`/`to` routing is not part of
what a grant authorizes. `cwd` and the **names** of overridden environment
variables also reach an attended surface as display metadata; the values do
not. A
command that cannot be snapshotted fails with an `InvalidData` `PlatformError`.
A command with no `cwd`, or a relative one, runs in `Workspace.root`, never the
process's own directory, and the check sees that resolved directory.

## ChildProcessEnvironment

Least-authority construction for a child process's replacement environment.

| Export                  | Type                                             | Meaning                                                                                                                                            |
| ----------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inheritedNames`        | `ReadonlyArray<string>`                          | `PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`, and `SHELL`; `LC_*` is admitted by prefix.                                                       |
| `credentialNamePattern` | `RegExp`                                         | The credential-name rule shared with `@smthrs/model/Auth`, including complete or separator-delimited `token`, `key`, `key_id`, and `pat` suffixes. |
| `isCredentialName`      | `(name: string) => boolean`                      | Tests one name against that rule.                                                                                                                  |
| `isInheritedName`       | `(name: string) => boolean`                      | Tests one name against `inheritedNames` and the `LC_*` prefix, case-insensitively.                                                                 |
| `make`                  | `(ambient, declared?) => Record<string, string>` | Selects bootstrap names, withholds sensitive ambient names, and overlays explicit declarations.                                                    |

`make` returns a null-prototype record suitable for `CommandOptions.env` with
`extendEnv: false`. An explicitly declared name is applied last, even when it
looks sensitive; an `undefined` declaration removes an inherited name.

## ContainedSpawner

Kill deadlines, platform lifecycle preparation, and ledger recording over the same spawner tag.

### ContainedSpawner.defaultGraceMs

```ts
const defaultGraceMs = 2000
```

Milliseconds between the `SIGTERM` that asks a child to stop and the `SIGKILL`
that makes it.

### ContainedSpawner.Options

```ts
interface Options {
  readonly graceMs?: number | undefined
  readonly platform?: string | undefined
}
```

`platform` is `process.platform` spelling, and decides only whether a command
naming no `detached` option gets a process group of its own. It defaults to
`"linux"`, the detaching branch.

### ContainedSpawner.Lifecycle

```ts
type Lifecycle = (
  command: ChildProcess.StandardCommand,
  spawn: (command: ChildProcess.StandardCommand) => Effect.Effect<ChildProcessHandle, PlatformError, Scope>
) => Effect.Effect<
  {
    readonly handle: ChildProcessHandle
    readonly activate: Effect.Effect<void, PlatformError, Scope>
    readonly settled: Effect.Effect<boolean>
  },
  PlatformError,
  Scope
>
```

Preparation owns cleanup before it can fail or be interrupted. It returns an
identity to record and an idempotent `activate` effect. The kernel records
that identity with the executable it prepared before activation can execute
the target. Failed startup closes its child scope immediately; successful
startup attaches the whole logical command to the caller's scope. Only
`settled === true` permits ledger retirement. A target exit alone does not
prove its children ended.

Node and Bun hosts install `ProcessReaper.layerSpawner` from
`@smthrs/platform-node`, which composes the native adapter with
`ProcessReaper.processLifecycle`. Use that factory for a smaller Node/Bun
composition, or provide a lifecycle explicitly when implementing a custom host.

### ContainedSpawner.isContained

```ts
const isContained: (spawner: ChildProcessSpawner["Service"]) => boolean
```

Checks whether the service declares a platform lifecycle. A deadline-only
wrapper does not qualify. The declaration interoperates across ESM and CommonJS
and is preserved by the kernel permission decorator. It is a trusted
composition check, not proof that a caller-supplied lifecycle is honest.

### ContainedSpawner.withContainment

```ts
const withContainment: (command: ChildProcess.Command, options?: Options) => ChildProcess.Command
```

Rewrites a command to carry the escalation deadline. Both legs of a pipeline
receive it; a command that already names `killSignal` or `forceKillAfter` keeps
the policy its caller chose.

### ContainedSpawner.groupOf

```ts
const groupOf: (command: ChildProcess.Command, pid: number, platform?: string) => number | null
```

The process group to record, or `null` when the child leads none. It takes the
platform because Effect detaches a child that names no `detached` option
everywhere except win32, and a win32 record claiming `pgid === pid` would name
a group the child does not lead.

### ContainedSpawner.layer

```ts
const layer: (
  options?: Options,
  lifecycle?: Lifecycle
) => Layer.Layer<ChildProcessSpawner, never, ChildProcessSpawner | ProcessLedger>
```

Applies the policy to every spawn. Each pipeline leg is prepared and recorded
separately; the aggregate handle exposes the rightmost leg's output and status.
A failed record prevents target activation and closes the prepared owner's
scope. Startup failure in a later pipeline leg also closes earlier legs.
Cleanup failure or an unverified `settled` result retains the ledger record.

Compose the permission decorator **above** containment so it authorizes the
caller's whole command before expansion. A decorator below containment sees
platform preparation commands, which may differ from the caller's command.
Both layers provide the spawner tag they require, but their order has this
semantic effect.

## ProcessLedger

The host's durable record of the processes it started.

### ProcessLedger event types and identity

```ts
const SpawnedEventType = "flows.host.process-spawned.v1"
const ExitedEventType = "flows.host.process-exited.v1"
const ReapedEventType = "flows.host.process-reaped.v1"
const SkippedEventType = "flows.host.process-reap-skipped.v1"
const sourceId = "@smthrs/kernel/ProcessLedger"
const hostRunId: (hostId: string) => JournalEvent.RunId // `flows.host:${hostId}`
```

Records are ownerless journal entries on the host run. A successful reap and a
safety refusal retire a record with different event types, so an operator can
tell them apart.

### ProcessLedger.Spawned and ProcessRecord

```ts
interface Spawned {
  readonly pid: number
  readonly pgid: number | null
  readonly commandDigest: string
}

const ProcessRecord: Schema.Struct<{
  pid: Schema.Int
  pgid: Schema.NullOr<Schema.Int>
  hostId: Schema.String
  ownerPid: Schema.Int
  startedAtMs: Schema.Int
  commandDigest: Schema.String
}>
type ProcessRecord = typeof ProcessRecord.Type
```

`commandDigest` is the executable alone, as `CommandLine.executable` renders
it. Arguments carry credentials and these records are permanent, so the ledger
never writes one down; a reader that acts on a record matches it by pid and
process group.

### ProcessLedger.Service and ProcessLedger.ProcessLedger

```ts
interface Service {
  readonly record: (spawned: Spawned) => Effect.Effect<ProcessRecord, JournalError>
  readonly release: (record: ProcessRecord) => Effect.Effect<void, JournalError>
  readonly reaped: (record: ProcessRecord) => Effect.Effect<void, JournalError>
  readonly skipped: (record: ProcessRecord, reason: string) => Effect.Effect<void, JournalError>
  readonly live: Effect.Effect<ReadonlyArray<ProcessRecord>>
  readonly orphans: Effect.Effect<ReadonlyArray<ProcessRecord>>
}

class ProcessLedger extends Context.Service<ProcessLedger, Service>()("@smthrs/kernel/ProcessLedger") {}
```

Every write carries the journal's failure to its caller: a swallowed write
leaves a child no incarnation of the host can discover. `live` is this
incarnation's unreleased records; `orphans` replays the host run and returns
the records whose owner pid is not this incarnation's.

### ProcessLedger.Options

```ts
interface Options {
  readonly hostId: string
  readonly ownerPid: number
}
```

### ProcessLedger.make, layer, makeMemory, and layerMemory

```ts
const make: (options: Options) => Effect.Effect<Service, never, Journal>
const layer: (options: Options) => Layer.Layer<ProcessLedger, never, Journal>
const makeMemory: (options: Options) => Effect.Effect<Service>
const layerMemory: (options: Options) => Layer.Layer<ProcessLedger>
```

The journal-backed forms inherit a crashed incarnation's processes; the memory
forms keep only the current incarnation's bookkeeping and inherit nothing.

## CommandLine

One renderer shared by the `proc:spawn` capability resource and the
interpreters that execute the line, so a granted capability and the command a
browser actually runs cannot drift apart. `resource` builds the grant identity
from that same line. The module is pure string handling.

### CommandLine.quote

```ts
const quote: (token: string) => string
```

POSIX-quotes one token, leaving tokens made only of
`A-Za-z0-9_@%+=:,./-` alone.

### CommandLine.render

```ts
const render: (command: ChildProcess.Command) => string
```

Renders a command as one shell line. A standard command with `shell: true`
renders its tokens verbatim; a custom shell renders as an explicit
`<shell> -c <line>` so the selected executable is part of the resource; without
`shell`, every token is quoted to preserve literal argv semantics. A
`PipedCommand` renders with `|` between its sides. `from` and `to` pipe options
are not expressible this way and are ignored, so capability checks see the
commands and never the plumbing. The rendering is POSIX-only by contract.

### CommandLine.resource

```ts
interface ResourceContext {
  readonly ambient?: Readonly<Record<string, string | undefined>>
  readonly contains?: (directory: string) => boolean
}
const resource: (command: ChildProcess.StandardCommand, context?: ResourceContext) => string
const stages: (command: ChildProcess.Command) => ReadonlyArray<ChildProcess.StandardCommand>
```

The `proc:spawn` capability resource for one stage: `render`, with three
additions so a prefix grant such as `git status *` authorizes only what the
stage names.

- A `shell: true` stage whose line holds `;`, `&`, `|`, a backtick, `$`, `<`,
  `>`, `(`, `)`, or a line break is marked as `sh -c '<line>'`. `git status *`
  therefore does not match `git status; curl x | sh`. A simple shell line such
  as `git status --short` keeps its verbatim resource, and so does one that
  only adds an fd duplication (`2>&1`, `>&2`) or a discard to `/dev/null`.
- A stage that sets an environment variable the child would not otherwise
  inherit is prefixed with `env <NAME>… --`, sorted names only. That is every
  name outside the bootstrap set (`ChildProcessEnvironment.isInheritedName`)
  and a bootstrap name (`PATH`, `HOME`, and the rest) whose value differs from
  `context.ambient`. A grant for `git status` does not cover `git status` run
  with `GIT_CONFIG_PARAMETERS`, `GIT_SSH_COMMAND`, `LD_PRELOAD`,
  `NODE_OPTIONS`, or a `PATH` or `HOME` pointing somewhere new; grant
  `env GIT_SSH_COMMAND -- git fetch` to allow that override. Values never
  enter the resource. Omitted, `context.ambient` is empty and every declared
  bootstrap name is named.
- A stage whose `cwd` `context.contains` rejects is prefixed with
  `cwd <path> --`. The spawner's `contains` accepts `Workspace.root` and
  everything below it. Omitted, every `cwd` is named. `context.resolvedCwd`,
  the `cwd` with symlinks resolved, replaces the lexical `cwd` for that check
  and in the prefix.

`stages` lists a command's stages from left to right. A pipeline has no single
resource: the spawner checks every stage, so `git status | sh` needs a grant
for `sh` too.

### CommandLine.executable

```ts
const executable: (command: ChildProcess.Command) => string
```

The program a command runs, without its arguments: `command` itself when no
shell parses it, the leading token of the line when one does, and one name per
stage of a pipeline joined with `|`. Durable process records name their program
this way rather than with `render`, because arguments carry credentials and a
journal entry is permanent.

### CommandLine.cwd and CommandLine.env

```ts
const cwd: (command: ChildProcess.Command) => string | undefined
const env: (command: ChildProcess.Command) => Record<string, string | undefined> | undefined
```

The working directory and environment overrides, taking the leftmost stage of a
pipeline, which is the stage `setCwd` and the spawners treat as the pipeline's
own.

## HttpClient

The `net:get`, `net:post`, and `model:call` decorator over Effect's own HTTP
client tag. There is no Smithers transport port beneath it.

### HttpClient.HttpClient and make

```ts
export { HttpClient, make } from "effect/unstable/http/HttpClient"
```

Effect's tag and constructor, unchanged.

### HttpClient.authorizePreflight

`authorizePreflight(request, effect)` checks the ordinary HTTP capability before
running network preflight work such as DNS resolution. The guarded client can
consume that admission once for the same capability and grant store. Redirects,
retries, and different stores require fresh authorization. The effect requires
the host's `GrantStore`, including when the underlying client captures it.

### HttpClient.ModelCall and withModelCall

```ts
const ModelCall: Context.Reference<string | undefined>
const withModelCall: (modelId: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
```

A model call is not a general `net:*` effect: the same host answers many
models, and a grant for one must not be a grant for the rest. Effect's tag has
no room for an extra method, so the intent rides on a context reference. Inside
`withModelCall`, the action is `model:call` and the resource gains
`/<model id>`.

### HttpClient.toHttpClientError and fromHttpClientError

```ts
const toHttpClientError: (options: {
  readonly request: HttpClientRequest
  readonly error: PermissionError
}) => HttpClientError

const fromHttpClientError: (error: HttpClientError) => Option.Option<PermissionErrorPayload>
```

The projection and its inverse. The reason is always a `TransportError`,
because the request did not leave the host; `description` carries
`Permission.formatError` and `cause` carries the structured failure. Recovery
returns the original cause as data-only `PermissionErrorPayload` when a
`TransportError` cause passes `Permission.isPermissionError`. This validates
structure, not origin; establish producer or request identity separately across
a trust boundary. Import `decodePermissionError` from `@smthrs/capability`
for a yieldable instance.

### HttpClient.makeNoop and layerNoop

```ts
const makeNoop: () => HttpClient
const layerNoop: () => Layer.Layer<HttpClient>
```

An unavailable client. Every request fails with a `TransportError` naming the
request and the cause `"HTTP is unavailable on this host"`.

### HttpClient.layer

```ts
const layer: Layer.Layer<HttpClient, never, HttpClient | GrantStore>
```

The decorator. GET and HEAD use `net:get` and every other method uses
`net:post`. For an `https:` URL the resource is the lowercased URL host; for
any other scheme it is `<scheme>//<lowercased host>`. In other words `https` is
the implicit scheme: `https://EXAMPLE.test/x` names `example.test`, while
`http://EXAMPLE.test/x` names `http://example.test`, so a host grant never
authorizes a cleartext downgrade. Requests are snapshotted before any
suspension. By default, redirects are followed **above** the guard, so every hop re-enters
authorization independently. The client below the guard must not follow
redirects on its own. The decorator forces `RequestInit { redirect: "manual" }`
for each request it executes, which covers a plain `FetchHttpClient.layer`; a
custom client that ignores `RequestInit` must meet that precondition itself.

A caller that provides `FetchHttpClient.RequestInit` with `redirect: "manual"`
receives one authorized hop, including its redirect response. The caller owns
any redirect loop and its hop limit; each subsequent request through this
client still requires authorization. Other caller options are preserved.
The raw host client's private manual-redirect setting does not disable the
decorator's default redirect following.

## Jj

### Jj re-exports

```ts
export { Jj, layerNoop, make, makeNoop } from "@smthrs/jj"
```

The tag and its constructors, unchanged.

### Jj.layer

```ts
const layer: Layer.Layer<Jj, never, Jj | FileSystem.FileSystem | Path.Path | Workspace | GrantStore>
```

Operation-specific capability checks: `jj:status` on `"."`, `jj:diff` on
`<from>:<to>`, `jj:snapshot` on the message, `jj:restore` and `jj:revert` on
the change id, `jj:workspace-add` on the canonicalized destination (which also
requires `fs:write` on it), `jj:workspace-forget` on the workspace name, and
`jj:root` on the canonicalized starting directory, and `jj:op-restore` on the
operation id. `workspaceAdd` and `root`
canonicalize through the **raw** filesystem first, so an existing symlink
cannot turn an inside-workspace grant into outside authority or separate the
authorized path from the directory jj runs in.

Smithers owns this service, so its interface names
`Permission.PermissionError` directly and nothing is projected.

## Path

```ts
type Path = EffectPath.Path
const Path = EffectPath.Path
const layer: Layer.Layer<Path, never, Path | Workspace>
```

Effect's path service with relative paths resolved against `Workspace.root`.
Path manipulation is pure and lexical, so it requires no capability check; the
explicit layer proves that every member of the closed list has a kernel
decision.

## Rooted

```ts
const path: (base: Path.Path, root: string) => Path.Path
const fileSystem: (base: FileSystem.FileSystem, rooted: Path.Path) => FileSystem.FileSystem
const command: (value: ChildProcess.Command, rooted: Path.Path) => ChildProcess.Command
const spawner: (
  base: ChildProcessSpawner["Service"],
  rooted: Path.Path
) => ChildProcessSpawner["Service"]
const layer: (
  root: string
) => Layer.Layer<
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
>
```

Unguarded services bound to one directory. Every relative path, and every
command without a `cwd`, resolves against `root`; absolute paths and symlink
targets pass through. `spawner` keeps a contained base contained. `layer`
decorates the services it is provided in place. `Path.layer` and
`ChildProcessSpawner.layer` root the guarded surface with the same functions.

## Workspace

```ts
interface Service {
  readonly root: string
}

class Workspace extends Context.Service<Workspace, Service>()("@smthrs/kernel/Workspace") {}

const make: (root: string) => Service
const layer: (root: string) => Layer.Layer<Workspace>
const makeNoop: Service // root "."
const layerNoop: Layer.Layer<Workspace>
```

The workspace root that makes filesystem capability resources stable. It lives
beside the closed host list rather than in a platform package: a workspace root
is a policy decision the kernel needs before it can name a filesystem
capability, not something a platform can answer.

## HostError

```ts
type HostError = JjError
```

A type union, not a re-export: import the error itself from
[`@smthrs/jj`](https://jj.smithers.sh/reference/api/). Process execution is absent on purpose, because it is
Effect's `ChildProcessSpawner` and fails with `PlatformError` like the rest of
Effect's platform surface.

## Test subpaths

For a deterministic host, use `@smthrs/testing/TestHost`. Add
`"@smthrs/testing": "workspace:*"` to the consuming package's devDependencies;
see [Testing](/testing/).

### @smthrs/kernel/test/TestGrantStore

```ts
const layerAllow: Layer.Layer<GrantStore>
const layerDeny: (reason?: string) => Layer.Layer<GrantStore>
const layerScripted: (replies: ReadonlyArray<GrantStore.Resolution>) => Layer.Layer<GrantStore>
```

`layerDeny` defaults to the reason `"denied by test"`. `layerScripted` consumes
one reply per check: `once`, `run`, and `remembered` allow it, `deny` rejects
it, and exhausting the script rejects with
`"permission reply script exhausted"`. None of the three requires a
`Workspace`.

### @smthrs/kernel/test/contract

```ts
const runHostContract: (
  name: string,
  layer: HostContractLayer,
  caps: HostContractCapabilities
) => void
```

Registers the shared behavioral contract for a complete host bundle:
`FileSystemSuccess` or `FailureCapability` per slot, plus `PathSuccess`,
`ChildProcessSuccess`, `JjSuccess`, and `HttpClientSuccess` with its three
probes. `FileSystemOperations` and `JjOperations` are exported so an adapter can
enumerate what it must declare. Node-only, and requires the
`@effect/vitest` and `vitest` peers. See
[Adapt a new host platform](/guides/adapt-a-new-host-platform/).

## Identity, failures, and bounds

Capability actions and resources, patterns, run ids, plan digests, request ids,
and grant metadata are identity-bearing values. Smithers does not apply Unicode
normalization: matching, signatures, and journal replay use the exact
JavaScript string and UTF-16 code-unit sequence supplied. Identity fields that
require well-formed text reject lone surrogates and NUL where their contract
forbids it.

Permission failures retain stable codes: `permission_required`,
`permission_denied`, and the `GrantStoreErrorCode` values `duplicate_request`,
`request_not_found`, `journal_failed`, `store_closed`, and
`invalid_resolution`. The kernel's in-memory store raises the last four;
`duplicate_request` is part of the vocabulary for an attended surface of your
own. Platform projections preserve the structured value as their cause.
Validation errors identify the rejected field but never retain or print
unbounded hostile input.

## What the kernel does not do

:::warning
The kernel checks capabilities at adapter call sites. It does not sandbox the operating system and cannot observe host access that bypasses the decorated services. Hermetic execution additionally requires a `StepBoundary`.
:::

See [Capabilities and the host kernel](https://smithers.sh/docs/concepts/kernel/) and the platform
bundles that satisfy these ports: [`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/),
[`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/), and
[`@smthrs/platform-bun`](https://platform-bun.smithers.sh/reference/api/).

## Web destination pinning

`HttpClient.Destination` carries an immutable `{ origin, addresses }` snapshot
for one authorized web request. `HttpClient.withDestinationPinning(client)` marks only the exact trusted
client instance that
rejects origin mismatches, pins every socket and proxy tunnel to the approved
addresses, preserves HTTP Host and TLS verification, and prevents reuse of
connections from another admission. Custom clients must implement this
contract before marking the client. Replacing the client does not inherit the assertion;
the kernel guard preserves it when wrapping a supported client. The standard Node and Bun host
bundles implement it. `HttpClient.supportsDestinationPinning(client)` reports
whether that exact client is marked. Model requests leave `Destination` unset.

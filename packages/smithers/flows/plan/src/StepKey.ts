/**
 * The KeyMaterial → step-key compiler.
 *
 * Revived from the deleted `packages/smithers/flows/keys/src/StepKey.ts`. Two
 * deliberate deviations from the original:
 *
 * 1. **It lives here, not in `@smthrs/keys`.** That package owns generic
 *    derivation and stored-key validation; a compiler that understands plan
 *    material belongs above it.
 * 2. **It produces `@smthrs/keys` `StoredKey` values, not a second `sk1_` digest
 *    format.** The original minted its own prefix over a private `Digest`
 *    module. The engine dispatches under `StoredKey` (`FlowEngine/ActionKey.ts`),
 *    so a plan whose node keys were a *different* string format could never be
 *    the thing the cache is consulted against, and that is the whole point of
 *    a `Plan`. One key format, one hashing
 *    chokepoint (canonical JSON + injected `Crypto`), one namespace field
 *    (`kind`) distinguishing content keys from ordinal ones.
 *
 * Everything the original earned is kept: nominally branded digest inputs (a
 * literal that merely *looks* like `{digest}` hashes as a literal), set
 * normalization, the separate environment namespace, per-variant tagging of
 * resolved references, and the hashed `version`.
 *
 * Governing contract: the step-key rules at
 * https://smithers.sh/docs/concepts/content-addressing.
 *
 * @since 0.1.0
 */

import { DerivedKey, type StoredKey } from "@smthrs/keys"
import * as Cause from "effect/Cause"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import type * as FileSet from "./FileSet.ts"
import type * as KeyMaterial from "./KeyMaterial.ts"

/**
 * A computed step key. Identical in representation to any other flow key —
 * `key1_` plus a SHA-256 digest of the canonical serialization of the material.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type StepKey = StoredKey

/**
 * The nominal brand carried by every {@link DigestInput}. Kept private: the
 * only way to produce a value bearing it is {@link digestInput}, so a plain
 * value that merely happens to look like `{ digest: "..." }` — actions pass
 * content hashes around as ordinary data — can never be mistaken for a genuine
 * upstream-result digest reference. This closes a step-key collision where
 * shape-sniffing (`"digest" in value`) hashed the two identically.
 *
 * @since 0.1.0
 * @category symbols
 */
const DigestInputTypeId: unique symbol = Symbol.for("@smthrs/plan/StepKey/DigestInput")

/**
 * Which kind of graph reference a {@link DigestInput} stands for. Declared
 * once here so the field on `DigestInput` and the parameter of
 * {@link digestInput} name one set and cannot drift apart.
 */
type GraphReference = "ref" | "pending" | "ref-projected"

/**
 * A precomputed digest supplied as a step input rather than a literal value.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface DigestInput {
  readonly [DigestInputTypeId]: typeof DigestInputTypeId
  readonly digest: string
  /**
   * Which kind of graph reference resolved to this digest.
   *
   * Carrying the discriminator on the digest input keeps `normalizeInputs` the
   * single normalizer: it wraps every variant once, and the variants stay
   * mutually distinct because they differ in this field rather than in a
   * hand-built object a second wrap would hide.
   */
  readonly reference?: GraphReference
  /** The projection applied to the referenced result, for `ref-projected`. */
  readonly path?: ReadonlyArray<string>
}

/**
 * Nominally tags a precomputed digest so it is hashed as a digest reference
 * rather than a literal value.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const digestInput = (
  digest: string,
  reference?: {
    readonly reference: GraphReference
    readonly path?: ReadonlyArray<string>
  }
): DigestInput => ({
  [DigestInputTypeId]: DigestInputTypeId,
  digest,
  ...(reference === undefined ? {} : { reference: reference.reference }),
  ...(reference?.path === undefined ? {} : { path: reference.path })
})

/**
 * Type guard for values produced by {@link digestInput}.
 *
 * @since 0.1.0
 * @category guards
 * @slop
 */
export const isDigestInput = (value: unknown): value is DigestInput =>
  typeof value === "object" && value !== null && DigestInputTypeId in value &&
  (value as Record<PropertyKey, unknown>)[DigestInputTypeId] === DigestInputTypeId

/**
 * The engine-resolved execution environment a content key is computed under,
 * hashed in its OWN namespace rather than merged into the caller's `layers`
 * and `capabilities`.
 *
 * Three properties matter and none survives a merge:
 *
 * 1. **Non-aliasing.** Concatenating environment material onto the caller's
 *    made `caller{fs:["a"]} + env{fs:["b"]}` hash identically to
 *    `caller{fs:["a","b"]} + env{}` — a cross-run collision in the very
 *    material whose purpose is preventing one.
 * 2. **Declared vs undeclared.** `declared: false` is not the same value as
 *    `declared: true` with empty sets.
 * 3. **Composition order.** Environment layers retain declaration order,
 *    because plugin and service composition order can change behavior. The
 *    caller-owned `ContentIdentity.layers` stays set-normalized.
 *
 * `runScope` is set only when `declared` is `false`: it pins the key to one
 * run, so a step whose environment identity is unknown can never serve a
 * cross-run hit. The union enforces this for typed callers; both
 * {@link content} and {@link dispatchIdentity} validate it at run time.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type EnvironmentIdentity = typeof EnvironmentIdentity.Type

/**
 * Validated, copyable runtime environment identity. Layer order matters;
 * capability patterns are set-like. Unknown fields are not identity material.
 * @since 1.0.0
 * @category schemas
 */
export const EnvironmentIdentity = Schema.Union([
  Schema.Struct({
    declared: Schema.Literal(true),
    layers: Schema.Array(Schema.String),
    capabilities: Schema.Record(Schema.String, Schema.Array(Schema.String)),
    runScope: Schema.optionalKey(Schema.Undefined)
  }),
  Schema.Struct({
    declared: Schema.Literal(false),
    layers: Schema.Array(Schema.String),
    capabilities: Schema.Record(Schema.String, Schema.Array(Schema.String)),
    runScope: Schema.NonEmptyString
  })
])

/**
 * Caller-owned memoization context for projected dependency-value digests.
 *
 * This is the flows counterpart of Bazel's `ActionKeyContext`: one context is
 * passed through related key computations so shared input material is hashed
 * once. Concurrent requests for the same projection share the in-flight
 * digest. Entries are sound only while each settled `from` value is immutable;
 * callers must create a fresh memo when those values can change.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface DigestMemo {
  readonly digest: (
    from: string,
    path: ReadonlyArray<string>,
    compute: Effect.Effect<StepKey, Schema.SchemaError, Crypto.Crypto>
  ) => Effect.Effect<StepKey, Schema.SchemaError, Crypto.Crypto>
}

/**
 * Creates an empty projected-value digest memo. Projection addresses are
 * JSON-encoded `[from, path]` tuples so segment boundaries are unambiguous.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const makeDigestMemo = (): DigestMemo => {
  const entries = new Map<string, Deferred.Deferred<StepKey, Schema.SchemaError>>()
  const digest: DigestMemo["digest"] = (from, path, compute) =>
    Effect.suspend(() => {
      const address = JSON.stringify([from, path])
      const existing = entries.get(address)
      if (existing !== undefined) {
        return Effect.flatMap(Effect.exit(Deferred.await(existing)), (exit) => {
          if (Exit.isSuccess(exit)) return Effect.succeed(exit.value)
          // A waiter did not request the leader's cancellation. It competes to
          // become the replacement leader instead of inheriting that interrupt.
          return Cause.hasInterrupts(exit.cause) ? digest(from, path, compute) : Effect.failCause(exit.cause)
        })
      }
      const pending = Deferred.makeUnsafe<StepKey, Schema.SchemaError>()
      entries.set(address, pending)
      return compute.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function*() {
            if (Exit.isFailure(exit) && entries.get(address) === pending) {
              entries.delete(address)
            }
            yield* Deferred.done(pending, exit)
          })
        )
      )
    })
  return { digest }
}

/**
 * Material describing a sealed or hermetic content-addressed step.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface ContentIdentity {
  readonly body: unknown
  readonly inputs: Readonly<Record<string, unknown | DigestInput>>
  readonly layers: ReadonlyArray<string>
  readonly capabilities: Readonly<Record<string, ReadonlyArray<string>>>
  readonly environment?: EnvironmentIdentity | undefined
  readonly hermetic?: {
    readonly readSet: ReadonlyArray<{ readonly path: string; readonly digest: string }>
    readonly writeSet: ReadonlyArray<FileSet.Entry>
    readonly removes?: ReadonlyArray<string> | undefined
    readonly boundaryMode: FileSet.BoundaryMode
  } | undefined
}

/**
 * Material describing the run-local identity of a non-cacheable step.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface OrdinalIdentity {
  readonly runId: string
  readonly parentScope?: string | undefined
  readonly ordinal: number
  readonly tier: "compensable" | "irreversible" | "unsealed"
}

/**
 * Stable failures while resolving graph-local dependency references.
 *
 * @since 0.1.0
 * @category errors
 * @slop
 */
export class KeyMaterialError extends Schema.TaggedError<KeyMaterialError>()("@smthrs/plan/KeyMaterialError", {
  code: Schema.Literals(["invalid_environment", "missing_dependency", "non_content_material"]),
  message: Schema.String
}) {}

const validateEnvironment = (environment: EnvironmentIdentity): KeyMaterialError | undefined => {
  const candidate = environment as { readonly declared?: unknown; readonly runScope?: unknown }
  if (candidate.declared === false) {
    if (typeof candidate.runScope !== "string" || candidate.runScope.length === 0) {
      return new KeyMaterialError({
        code: "invalid_environment",
        message: "Undeclared environment identity requires a non-empty runScope"
      })
    }
    return undefined
  }
  if (candidate.declared === true) {
    return candidate.runScope === undefined
      ? undefined
      : new KeyMaterialError({
        code: "invalid_environment",
        message: "Declared environment identity must not include runScope"
      })
  }
  return new KeyMaterialError({
    code: "invalid_environment",
    message: "Environment identity requires a boolean declared field"
  })
}

const decodeEnvironment = (environment: EnvironmentIdentity) =>
  Effect.try({
    try: () => {
      const invalid = validateEnvironment(environment)
      if (invalid !== undefined) throw invalid
      return Schema.decodeUnknownSync(EnvironmentIdentity)(environment, { onExcessProperty: "error" })
    },
    catch: (cause) =>
      cause instanceof KeyMaterialError ? cause : new KeyMaterialError({
        code: "invalid_environment",
        message:
          "Environment identity must contain only its declared fields, string layers, and string capability patterns"
      })
  })

const sortStrings = (values: ReadonlyArray<string>): Array<string> =>
  [...new Set(values.map((value) => value.normalize("NFC")))].sort()

const normalizeInputs = (inputs: ContentIdentity["inputs"]): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(inputs).map(([name, value]) => [
      name,
      isDigestInput(value)
        ? {
          kind: "digest",
          digest: value.digest,
          ...(value.reference === undefined ? {} : { reference: value.reference }),
          ...(value.path === undefined ? {} : { path: value.path })
        }
        : { kind: "literal", value }
    ])
  )

const normalizeCapabilities = (capabilities: ContentIdentity["capabilities"]): Record<string, Array<string>> =>
  Object.fromEntries(Object.entries(capabilities).map(([group, patterns]) => [group, sortStrings(patterns)]))

const normalizeEnvironment = (environment: EnvironmentIdentity) => ({
  declared: environment.declared,
  layers: environment.layers.map((layer) => layer.normalize("NFC")),
  capabilities: normalizeCapabilities(environment.capabilities),
  ...(environment.runScope === undefined ? {} : { runScope: environment.runScope })
})

const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : 1

type NormalizedWriteEntry =
  | string
  | { readonly _tag: "TreeArtifact"; readonly path: string }
  | {
    readonly _tag: "Glob"
    readonly include: ReadonlyArray<string>
    readonly exclude?: ReadonlyArray<string> | undefined
  }

const writeEntryKey = (entry: NormalizedWriteEntry): string =>
  typeof entry === "string"
    ? JSON.stringify(["Path", entry])
    : entry._tag === "TreeArtifact"
    ? JSON.stringify([entry._tag, entry.path])
    : JSON.stringify([entry._tag, entry.include, entry.exclude ?? null])

const normalizeHermetic = (hermetic: NonNullable<ContentIdentity["hermetic"]>) => {
  const readSet = [...hermetic.readSet]
    .map((entry) => ({ path: entry.path.normalize("NFC"), digest: entry.digest }))
    .sort((left, right) => {
      if (left.path !== right.path) return left.path < right.path ? -1 : 1
      return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0
    })
    .filter((entry, index, entries) =>
      index === 0 || entry.path !== entries[index - 1]!.path || entry.digest !== entries[index - 1]!.digest
    )
  const normalizedWrites = [...hermetic.writeSet].map((entry) => {
    if (typeof entry === "string") return entry.normalize("NFC")
    if (entry._tag === "TreeArtifact") return { ...entry, path: entry.path.normalize("NFC") }
    return {
      ...entry,
      include: sortStrings(entry.include),
      ...(entry.exclude === undefined ? {} : { exclude: sortStrings(entry.exclude) })
    }
  })
  const writeSet = [...new Map(normalizedWrites.map((entry) => [writeEntryKey(entry), entry])).entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, entry]) => entry)
  return {
    readSet,
    writeSet,
    ...(hermetic.removes === undefined ? {} : { removes: sortStrings(hermetic.removes) }),
    boundaryMode: hermetic.boundaryMode
  }
}

const decodeKey = Schema.decodeUnknownEffect(DerivedKey)

/**
 * Fingerprint for binding one execution to its runtime environment, not an
 * action dispatch key. Uses the same normalization as content/dispatch keys.
 * An omitted environment is distinct from declared-empty and run-scoped ones.
 * @since 1.0.0
 * @category constructors
 */
export const environmentIdentity = (
  environment?: EnvironmentIdentity
): Effect.Effect<StoredKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const captured = environment === undefined ? undefined : yield* decodeEnvironment(environment)
    return yield* decodeKey({
      kind: "execution-environment/v1",
      environment: captured === undefined ? null : normalizeEnvironment(captured)
    })
  })

/**
 * Produces a cross-run reusable key for a sealed or hermetic step. Set-like
 * declarations are normalized before serialization; write declarations remain
 * part of the identity even when the step writes nothing.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const content = (
  identity: ContentIdentity
): Effect.Effect<StepKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const environment = identity.environment === undefined ? undefined : yield* decodeEnvironment(identity.environment)
    return yield* decodeKey({
      kind: "content",
      body: identity.body,
      inputs: normalizeInputs(identity.inputs),
      layers: sortStrings(identity.layers),
      capabilities: normalizeCapabilities(identity.capabilities),
      ...(environment === undefined ? {} : { environment: normalizeEnvironment(environment) }),
      ...(identity.hermetic === undefined ? {} : { hermetic: normalizeHermetic(identity.hermetic) })
    })
  })

/**
 * Produces a run-local ordinal key for compensable, irreversible, or unsealed
 * work. These keys intentionally cannot be reused across runs.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const ordinal = (
  identity: OrdinalIdentity
): Effect.Effect<StepKey, Schema.SchemaError, Crypto.Crypto> => decodeKey({ kind: "ordinal", ...identity })

/**
 * Resolves graph-local references to dependency digests and constructs a
 * sealed content key. Use {@link planIdentity} to compile any effect tier.
 *
 * This is the handoff the Flow Builder Brief describes: the planner hands over
 * a topologically ordered sequence of `{ nodeId, material }`, and for each one
 * the compiler substitutes every `Ref`/`Pending` with the *already computed
 * key of the referenced node*. Structural node ids are lookup addresses only
 * and never enter the hashed value — rename a node and nothing re-keys; change
 * what a node consumes and everything downstream of it does.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const fromKeyMaterial = (
  material: KeyMaterial.KeyMaterial,
  dependencyDigests: Readonly<Record<string, string>>
): Effect.Effect<StepKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto> => {
  if (material.kind !== "sealed") {
    return Effect.fail(
      new KeyMaterialError({
        code: "non_content_material",
        message: `Cannot create a content key for ${material.kind} material`
      })
    )
  }
  return materialIdentity(material, dependencyDigests).pipe(Effect.flatMap(content))
}

/**
 * Identifies a declaration in a plan, independently of whether its execution
 * can be cached. Sealed material retains its existing content-key format;
 * compensable and irreversible material use a distinct, tier-bearing plan
 * namespace. These fingerprints bind approvals, not cross-run result reuse.
 * Dispatch non-cacheable work under a run-local {@link ordinal} instead.
 *
 * @since 1.0.0
 * @category constructors
 */
export const planIdentity = (
  material: KeyMaterial.KeyMaterial,
  dependencyDigests: Readonly<Record<string, string>>
): Effect.Effect<StepKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto> =>
  material.kind === "sealed" ?
    fromKeyMaterial(material, dependencyDigests) :
    materialIdentity(material, dependencyDigests).pipe(Effect.flatMap((identity) =>
      decodeKey({
        kind: "plan-declaration",
        tier: material.kind,
        body: identity.body,
        inputs: normalizeInputs(identity.inputs),
        layers: sortStrings(identity.layers),
        capabilities: normalizeCapabilities(identity.capabilities)
      })
    ))

/**
 * Reads the entry a graph reference names. Only an own data property counts:
 * an absent name or an accessor is a missing dependency, and no getter runs.
 * `label` names what the record holds, as each refusal says it.
 *
 * @private
 */
const ownDataProperty = (
  record: Readonly<Record<string, unknown>>,
  from: string,
  label: "Digest" | "Settled result"
): Effect.Effect<unknown, KeyMaterialError> => {
  const descriptor = Object.getOwnPropertyDescriptor(record, from)
  if (descriptor === undefined) {
    return Effect.fail(
      new KeyMaterialError({
        code: "missing_dependency",
        message: `Missing ${label.toLowerCase()} for graph dependency ${from}`
      })
    )
  }
  if (!("value" in descriptor)) {
    return Effect.fail(
      new KeyMaterialError({
        code: "missing_dependency",
        message: `${label} for graph dependency ${from} must be a data property`
      })
    )
  }
  return Effect.succeed(descriptor.value)
}

/**
 * The positional inputs both identities hash. A `Literal` contributes its raw
 * value, so `normalizeInputs` applies the one literal wrap; `resolve` supplies
 * the digest for each `Ref` and `Pending`, tagged with the reference variant.
 *
 * @private
 */
const resolveInputs = <E, R>(
  material: KeyMaterial.KeyMaterial,
  resolve: (reference: Exclude<KeyMaterial.InputRef, { readonly _tag: "Literal" }>) => Effect.Effect<string, E, R>
): Effect.Effect<Record<string, unknown>, E, R> =>
  Effect.gen(function*() {
    const inputs: Record<string, unknown> = {}
    for (let index = 0; index < material.inputs.length; index++) {
      const input = material.inputs[index]!
      if (input._tag === "Literal") {
        inputs[String(index)] = input.value
        continue
      }
      const digest = yield* resolve(input)
      inputs[String(index)] = input._tag === "Pending"
        ? digestInput(digest, { reference: "pending" })
        : input.path.length > 0
        ? digestInput(digest, { reference: "ref-projected", path: input.path })
        : digestInput(digest, { reference: "ref" })
    }
    return inputs
  })

/** Resolves plan references once for both content and non-cacheable declarations. */
const materialIdentity = (
  material: KeyMaterial.KeyMaterial,
  dependencyDigests: Readonly<Record<string, string>>
): Effect.Effect<ContentIdentity, KeyMaterialError> =>
  resolveInputs(
    material,
    (reference) =>
      Effect.flatMap(ownDataProperty(dependencyDigests, reference.from, "Digest"), (digest) =>
        typeof digest === "string" ? Effect.succeed(digest) : Effect.fail(
          new KeyMaterialError({
            code: "missing_dependency",
            message: `Digest for graph dependency ${reference.from} must be a string`
          })
        ))
  ).pipe(Effect.map((inputs) => ({
    body: materialBody(material),
    inputs,
    layers: material.layers,
    capabilities: { declared: material.capabilities }
  })))

/**
 * The node's own declaration, hashed. Shared by {@link planIdentity},
 * {@link fromKeyMaterial}, and {@link dispatchIdentity} so derivations cannot drift about what
 * "the node itself" means.
 *
 * @private
 */
const materialBody = (material: KeyMaterial.KeyMaterial) => ({
  version: material.version,
  declaration: material.body,
  ...(material.nondeterministic === undefined ? {} : { nondeterministic: material.nondeterministic }),
  ...(material.effects === undefined ? {} : { effects: material.effects }),
  ...(material.placement === undefined ? {} : { placement: material.placement })
})

/**
 * The digest a `Pending` input contributes to a dispatch key. It is a
 * constant, and that is the point: `Pending` is an ordering reference, and
 * ordering does not change what a node consumes, so it must not change what
 * the node caches under. The string is self-describing, so a reader of a
 * hashed payload can see that no upstream value was folded.
 *
 * @private
 */
const orderingOnly = "ordering-only"

/**
 * Projects a settled result along a `Ref` path. Only own data properties
 * resolve, so a missing, inherited, or accessor segment yields `undefined`
 * without invoking a getter. This is a stable, distinct value: a projection that
 * walks off the end of a result is a fact about the graph, not a failure.
 * `undefined` drops out of the canonical form, so it hashes distinctly from
 * every JSON value including `null`.
 *
 * Exported because it is the ONE projection semantics for the value channel:
 * {@link dispatchIdentity} digests what this returns, so every consumer that
 * resolves a `Ref` at execution time must resolve it the same way, or two
 * inputs that key identically could be consumed differently — a stale-hit
 * vector.
 *
 * @since 0.1.0
 * @category utilities
 * @slop
 */
export const project = (value: unknown, path: ReadonlyArray<string>): unknown => {
  let current = value
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(current, segment)
    if (descriptor === undefined || !("value" in descriptor)) return undefined
    current = descriptor.value
  }
  return current
}

/**
 * The key a dispatch is *cached* under, as distinct from the plan key a node
 * is *identified* by.
 *
 * A plan key folds the resolved keys of every upstream node, transitively, so
 * an edit anywhere upstream re-keys everything below it — even when the edited
 * node's output value is byte for byte what it was before. Bazel does not work
 * that way: `ActionCacheChecker` keys an action by the *content* of its
 * inputs, so an unchanged output stops invalidation dead. The file channel in
 * flows already had that property through the measured boundary digests; the
 * JSON value channel did not, and this is what gives it one.
 *
 * The derivation folds the node's OWN material — body, version, effects,
 * placement, layers, capabilities — and never an upstream key. Each material
 * input contributes content instead: a `Literal` its value, a `Ref` the digest
 * of the settled result of `from` projected along `path`, and a `Pending`
 * nothing beyond its tag. The measured hermetic boundary is folded unchanged.
 *
 * `results` must hold every dependency the material names. The scheduler's
 * halt rule guarantees it: a dependent of failed or skipped work never
 * dispatches, so a `Ref` always resolves against a success.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const dispatchIdentity = (options: {
  readonly material: KeyMaterial.KeyMaterial
  /** The settled output value of each dependency, by node id. */
  readonly results: Readonly<Record<string, unknown>>
  readonly hermetic: NonNullable<ContentIdentity["hermetic"]>
  /** The engine-resolved execution environment this dispatch runs under. */
  readonly environment?: EnvironmentIdentity | undefined
  /** Reuses projected-value digests while the corresponding settled values remain immutable. */
  readonly digestMemo?: DigestMemo | undefined
}): Effect.Effect<StepKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const material = options.material
    if (material.kind !== "sealed") {
      return yield* new KeyMaterialError({
        code: "non_content_material",
        message: `Cannot create a dispatch key for ${material.kind} material`
      })
    }
    const environment = options.environment === undefined ? undefined : yield* decodeEnvironment(options.environment)
    const inputs = yield* resolveInputs(material, (reference) =>
      reference._tag === "Pending"
        ? Effect.succeed(orderingOnly)
        : Effect.flatMap(ownDataProperty(options.results, reference.from, "Settled result"), (settled) => {
          const compute = decodeKey({ kind: "input-value", value: project(settled, reference.path) })
          return options.digestMemo === undefined
            ? compute
            : options.digestMemo.digest(reference.from, reference.path, compute)
        }))
    return yield* content({
      body: materialBody(material),
      inputs,
      layers: material.layers,
      capabilities: { declared: material.capabilities },
      environment,
      hermetic: options.hermetic
    })
  })

/**
 * In-memory capability grants with an attended Deferred request lifecycle.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Trust Granularity.md`.
 *
 * @since 1.0.0-rc.0
 */

import {
  type Capability,
  Capability as CapabilityValue,
  CapabilityPattern,
  type EffectTier,
  format,
  matches,
  maxResourceLength,
  parsePattern,
  patternFromCapability,
  subsumes,
  tierOf
} from "@smthrs/capability/Capability"
import {
  evaluate,
  GrantStoreError,
  type PermissionDenied,
  permissionDenied,
  type PermissionRequired,
  permissionRequired,
  Rule
} from "@smthrs/capability/Permission"
import { digestSync } from "@smthrs/crypto/Sha256"
import { Cause, Context, Deferred, Effect, Layer, Option, Schema, type Scope, Semaphore } from "effect"
import { allows, type CapabilitySet, current, fromPatterns, intersect } from "./CapabilitySet.ts"
import { DeniedGrant, EnvelopeGrant, type GrantEvent, OnceGrant, RememberedGrant, RunGrant } from "./GrantEvent.ts"
import { Workspace } from "./Workspace.ts"

/**
 * A capability request waiting for an attended reply.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface PendingRequest {
  readonly requestId: string
  readonly capability: Capability
  readonly tier: EffectTier
  readonly meta: Record<string, unknown>
}

/**
 * A resolution supplied by an attended permission surface.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Resolution = "once" | "run" | "remembered" | "deny"

/**
 * Scope and plan identity for a bulk envelope approval.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface EnvelopeGrantOptions {
  readonly planDigest: string
  readonly patterns: ReadonlyArray<CapabilityPattern>
  readonly scope?: "run" | "remembered" | undefined
}

/**
 * Operations exposed by the grant store.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Service {
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

/**
 * Service key for permission decisions and attended grant requests.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export class GrantStore extends Context.Service<GrantStore, Service>()("@smthrs/kernel/GrantStore") {}

/**
 * A hook that durably records a grant decision before it becomes active.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Persist = (event: GrantEvent) => Effect.Effect<void, GrantStoreError>

/**
 * Configuration for an in-memory grant store.
 *
 * A nested `rules` value is also accepted by the journal adapter: its first
 * ruleset is configured policy and subsequent rulesets are replayed remembered
 * grants.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface MakeOptions {
  readonly attended?: boolean | undefined
  readonly rules?: ReadonlyArray<Rule> | ReadonlyArray<ReadonlyArray<Rule>> | undefined
  /** Bare rules use the constructor ceiling; captured groups intersect it. */
  readonly runRules?:
    | ReadonlyArray<
      Rule | {
        readonly rule: Rule
        readonly ceiling: ReadonlyArray<ReadonlyArray<CapabilityPattern>>
      }
    >
    | undefined
  readonly envelope?: EnvelopeGrantOptions | undefined
  /**
   * {@link envelopeSignature} values of envelopes that are already durable —
   * typically replayed from a journal. A construction or runtime envelope
   * matching a seeded signature still activates its rules but is not
   * persisted again.
   */
  readonly envelopeSignatures?: ReadonlyArray<string> | undefined
  readonly runId?: string | undefined
  readonly planDigest?: string | undefined
  readonly persist?: Persist | undefined
}

interface PendingEntry extends PendingRequest {
  readonly ceiling: CapabilitySet
  readonly deferred: Deferred.Deferred<void, PermissionDenied>
}

/**
 * Maximum policy rules retained by one store.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumRules = 1_024
/**
 * Maximum predicates in one approval envelope.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumEnvelopePatterns = 256
/**
 * Maximum permission requests parked at once.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumPendingRequests = 1_024
/**
 * Maximum nesting depth of permission metadata.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumMetadataDepth = 16
/**
 * Maximum members across one permission metadata graph.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumMetadataMembers = 1_024
/**
 * Maximum encoded bytes retained for one metadata value.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumMetadataBytes = 64 * 1024
/**
 * Maximum encoded bytes persisted for one grant event.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumEventBytes = 256 * 1024
/**
 * Maximum milliseconds one grant journal write may take before its reply or
 * envelope admission fails with `journal_failed`. Journal writes never hold
 * the store's mutation permit, so a slow write stalls only the admission that
 * issued it.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumPersistMillis = 30_000
/**
 * Maximum length of a run, plan, request, or signature identity.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumIdentityLength = 4_096
/**
 * Maximum capability resource length enforced by the capability vocabulary.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumCapabilityResourceLength = maxResourceLength

const encoder = new TextEncoder()

const isWellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

const invalid = (message: string): GrantStoreError => new GrantStoreError({ code: "invalid_resolution", message })

const immutableFields = <A extends object, K extends keyof A>(
  value: A,
  fields: ReadonlyArray<K>
): A => {
  for (const field of fields) {
    Object.defineProperty(value, field, {
      value: value[field],
      enumerable: true,
      writable: false,
      configurable: false
    })
  }
  return value
}

const snapshotCapability = (capability: Capability): Capability =>
  immutableFields(
    new CapabilityValue({ action: capability.action, resource: capability.resource }),
    ["action", "resource"]
  )

const snapshotPattern = (pattern: CapabilityPattern): CapabilityPattern =>
  immutableFields(
    new CapabilityPattern({ action: pattern.action, resource: pattern.resource }),
    ["action", "resource"]
  )

const snapshotRule = (rule: Rule): Rule =>
  immutableFields(
    new Rule({ effect: rule.effect, pattern: snapshotPattern(rule.pattern) }),
    ["effect", "pattern"]
  )

const snapshotFailure = (what: string, cause: unknown): GrantStoreError =>
  cause instanceof GrantStoreError ? cause : invalid(`${what} is invalid`)

const attemptSnapshot = <A>(what: string, evaluate: () => A): Effect.Effect<A, GrantStoreError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => snapshotFailure(what, cause)
  })

type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

const metadataSnapshot = (input: Readonly<Record<string, unknown>>): Readonly<Record<string, Json>> => {
  let members = 0
  const active = new WeakSet<object>()

  const visit = (value: unknown, depth: number): Json => {
    if (depth > maximumMetadataDepth) throw invalid(`metadata exceeds depth ${maximumMetadataDepth}`)
    if (value === null || typeof value === "boolean") return value
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw invalid("metadata contains a non-finite number")
      return value
    }
    if (typeof value === "string") {
      if (!isWellFormed(value)) throw invalid("metadata contains ill-formed text")
      if (value.length > maximumMetadataBytes) throw invalid(`metadata exceeds ${maximumMetadataBytes} bytes`)
      return value
    }
    if (typeof value !== "object" || value === null) throw invalid("metadata must be JSON data")
    if (active.has(value)) throw invalid("metadata must not contain cycles")
    active.add(value)
    try {
      if (Array.isArray(value)) {
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const snapshot: Array<Json> = []
        for (let index = 0; index < value.length; index += 1) {
          members += 1
          if (members > maximumMetadataMembers) {
            throw invalid(`metadata exceeds ${maximumMetadataMembers} members`)
          }
          const descriptor = descriptors[String(index)]
          if (descriptor === undefined || !("value" in descriptor)) {
            throw invalid("metadata arrays must be dense data")
          }
          snapshot.push(visit(descriptor.value, depth + 1))
        }
        return Object.freeze(snapshot)
      }

      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalid("metadata objects must be plain records")
      }
      const snapshot: Record<string, Json> = {}
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable) continue
        members += 1
        if (members > maximumMetadataMembers) {
          throw invalid(`metadata exceeds ${maximumMetadataMembers} members`)
        }
        if (!isWellFormed(key) || !("value" in descriptor)) {
          throw invalid("metadata members must be well-formed data properties")
        }
        if (descriptor.value !== undefined) snapshot[key] = visit(descriptor.value, depth + 1)
      }
      return Object.freeze(snapshot)
    } finally {
      active.delete(value)
    }
  }

  const snapshot = visit(input, 0)
  if (Array.isArray(snapshot) || snapshot === null || typeof snapshot !== "object") {
    throw invalid("metadata must be a record")
  }
  const encoded = JSON.stringify(snapshot)
  if (encoder.encode(encoded).byteLength > maximumMetadataBytes) {
    throw invalid(`metadata exceeds ${maximumMetadataBytes} bytes`)
  }
  return snapshot as Readonly<Record<string, Json>>
}

const validIdentity = (value: unknown): value is string | undefined =>
  value === undefined ||
  (typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumIdentityLength &&
    isWellFormed(value) &&
    !value.includes("\0"))

const prepareEnvelope = (
  input: EnvelopeGrantOptions,
  expectedPlanDigest: string | undefined,
  workspaceRoot: string
): Effect.Effect<{
  readonly planDigest: string
  readonly scope: "run" | "remembered"
  readonly patterns: ReadonlyArray<CapabilityPattern>
}, GrantStoreError> =>
  attemptSnapshot("grant envelope", () => {
    if (!Array.isArray(input.patterns)) throw invalid("patterns must be an array")
    if (input.patterns.length > maximumEnvelopePatterns) {
      throw invalid(`patterns exceed ${maximumEnvelopePatterns} entries`)
    }
    const patterns = canonicalEnvelopePatterns(input.patterns)
    // An empty envelope carries no authority. It is deliberately a no-op even
    // when replayed without the plan identity that authorized a non-empty one.
    if (patterns.length === 0) {
      return { planDigest: expectedPlanDigest ?? "", scope: "run" as const, patterns }
    }
    const scope = input.scope ?? "run"
    if (!isEnvelopeScope(scope)) throw invalid("scope must be run or remembered")
    if (expectedPlanDigest === undefined) throw invalid("grant envelope requires a configured planDigest")
    if (!validIdentity(input.planDigest)) throw invalid("planDigest is empty, malformed, or too long")
    if (input.planDigest !== expectedPlanDigest) throw invalid("planDigest mismatch")
    for (let index = 0; index < patterns.length; index += 1) {
      if (!isValidEnvelopePattern(patterns[index]!, workspaceRoot)) {
        throw invalid(`patterns[${index}] is outside the workspace envelope`)
      }
    }
    return { planDigest: input.planDigest, scope, patterns }
  })

/**
 * Records the displayed capability for once/deny audit events, which are never
 * installed or replayed as authority.
 */
const exactPattern = (capability: Capability): CapabilityPattern =>
  new CapabilityPattern({
    action: capability.action,
    resource: capability.resource
  })

const hasResourceWildcard = (resource: string): boolean => resource.includes("*") || resource.includes("?")

const isResolution = (value: string): value is Resolution =>
  value === "once" || value === "run" || value === "remembered" || value === "deny"

const isEnvelopeScope = (value: string): value is "run" | "remembered" => value === "run" || value === "remembered"

/**
 * Canonicalizes an envelope pattern list: duplicate predicates collapse to
 * their first occurrence and the survivors sort by their formatted identity.
 *
 * An envelope is a *set* of predicates, so two envelopes listing the same
 * predicates in a different order or multiplicity are the same approval. Every
 * envelope is canonicalized before it is persisted or compared, which makes
 * envelope idempotency structural rather than dependent on caller discipline.
 *
 * The ordering is the code-unit sort of `format(pattern)` — the one renderer
 * for capability identity. RFC 8785 canonical JSON (`@smthrs/canonical`)
 * was considered and does not fit: it canonicalizes object keys but preserves
 * array order as semantic, and the ordering that matters here is exactly the
 * pattern-array order.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const canonicalEnvelopePatterns = (
  patterns: ReadonlyArray<CapabilityPattern>
): ReadonlyArray<CapabilityPattern> => {
  const byIdentity = new Map<string, CapabilityPattern>()
  for (const input of patterns) {
    const pattern = snapshotPattern(input)
    const identity = format(pattern)
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, pattern)
    }
  }
  return Object.freeze([...byIdentity.keys()].sort().map((identity) => byIdentity.get(identity)!))
}

const envelopeEncoding = (
  planDigest: string,
  scope: "run" | "remembered",
  patterns: ReadonlyArray<CapabilityPattern>
): string => JSON.stringify({ planDigest, scope, patterns: canonicalEnvelopePatterns(patterns).map(format) })

/**
 * Computes the canonical identity of an envelope approval.
 *
 * Two envelopes with the same plan digest, scope, and predicate set produce
 * the same signature regardless of pattern order or repetition. The signature
 * is how the store, and journal replay above it, recognise an envelope that
 * is already durable. It is `sha256:` followed by 64 lowercase hex digits.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const envelopeSignature = (
  planDigest: string,
  scope: "run" | "remembered",
  patterns: ReadonlyArray<CapabilityPattern>
): string => `sha256:${digestSync(envelopeEncoding(planDigest, scope, patterns))}`

const decodeLegacySignature = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Struct({
    planDigest: Schema.String,
    scope: Schema.Literals(["run", "remembered"]),
    patterns: Schema.Array(Schema.String).check(Schema.isMaxLength(maximumEnvelopePatterns))
  })),
  { onExcessProperty: "error" }
)

// v1 events contain predicates, not signatures, and replay hashes them afresh.
// Also accept canonical full-JSON identities supplied by older seed callers.
const normalizeEnvelopeSignature = (value: string): string => {
  if (!value.startsWith("{")) return value
  if (value.length > maximumEventBytes || encoder.encode(value).byteLength > maximumEventBytes) return value
  const decoded = decodeLegacySignature(value)
  if (decoded._tag === "Failure" || !validIdentity(decoded.success.planDigest)) return value
  const { planDigest, scope, patterns } = decoded.success
  const parsed = Option.all(patterns.map(parsePattern))
  if (Option.isNone(parsed) || envelopeEncoding(planDigest, scope, parsed.value) !== value) return value
  return envelopeSignature(planDigest, scope, parsed.value)
}

/**
 * Checks that a request-scoped grant cannot authorize a different action or a
 * more dangerous effect tier than the request displayed to the user. A
 * wildcard-bearing pattern identical to the resource is ambiguous because the
 * grammar has no escape, so its wildcard reading would silently widen access.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const isValidGrantPattern = (
  pattern: CapabilityPattern,
  capability: Capability,
  tier: EffectTier,
  workspaceRoot: string
): boolean => {
  if (pattern.action !== capability.action || !matches(pattern, capability)) {
    return false
  }
  if (hasResourceWildcard(pattern.resource) && pattern.resource === capability.resource) {
    return false
  }
  if (tierOf(capability, { workspaceRoot }) !== tier) {
    return false
  }
  if (capability.action !== "fs:write") {
    return true
  }
  if (tier === "irreversible") {
    return !hasResourceWildcard(pattern.resource)
  }
  const workspacePattern = new CapabilityPattern({
    action: "fs:write",
    resource: `${workspaceRoot.replace(/[\\/]+$/, "")}/**`
  })
  return pattern.resource === workspaceRoot || subsumes(workspacePattern, pattern)
}

/**
 * Checks that a bulk envelope pattern preserves exact action and filesystem
 * effect-tier boundaries.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const isValidEnvelopePattern = (
  pattern: CapabilityPattern,
  workspaceRoot: string
): boolean => {
  if (pattern.action.includes("*")) {
    return false
  }
  if (pattern.action !== "fs:write" || !hasResourceWildcard(pattern.resource)) {
    return true
  }
  const workspacePattern = new CapabilityPattern({
    action: "fs:write",
    resource: `${workspaceRoot.replace(/[\\/]+$/, "")}/**`
  })
  return subsumes(workspacePattern, pattern)
}

const normalizeRules = (
  rules: MakeOptions["rules"]
): {
  readonly configured: ReadonlyArray<Rule>
  readonly remembered: ReadonlyArray<Rule>
} => {
  if (rules === undefined || rules.length === 0 || rules[0] === undefined) {
    return { configured: [], remembered: [] }
  }
  if (rules.length > maximumRules) throw invalid(`rules exceed ${maximumRules} entries`)
  if (Array.isArray(rules[0])) {
    const rulesets = rules as ReadonlyArray<ReadonlyArray<Rule>>
    let count = 0
    for (const ruleset of rulesets) {
      count += ruleset.length
      if (count > maximumRules) throw invalid(`rules exceed ${maximumRules} entries`)
    }
    return {
      configured: Object.freeze(rulesets[0]!.map(snapshotRule)),
      remembered: Object.freeze(rulesets.slice(1).flatMap((ruleset) => ruleset.map(snapshotRule)))
    }
  }
  return {
    configured: Object.freeze((rules as ReadonlyArray<Rule>).map(snapshotRule)),
    remembered: []
  }
}

/**
 * Builds an in-memory grant store.
 *
 * Attended stores suspend an asking fiber on a request-local `Deferred`.
 * Unattended stores fail immediately with `PermissionRequired`. The returned
 * service is scoped: closing its scope rejects every waiter and clears the
 * pending map.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = (
  options: MakeOptions = {}
): Effect.Effect<Service, GrantStoreError, Scope.Scope | Workspace> =>
  Effect.gen(function*() {
    const attended = options.attended ?? true
    const runId = options.runId
    const planDigest = options.planDigest
    if (!validIdentity(runId)) {
      return yield* Effect.fail(invalid("runId is empty, malformed, or too long"))
    }
    if (!validIdentity(planDigest)) {
      return yield* Effect.fail(invalid("planDigest is empty, malformed, or too long"))
    }
    const workspace = yield* Workspace
    const initialCeiling = yield* current
    const workspaceRoot = workspace.root
    const initial = yield* attemptSnapshot("rules", () => normalizeRules(options.rules))
    const initialRunRules = yield* attemptSnapshot("runRules", () => {
      const values = options.runRules ?? []
      if (values.length > maximumRules) throw invalid(`runRules exceed ${maximumRules} entries`)
      return values.map((value) =>
        "rule" in value
          ? {
            rule: snapshotRule(value.rule),
            ceiling: value.ceiling.reduce(
              (ceiling, group) => intersect(ceiling, fromPatterns(group)),
              initialCeiling
            )
          }
          : { rule: snapshotRule(value), ceiling: initialCeiling }
      )
    })
    if (initial.configured.length + initial.remembered.length + initialRunRules.length > maximumRules) {
      return yield* Effect.fail(invalid(`rules exceed ${maximumRules} entries`))
    }
    const configuredRules = initial.configured
    const envelopeRules: Array<Rule> = []
    const runRules = initialRunRules
    const rememberedRules = [...initial.remembered]
    const pending = new Map<string, PendingEntry>()
    const persist = options.persist ?? (() => Effect.void)
    const signatures = yield* attemptSnapshot("envelopeSignatures", () => {
      const values = options.envelopeSignatures ?? []
      if (!Array.isArray(values) || values.length > maximumRules) {
        throw invalid(`envelopeSignatures exceed ${maximumRules} entries`)
      }
      return values.map((value, index) => {
        const signature = typeof value === "string" ? normalizeEnvelopeSignature(value) : value
        if (typeof signature !== "string" || !validIdentity(signature)) {
          throw invalid(`envelopeSignatures[${index}] is malformed or too long`)
        }
        return signature
      })
    })
    const grantedEnvelopes = new Set<string>(signatures)
    let nextRequestId = 1
    let closed = false
    const mutation = yield* Semaphore.make(1)

    const persistEvent = (event: GrantEvent): Effect.Effect<void, GrantStoreError> => {
      // Every event is constructed below exclusively from validated primitive
      // identities and immutable capability snapshots, so encoding cannot
      // observe caller objects or invoke a caller-defined `toJSON` hook.
      const bytes = encoder.encode(JSON.stringify(event)).byteLength
      return bytes > maximumEventBytes
        ? Effect.fail(invalid(`grant event exceeds ${maximumEventBytes} bytes`))
        : Effect.timeoutOrElse(persist(event), {
          duration: maximumPersistMillis,
          orElse: () =>
            Effect.fail(
              new GrantStoreError({
                code: "journal_failed",
                message: `grant journal write exceeded ${maximumPersistMillis}ms`
              })
            )
        })
    }

    const invalidRemembered = rememberedRules.findIndex((rule) =>
      rule.effect === "allow" && !isValidEnvelopePattern(rule.pattern, workspaceRoot)
    )
    if (invalidRemembered !== -1) {
      return yield* Effect.fail(invalid(`rememberedRules[${invalidRemembered}] is outside the workspace envelope`))
    }
    const invalidRun = runRules.findIndex(({ rule }) =>
      rule.effect === "allow" && !isValidEnvelopePattern(rule.pattern, workspaceRoot)
    )
    if (invalidRun !== -1) {
      return yield* Effect.fail(invalid(`runRules[${invalidRun}] is outside the workspace envelope`))
    }

    // Construction envelopes validate capacity before persistence or
    // activation. A seeded construction envelope may already have rules
    // installed by replay. Runtime admission is two-phase in grantEnvelope.
    const admitEnvelope = (
      envelope: Effect.Success<ReturnType<typeof prepareEnvelope>>
    ): Effect.Effect<boolean, GrantStoreError> =>
      Effect.gen(function*() {
        const { patterns, scope } = envelope
        if (patterns.length === 0) return false
        const signature = envelopeSignature(envelope.planDigest, scope, patterns)
        const durable = grantedEnvelopes.has(signature)
        const destination = scope === "remembered" ? rememberedRules : envelopeRules
        const replayed = scope === "remembered"
          ? rememberedRules
          : runRules.filter(({ ceiling }) => ceiling === initialCeiling).map(({ rule }) => rule)
        const existing = new Set<string>()
        for (const rule of replayed) {
          // Supplied rules can mask earlier grants. Only the trailing allow
          // rules (including journal replay) can replace a fresh activation.
          if (rule.effect === "allow") existing.add(format(rule.pattern))
          else existing.clear()
        }
        const incoming = durable ? patterns.filter((pattern) => !existing.has(format(pattern))) : patterns
        if (
          configuredRules.length + envelopeRules.length + runRules.length + rememberedRules.length +
              incoming.length > maximumRules
        ) {
          return yield* Effect.fail(invalid(`rules exceed ${maximumRules} entries`))
        }
        if (!durable && grantedEnvelopes.size >= maximumRules) {
          return yield* Effect.fail(invalid(`grant envelopes exceed ${maximumRules} entries`))
        }
        if (!durable) {
          yield* persistEvent(
            new EnvelopeGrant({
              eventType: "flows.kernel.grant.envelope.v1",
              runId: runId ?? "",
              planDigest: envelope.planDigest,
              patterns,
              scope
            })
          )
          grantedEnvelopes.add(signature)
        }
        for (const pattern of incoming) {
          destination.push(snapshotRule(new Rule({ effect: "allow", pattern })))
        }
        return true
      })

    if (options.envelope !== undefined) {
      const envelope = yield* prepareEnvelope(options.envelope, planDigest, workspaceRoot)
      yield* admitEnvelope(envelope)
    }

    const rulesets = (capability: Capability): ReadonlyArray<ReadonlyArray<Rule>> => [
      configuredRules,
      envelopeRules,
      runRules
        .filter(({ ceiling }) => allows(ceiling, capability))
        .map(({ rule }) => rule),
      rememberedRules
    ]

    yield* Effect.addFinalizer(() =>
      mutation.withPermit(
        Effect.gen(function*() {
          closed = true
          const entries = [...pending.values()]
          pending.clear()
          yield* Effect.forEach(
            entries,
            (entry) =>
              Deferred.fail(
                entry.deferred,
                permissionDenied(entry.capability, "grant store closed")
              ),
            { discard: true }
          )
        })
      )
    )

    const allocateRequest = (
      capability: Capability,
      tier: EffectTier,
      meta: Record<string, unknown>,
      ceiling: CapabilitySet
    ): Effect.Effect<PendingEntry, GrantStoreError> =>
      Effect.gen(function*() {
        if (pending.size >= maximumPendingRequests) {
          return yield* Effect.fail(invalid(`pending requests exceed ${maximumPendingRequests} entries`))
        }
        const requestId = `permission-${nextRequestId++}`
        const deferred = yield* Deferred.make<void, PermissionDenied>()
        const entry: PendingEntry = {
          requestId,
          capability,
          tier,
          meta,
          ceiling,
          deferred
        }
        pending.set(requestId, entry)
        return entry
      })

    const nextUnattendedRequestId = Effect.sync(() => `permission-${nextRequestId++}`)

    const check: Service["check"] = Effect.fn("GrantStore.check")((capability, meta = {}) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          const request = yield* attemptSnapshot("permission request", () => ({
            capability: snapshotCapability(capability),
            meta: metadataSnapshot(meta)
          }))
          // The permit guards only in-memory state, so acquiring it is
          // interruptible: a cancelled caller is released instead of queueing
          // uninterruptibly. The critical section itself stays uninterruptible.
          const entry = yield* restore(mutation.take(1)).pipe(
            Effect.andThen(
              Effect.gen(function*() {
                if (closed) {
                  return yield* Effect.fail(new GrantStoreError({ code: "store_closed" }))
                }
                const ceiling = yield* current
                if (!allows(ceiling, request.capability)) {
                  return yield* Effect.fail(permissionDenied(request.capability, "outside capability ceiling"))
                }

                const decision = evaluate(rulesets(request.capability), request.capability)
                if (decision === "allow") {
                  return undefined
                }
                if (decision === "deny") {
                  return yield* Effect.fail(permissionDenied(request.capability, "denied by permission policy"))
                }

                const tier = tierOf(request.capability, { workspaceRoot })
                if (!attended) {
                  const requestId = yield* nextUnattendedRequestId
                  return yield* Effect.fail(
                    permissionRequired({
                      requestId,
                      runId,
                      capability: request.capability,
                      tier,
                      meta: request.meta
                    })
                  )
                }

                return yield* allocateRequest(
                  request.capability,
                  tier,
                  request.meta,
                  ceiling
                )
              }).pipe(Effect.ensuring(mutation.release(1)))
            )
          )
          if (entry === undefined) {
            return
          }
          return yield* restore(Deferred.await(entry.deferred)).pipe(
            Effect.ensuring(
              mutation.withPermit(
                Effect.sync(() => {
                  pending.delete(entry.requestId)
                })
              )
            )
          )
        })
      )
    )

    const resolveCovered: Effect.Effect<void> = Effect.suspend(() =>
      Effect.forEach(
        [...pending.entries()],
        ([requestId, entry]) => {
          if (
            !allows(entry.ceiling, entry.capability) ||
            evaluate(rulesets(entry.capability), entry.capability) !== "allow"
          ) {
            return Effect.void
          }
          return Deferred.succeed(entry.deferred, undefined).pipe(
            Effect.andThen(
              Effect.sync(() => {
                pending.delete(requestId)
              })
            )
          )
        },
        { discard: true }
      ).pipe(Effect.asVoid)
    )

    // Requests and envelopes with a journal write in flight. The mutation
    // permit guards only in-memory state: a decision is planned under the
    // permit, persisted without it, then activated under it again.
    const resolving = new Set<string>()
    const granting = new Map<string, Deferred.Deferred<void, GrantStoreError>>()
    // Planned rules occupy capacity until their write fails or they activate.
    // Replies and envelopes share this count, guarded by the mutation permit.
    let reservedRules = 0

    type PlannedReply =
      | {
        readonly resolution: "once" | "deny"
        readonly entry: PendingEntry
        readonly event: GrantEvent
      }
      | {
        readonly resolution: "run" | "remembered"
        readonly entry: PendingEntry
        readonly rule: Rule
        readonly event: GrantEvent
      }

    const planReply = (
      requestId: string,
      resolution: Resolution,
      suppliedPattern: CapabilityPattern | undefined
    ): Effect.Effect<PlannedReply, GrantStoreError> =>
      Effect.gen(function*() {
        if (closed) {
          return yield* Effect.fail(new GrantStoreError({ code: "store_closed" }))
        }
        if (!isResolution(resolution)) {
          // A runtime-invalid resolution must fail the reply, not fall
          // through the switch below: silently succeeding would strand
          // the request's waiter on its Deferred forever. The request
          // stays pending so the caller can still answer it.
          return yield* Effect.fail(
            new GrantStoreError({
              code: "invalid_resolution",
              message: "unknown grant resolution"
            })
          )
        }
        const entry = pending.get(requestId)
        // A request whose decision is already being persisted is decided:
        // the losing reply fails fast instead of queueing behind the journal.
        if (entry === undefined || resolving.has(requestId)) {
          return yield* Effect.fail(new GrantStoreError({ code: "request_not_found" }))
        }
        const pattern = yield* attemptSnapshot("grant pattern", () => {
          if (resolution === "run" || resolution === "remembered") {
            if (suppliedPattern !== undefined) return snapshotPattern(suppliedPattern)
            const derived = patternFromCapability(entry.capability)
            if (Option.isNone(derived)) {
              throw invalid(
                "the requested resource contains glob metacharacters; supply an explicit grant pattern or resolve once"
              )
            }
            return snapshotPattern(derived.value)
          }
          return snapshotPattern(exactPattern(entry.capability))
        })

        switch (resolution) {
          case "once": {
            resolving.add(requestId)
            return {
              resolution,
              entry,
              event: new OnceGrant({
                eventType: "flows.kernel.grant.once.v1",
                requestId,
                runId: runId ?? "",
                ...(planDigest === undefined ? {} : { planDigest }),
                capability: entry.capability,
                pattern,
                scope: "once",
                tier: entry.tier
              })
            }
          }
          case "run": {
            if (planDigest === undefined) {
              return yield* Effect.fail(
                new GrantStoreError({
                  code: "invalid_resolution",
                  message: "run grants require a plan digest"
                })
              )
            }
            if (!isValidGrantPattern(pattern, entry.capability, entry.tier, workspaceRoot)) {
              return yield* Effect.fail(invalid("grant pattern exceeds the requested authority"))
            }
            if (
              configuredRules.length + envelopeRules.length + runRules.length + rememberedRules.length +
                  reservedRules >=
                maximumRules
            ) {
              return yield* Effect.fail(invalid(`rules exceed ${maximumRules} entries`))
            }
            resolving.add(requestId)
            reservedRules += 1
            return {
              resolution,
              entry,
              rule: snapshotRule(new Rule({ effect: "allow", pattern })),
              event: new RunGrant({
                eventType: "flows.kernel.grant.run.v2",
                requestId,
                runId: runId ?? "",
                planDigest,
                capability: entry.capability,
                pattern,
                ceiling: entry.ceiling.groups,
                scope: "run",
                tier: entry.tier
              })
            }
          }
          case "remembered": {
            if (!isValidGrantPattern(pattern, entry.capability, entry.tier, workspaceRoot)) {
              return yield* Effect.fail(invalid("grant pattern exceeds the requested authority"))
            }
            if (
              configuredRules.length + envelopeRules.length + runRules.length + rememberedRules.length +
                  reservedRules >=
                maximumRules
            ) {
              return yield* Effect.fail(invalid(`rules exceed ${maximumRules} entries`))
            }
            resolving.add(requestId)
            reservedRules += 1
            return {
              resolution,
              entry,
              rule: snapshotRule(new Rule({ effect: "allow", pattern })),
              event: new RememberedGrant({
                eventType: "flows.kernel.grant.remembered.v1",
                requestId,
                runId: runId ?? "",
                ...(planDigest === undefined ? {} : { planDigest }),
                capability: entry.capability,
                pattern,
                scope: "remembered",
                tier: entry.tier
              })
            }
          }
          case "deny": {
            resolving.add(requestId)
            return {
              resolution,
              entry,
              event: new DeniedGrant({
                eventType: "flows.kernel.grant.denied.v1",
                requestId,
                runId: runId ?? "",
                ...(planDigest === undefined ? {} : { planDigest }),
                capability: entry.capability,
                pattern,
                scope: "once",
                tier: entry.tier
              })
            }
          }
        }
      })

    const activateReply = (requestId: string, planned: PlannedReply): Effect.Effect<void, GrantStoreError> =>
      Effect.gen(function*() {
        resolving.delete(requestId)
        if (planned.resolution === "run" || planned.resolution === "remembered") reservedRules -= 1
        if (closed) {
          return yield* Effect.fail(new GrantStoreError({ code: "store_closed" }))
        }
        const entry = pending.get(requestId)
        switch (planned.resolution) {
          case "once": {
            if (entry === undefined) {
              return yield* Effect.fail(new GrantStoreError({ code: "request_not_found" }))
            }
            yield* Deferred.succeed(entry.deferred, undefined)
            pending.delete(requestId)
            return
          }
          case "deny": {
            if (entry === undefined) {
              return yield* Effect.fail(new GrantStoreError({ code: "request_not_found" }))
            }
            yield* Deferred.fail(
              entry.deferred,
              permissionDenied(entry.capability, "permission request denied")
            )
            pending.delete(requestId)
            return
          }
          case "run": {
            // The decision is already durable, so the rule activates even
            // when the request's own waiter left while the journal wrote:
            // replay installs it on the next open and the live store must
            // not diverge from the journal. Capacity was validated before
            // persistence.
            runRules.push({ rule: planned.rule, ceiling: planned.entry.ceiling })
            yield* resolveCovered
            return
          }
          case "remembered": {
            rememberedRules.push(planned.rule)
            yield* resolveCovered
            return
          }
        }
      })

    const reply: Service["reply"] = Effect.fn("GrantStore.reply")((
      requestId,
      resolution,
      suppliedPattern
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          const planned = yield* mutation.withPermit(planReply(requestId, resolution, suppliedPattern))
          // Journal IO never holds the permit: only this reply waits on it,
          // interruptibly, so the write deadline can fire and a cancelled
          // reply is released. A failed write clears the in-flight mark so
          // the request stays retryable.
          yield* restore(persistEvent(planned.event)).pipe(
            Effect.onError(() =>
              mutation.withPermit(
                Effect.sync(() => {
                  resolving.delete(requestId)
                  if (planned.resolution === "run" || planned.resolution === "remembered") reservedRules -= 1
                })
              )
            )
          )
          yield* mutation.withPermit(activateReply(requestId, planned))
        })
      )
    )

    const list: Service["list"] = Effect.fn("GrantStore.list")(() =>
      mutation.withPermit(
        Effect.sync(() =>
          // Every entry's meta is already the frozen snapshot taken at check
          // time; list copies the array and re-wraps identity without
          // re-walking or re-serializing the metadata graph.
          Object.freeze(Array.from(
            pending.values(),
            ({ requestId, capability, tier, meta }): PendingRequest =>
              Object.freeze({
                requestId,
                capability: snapshotCapability(capability),
                tier,
                meta
              })
          ))
        )
      )
    )()

    type EnvelopeAdmission =
      | { readonly _tag: "Durable" }
      | { readonly _tag: "Wait"; readonly completion: Deferred.Deferred<void, GrantStoreError> }
      | {
        readonly _tag: "Fresh"
        readonly signature: string
        readonly scope: "run" | "remembered"
        readonly patterns: ReadonlyArray<CapabilityPattern>
        readonly completion: Deferred.Deferred<void, GrantStoreError>
        readonly event: GrantEvent
      }

    const planEnvelope = (
      envelope: Effect.Success<ReturnType<typeof prepareEnvelope>>
    ): Effect.Effect<EnvelopeAdmission, GrantStoreError> =>
      Effect.gen(function*() {
        if (closed) {
          return yield* Effect.fail(new GrantStoreError({ code: "store_closed" }))
        }
        const { patterns, scope } = envelope
        const signature = envelopeSignature(envelope.planDigest, scope, patterns)
        if (grantedEnvelopes.has(signature)) return { _tag: "Durable" as const }
        // A concurrent admission of the same envelope is already persisting;
        // wait for its outcome rather than writing a duplicate record.
        const inFlight = granting.get(signature)
        if (inFlight !== undefined) return { _tag: "Wait" as const, completion: inFlight }
        if (
          configuredRules.length + envelopeRules.length + runRules.length + rememberedRules.length +
              reservedRules + patterns.length > maximumRules
        ) {
          return yield* Effect.fail(invalid(`rules exceed ${maximumRules} entries`))
        }
        if (grantedEnvelopes.size + granting.size >= maximumRules) {
          return yield* Effect.fail(invalid(`grant envelopes exceed ${maximumRules} entries`))
        }
        const completion = yield* Deferred.make<void, GrantStoreError>()
        granting.set(signature, completion)
        reservedRules += patterns.length
        return {
          _tag: "Fresh" as const,
          signature,
          scope,
          patterns,
          completion,
          event: new EnvelopeGrant({
            eventType: "flows.kernel.grant.envelope.v1",
            runId: runId ?? "",
            planDigest: envelope.planDigest,
            patterns,
            scope
          })
        }
      })

    const activateEnvelope = (
      planned: Extract<EnvelopeAdmission, { readonly _tag: "Fresh" }>
    ): Effect.Effect<void, GrantStoreError> =>
      Effect.gen(function*() {
        granting.delete(planned.signature)
        reservedRules -= planned.patterns.length
        if (closed) {
          return yield* Effect.fail(new GrantStoreError({ code: "store_closed" }))
        }
        // The decision is already durable, so its rules activate without
        // re-checking capacity: replay installs them on the next open and the
        // live store must not diverge from the journal.
        grantedEnvelopes.add(planned.signature)
        const destination = planned.scope === "remembered" ? rememberedRules : envelopeRules
        for (const pattern of planned.patterns) {
          destination.push(snapshotRule(new Rule({ effect: "allow", pattern })))
        }
        yield* resolveCovered
      })

    const grantEnvelope: Service["grantEnvelope"] = Effect.fn("GrantStore.grantEnvelope")((input) =>
      Effect.uninterruptibleMask((restore) => {
        const admit = (
          prepared: Effect.Success<ReturnType<typeof prepareEnvelope>>
        ): Effect.Effect<void, GrantStoreError> =>
          Effect.gen(function*() {
            const planned = yield* mutation.withPermit(planEnvelope(prepared))
            switch (planned._tag) {
              case "Durable":
                return
              case "Wait": {
                // The identical envelope is mid-flight elsewhere; adopt its
                // outcome. A failed write fails here too: re-planning would
                // turn one journal outage into an unbounded loop of writes.
                // An interrupted first admission decided nothing and can be
                // retried. Check this caller's cancellation before re-planning
                // so an interrupted duplicate cannot loop under the mask.
                return yield* restore(Deferred.await(planned.completion)).pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? restore(Effect.void).pipe(Effect.andThen(admit(prepared)))
                      : Effect.failCause(cause)
                  )
                )
              }
              case "Fresh": {
                // Journal IO never holds the permit: only this admission
                // waits on it, interruptibly, so the write deadline can fire.
                // Concurrent duplicates are released with the same outcome.
                yield* restore(persistEvent(planned.event)).pipe(
                  Effect.onError((cause) =>
                    mutation.withPermit(
                      Effect.gen(function*() {
                        granting.delete(planned.signature)
                        reservedRules -= planned.patterns.length
                        yield* Deferred.failCause(planned.completion, cause)
                      })
                    )
                  )
                )
                yield* mutation.withPermit(activateEnvelope(planned)).pipe(
                  Effect.tap(() => Deferred.succeed(planned.completion, undefined)),
                  Effect.onError((cause) => Deferred.failCause(planned.completion, cause))
                )
                return
              }
            }
          })
        return Effect.gen(function*() {
          const prepared = yield* prepareEnvelope(input, planDigest, workspaceRoot)
          if (prepared.patterns.length === 0) return
          yield* admit(prepared)
        })
      })
    )

    return GrantStore.of({ check, reply, list, grantEnvelope })
  })

/**
 * Provides a scoped in-memory grant store.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (
  options: MakeOptions = {}
): Layer.Layer<GrantStore, GrantStoreError, Workspace> => Layer.effect(GrantStore, make(options))

/**
 * An allow-all grant store.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const makeNoop: Service = GrantStore.of({
  check: Effect.fn("GrantStore.check")(() => Effect.void),
  reply: Effect.fn("GrantStore.reply")(() => Effect.void),
  list: Effect.fn("GrantStore.list")(() => Effect.succeed([]))(),
  grantEnvelope: Effect.fn("GrantStore.grantEnvelope")(() => Effect.void)
})

/**
 * Provides the allow-all grant store.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerNoop: Layer.Layer<GrantStore> = Layer.succeed(GrantStore)(makeNoop)

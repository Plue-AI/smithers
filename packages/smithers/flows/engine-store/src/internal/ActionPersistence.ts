/**
 * Durable action dispatch at the engine encoded seam.
 *
 * Governing design: `packages/smithers/flows/plan/docs/concepts/step-keys.md`.
 *
 * @since 0.1.0
 */

import { Sha256 } from "@smthrs/crypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Journal, type JournalEvent, Redaction } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { DerivedKey } from "@smthrs/keys"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as EngineStoreMetrics from "../EngineStoreMetrics.ts"
import * as Inconsistency from "../Inconsistency.ts"
import * as ReplayOnly from "../ReplayOnly.ts"
import * as StepBoundary from "../StepBoundary.ts"
import * as StepSandbox from "../StepSandbox.ts"
import * as WorkspaceSandbox from "../WorkspaceSandbox.ts"
import * as AttemptAdmission from "./AttemptAdmission.ts"
import * as CacheAdmission from "./CacheAdmission.ts"
import * as CacheAgeHistory from "./CacheAgeHistory.ts"
import * as CacheAgeVerdicts from "./CacheAgeVerdicts.ts"
import * as CacheOutputPolicy from "./CacheOutputPolicy.ts"
import * as CachePublication from "./CachePublication.ts"
import * as CallFacts from "./CallFacts.ts"
import * as CopiedRecord from "./CopiedRecord.ts"
import * as EffectRecords from "./EffectRecords.ts"
import * as HostReflection from "./HostReflection.ts"
import * as JournalRecords from "./JournalRecords.ts"
import * as ProvenanceSlot from "./ProvenanceSlot.ts"
import * as SandboxedExecution from "./SandboxedExecution.ts"
import * as StepFacts from "./StepFacts.ts"

/**
 * The boundary declaration an action may carry alongside its input.
 *
 * Aliased to `FileBoundary` rather than re-declared so the dispatch path and
 * the `@smthrs/flow` declaration cannot drift apart; it is a distinct name only
 * because "metadata" is how the action input refers to it.
 *
 * @since 0.1.0
 * @category models
 */
export type BoundaryMetadata = FileBoundary

/**
 * Everything one dispatch of a durable action needs: the opaque `action`
 * body, which `attempt` this is, the step `key` it is cached under, its trust
 * `tier`, and the boundary it declared, if any.
 *
 * The `key` is a digest of the caller's declaration, so two dispatches sharing
 * one carry the same claim about their inputs — which is what makes the
 * attempt row and the cache row addressable by it.
 *
 * @since 0.1.0
 * @category models
 */
export interface ActionInput {
  readonly action: unknown
  readonly attempt: number
  readonly key: string
  readonly tier: Action.Tier
  /**
   * The caller declares this sealed step's recorded result is one of many
   * legitimate results; a same-key divergence is expected, not a hermeticity
   * violation.
   */
  readonly nondeterministic?: true | undefined
  readonly metadata?: BoundaryMetadata | undefined
  /**
   * The engine's `SnapshotBoundary` preparation for a compensable attempt:
   * restore the retry sequence's original handle, then take this attempt's.
   * Evaluated only when the attempt actually executes, after the journal and
   * cache lookups, and its handle is persisted in the attempt row before the
   * body runs.
   */
  readonly snapshot?: Effect.Effect<unknown> | undefined
}

/**
 * The attempt stopped without settling — it is durably parked, not failed.
 *
 * The distinction matters to the driver: a suspended attempt keeps its row and
 * its attempt number, so resuming continues the same attempt rather than
 * burning a new one against the retry budget.
 *
 * @since 0.1.0
 * @category errors
 */
export class AttemptSuspended extends Schema.TaggedError<AttemptSuspended>()(
  "@smthrs/engine-store/AttemptSuspended",
  {
    code: Schema.Literal("attempt_suspended"),
    runId: Schema.String,
    keyDigest: Schema.String,
    attempt: Schema.Int
  }
) {}

/**
 * The attempt was not admitted, so its body never ran.
 *
 * `outcome` names which admission check refused — a superseded fence, a live
 * same-key attempt, an already-settled row. Because the body did not execute,
 * this failure is always safe to surface without compensation.
 *
 * @since 0.1.0
 * @category errors
 */
export class AttemptAdmissionRejected extends Schema.TaggedError<AttemptAdmissionRejected>()(
  "@smthrs/engine-store/AttemptAdmissionRejected",
  {
    code: Schema.Literal("attempt_admission_rejected"),
    keyDigest: Schema.String,
    outcome: Schema.String
  }
) {}

/**
 * Two different runs recorded results under the same step key.
 *
 * The key is a digest of the declaration, so a conflict means the declaration
 * does not fully describe what the step depends on: same key, different
 * answer. `recordedRunId` names the run that got there first, so the
 * divergence can be investigated rather than silently resolved.
 *
 * @since 0.1.0
 * @category errors
 */
export class CacheConflictDetected extends Schema.TaggedError<CacheConflictDetected>()(
  "@smthrs/engine-store/CacheConflictDetected",
  {
    code: Schema.Literal("cache_conflict_detected"),
    keyDigest: Schema.String,
    recordedRunId: Schema.String
  }
) {}

/**
 * A cached output's bytes no longer hash to the digest recorded for them.
 *
 * Unlike a succeeded attempt row, a shared cache row is evictable: the entry is
 * dropped and the next dispatch re-executes and re-captures cleanly (issue
 * #164). Reported rather than swallowed so a failing disk is visible.
 *
 * @since 0.1.0
 * @category errors
 */
export class CacheCorruptionDetected extends Schema.TaggedError<CacheCorruptionDetected>()(
  "@smthrs/engine-store/CacheCorruptionDetected",
  {
    code: Schema.Literal("cache_corruption_detected"),
    keyDigest: Schema.String,
    path: Schema.String,
    recordedDigest: Schema.String,
    measuredDigest: Schema.String
  }
) {}

/**
 * Corrupt recorded evidence on a SUCCEEDED durable attempt row under the
 * strict verdict (issue #171).
 *
 * Distinct from {@link CacheCorruptionDetected} on purpose: a corrupt shared
 * cache row is evictable — the next dispatch re-executes and re-captures
 * cleanly (issue #164) — but a succeeded attempt row records that this run's
 * side effects already ran, so eviction/re-execution would violate
 * exactly-once for irreversible actions. The corrupt boundary evidence is
 * quarantined off the succeeded row instead: the driver parks the first
 * detection in the `quarantine` waiting state, and the next explicit resume
 * returns the durable outcome without re-materializing the poisoned evidence
 * or re-executing the action.
 *
 * @since 0.1.0
 * @category errors
 */
export class AttemptEvidenceQuarantined extends Schema.TaggedError<AttemptEvidenceQuarantined>()(
  "@smthrs/engine-store/AttemptEvidenceQuarantined",
  {
    code: Schema.Literal("attempt_evidence_quarantined"),
    keyDigest: Schema.String,
    attempt: Schema.Int,
    path: Schema.String,
    recordedDigest: Schema.String,
    measuredDigest: Schema.String
  }
) {}

/**
 * Extracts an {@link AttemptEvidenceQuarantined} carried anywhere in a flow
 * result's cause — as a typed failure or squashed into a defect — so the
 * driver can park the run instead of settling it `failed` (issue #171).
 *
 * @since 0.1.0
 * @category errors
 */
export const evidenceQuarantined = (
  cause: Cause.Cause<unknown>
): AttemptEvidenceQuarantined | undefined => {
  for (const reason of cause.reasons) {
    const carried = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
      ? reason.defect
      : undefined
    if (carried instanceof AttemptEvidenceQuarantined) {
      return carried
    }
  }
  return undefined
}

/**
 * The one classification of a `replayOutputs` failure (issue #150): a
 * `BoundaryCorruption` in the cause is on-disk corruption of recorded
 * evidence — the store's strongest invariant violated — while anything else
 * is a transient host refusal that stays retryable. The two previously
 * journalled identically, so a failing disk corrupting many blobs was
 * indistinguishable from a one-off EIO.
 */
const replayCorruption = (
  cause: Cause.Cause<unknown>
): StepBoundary.BoundaryCorruption | undefined => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && reason.error instanceof StepBoundary.BoundaryCorruption) {
      return reason.error
    }
  }
  return undefined
}

/**
 * The stable effect kind a compensation handler is registered under.
 *
 * The action name is the adapter's own identity and is what an engine
 * composition registers its handler by; a dispatch whose action carries no
 * name at all (the plan scheduler's synthetic node dispatch) falls back to a
 * constant, which resolves to no handler and therefore assesses as blocking —
 * the safe direction.
 */
const actionKind = (action: unknown): string =>
  typeof action === "object" && action !== null && typeof (action as { name?: unknown }).name === "string"
    ? (action as { readonly name: string }).name
    : "flows/engine-store/action"

/**
 * Whether a failing execution failed because it broke its declared boundary.
 *
 * The isolated execution path raises the boundary's own `UndeclaredWrite`, so
 * a violation detected while the body ran classifies exactly like one detected
 * at settle time: the row records `hardViolation` and the journal gets the
 * violation record, rather than the failure passing as an ordinary action
 * error the retry policy might happily retry.
 */
const declarationViolated = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) =>
    Cause.isFailReason(reason) &&
    (reason.error instanceof StepBoundary.UndeclaredWrite || reason.error instanceof StepSandbox.UndeclaredRead)
  )

/**
 * Whether a failed settle carries one of the boundary's own contract
 * violations, as opposed to a host refusal. Classification for the
 * `boundarySettlements` counter only — the journal record stays the source
 * of truth.
 */
const settlementViolated = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) =>
    Cause.isFailReason(reason) &&
    (reason.error instanceof StepBoundary.UndeclaredWrite ||
      reason.error instanceof StepBoundary.MissingDeclaredOutput ||
      reason.error instanceof StepBoundary.SurvivingDeclaredRemoval)
  )

/**
 * What the action dispatcher is constructed with: the run it belongs to, the
 * ownership fence it writes under, and the `execute` function that actually
 * runs an action body.
 *
 * Everything durable — the attempt row, the cache row, the journal record — is
 * this module's job; `execute` is the only part it delegates, which is what
 * keeps the persistence discipline in one place regardless of what a flow
 * runtime does with the body.
 *
 * @since 0.1.0
 * @category models
 */
export interface Dependencies {
  readonly runId: string
  readonly owner: Ownership.OwnerId
  readonly sourceId: string
  /** Runs one action body. The only part of a dispatch this module delegates. */
  readonly execute: (input: ActionInput) => Effect.Effect<unknown, unknown>
  /** Repository authority reserved for engine bookkeeping. */
  readonly engineJj?: Jj.Jj | undefined
  /**
   * Makes a retry of an irreversible action recognizable downstream. Its
   * absence is what
   * {@link Action.IrreversibleRetryRequiresIdempotencyKey} reports.
   */
  readonly idempotencyKey?: string | undefined
  /**
   * The incarnation-wide admission mutex (issues #102, #103). `EngineStore`
   * passes one shared instance per store incarnation so every dispatch of a
   * given attempt key in this process serializes through it; when omitted, a
   * fresh mutex private to this `make` call is used — correct only when all
   * same-key dispatches share the returned executor.
   */
  readonly admission?: AttemptAdmission.Service | undefined
  /** Shared by callers that construct an executor for every dispatch in a run. */
  readonly cacheAgeVerdict?: ReturnType<typeof CacheAgeVerdicts.make> | undefined
  /**
   * Present on a replay-only engine: every settled dispatch is reported to it,
   * and a dispatch that would execute a body dies with `WouldExecute` first.
   */
  readonly replayOnly?: ReplayOnly.Service | undefined
}

const AttemptMeta = Schema.Struct({
  tier: Schema.Literals(["sealed", "compensable", "irreversible"]),
  /**
   * The sealed declaration admits multiple legitimate recorded results under
   * this key. Absence remains the durable determinism claim.
   */
  nondeterministic: Schema.optional(Schema.Literal(true)),
  boundary: Schema.optional(StepBoundary.BoundaryEvidence),
  /**
   * The prepare-time measurement matched the caller-declared read set the
   * step key was derived from (issue #106). Only such completions may enter
   * the shared cache: a stale declaration executes against the *real*
   * content, so recording its result under the declaration's key would hand
   * a later, genuinely accurate run the wrong value as a verified hit.
   */
  readSetVerified: Schema.optional(Schema.Literal(true)),
  /**
   * The row's boundary evidence failed integrity verification and was removed
   * after its detailed corruption record reached the journal (issue #171).
   * The succeeded outcome remains authoritative, but this row may never be
   * converged into the shared cache again.
   */
  boundaryQuarantined: Schema.optional(Schema.Literal(true)),
  /**
   * The failed row records a boundary violation (a prepare or settle
   * failure), so the failed replay branch can re-emit the `hardViolation`
   * journal record idempotently after a crash in the finish→emit window
   * (issue #109) — the violation kind is not recoverable from the persisted
   * cause alone.
   */
  hardViolation: Schema.optional(Schema.Literal(true)),
  snapshotId: Schema.optional(Schema.String),
  /**
   * The jj operation that recorded `snapshotId`, when the host reports one.
   * A whole-repository rewind restores it to undo bookmark moves, rebases,
   * `describe`, and `abandon` that a tree restore leaves in place.
   */
  snapshotOperationId: Schema.optional(Schema.String),
  /**
   * The engine `SnapshotBoundary` handle taken before this attempt executed.
   * Wrapped so an opaque `null` or `undefined` handle stays distinguishable
   * from no handle; `handle` is absent when the handle was `undefined`.
   */
  boundarySnapshot: Schema.optional(Schema.Struct({ handle: Schema.optionalKey(Schema.Unknown) })),
  // The incarnation that admitted the running row. Since issues #102/#103
  // the adoption decision rests on the admission permit rather than this
  // nonce — a live same-key fiber of this process would be holding the
  // permit, which distinguishes a dead fiber from a live dispatch in a way
  // the recorded incarnation cannot — but the field is kept as durable
  // forensic evidence of which incarnation last drove the attempt.
  admittedBy: Schema.optional(Ownership.OwnerId),
  /**
   * How far this attempt's effect boundary got, in EXECUTABLE state.
   *
   * The journal's boundary records already say this, and adoption cannot use
   * them: `@smthrs/journal` puts every payload it writes through redaction,
   * deliberately, so a recorded `output` may never be re-entered as a flow's
   * result (issue #72), and the journal offers no read addressed by producer
   * identity — only a full scan of the run. So the same fact is written here,
   * where the attempt's `outcome` column is already replayed verbatim, in the
   * SAME transaction as the record that describes it.
   *
   * - `intended`: the body was dispatched and its outcome is not durably
   *   known. Whether the effect reached the outside world is genuinely
   *   unanswerable from durable state.
   * - `parked`: the body reached a durable wait and suspended, so it never
   *   finished and nothing crossed. Recorded explicitly because a park leaves
   *   the same `running` row a crash does.
   * - `succeeded`: the body completed and the row carries its result.
   */
  effectCrossing: Schema.optional(Schema.Literals(["intended", "parked", "succeeded"]))
})

type AttemptMeta = typeof AttemptMeta.Type

const decodeMeta = (value: unknown): AttemptMeta | undefined => {
  const decoded = Schema.decodeUnknownResult(AttemptMeta)(value)
  return decoded._tag === "Success" ? decoded.success : undefined
}

/**
 * The earliest boundary snapshot handle persisted for an action key's
 * surviving attempts, walking `earliest` through `latest`. An attempt row
 * without one (it crashed before its snapshot was persisted) is skipped.
 *
 * @since 0.1.0
 * @category combinators
 */
export const earliestBoundarySnapshot = (
  attempts: AttemptStore.Service,
  runId: string,
  stepKeyDigest: string,
  range: { readonly earliest: number; readonly latest: number }
): Effect.Effect<Option.Option<unknown>> =>
  Effect.gen(function*() {
    for (let attempt = range.earliest; attempt <= range.latest; attempt++) {
      const row = yield* attempts.get({ runId, stepKeyDigest, attempt }).pipe(Effect.orDie)
      const persisted = Option.isSome(row) ? decodeMeta(row.value.meta)?.boundarySnapshot : undefined
      if (persisted !== undefined) return Option.some(persisted.handle)
    }
    return Option.none()
  })

const CauseJson = Schema.Struct({
  reasons: Schema.Array(Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("Fail"), error: Schema.Unknown }),
    Schema.Struct({ _tag: Schema.Literal("Die"), defect: Schema.Unknown }),
    Schema.Struct({
      _tag: Schema.Literal("Interrupt"),
      fiberId: Schema.optional(Schema.NullOr(Schema.Number))
    })
  ]))
})

/**
 * Maximum nesting copied from one live failure value.
 *
 * The bounds here are the store's own admission limits, less the envelope
 * `persistCause` wraps around a reduced value, and never tighter: a value the
 * store would have persisted must not be thrown away here. `AttemptStore`
 * admits 128 levels, and a reduced value sits three levels down, inside
 * `{ reasons: [{ error }] }`.
 *
 * @since 1.0.0
 * @category constants
 */
export const maxInertJsonDepth = AttemptStore.maximumJsonDepth - 4

/**
 * Maximum JSON values copied from one persisted cause.
 *
 * The budget is spent across the cause object, its reasons array, every reason
 * envelope, and every reduced leaf. A cause that cannot fit collapses to one
 * bounded reason before it reaches `AttemptStore`. Own-key enumeration has a
 * separate allowance of the same size so ignored keys cannot make traversal
 * unbounded.
 *
 * @since 1.0.0
 * @category constants
 */
export const maxInertJsonNodes = AttemptStore.maximumJsonNodes - 8

/**
 * Maximum UTF-16 units copied from one persisted cause, keys included.
 *
 * Spent across every caller-supplied key and string leaf. This bounds text the
 * reduction inspects and retains, not the serialized byte length: numeric
 * spellings, punctuation, and the fixed cause envelope are outside this
 * character count and are bounded separately by {@link maxInertJsonNodes}.
 *
 * @since 1.0.0
 * @category constants
 */
export const maxInertJsonCharacters = 256 * 1024

type InertJsonValue =
  | null
  | boolean
  | number
  | string
  | Array<InertJsonValue>
  | { [key: string]: InertJsonValue }

const inertJsonRejected = Symbol("inertJsonRejected")
const inertJsonOmitted = Symbol("inertJsonOmitted")
const arrayBufferViewMarker = "[ArrayBufferView]"

type InertJsonReduction = InertJsonValue | typeof inertJsonRejected | typeof inertJsonOmitted

/** What one cause's reduction has already spent of its shared bounds. */
interface InertJsonBudget {
  nodes: number
  characters: number
  enumeratedKeys: number
}

/** Charges JSON values against the cause-wide node allowance. */
const spendNodes = (budget: InertJsonBudget, nodes: number): boolean => {
  if (budget.nodes + nodes > maxInertJsonNodes) return false
  budget.nodes += nodes
  return true
}

/** The store rejects unpaired surrogates, so an ill-formed string is refused. */
const isWellFormedInertString = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/**
 * Charges one string, a key or a value, against the cause's character budget.
 * Answers whether the string is admitted.
 */
const spend = (budget: InertJsonBudget, value: string): boolean => {
  budget.characters += value.length
  return budget.characters <= maxInertJsonCharacters && isWellFormedInertString(value)
}

/** Charges every own key before its type or descriptor can make it ignorable. */
const spendEnumeratedKey = (budget: InertJsonBudget, key: PropertyKey): boolean => {
  budget.enumeratedKeys += 1
  if (budget.enumeratedKeys > maxInertJsonNodes) return false
  return typeof key !== "string" || spend(budget, key)
}

/**
 * Projects one failure value into the inert JSON data `AttemptStore` admits.
 *
 * A `Fail` reason raised by a service rather than by `Action.executeEncoded`
 * carries a live class instance — `StepBoundary.UnsupportedBoundary`, a
 * `StepSandbox` refusal, any `Data.TaggedError` — and a `Die` reason carries
 * an arbitrary defect. `@smthrs/run-store`'s attempt boundary refuses a
 * non-plain object outright rather than serializing it, so the projection has
 * to happen on the write side, here, where the durable shape is already owned.
 *
 * The reduction reads only own data-property descriptors. It never invokes a
 * getter or `toJSON`, and a host-detected proxy is rejected before any of its
 * traps can run. An array-buffer view becomes the fixed
 * `"[ArrayBufferView]"` marker before its indexed own keys can be materialized;
 * its bytes and attached properties are deliberately omitted. JSON leaves,
 * arrays, and enumerable string-keyed object data otherwise keep their ordinary
 * JSON shape. Unsupported object members are omitted and unsupported array
 * members become `null`, matching JSON's container rules. Every key returned
 * by an own-key enumeration spends from a cause-wide allowance before its type,
 * enumerability, or descriptor is inspected.
 *
 * Depth, node, and character bounds apply before the attempt store's admission
 * boundary, and `budget` carries the allowances across every reason of one
 * cause. The caller charges the root value as part of its reason envelope; this
 * walk charges every descendant. A cycle, proxy, inspection refusal, or
 * exceeded bound rejects the whole value as `null`, so persistence on the
 * failure path neither executes user code nor leaves an attempt running because
 * its error was too large for the store.
 */
const inertJson = (value: unknown, budget: InertJsonBudget): unknown => {
  const active = new WeakSet<object>()

  const reduce = (current: unknown, depth: number): InertJsonReduction => {
    if (depth > maxInertJsonDepth) return inertJsonRejected
    if (depth > 0 && !spendNodes(budget, 1)) return inertJsonRejected

    if (current === null) return null
    switch (typeof current) {
      case "boolean":
        return current
      case "number":
        return Number.isFinite(current) ? current : null
      case "string":
        return spend(budget, current) ? current : inertJsonRejected
      case "undefined":
      case "symbol":
      case "function":
      case "bigint":
        return inertJsonOmitted
      case "object": {
        if (HostReflection.host.isProxy(current) || active.has(current)) return inertJsonRejected
        if (ArrayBuffer.isView(current)) return arrayBufferViewMarker
        active.add(current)
        try {
          if (Array.isArray(current)) {
            const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length")
            /* v8 ignore next 3 -- A non-proxy Array always has an own data-property uint32 length. */
            if (
              lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
              typeof lengthDescriptor.value !== "number"
            ) return inertJsonRejected
            const output: Array<InertJsonValue> = []
            for (let index = 0; index < lengthDescriptor.value; index++) {
              const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
              const reduced = reduce(
                descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined,
                depth + 1
              )
              if (reduced === inertJsonRejected) return inertJsonRejected
              output.push(reduced === inertJsonOmitted ? null : reduced)
            }
            return output
          }

          const output: Record<string, InertJsonValue> = {}
          // This engine-owned error's native Error.message is non-enumerable,
          // but is part of the durable schema used to classify a landing
          // conflict. Preserve that one data field, never getters, stacks, or
          // arbitrary hidden properties. It spends the same bounded budget.
          const tag = Object.getOwnPropertyDescriptor(current, "_tag")
          const conflictMessage = tag !== undefined && "value" in tag &&
            tag.value === WorkspaceSandbox.MaterializationConflict.identifier
          for (const key of Reflect.ownKeys(current)) {
            if (!spendEnumeratedKey(budget, key)) return inertJsonRejected
            if (typeof key !== "string") continue
            const descriptor = Object.getOwnPropertyDescriptor(current, key)
            /* v8 ignore next -- A key returned by Reflect.ownKeys exists on a non-proxy object. */
            if (descriptor === undefined) continue
            if ((!descriptor.enumerable && !(key === "message" && conflictMessage)) || !("value" in descriptor)) {
              continue
            }
            // `message` and `stack` are observability text, never a field replay
            // classifies on, and a git or HTTP failure embeds its remote URL,
            // credentials included. They meet the journal's own rules; every
            // other member, `_tag` included, stays byte-exact for replay.
            const member = (key === "message" || key === "stack") && typeof descriptor.value === "string"
              ? Redaction.redact(descriptor.value)
              : descriptor.value
            const reduced = reduce(member, depth + 1)
            if (reduced === inertJsonRejected) return inertJsonRejected
            if (reduced === inertJsonOmitted) continue
            Object.defineProperty(output, key, {
              value: reduced,
              enumerable: true,
              configurable: true,
              writable: true
            })
          }
          return output
        } finally {
          active.delete(current)
        }
      }
    }
    /* v8 ignore next -- The typeof switch covers every JavaScript value category. */
    return inertJsonRejected
  }

  try {
    const reduced = reduce(value, 0)
    return reduced === inertJsonRejected || reduced === inertJsonOmitted ? null : reduced
  } catch {
    return null
  }
}

/**
 * Encodes a live `Cause` into the plain tagged-reason JSON `rehydrateCause`
 * decodes. Persisting the `Cause` object itself left the durable shape to
 * whatever the ambient serializer produced (`Cause.toJSON` emits
 * `{_id, failures}`, a structural walk emits `{reasons}`), so a change in
 * the store's encoding silently broke failed-attempt replay. The write side
 * now owns the shape explicitly. {@link inertJson} makes every live leaf
 * inert and bounded before the store sees it, against one budget shared by
 * the fixed envelope and every reason. The loop stops at the first reason that
 * cannot fit and returns one `Die(null)` reason, which {@link rehydrateCause}
 * decodes on replay, so even an adversarial reason count remains admissible.
 */
const persistCause = (cause: Cause.Cause<unknown>): typeof CauseJson.Type => {
  // The cause object and its `reasons` array are the two fixed envelope nodes.
  const budget: InertJsonBudget = { nodes: 2, characters: 0, enumeratedKeys: 0 }
  const reasons: Array<typeof CauseJson.Type.reasons[number]> = []
  for (const reason of cause.reasons) {
    // One object, its `_tag` string, and its error, defect, or fiber-id value.
    if (!spendNodes(budget, 3)) {
      return { reasons: [{ _tag: "Die", defect: null }] }
    }
    if (Cause.isFailReason(reason)) {
      reasons.push({ _tag: "Fail", error: inertJson(reason.error, budget) })
    } else if (Cause.isDieReason(reason)) {
      reasons.push({ _tag: "Die", defect: inertJson(reason.defect, budget) })
    } else {
      reasons.push({ _tag: "Interrupt", fiberId: reason.fiberId ?? null })
    }
  }
  return { reasons }
}

/**
 * Presents a payload this module already reduced to JSON as the attempt
 * store's `JsonValue`.
 *
 * `@smthrs/run-store` types the `meta`, `error`, and `outcome` columns as
 * `JsonValue` and admits every write through its own inert-JSON boundary,
 * which refuses anything that boundary rejects with `AttemptStoreError`. The
 * values handed here are already reduced: `AttemptMeta` is a schema whose
 * optional fields are omitted rather than written as `undefined`,
 * {@link persistCause} passes every leaf through {@link inertJson}, and an
 * action `outcome` is the encoded result the caller's own codec produced.
 * TypeScript still refuses the assignment because an optional property's type
 * includes `undefined` and a JSON index signature does not, and because a
 * schema-level `unknown` leaf cannot be proven JSON statically. The store's
 * admission is the check; this is the type-level statement of what it checks.
 */
const attemptPayload = (value: unknown): AttemptStore.JsonValue => value as AttemptStore.JsonValue

/**
 * Rebuilds the persisted failure of a `failed` attempt row so replay can
 * rethrow the original domain error (issue #59). The row's `error` column
 * holds the {@link persistCause} encoding of the failing `Cause` — a plain
 * object whose `reasons` carry the tagged `Fail`/`Die`/`Interrupt` material.
 * `Fail` errors are already schema-encoded by `Action.executeEncoded`, so
 * their `_tag` survives and `RetryPolicy` non-retryable matching applies on
 * replay exactly as it did on the live attempt. Live reasons are rebuilt
 * unconditionally from the tagged material; anything unrecognizable becomes
 * a defect carrying the raw persisted value.
 */
const rehydrateCause = (error: unknown): Cause.Cause<unknown> => {
  const decoded = Schema.decodeUnknownResult(CauseJson)(error)
  if (decoded._tag === "Success" && decoded.success.reasons.length > 0) {
    return Cause.fromReasons(decoded.success.reasons.map((reason) => {
      switch (reason._tag) {
        case "Fail":
          return Cause.makeFailReason(reason.error)
        case "Die":
          return Cause.makeDieReason(reason.defect)
        case "Interrupt":
          return Cause.makeInterruptReason(reason.fiberId ?? undefined)
      }
    }))
  }
  return Cause.die(error)
}

/**
 * The {@link module:CacheEnvironment.CachePolicy} the dispatched declaration
 * annotated, if any.
 *
 * The action stays opaque to this module — it is `unknown` on
 * {@link ActionInput} on purpose — so the policy is read out of its annotation
 * bag rather than off a field. An action without one, or a caller that hands
 * the seam a bare object (every unit test of this module does), simply has no
 * policy and keeps the pre-policy behavior.
 *
 * @since 0.1.0
 * @private
 */
const declaredCachePolicy = (action: unknown): CacheEnvironment.CachePolicy | undefined => {
  const annotations = (action as { readonly annotations?: unknown } | null | undefined)?.annotations
  return Context.isContext(annotations) ? CacheEnvironment.cachePolicyOf(annotations) : undefined
}

/**
 * Constructs the encoded action executor. The action itself stays opaque;
 * the supplied dispatcher is the only physical execution point.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (deps: Dependencies) => {
  /**
   * Runs one action body, and tells whoever drove this dispatch that it ran.
   *
   * The report is the only way a node above this knows the difference between
   * work and replay. Every execution path funnels through here, so a body
   * that starts says so exactly once; a path that returns a durable record
   * instead reports `replayed` at its own return. A dispatch that reports
   * nothing is read as work, which is the safe reading: a node never claims
   * it rebuilt nothing when it might have rebuilt something.
   *
   * The digest travels with the report because it is what joins the two
   * halves of a node's evidence: the attempt records this dispatch writes are
   * keyed by it, and the node record above has no other way to name them.
   */
  const execute = (input: ActionInput, stepKeyDigest: string) =>
    Effect.andThen(
      Action.reportDispatch({ outcome: "executed", stepKeyDigest, attempt: input.attempt }),
      deps.execute(input)
    )
  const admission = deps.admission ?? AttemptAdmission.makeUnsafe()
  const recordedAgeVerdict = deps.cacheAgeVerdict ?? CacheAgeVerdicts.make(deps.runId)
  // The lineage every record this executor writes addresses itself to.
  // An action is a node inside its run's root lineage, not a lineage of
  // its own: a lineage segment is minted only where a separate run is.
  const lineageId = FlowEngine.Lineage.root(deps.runId)
  return Effect.fn("ActionPersistence.execute")((input: ActionInput) => {
    // What a replay-only engine reports for this dispatch: the digest once it
    // exists, and whether the dispatch stopped at the execution gate.
    const replay: { stepKeyDigest?: string; gated: boolean } = { gated: false }
    return Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({
        runId: deps.runId,
        attempt: input.attempt,
        tier: input.tier
      })
      const attempts = yield* AttemptStore.AttemptStore
      const cache = yield* CacheStore.CacheStore
      const journal = yield* Journal.Journal
      const runs = yield* RunStore.RunStore
      const policy = declaredCachePolicy(input.action)
      // SCOPE NARROWS THE CACHE ADDRESS. The engine derives a cross-run key
      // from the inputs and the environment, which is the widest reach a
      // content address can have. A declaration that wants a narrower one
      // folds the identity it is narrowing to into the address of its cache
      // row, so a sibling run derives a different address and never finds the
      // row: narrowing by construction rather than by a read-time filter that
      // a second reader could disagree with. `shared` is the unnarrowed
      // default and folds nothing, so every key predating the policy keeps
      // its bytes.
      const scopeTag = policy?.scope === "run"
        ? `run:${deps.runId}`
        : policy?.scope === "flow"
        // The flow tag comes from the executing instance, which the engine
        // provides around every dispatch. A caller that reaches this seam
        // without one — the unit tests of this module — cannot name a flow, so
        // the key narrows to the run instead: never wider than the caller
        // asked for.
        ? `flow:${
          Option.getOrUndefined(
            Option.map(yield* Effect.serviceOption(FlowRuntime.FlowInstance), (instance) => instance.flow._tag)
          ) ?? `run:${deps.runId}`
        }`
        : undefined
      // THE STEP KEY DIGEST IS NOT NARROWED. It is the identity the rest of the
      // engine addresses this dispatch by: `flows_attempts` rows, which
      // `EngineStore.actionRetryOrigin` and `actionLatestAttempt` probe under
      // `sha256(input.key)`, and the `stepKeyDigest` on every attempt record,
      // which `PlanScheduler` maps back to the node that dispatched it. Both
      // derive the digest from the key alone and neither can see an
      // annotation, so narrowing this one would hide a scoped step's attempts
      // from its own retry counter and its deviations from the reconciler.
      const stepKeyDigest = yield* Schema.decodeUnknownEffect(Sha256)(input.key).pipe(Effect.orDie)
      replay.stepKeyDigest = stepKeyDigest
      // What the scope narrows is the CACHE ROW ADDRESS, which is the only
      // thing a scope is about: an unscoped declaration addresses the row by
      // the step key alone, and a narrowed one folds the identity it is
      // narrowing to into the address, so a sibling derives a different one and
      // never finds the row. The two digests are the same string for every
      // declaration that narrows nothing.
      const keyDigest = scopeTag === undefined
        ? stepKeyDigest
        : yield* Schema.decodeUnknownEffect(Sha256)(`${input.key}\u0000scope:${scopeTag}`).pipe(Effect.orDie)
      yield* Effect.annotateCurrentSpan({ stepKeyDigest, keyDigest })
      const attemptId = { runId: deps.runId, stepKeyDigest, attempt: input.attempt }
      /**
       * Lifecycle events take the journal's durable channel, fenced to the
       * owning process: the write commits inside the SQL sink while
       * `flows_runs` still records `deps.owner`, so a reclaimed (zombie) run
       * fails with `fence_lost` — surfaced as self-interruption, matching the
       * store-level fence outcomes — and a saturated lossy queue can never
       * drop an attempt lifecycle record (issue #10).
       */
      const emitLifecycle = (record: JournalEvent.Input) =>
        journal.emitDurable(record, deps.owner).pipe(
          Effect.catch((error) => error.code === "fence_lost" ? Effect.interrupt : Effect.fail(error))
        )
      const callFacts = CallFacts.make(input.action, deps.runId)
      const stepFacts = StepFacts.make(input.action, deps.runId)
      const emitStepSettled = (outcome: unknown) =>
        Effect.flatMap(
          stepFacts.settled(outcome),
          (record) => record === undefined ? Effect.void : Effect.asVoid(emitLifecycle(record))
        )
      const emitCallInvoked = Effect.flatMap(
        callFacts.invoked,
        (record) => record === undefined ? Effect.void : Effect.asVoid(emitLifecycle(record))
      )
      const emitCallSettled = (outcome: unknown) =>
        Effect.flatMap(
          callFacts.settled(outcome),
          (record) => record === undefined ? Effect.void : Effect.asVoid(emitLifecycle(record))
        )
      /**
       * Commits an attempt/cache state transition and the lifecycle records
       * describing it in ONE write transaction.
       *
       * The store writes below (`attempts.put`/`patch`/`finish`, `cache.put`)
       * and `emitLifecycle` all go through the same `DurableWriter`, so the inner
       * writes become savepoints of this transaction: either the row and its
       * journal entry are both durable, or neither is. Before this, a crash in
       * the interstitial left an attempt row the journal could not explain —
       * `attemptStarted` with no `attemptFinished`, forever. Temporal's
       * mutable state and history events commit as one persistence request
       * (`reference/temporal/service/history/workflow/transaction_impl.go`);
       * this is that unit of work, scoped to one attempt.
       *
       * Nothing that is not storage work belongs inside: the action body,
       * the Jj snapshot, and the boundary prepare/settle all stay outside so
       * the write transaction is never held across a host call.
       */
      const atomically = <A, E, R>(effect: Effect.Effect<A, E, R>) => journal.transact(effect)
      /**
       * Commits an attempt's terminal row and the lifecycle records describing
       * it as one unit, reporting whether the fenced write landed.
       *
       * Returning a boolean rather than interrupting inside keeps the
       * transaction's failure paths to genuine storage failures: a lost fence
       * is an ordinary "someone else owns this attempt now" outcome, and its
       * self-interruption belongs to the caller, outside the transaction.
       */
      const settleAttempt = (
        row: AttemptStore.FinishAttempt,
        records: ReadonlyArray<JournalEvent.Input>
      ) =>
        atomically(Effect.gen(function*() {
          const finished = yield* attempts.finish(row, deps.owner)
          if (finished._tag !== "Finished") {
            return false
          }
          // The checkpoint fact precedes its completion boundary so a rewind
          // retaining that completion also retains the observation it owns.
          if (row.state === "succeeded" && stepFacts.annotated) {
            const committed = yield* attempts.get(attemptId)
            if (Option.isNone(committed)) {
              return yield* Effect.fail(
                new AttemptStore.AttemptStoreError({
                  code: "persistence_failed",
                  method: "get",
                  message: "Finished checkpoint outcome disappeared",
                  cause: attemptId
                })
              )
            }
            yield* emitStepSettled(committed.value.outcome)
          }
          yield* Effect.forEach(records, (record) => emitLifecycle(record), { discard: true })
          if (row.state === "succeeded" && callFacts.settles) {
            const committed = yield* attempts.get(attemptId)
            if (Option.isNone(committed)) {
              return yield* Effect.die(new Error("Finished call outcome disappeared"))
            }
            yield* emitCallSettled(committed.value.outcome)
          }
          return true
        }))
      const fencedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
      const heartbeat = yield* runs.heartbeat(deps.runId, deps.owner, fencedAtMs)
      if (heartbeat._tag !== "Updated") {
        return yield* Effect.interrupt
      }

      if (input.tier === "irreversible" && input.attempt > 1 && deps.idempotencyKey === undefined) {
        return yield* Effect.fail(
          new Action.IrreversibleRetryRequiresIdempotencyKey({
            actionName: actionKind(input.action),
            attempt: input.attempt
          })
        )
      }

      // A source glob is cacheable only after the scheduler pins and replaces
      // it with exact measured inputs. Direct actions retain the pattern, so
      // their key cannot prove which expansion it names and must stay local.
      const cacheDeclaration = CacheAdmission.declaration(input)
      const declarationMeta = {
        tier: input.tier,
        ...(input.nondeterministic === undefined ? {} : { nondeterministic: input.nondeterministic })
      } satisfies AttemptMeta

      /**
       * Cache-provenance producer identity (issue #124): the plain
       * `{runId, sourceId}` identity carried no `sourceSeq`, so every re-drive of
       * the same observation — the same replay refusal against the same
       * recorded row, on every later dispatch of the key — appended a fresh
       * journal row forever. A per-(key, action, recorded-provenance)
       * identity with `sourceSeq 0` collapses the identical re-observation
       * into a `Duplicate`, while folding the recorded row's provenance into
       * the identity keeps a genuinely new observation — the same action
       * against a *different* recorded row — a distinct producer that still
       * journals.
       *
       * The identity names the run, the step-key digest, the decision, and the
       * recorded row's provenance — everything the decision is ABOUT — and
       * deliberately nothing about WHO TOOK IT. `deps.sourceId` is the host's
       * configured `journalSource` (`EngineStore.Options.journalSource`), which
       * a run outlives: the process that admits a row at 900 ms is routinely
       * not the process that resumes the run at 1100 ms. Folding it in made the
       * `ttl` verdict below re-decidable — the resuming incarnation got
       * `Accepted` for a fresh verdict under its own identity and re-judged the
       * age against its own clock, which is the one thing a recorded verdict
       * exists to prevent — and made every other record here re-appendable once
       * per incarnation rather than once per observation.
       *
       * The sibling `recorded` identity below still carries `deps.sourceId`, on
       * purpose: nothing reads a decision back out of it. It exists so a
       * convergence re-record collapses into a `Duplicate`, and a resume under
       * another journal source costs one extra provenance row there, never a
       * different answer.
       */
      const cacheSource = (
        action: string,
        recorded?: { readonly runId: string; readonly eventSeq: number }
      ): JournalRecords.EventOptions => ({
        runId: deps.runId,
        lineageId,
        sourceId: `cache:${keyDigest}:${action}${
          recorded === undefined ? "" : `:${recorded.runId}:${recorded.eventSeq}`
        }`,
        sourceSeq: 0
      })
      const noteUnshareable = (unshareable: CachePublication.Unshareable) =>
        Effect.gen(function*() {
          const reason = yield* Schema.decodeUnknownEffect(Sha256)(`${unshareable.stage}:${unshareable.message}`).pipe(
            Effect.orDie
          )
          yield* emitLifecycle(JournalRecords.cacheProvenance(cacheSource(`unpublished:${reason}`), {
            keyDigest,
            action: "unpublished",
            stage: unshareable.stage,
            message: unshareable.message
          }))
        })
      /**
       * Records the sealed completion into the shared cache with provenance,
       * failing (by default) on a divergent first-recorded row. Used by both
       * the fresh completion path and succeeded-attempt replay, so a crash
       * between `attempts.finish` and `cache.put` converges on restart
       * instead of leaving the cache permanently behind the journal.
       */
      const recordCache = (options: {
        readonly result: unknown
        readonly admission: CacheAdmission.PublishCompletion<AttemptMeta>
        readonly createdAtMs: number
      }) =>
        Effect.gen(function*() {
          // BLOBS BEFORE METADATA (issue #172). Every artifact this evidence
          // references is made durable in the shared tier *before* the entry
          // that references it is written, so a sibling machine can never see
          // a hit whose outputs it cannot materialize. Bazel's REAPI ordering
          // constraint, stated at `UploadManifest.java:630-633`; the whole
          // protocol lives in `CachePublication`, which is a no-op when no
          // shared tier is configured. It runs OUTSIDE the write transaction
          // below, like every other host call.
          //
          // A refusal withholds the SHARED entry, never the local row and never
          // the run: this point is reached after `attempts.finish`, so the work
          // is already done and durably recorded, and failing here would throw
          // a real result away because an optional accelerator was unreachable.
          // It is journalled below instead — the same "visible, not silent"
          // treatment an unverified read set gets (issue #106).
          const meta = options.admission.meta
          let unshareable = yield* CachePublication.publishArtifacts(meta.boundary)
          // The producer identity folds a digest of the recorded content
          // (issue #129): a constant per-key identity made a post-eviction
          // re-record collapse into a `Duplicate` carrying the EVICTED
          // generation's seq, so the fresh row inherited the evicted row's
          // exact provenance and a laggard's #119 `ifRecordedBy` fence could
          // delete the valid new row. With the content folded in, the #124
          // convergence re-record (identical content, rebuilt from the same
          // persisted attempt row, so the serialization is byte-stable)
          // still collapses into a `Duplicate` whose receipt carries the
          // original emission's canonical seq, while a re-record with
          // different content is a distinct producer that journals fresh
          // provenance. A re-record whose content happens to equal the
          // evicted generation's shares its provenance by design: the two
          // rows are indistinguishable, so a fenced evict of one is exactly
          // a fenced evict of the other.
          //
          // The digest goes through `DerivedKey`, the repo's one hashing
          // chokepoint: RFC 8785 canonical JSON, then SHA-256. Hashing
          // `JSON.stringify` output made "byte stable" depend on key order,
          // and the two paths do not build `meta` the same way — the fresh
          // path spreads an object, the convergence path decodes through
          // `Schema.decodeUnknownEffect(AttemptMeta)`, which emits keys in
          // schema declaration order. Today the two orders coincide, so the
          // break was latent; adding one optional field to `AttemptMeta` or
          // `BoundaryEvidence` above an existing one, or reordering the spread
          // at line 1405, would have made the convergence re-record compute a
          // different `generation`, append fresh provenance on every later
          // dispatch, and reopen the unbounded-append regression issue #124
          // closed. Canonical JSON makes the stability structural.
          const generation = yield* Schema.decodeUnknownEffect(DerivedKey)({
            kind: "cache-generation",
            meta,
            result: options.result
          }).pipe(Effect.orDie)
          // The provenance record and the row it describes commit together:
          // the row carries the record's canonical seq as its provenance, so a
          // crash between them left either a row pointing at a sequence that
          // does not exist or a `recorded` entry for a row nobody wrote.
          // Losing the first-writer race is not that crash — it is a decision,
          // and it stays journalled: the `recorded` entry says what this run
          // tried to record and the `cache-conflict` entry below says how it
          // resolved.
          const recording = yield* atomically(
            Effect.gen(function*() {
              const receipt = yield* emitLifecycle(
                JournalRecords.cacheProvenance({
                  runId: deps.runId,
                  lineageId,
                  cacheKey: keyDigest,
                  sourceId: `${deps.sourceId}:cache:${keyDigest}:recorded:${generation}`,
                  sourceSeq: 0
                }, { keyDigest, action: "recorded" })
              )
              const entry = {
                keyDigest,
                result: options.result,
                meta,
                createdAtMs: options.createdAtMs,
                recordedRunId: deps.runId,
                recordedEventSeq: receipt.seq
              }
              const outcome = yield* cache.put(entry)
              // Only an inserting put creates a head, so the insertion is
              // journalled in the same transaction. `StepCacheFold` rebuilds the
              // heads from these entries and never from `recorded`, which a
              // duplicate or a losing conflict also writes (issue #2053).
              if (outcome._tag === "Inserted") {
                const recorded = { runId: deps.runId, eventSeq: receipt.seq }
                yield* emitLifecycle(JournalRecords.cacheProvenance(cacheSource("admitted", recorded), {
                  keyDigest,
                  action: "admitted",
                  recordedRunId: recorded.runId,
                  recordedEventSeq: recorded.eventSeq
                }))
              }
              return { entry, outcome }
            })
          ).pipe(Effect.catchTag("@smthrs/step-cache/CacheStoreError", (error) =>
            // Only availability of the local transaction is optional. A known
            // deterministic Conflict below still belongs to Inconsistency.
            noteUnshareable({ stage: "entry", message: `local cache publication failed: ${error.message}` }).pipe(
              Effect.as(undefined)
            )))
          if (recording === undefined) {
            return
          }
          // ENTRY LAST, AND OUTSIDE THE TRANSACTION. The local row and its
          // provenance record are now durable together; only here does the
          // entry become observable to other machines, which is the second half
          // of the REAPI ordering constraint. It is deliberately not inside the
          // transaction above: `CacheSync` speaks HTTP, and nothing that is not
          // storage work may be held across a `DurableWriter` write — a stalled
          // shared cache would block every other writer and roll back a row
          // that has nothing to do with it. A `Conflict` skips publication for
          // the reason the local tier reported it: this machine does not agree
          // with itself about the key yet.
          if (unshareable === undefined && recording.outcome._tag !== "Conflict") {
            unshareable = yield* CachePublication.publishEntry(recording.entry)
          }
          if (unshareable !== undefined) {
            // The refusal is journalled so a missing shared entry is
            // explainable, never inferred from its absence. The identity folds
            // a digest of the reason for the same reason the `recorded` record
            // above folds one of its content (issue #129): a convergence
            // re-record hitting the identical refusal is an exact producer
            // retry the journal collapses into a `Duplicate`, while a
            // *different* refusal is a genuinely new observation that journals
            // fresh — and neither can ever be the same identity carrying
            // different content, which is what an idempotency conflict is.
            yield* noteUnshareable(unshareable)
          }
          if (recording.outcome._tag === "Conflict") {
            const conflicting = yield* cache.get(keyDigest)
            if (meta.nondeterministic === true) {
              const recorded = Option.map(conflicting, (entry) => ({
                runId: entry.recordedRunId,
                eventSeq: entry.recordedEventSeq
              }))
              // Declared output nondeterminism is not a hermeticity violation,
              // so it does not enter the Inconsistency receiver. The key folds
              // the declaration, making first-writer-wins safe for both sides.
              yield* emitLifecycle(
                JournalRecords.cacheProvenance(
                  cacheSource("conflict_first_writer", Option.getOrUndefined(recorded)),
                  {
                    keyDigest,
                    action: "conflict_first_writer",
                    recordedRunId: Option.getOrNull(Option.map(recorded, (value) => value.runId)),
                    recordedEventSeq: Option.getOrNull(Option.map(recorded, (value) => value.eventSeq))
                  }
                )
              )
              return
            }
            const receiverOption = yield* Effect.serviceOption(Inconsistency.Inconsistency)
            // Core default is STRICT: journal the conflict and fail the run,
            // which is Skyframe's throwing `GraphInconsistencyReceiver`.
            // Providing `Inconsistency.layerTolerant` opts out.
            const receiver = Option.isSome(receiverOption)
              ? receiverOption.value
              : Inconsistency.make({ journal, verdict: "fail", owner: deps.owner })
            const verdict = yield* receiver.note({
              key: keyDigest,
              existing: Option.getOrUndefined(conflicting),
              attempted: recording.entry
            })
            if (verdict === "fail") {
              return yield* Effect.fail(
                new CacheConflictDetected({
                  code: "cache_conflict_detected",
                  keyDigest,
                  recordedRunId: Option.isSome(conflicting) ? conflicting.value.recordedRunId : "unknown"
                })
              )
            }
          }
        })
      // Everything from the cache-hit verification to the terminal transition
      // runs under this process's exclusive permit for the attempt key
      // (issues #102, #103, #118): the adoption decision below is taken from
      // a read no in-process racer can invalidate before the claim lands, a
      // concurrent same-key dispatch waits here until the winner's terminal
      // row is visible and replays it instead of re-executing the body, and
      // the cache block's read-verify-materialize-evict span can never
      // interleave with another dispatch's execution. A verified hit returns
      // from inside the permit. The permit is keyed by (runId, stepKeyDigest)
      // alone (issue #133): the cache row is addressed with no attempt
      // material, so folding the attempt counter in let sanctioned keyed
      // dispatches at skewed attempt counters (#111/#116) acquire different
      // permits and interleave the very span the permit serializes. The step
      // key, not the narrowed cache address, is what serializes here, because
      // the attempt rows two scopes of one key share are what they race over.
      return yield* admission.withPermit(`${deps.runId}|${stepKeyDigest}`)(
        Effect.gen(function*() {
          // Lifecycle announcements take a per-attempt producer identity
          // (issue #91): adoption — or a replay after a crash in the
          // finish→emit window (issue #109) — re-emits records a dead
          // incarnation may already have announced, and lifecycle records
          // without a `sourceSeq` allocate a fresh journal row on every
          // emission. A dedicated `(sourceId, sourceSeq 0)` per record makes
          // the re-emission an exact producer retry the journal collapses
          // into a `Duplicate`.
          const attemptSource = (record: string): JournalRecords.EventOptions => ({
            runId: deps.runId,
            lineageId,
            // A sealed dispatch's result lives in the step cache, so the record
            // carries the digest that addresses it: replay hands the projection
            // the sealed value instead of re-deriving it, and a cache miss is
            // simply an absent value rather than a broken fold.
            ...(input.tier === "sealed" ? { cacheKey: keyDigest } : {}),
            sourceId: `${deps.sourceId}:attempt:${stepKeyDigest}:${input.attempt}:${record}`,
            sourceSeq: 0
          })
          /**
           * Journal-convergence emit for the replay branches (issue #109):
           * an identical re-emission collapses into a `Duplicate`, and an
           * `idempotency_conflict` may mean the journal already holds this
           * record under this producer identity as another lineage recorded
           * it — a time-travel fork copies the parent's journal rows, so the
           * copied record names the parent run. A cache-provenance record
           * may also restate a fact this run already journalled with fresh
           * measurements (an expiry re-measured after a resume). Those are
           * the only conflicts this emit tolerates, and only after reading
           * the occupying record and validating it: an attempt-scoped record
           * must be this record as a retained fork ancestor emitted it — same
           * event type, attempt coordinates and terminal state
           * (`CopiedRecord.accept`); a provenance record must state the same
           * fact about the same row (`ProvenanceSlot.accept`). An unrelated
           * or contradictory record in the slot — corrupt or imported
           * history, a producer collision — surfaces the journal's own
           * conflict instead of a replay that reports no inconsistency.
           */
          const emitConverging = (record: JournalEvent.Input) =>
            emitLifecycle(record).pipe(
              Effect.catch((error) =>
                error.code !== "idempotency_conflict"
                  ? Effect.fail(error)
                  : record.eventType === "flows.engine.cache-provenance"
                  ? ProvenanceSlot.accept({ journal, runId: deps.runId, record, conflict: error })
                  : CopiedRecord.accept({ journal, runs, runId: deps.runId, record, conflict: error })
              )
            )
          /**
           * Records and clears a row the declared time to live has aged out.
           *
           * The age judgement is journalled BEFORE the row is dropped, and
           * with the age and the bound in the payload, so a reader can tell an
           * expiry from a plain miss and a replay reads the recorded verdict
           * instead of re-judging the age against a fresh clock. The eviction
           * is what keeps `CacheStore.put`'s insert-or-nothing head from
           * turning the re-execution's genuinely newer result into a
           * `Conflict` — the same repair the stale-read-set branch performs
           * (issue #99) — and it is fenced on the expired row's own provenance
           * (issue #119) so a fresh row another process landed in the meantime
           * survives.
           */
          const expireRow = (ttlMs: number, stale: CacheStore.CacheEntry) =>
            Effect.gen(function*() {
              const recorded = {
                runId: stale.recordedRunId,
                eventSeq: stale.recordedEventSeq
              }
              const nowMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
              yield* emitConverging(
                JournalRecords.cacheProvenance(cacheSource("expired", recorded), {
                  keyDigest,
                  action: "expired",
                  ttlMs,
                  ageMs: nowMs - stale.createdAtMs,
                  recordedRunId: recorded.runId,
                  recordedEventSeq: recorded.eventSeq
                })
              )
              yield* cache.evict(keyDigest, { ifRecordedBy: recorded })
            })
          /**
           * Decides — once, durably — whether a row is inside the declared time
           * to live, and answers the DECISION THIS RUN RECORDED rather than the
           * one this clock reading would make.
           *
           * A time to live is the one cache input that changes answer on its
           * own. A dispatch that served a row at 900 ms and then lost its
           * process would, on the plain reading, re-dispatch at 1100 ms, expire
           * the row it already served, and execute a body whose result the run
           * had already consumed. The verdict is therefore journalled before it
           * is acted on, under a producer identity that names the step key, the
           * `ttl` decision, and the row's own recorded provenance
           * (`cacheSource`), with `sourceSeq` 0. That identity belongs to the
           * RUN, not to the incarnation driving it, so the engine that resumes
           * the run reads the same verdict rather than taking a second one.
           *
           * `Accepted` records the first decision; `Duplicate` confirms it.
           * A conflict alone does not identify the recorded verdict: TTL is
           * not part of every action key, and copied history can carry other
           * lineage metadata. Only an exact duplicate of the opposite verdict
           * proves a clock change. Otherwise fail before serving or expiring
           * the row, preserving the incompatible history for the caller.
           *
           * A row re-recorded under a provenance this run already expired keeps
           * that verdict, which is the same rule read from the other side.
           */
          const admitByAge = (ttlMs: number, row: CacheStore.CacheEntry) =>
            Effect.gen(function*() {
              const recorded = { runId: row.recordedRunId, eventSeq: row.recordedEventSeq }
              const nowMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
              const measured: "admitted" | "expired" = nowMs - row.createdAtMs <= ttlMs ? "admitted" : "expired"
              const decision = (verdict: "admitted" | "expired") =>
                JournalRecords.cacheProvenance(cacheSource("ttl", recorded), {
                  keyDigest,
                  action: "ttl",
                  ttlMs,
                  verdict,
                  recordedRunId: recorded.runId,
                  recordedEventSeq: recorded.eventSeq
                })
              // A copied producer whose source fields changed must not look
              // like a new first decision merely because emit would accept it.
              const expectedSource = cacheSource("ttl", recorded).sourceId
              const prior = yield* CacheAgeHistory.find(journal, deps.runId, (entry) => {
                const payload = entry.payload as {
                  action?: unknown
                  keyDigest?: unknown
                  recordedRunId?: unknown
                  recordedEventSeq?: unknown
                } | null
                return entry.sourceId === expectedSource ||
                  (payload?.action === "ttl" && payload.keyDigest === keyDigest &&
                    payload.recordedRunId === recorded.runId && payload.recordedEventSeq === recorded.eventSeq)
              })
              if (prior !== undefined && (prior.sourceId !== expectedSource || prior.sourceSeq !== 0)) {
                yield* emitConverging(JournalRecords.cacheProvenance(cacheSource("replay_failed", recorded), {
                  keyDigest,
                  action: "replay_failed",
                  reason: "incompatible-age-history",
                  recordedRunId: recorded.runId,
                  recordedEventSeq: recorded.eventSeq
                }))
                return yield* Effect.fail(
                  new Journal.JournalError({
                    code: "idempotency_conflict",
                    message: "incompatible recorded cache-age decision: producer identity changed",
                    cause: prior
                  })
                )
              }
              return yield* emitLifecycle(decision(measured)).pipe(
                Effect.as(measured),
                Effect.catch((error) => {
                  if (error.code !== "idempotency_conflict") {
                    return Effect.fail(error)
                  }
                  const conflict = new Journal.JournalError({
                    code: "idempotency_conflict",
                    message:
                      "incompatible recorded cache-age decision: restore the original TTL and history identity " +
                      "or use a new action identity; the cache row was not served or expired",
                    cause: error
                  })
                  const opposite = measured === "admitted" ? "expired" : "admitted"
                  return emitLifecycle(decision(opposite)).pipe(
                    Effect.catch((oppositeError) =>
                      oppositeError.code === "idempotency_conflict"
                        ? CacheAgeHistory.copiedVerdict({
                          journal,
                          runs,
                          runId: deps.runId,
                          decision: decision(measured),
                          conflict
                        }).pipe(
                          Effect.tapError((failure) =>
                            failure.code === "idempotency_conflict"
                              ? emitConverging(JournalRecords.cacheProvenance(cacheSource("replay_failed", recorded), {
                                keyDigest,
                                action: "replay_failed",
                                reason: "incompatible-age-history",
                                recordedRunId: recorded.runId,
                                recordedEventSeq: recorded.eventSeq
                              })).pipe(Effect.asVoid)
                              : Effect.void
                          ),
                          Effect.map((verdict) => ({ _tag: "Historical" as const, verdict }))
                        )
                        : Effect.fail(oppositeError)
                    ),
                    Effect.flatMap((receipt) =>
                      receipt._tag === "Historical" ?
                        Effect.succeed(receipt.verdict) :
                        receipt._tag === "Duplicate"
                        ? Effect.succeed(opposite)
                        : Effect.fail(conflict)
                    )
                  )
                })
              )
            })
          /**
           * The row this dispatch may serve, after the declared age bound.
           *
           * The bound is applied here rather than inside `cache.get` so the
           * refusal is a decision this run journalled and owns, not a read
           * policy the store re-derives from a fresh clock on every lookup.
           * The no-TTL guard refreshes a per-executor verdict index through
           * the journal's current tail before answering absence. Its cursor
           * covers only fully processed pages in the same journal generation;
           * resume or a changed history rebuilds it once, never per dispatch.
           */
          const admissible = (
            ttlMs: number | undefined,
            row: Option.Option<CacheStore.CacheEntry>
          ): Effect.Effect<Option.Option<CacheStore.CacheEntry>, Journal.JournalError | CacheStore.CacheStoreError> =>
            Effect.gen(function*() {
              // Removing TTL cannot bypass a verdict this run already consumed,
              // even if the head was subsequently evicted or replaced.
              if (ttlMs === undefined) {
                const recorded = yield* recordedAgeVerdict(journal, keyDigest)
                if (recorded !== undefined) {
                  return yield* Effect.fail(
                    new Journal.JournalError({
                      code: "idempotency_conflict",
                      message:
                        "incompatible recorded cache-age decision: ttlMs cannot be removed after a recorded verdict",
                      cause: recorded
                    })
                  )
                }
                return row
              }
              if (Option.isNone(row)) {
                return row
              }
              if ((yield* admitByAge(ttlMs, row.value)) === "admitted") {
                return row
              }
              yield* expireRow(ttlMs, row.value)
              return Option.none<CacheStore.CacheEntry>()
            })
          // A run's admitted attempt is replay authority. Shared cache rows
          // are replaceable and cannot overwrite its result or failure.
          const existing = yield* attempts.get(attemptId)
          if (cacheDeclaration._tag === "Eligible") {
            const observed = yield* cache.get(keyDigest).pipe(
              Effect.catch((error) =>
                noteUnshareable({ stage: "entry", message: `cache lookup failed: ${error.message}` }).pipe(
                  Effect.as(Option.none<CacheStore.CacheEntry>())
                )
              )
            )
            const evidenceDecision = CacheAdmission.candidate(
              Option.isSome(observed) ? decodeMeta(observed.value.meta) : undefined
            )
            const outputDecision = evidenceDecision._tag === "CandidateEvidence"
              ? CacheOutputPolicy.replay(input.metadata, evidenceDecision.evidence)
              : undefined
            const candidate = outputDecision?._tag === "Refused" ? outputDecision : evidenceDecision
            // A descriptor refusal cannot be turned into TTL eviction. Validate
            // replay authority before any age decision is allowed to prune a head.
            const cached =
              Option.isNone(observed) || candidate._tag === "CandidateEvidence" || policy?.ttlMs === undefined
                ? yield* admissible(policy?.ttlMs, observed)
                : observed
            if (Option.isSome(cached)) {
              if (candidate._tag === "Refused") {
                yield* emitConverging(JournalRecords.cacheProvenance(
                  cacheSource("replay_failed", {
                    runId: cached.value.recordedRunId,
                    eventSeq: cached.value.recordedEventSeq
                  }),
                  {
                    keyDigest,
                    action: "replay_failed",
                    reason: candidate.reason,
                    recordedRunId: cached.value.recordedRunId,
                    recordedEventSeq: cached.value.recordedEventSeq
                  }
                ))
              }
              if (candidate._tag === "CandidateEvidence" && Option.isNone(existing)) {
                const boundary = yield* StepBoundary.StepBoundary
                // Skyframe's dirty check, not "the declaration changed" (issue
                // #90): the read-set digests folded into the step key are caller
                // metadata, so reuse is justified only once the host has
                // measured them and agreed. A stale declaration falls through to
                // a real execution instead of replaying a pre-edit result, and
                // the refusal is journalled so it is visible rather than silent.
                // A boundary the host cannot enforce is likewise not a hit; the
                // dispatch path below re-prepares and fails the attempt properly.
                const measured = yield* boundary.prepare(cacheDeclaration.metadata).pipe(Effect.option)
                const verified = Option.isSome(measured) && StepBoundary.readSetMatches(measured.value)
                if (verified) {
                  const evidence = candidate.evidence
                  // Cache materialization is host work too. The authorized
                  // invocation is durable before it, even without a new attempt.
                  yield* emitCallInvoked
                  let materialized = yield* boundary.replayOutputs(evidence).pipe(Effect.exit)
                  if (
                    Exit.isFailure(materialized) &&
                    CachePublication.replayMissingArtifact(materialized.cause) !== undefined
                  ) {
                    // LAZY DOWNLOAD (issue #172). A shared cache row is
                    // routinely recorded on a machine whose artifacts this one
                    // has never seen, so "the blob is not here" is the normal
                    // first answer, not a defect — and it is the one replay
                    // refusal a shared artifact tier can repair. Fetch, verify,
                    // write back, and retry the replay ONCE. Only once: a
                    // second failure means the tier cannot serve it either, and
                    // the fall-through below (a real execution) is strictly
                    // better than looping. With no shared tier configured
                    // `hydrateArtifacts` reports `false` and this costs one
                    // cheap branch.
                    if (yield* CachePublication.hydrateArtifacts(evidence)) {
                      materialized = yield* boundary.replayOutputs(evidence).pipe(Effect.exit)
                    }
                  }
                  if (Exit.isSuccess(materialized)) {
                    const recorded = {
                      runId: cached.value.recordedRunId,
                      eventSeq: cached.value.recordedEventSeq
                    }
                    yield* emitConverging(JournalRecords.cacheProvenance(cacheSource("hit", recorded), {
                      keyDigest,
                      recordedRunId: cached.value.recordedRunId,
                      recordedEventSeq: cached.value.recordedEventSeq
                    }))
                    // Counted after the provenance emit: `verified_hit` means
                    // the cached result was served, and a journal failure on
                    // the emit fails the dispatch before any result is
                    // returned. A dispatch that dies mid-decision records no
                    // decision; its exit lands in `flows_engine_dispatches`.
                    yield* Metric.update(EngineStoreMetrics.stepCacheDecision.VerifiedHit, 1)
                    // Served from a record: the body never ran, and the node
                    // above this dispatch is told so rather than left to
                    // report work nobody did.
                    yield* Action.reportDispatch({
                      outcome: "replayed",
                      stepKeyDigest,
                      attempt: input.attempt
                    })
                    return cached.value.result
                  }
                  // Evidence the host cannot re-materialize — a transient
                  // filesystem error, or a row recorded by a foreign boundary
                  // implementation — is not a hit and not a run failure
                  // (issue #107): failing here while the verified row survived
                  // repeated refuse→fail on every later run, the exact
                  // permanent-failure loop #99 closed one branch later. The
                  // refusal is journalled and the dispatch path below executes
                  // for real; the row survives for hosts that can replay it.
                  // The refusal record carries its classification (issue
                  // #150): `corruption` for a digest mismatch at the
                  // content-addressed blob path, `host` for everything else —
                  // a failing disk corrupting many blobs must never journal
                  // identically to a one-off EIO.
                  const corruption = replayCorruption(materialized.cause)
                  yield* emitConverging(
                    JournalRecords.cacheProvenance(
                      cacheSource("replay_failed", {
                        runId: cached.value.recordedRunId,
                        eventSeq: cached.value.recordedEventSeq
                      }),
                      {
                        keyDigest,
                        action: "replay_failed",
                        reason: corruption === undefined ? "host" : "corruption",
                        recordedRunId: cached.value.recordedRunId,
                        recordedEventSeq: cached.value.recordedEventSeq
                      }
                    )
                  )
                  if (corruption !== undefined) {
                    // Corruption is an integrity violation, not a retryable
                    // refusal: it routes to the Inconsistency receiver like
                    // a cache-key conflict does. The core default is STRICT
                    // (fail); `Inconsistency.layerTolerant` (or a plugin
                    // verdict) lets the dispatch fall back to the real
                    // execution below, whose re-capture heals the address.
                    const receiverOption = yield* Effect.serviceOption(Inconsistency.Inconsistency)
                    const receiver = Option.isSome(receiverOption)
                      ? receiverOption.value
                      : Inconsistency.make({ journal, verdict: "fail", owner: deps.owner })
                    const verdict = yield* receiver.noteCorruption({
                      runId: deps.runId,
                      keyDigest,
                      path: corruption.path,
                      recordedDigest: corruption.recordedDigest,
                      measuredDigest: corruption.measuredDigest,
                      recordedRunId: cached.value.recordedRunId,
                      recordedEventSeq: cached.value.recordedEventSeq
                    })
                    // Quarantine is journal AND evict (issue #164). The
                    // receiver's durable record preserved the evidence, but
                    // leaving the row in place made the poison permanent for
                    // INLINE evidence: `CacheStore.put` is insert-or-nothing,
                    // so a tolerant re-execution never replaced the corrupt
                    // bytes and re-detected them on every later run, while
                    // strict mode re-failed the key forever. Evicting under
                    // both verdicts lets the next dispatch — the tolerant
                    // fall-through below, or the run after a strict failure —
                    // execute and record cleanly. The evict is fenced on the
                    // poisoned row's own provenance like the stale-read-set
                    // branch (issue #119): a fresh row landed by a concurrent
                    // run between this dispatch's `get` and the `evict` makes
                    // the compare-and-swap a no-op instead of deleting valid
                    // evidence.
                    yield* cache.evict(keyDigest, {
                      ifRecordedBy: {
                        runId: cached.value.recordedRunId,
                        eventSeq: cached.value.recordedEventSeq
                      }
                    })
                    if (verdict === "fail") {
                      return yield* Effect.fail(
                        new CacheCorruptionDetected({
                          code: "cache_corruption_detected",
                          keyDigest,
                          path: corruption.path,
                          recordedDigest: corruption.recordedDigest,
                          measuredDigest: corruption.measuredDigest
                        })
                      )
                    }
                  }
                  // `replay_failed` is a fall-through decision, so it is
                  // counted only once the refusal emit landed and the strict
                  // corruption verdict above has NOT terminated the dispatch:
                  // a dispatch that fails instead of re-executing records no
                  // decision.
                  yield* Metric.update(EngineStoreMetrics.stepCacheDecision.ReplayFailed, 1)
                } else if (Option.isSome(measured)) {
                  // Only a *measured* mismatch is evidence the inputs changed
                  // (issue #110): a host that cannot measure right now — a
                  // transient EIO/EACCES on any declared read path — says
                  // nothing about the read set, so the hit is merely refused for
                  // this dispatch (the path below re-prepares and surfaces the
                  // host failure as an ordinary attempt failure) and the valid
                  // shared row survives for every run whose host is healthy.
                  //
                  // The durable emit is also the fence: `emitDurable` fails with
                  // `fence_lost` for a zombie that lost the run, surfacing as
                  // self-interruption before the eviction below can run.
                  yield* emitConverging(
                    JournalRecords.cacheProvenance(
                      cacheSource("stale_read_set", {
                        runId: cached.value.recordedRunId,
                        eventSeq: cached.value.recordedEventSeq
                      }),
                      {
                        keyDigest,
                        action: "stale_read_set",
                        recordedRunId: cached.value.recordedRunId,
                        recordedEventSeq: cached.value.recordedEventSeq
                      }
                    )
                  )
                  // Skyframe invalidation, not just refusal (issue #99): a stale
                  // read set means the inputs changed, so the re-execution's
                  // result is *expected* to differ — left in place, the poisoned
                  // row turns the fresh `cache.put` into a Conflict, the strict
                  // verdict fails the run, and nothing ever removes the row, so
                  // every later run repeats the refuse → re-execute → conflict →
                  // fail cycle. The refusal is journalled above; evicting here
                  // lets the re-execution record cleanly under the same key.
                  // The eviction is fenced on the poisoned row's own
                  // provenance (issue #119): a fresh entry recorded by a
                  // concurrent run between this dispatch's `get` and its
                  // `evict` must not be deleted with the poison (issue #110).
                  // The permit (issue #118) only closes the *in-process*
                  // window, so the guard rides inside the DELETE rather than
                  // in a preceding read — a foreign process landing a fresh
                  // row simply makes the compare-and-swap a no-op.
                  yield* cache.evict(keyDigest, {
                    ifRecordedBy: {
                      runId: cached.value.recordedRunId,
                      eventSeq: cached.value.recordedEventSeq
                    }
                  })
                  // The fall-through decision is counted once the refusal is
                  // durable and the poisoned row is gone: a fenced-out zombie
                  // self-interrupts at the emit above and records no decision.
                  yield* Metric.update(EngineStoreMetrics.stepCacheDecision.StaleReadSet, 1)
                } else {
                  // The host could not measure the read set at all, so the
                  // hit is merely refused for this dispatch; the row survives.
                  yield* Metric.update(EngineStoreMetrics.stepCacheDecision.Unmeasurable, 1)
                }
              } else if (candidate._tag === "Refused") {
                // A row whose recorded evidence cannot justify reuse — a
                // foreign tier, an unverified capture, a recorded deviation.
                yield* Metric.update(EngineStoreMetrics.stepCacheDecision.UnverifiableEvidence, 1)
              }
            } else {
              yield* Metric.update(EngineStoreMetrics.stepCacheDecision.Miss, 1)
            }
          }

          if (Option.isSome(existing)) {
            const row = existing.value
            if (row.state === "succeeded") {
              yield* emitCallInvoked
              const meta = decodeMeta(row.meta)
              let corruptEvidence = false
              const outputDecision = meta?.boundary === undefined
                ? undefined
                : CacheOutputPolicy.replay(input.metadata, meta.boundary)
              const storedDecision = CacheAdmission.candidate(meta)
              const refused = storedDecision._tag === "Refused" &&
                  (storedDecision.reason === "contradictory-evidence" ||
                    storedDecision.reason === "quarantined-evidence")
                ? storedDecision
                : outputDecision
              if (refused?._tag === "Refused") {
                yield* emitConverging(JournalRecords.cacheProvenance(cacheSource("replay_failed"), {
                  keyDigest,
                  action: "replay_failed",
                  reason: refused.reason
                }))
              }
              if (meta?.boundary !== undefined && refused?._tag !== "Refused") {
                const boundary = yield* StepBoundary.StepBoundary
                const materialized = yield* boundary.replayOutputs(meta.boundary).pipe(Effect.exit)
                if (Exit.isFailure(materialized)) {
                  // The attempt durably succeeded: its recorded outcome is
                  // the truth, and re-materializing the workspace outputs is
                  // best-effort — failing the dispatch here while the
                  // terminal row survived recreated the #99 permanent
                  // refuse→fail loop one branch earlier (issue #107). The
                  // refusal is journalled so a missing output is
                  // explainable rather than silent, and it carries its
                  // classification (issue #150): corruption of the recorded
                  // evidence routes to the Inconsistency receiver instead of
                  // passing as an ordinary transient host refusal.
                  const corruption = replayCorruption(materialized.cause)
                  corruptEvidence = corruption !== undefined
                  yield* emitConverging(
                    JournalRecords.cacheProvenance(cacheSource("replay_failed"), {
                      keyDigest,
                      action: "replay_failed",
                      reason: corruption === undefined ? "host" : "corruption"
                    })
                  )
                  if (corruption !== undefined) {
                    const receiverOption = yield* Effect.serviceOption(Inconsistency.Inconsistency)
                    const receiver = Option.isSome(receiverOption)
                      ? receiverOption.value
                      : Inconsistency.make({ journal, verdict: "fail", owner: deps.owner })
                    const verdict = yield* receiver.noteCorruption({
                      runId: deps.runId,
                      // The attempt row, not a cache row: this evidence is
                      // addressed by (runId, stepKeyDigest, attempt).
                      keyDigest: stepKeyDigest,
                      path: corruption.path,
                      recordedDigest: corruption.recordedDigest,
                      measuredDigest: corruption.measuredDigest
                    })
                    // Quarantine is journal AND take a state action (issues
                    // #164, #171). Unlike a shared cache row, this succeeded
                    // attempt cannot be evicted: its side effects already ran,
                    // so a miss would re-execute potentially irreversible work.
                    // Remove only the corrupt boundary evidence and mark the
                    // row quarantined. The durable outcome stays intact and the
                    // next dispatch returns it without materializing the poison
                    // or publishing the row back into the shared cache.
                    //
                    // The owner heartbeat and patch share one write
                    // transaction. The patch is owner-fenced itself — it only
                    // lands while `flows_runs` still records `deps.owner` —
                    // and the heartbeat both refreshes the lease and reports
                    // the loss as a run-store outcome before the patch runs.
                    // `boundary` is dropped by omitting the key, never by
                    // writing `undefined` over it: the attempt store admits
                    // inert JSON, and an own property holding `undefined` is
                    // not JSON, so the patch would be refused outright.
                    // New quarantine writes clear both reusable proof fields;
                    // contradictory legacy rows remain readable without repair.
                    const { boundary: _quarantined, readSetVerified: _unverified, ...retainedMeta } = meta
                    const quarantinedMeta: AttemptMeta = {
                      ...retainedMeta,
                      boundaryQuarantined: true
                    }
                    const quarantined = yield* atomically(Effect.gen(function*() {
                      const quarantineAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
                      const fence = yield* runs.heartbeat(deps.runId, deps.owner, quarantineAtMs)
                      if (fence._tag !== "Updated") {
                        return false
                      }
                      const patched = yield* attempts.patch(
                        attemptId,
                        { meta: attemptPayload(quarantinedMeta) },
                        deps.owner
                      )
                      return patched._tag === "Patched"
                    }))
                    if (!quarantined) {
                      return yield* Effect.interrupt
                    }
                    if (verdict === "fail") {
                      // The strict verdict still makes the integrity violation
                      // visible by parking this dispatch. The row repair above
                      // is what makes the park resumable without an out-of-band
                      // byte repair. This is a defect, not a declared action
                      // business error: routing it through the failure channel
                      // would make the action's error schema replace it with
                      // a SchemaError.
                      return yield* Effect.die(
                        new AttemptEvidenceQuarantined({
                          code: "attempt_evidence_quarantined",
                          keyDigest: stepKeyDigest,
                          attempt: input.attempt,
                          path: corruption.path,
                          recordedDigest: corruption.recordedDigest,
                          measuredDigest: corruption.measuredDigest
                        })
                      )
                    }
                  }
                }
              }
              // Converge the cache with the durable completion: a crash between
              // `attempts.finish` and `cache.put` otherwise leaves the sealed
              // result permanently missing from the shared cache (issue #24).
              // Reaching this branch with an eligible declaration means `cache.get`
              // above missed or was unfit for replay.
              // Only a row whose recorded read set was verified at prepare
              // time may converge into the shared cache (issue #106): an
              // unverified result was computed against content the key does
              // not describe.
              // A row whose boundary evidence was just measured corrupt is
              // quarantined, never converged (issue #160): a `tolerate`
              // verdict keeps the durable outcome as this run's truth, but
              // publishing the known-corrupt evidence into the shared cache
              // would hand sibling runs a poisoned hit under this run's
              // provenance.
              const admission = CacheAdmission.completion(
                cacheDeclaration,
                meta,
                corruptEvidence || refused?._tag === "Refused"
              )
              if (admission._tag === "PublishCompletion") {
                yield* recordCache({
                  result: row.outcome,
                  admission,
                  createdAtMs: row.finishedAtMs ?? (yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor)))
                })
              }
              // Converge the journal with the durable completion (issue
              // #109): a crash between `attempts.finish` and the terminal
              // emits left `attemptStarted` without `attemptFinished`
              // forever. The per-attempt producer identity collapses the
              // re-emission into a `Duplicate` on ordinary replays.
              if (meta?.boundary?.deviation !== undefined) {
                yield* emitConverging(
                  JournalRecords.expectedSetDeviation(attemptSource("deviation"), {
                    ...attemptId,
                    ...meta.boundary.deviation
                  })
                )
              }
              // Replays publish the saved first observation, never a newly
              // computed timestamp or the current history generation.
              yield* emitStepSettled(row.outcome)
              yield* emitConverging(
                JournalRecords.attemptFinished(attemptSource("finished"), { ...attemptId, state: "succeeded" })
              )
              // Upgrade an older durable controller record without rerunning
              // its handler; current records collapse to the original receipt.
              yield* emitCallSettled(row.outcome)
              // A durable attempt row answered the dispatch, so nothing ran.
              yield* Action.reportDispatch({ outcome: "replayed", stepKeyDigest, attempt: input.attempt })
              return row.outcome
            }
            if (row.state === "failed") {
              yield* emitCallInvoked
              // Converge the journal before rethrowing (issue #109): the
              // violation kind survives in the row meta because the
              // persisted cause alone cannot distinguish a boundary
              // violation from an ordinary execution failure.
              if (decodeMeta(row.meta)?.hardViolation === true) {
                yield* emitConverging(
                  JournalRecords.hardViolation(attemptSource("hard-violation"), {
                    ...attemptId,
                    error: rehydrateCause(row.error)
                  })
                )
              }
              yield* emitConverging(
                JournalRecords.attemptFinished(attemptSource("finished"), { ...attemptId, state: "failed" })
              )
              // A durably failed attempt is replayed by rethrowing the persisted
              // domain failure — never by readmission (issue #59). Falling
              // through to `attempts.put` here surfaced the row as
              // `AttemptAdmissionRejected`, whose tag can never match a
              // policy-declared `nonRetryable` classification, so a durably
              // failed no-retry action earned an extra real dispatch after
              // resume. Temporal's prior art: mutable state persists the attempt
              // failure and `ExecutionInfo.Attempt`, and its no-retry decision
              // (`service/history/workflow/retry.go`) is re-evaluated from that
              // persisted failure — the failure itself is durable, not just the
              // fact that an attempt happened.
              return yield* Effect.failCause(rehydrateCause(row.error))
            }
            if (row.state === "suspended") {
              return yield* Effect.fail(
                new AttemptSuspended({
                  code: "attempt_suspended",
                  runId: deps.runId,
                  keyDigest: stepKeyDigest,
                  attempt: input.attempt
                })
              )
            }
          }

          /**
           * A persisted `running` row read while this owner holds the run fence
           * is crash evidence, not a live admission (issue #71): the incarnation
           * that admitted the attempt died before finishing (SIGKILL, OOM), and
           * the #53 stale-running sweep re-drove the run to a new owner — or the
           * same owner after restart. The attempt never completed, so it must
           * re-execute under its original number rather than fall through to
           * `attempts.put` (whose `Conflict` on the differing `startedAtMs`
           * surfaced as `AttemptAdmissionRejected`, permanently failing a
           * no-policy run with an infrastructure tag). The row is adopted; the
           * ordinary fenced `attempts.finish` transition below records the
           * re-execution's outcome.
           *
           * Adoption requires liveness evidence (issue #86), and that evidence is
           * the admission permit held around this whole span (issues #102, #103):
           * a live same-key dispatch of this process would be holding the permit,
           * so a `running` row observed here cannot belong to a live in-process
           * fiber — it is a dead fiber of this incarnation (an in-process
           * re-drive after an interrupt, the #71 mode the recorded-nonce guard
           * wrongly refused) or a superseded incarnation (which provably lost the
           * run fence this owner holds). Deciding from the recorded `admittedBy`
           * nonce could not tell those apart, and comparing it against a stale
           * pre-claim read left a TOCTOU window where two concurrent dispatches
           * both saw a dead owner and both executed an irreversible body.
           */
          const runningRow = Option.isSome(existing) && existing.value.state === "running"
            ? existing.value
            : undefined
          const runningMeta = runningRow === undefined ? undefined : decodeMeta(runningRow.meta)
          /**
           * ADOPTION READS THE CROSSING BACK. A `running` row is crash
           * evidence, but "the attempt did not settle" is not "the body did
           * not run": an effect whose terminal boundary is already durable was
           * still re-dispatched here, because the row alone cannot say so and
           * nothing ever read the boundary record back. That made a keyless
           * irreversible action charge twice on a SIGKILL landing in the
           * millisecond between the `succeeded` boundary and `attempts.finish`
           * — the exact window the boundary record exists to close.
           *
           * A recorded `succeeded` crossing settles the adopted attempt from
           * the outcome the crossing wrote, in this attempt's own number, and
           * the body never runs again. The outcome comes from the ROW, not
           * from the journal record: journal payloads go through redaction on
           * write, so the record's `output` is observability and the row's
           * `outcome` is the executable copy (see `AttemptMeta.effectCrossing`).
           */
          if (runningRow !== undefined && runningMeta?.effectCrossing === "succeeded") {
            yield* emitCallInvoked
            const finishedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
            // `outcome` and `meta` are deliberately omitted: `FinishAttempt`
            // leaves an omitted field as recorded, so the terminal transition
            // is the crossing's own result being sealed rather than a value
            // this incarnation invented.
            const finished = yield* settleAttempt(
              { ...attemptId, state: "succeeded", finishedAtMs },
              [JournalRecords.attemptFinished(attemptSource("finished"), { ...attemptId, state: "succeeded" })]
            )
            if (!finished) {
              return yield* Effect.interrupt
            }
            return runningRow.outcome
          }
          /**
           * AN UNRESOLVED CROSSING IS NOT SILENTLY RE-DISPATCHED. `intended`
           * without a terminal crossing means the body was dispatched and
           * nothing durable says how it ended: the charge may have gone
           * through, and no record can settle the question. An idempotency key
           * is the one thing that makes the repeat safe, so with a key the
           * attempt re-executes exactly as before, and without one this
           * refuses under the same error a numbered retry refuses under. The
           * run stops with a typed, durable "we cannot tell whether this
           * happened" for an operator, which is the honest outcome; charging a
           * second time to keep the run moving is not.
           *
           * Only tier 3 refuses. A compensable body is re-executed on a
           * restored pre-image (issue #87), which is what makes its repeat
           * safe by construction.
           */
          if (
            input.tier === "irreversible" &&
            runningMeta?.effectCrossing === "intended" &&
            deps.idempotencyKey === undefined
          ) {
            return yield* Effect.fail(
              new Action.IrreversibleRetryRequiresIdempotencyKey({
                actionName: actionKind(input.action),
                attempt: input.attempt
              })
            )
          }
          // THE REPLAY-ONLY GATE. Every durable record that could serve this
          // dispatch has been consulted above; what remains is admitting an
          // attempt and running the body. A replay-only engine stops here,
          // before the attempt row, the snapshot, the boundary and the body.
          if (deps.replayOnly !== undefined) {
            replay.gated = true
            const refused = {
              runId: deps.runId,
              stepKeyDigest,
              attempt: input.attempt,
              action: actionKind(input.action)
            }
            yield* deps.replayOnly.observe({ ...refused, tier: input.tier, outcome: "would-execute" })
            return yield* Effect.die(new ReplayOnly.WouldExecute(refused))
          }
          const adopted = runningRow !== undefined
          // The admission row and its announcement commit as one unit: an
          // `attemptStarted` never describes a row that rolled back, and an
          // admitted attempt is never invisible to the journal.
          yield* atomically(Effect.gen(function*() {
            if (!adopted) {
              const now = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
              const initialMeta: AttemptMeta = { ...declarationMeta, admittedBy: deps.owner }
              const put = yield* attempts.put(
                { ...attemptId, state: "running", startedAtMs: now, meta: attemptPayload(initialMeta) },
                deps.owner
              )
              if (put._tag === "FenceLost" || put._tag === "RunNotFound") {
                return yield* Effect.interrupt
              }
              if (put._tag !== "Inserted") {
                return yield* Effect.fail(
                  new AttemptAdmissionRejected({
                    code: "attempt_admission_rejected",
                    keyDigest: stepKeyDigest,
                    outcome: put._tag
                  })
                )
              }
            } else {
              // The claim is fenced at the moment it lands (issue #102): re-verify
              // run ownership immediately before re-homing the row, so a process
              // that lost the fence while waiting on the permit parks instead of
              // patching a run it no longer owns. The patch below carries the
              // owner fence itself; the heartbeat additionally refreshes the
              // lease, and the permit excludes in-process racers.
              const claimAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
              const claimFence = yield* runs.heartbeat(deps.runId, deps.owner, claimAtMs)
              if (claimFence._tag !== "Updated") {
                return yield* Effect.interrupt
              }
              // Re-home the adopted row to the current incarnation; the patch
              // keeps the dead incarnation's other meta (tier, pre-image
              // snapshot) intact. A vanished row or a lost fence means the
              // durable state moved under us — surface it as self-interruption
              // like the other fence losses.
              const rehomed = yield* attempts.patch(attemptId, {
                meta: attemptPayload(
                  { ...runningMeta, ...declarationMeta, admittedBy: deps.owner } satisfies AttemptMeta
                )
              }, deps.owner)
              if (rehomed._tag !== "Patched") {
                return yield* Effect.interrupt
              }
            }
            yield* emitLifecycle(
              JournalRecords.attemptStarted(attemptSource("started"), { ...attemptId, tier: input.tier })
            )
            // Shares attempt admission's transaction. Refusal rolls admission
            // back before a handler, snapshot, or sandbox can execute.
            yield* emitCallInvoked
          }))

          /** The pre-image as the attempt row carries it: the jj operation only when reported. */
          const snapshotFields = (id: string, operationId: string | undefined) =>
            operationId === undefined
              ? { meta: { snapshotId: id }, announced: { snapshotId: id } }
              : {
                meta: { snapshotId: id, snapshotOperationId: operationId },
                announced: { snapshotId: id, operationId }
              }
          const announceSnapshot = (fields: ReturnType<typeof snapshotFields>) =>
            emitLifecycle(
              JournalRecords.snapshotIdentified(attemptSource("snapshot"), { ...attemptId, ...fields.announced })
            )
          let snapshotId: string | undefined
          let snapshotMeta: Pick<AttemptMeta, "snapshotId" | "snapshotOperationId" | "boundarySnapshot"> = {}
          if (input.tier !== "compensable") {
            /**
             * THE TIER-2 ANCHOR FOR AN ORDINARY FRAME.
             *
             * Time travel (`packages/smithers/flows/time-travel/docs/README.md`) requires the jj pointer
             * current when a seq was journaled to be recorded at the frame,
             * because replay cannot derive it. Only compensable work took a
             * fresh snapshot, so every other frame had no anchor at all and a
             * rewind to it restored the workspace to whatever the nearest
             * *compensable* attempt happened to leave behind.
             *
             * The anchor is `carried`: it asserts "the same pointer as the
             * previous anchor in this lineage" rather than naming one. That is
             * the cheap half of the obligation — no jj call, no host round
             * trip, one journal row — and the snapshot projector resolves it by
             * copying the last change id forward. A lineage that has taken no
             * snapshot yet carries nothing forward, which is honest: there is
             * no pointer to restore, and a rewind reports none rather than
             * inventing one.
             */
            yield* emitLifecycle(
              JournalRecords.snapshotIdentified(attemptSource("snapshot"), { ...attemptId, carried: true })
            )
          }
          if (input.tier === "compensable") {
            const jj = deps.engineJj === undefined ? yield* Jj.Jj : deps.engineJj
            /**
             * THE ENGINE'S BOUNDARY HANDLE (issue #1805). The engine restores
             * the retry sequence's original handle inside `input.snapshot` and
             * hands back this attempt's pre-image. It runs only here, past the
             * journal and cache lookups, so a replayed attempt never touches
             * the boundary. An adopted attempt keeps the handle its dead
             * incarnation persisted: that one predates any partial mutation.
             * Every meta write below carries it, so it reaches the row before
             * the body can run.
             */
            const boundaryHandle = input.snapshot === undefined ? undefined : yield* input.snapshot
            const boundarySnapshot = runningMeta?.boundarySnapshot ?? (
              input.snapshot === undefined
                ? undefined
                : boundaryHandle === undefined
                ? {}
                : { handle: boundaryHandle }
            )
            const boundaryMeta = boundarySnapshot === undefined ? {} : { boundarySnapshot }
            if (adopted && runningMeta?.snapshotId !== undefined) {
              // The dead incarnation persisted this attempt's own pre-image
              // before mutating the workspace (issue #87): restore it so the
              // re-execution runs on the clean tree, and keep it as the attempt's
              // compensation baseline instead of snapshotting the dirty state.
              yield* jj.restore(runningMeta.snapshotId)
              snapshotId = runningMeta.snapshotId
              const fields = snapshotFields(snapshotId, runningMeta.snapshotOperationId)
              snapshotMeta = { ...fields.meta, ...boundaryMeta }
              // Re-announcing a pre-image the row already records durably:
              // there is no state write to pair this announcement with.
              yield* announceSnapshot(fields)
            } else {
              if (input.attempt > 1) {
                const previous = yield* attempts.get({ ...attemptId, attempt: input.attempt - 1 })
                if (
                  Option.isSome(previous) &&
                  decodeMeta(previous.value.meta)?.snapshotId !== undefined
                ) {
                  yield* jj.restore(decodeMeta(previous.value.meta)!.snapshotId!)
                }
              }
              const snapshot = yield* jj.snapshot(`smithers action ${stepKeyDigest} attempt ${input.attempt}`)
              // The immutable commit id: a retry or an adoption restores this
              // pointer, and a change id would follow an agent's rewrite of the
              // pre-image change (`jj squash`) and restore the step's edits.
              snapshotId = snapshot.commitId
              const fields = snapshotFields(snapshotId, snapshot.operationId)
              snapshotMeta = { ...fields.meta, ...boundaryMeta }
              // Persist the pre-image into the running row before announcing it
              // (issue #87): a SIGKILL mid-attempt must not lose the only
              // reference to the clean tree, or adoption re-executes on top of
              // the dead incarnation's partial mutations. The announcement
              // shares the patch's transaction, so the journal never names a
              // pre-image the row does not carry. The Jj snapshot itself stays
              // outside: a host call must never run inside a write transaction.
              yield* atomically(
                attempts.patch(attemptId, {
                  meta: attemptPayload(
                    { ...declarationMeta, admittedBy: deps.owner, ...snapshotMeta } satisfies AttemptMeta
                  )
                }, deps.owner).pipe(Effect.andThen(announceSnapshot(fields)))
              )
            }
          }

          /**
           * Settles an attempt its boundary refused and rethrows the refusal.
           * Preparation, sandbox open, and settlement can each refuse, and all
           * three are the same durable transition: a `failed` row marked
           * `hardViolation`, committed with the hard-violation record and the
           * failed finish. A lost fence self-interrupts instead.
           *
           * A boundary exists only for sealed work, while snapshots are
           * created only for compensable work. The two capabilities are
           * disjoint, so a refused attempt never carries a snapshot.
           */
          const failBoundaryAttempt = (cause: Cause.Cause<unknown>) =>
            Effect.gen(function*() {
              const finishedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
              const finished = yield* settleAttempt({
                ...attemptId,
                state: "failed",
                finishedAtMs,
                error: attemptPayload(persistCause(cause)),
                meta: { ...declarationMeta, hardViolation: true }
              }, [
                JournalRecords.hardViolation(attemptSource("hard-violation"), { ...attemptId, error: cause }),
                JournalRecords.attemptFinished(attemptSource("finished"), { ...attemptId, state: "failed" })
              ])
              if (!finished) {
                return yield* Effect.interrupt
              }
              return yield* Effect.failCause(cause)
            })
          const boundary = input.tier === "sealed" && input.metadata !== undefined
            ? yield* StepBoundary.StepBoundary
            : undefined
          const preparedResult = boundary === undefined || input.metadata === undefined
            ? undefined
            : yield* boundary.prepare(input.metadata).pipe(Effect.exit)
          if (preparedResult !== undefined && Exit.isFailure(preparedResult)) {
            return yield* failBoundaryAttempt(preparedResult.cause)
          }
          const prepared = preparedResult === undefined ? undefined : preparedResult.value

          /**
           * THE ISOLATED EXECUTION (this lane). A sealed action carrying a
           * boundary descriptor runs inside a workspace transaction when one
           * is composed: the body observes only its declared read set, its
           * writes become a diff bundle, and the host is untouched until
           * copy-back. That is what makes whole-tree write verification
           * structural rather than inferred — and therefore what lets a
           * production-composed result enter the shared cache at all.
           *
           * The service is optional. Without it the body runs directly
           * against the host, exactly as before, and its evidence keeps the
           * honest omission that withholds it from the shared cache.
           */
          const stepSandbox = boundary === undefined || input.metadata === undefined
            ? Option.none<StepSandbox.Service>()
            : yield* Effect.serviceOption(StepSandbox.StepSandbox)
          const opened = Option.isSome(stepSandbox) ? yield* stepSandbox.value.open.pipe(Effect.exit) : undefined
          if (opened !== undefined && Exit.isFailure(opened)) {
            // A host that cannot isolate (`layerNoop`, a refusing forest) is a
            // typed refusal, not a crash: settle the attempt, or the row stays
            // "running" and reads as an abandoned attempt to the reclaim
            // machinery.
            return yield* failBoundaryAttempt(opened.cause)
          }
          const sandbox = boundary === undefined || input.metadata === undefined
            ? undefined
            : opened !== undefined
            ? opened.value
            : Option.getOrUndefined(yield* Effect.serviceOption(WorkspaceSandbox.WorkspaceSandbox))
          const isolated = sandbox === undefined || input.metadata === undefined
            ? undefined
            : yield* SandboxedExecution.execute({
              sandbox,
              descriptor: input.metadata,
              workflow: execute(input, stepKeyDigest)
            }).pipe(Effect.exit)
          // The settlement is the isolated execution's whole story; the
          // attempt's outcome is only its `result`, so the ordinary failure
          // handling below is unchanged by which path produced it.
          const settlement = isolated !== undefined && Exit.isSuccess(isolated) ? isolated.value : undefined
          /**
           * THE EFFECT BOUNDARY. An irreversible dispatch can change the world
           * outside this journal, and a compensable one mutates the workspace
           * a rewind must restore — both are wrapped: `intended` commits
           * before the body starts, and the terminal record commits after it
           * settles — `succeeded` with the recorded result, `unknown` for a
           * failure, defect, or interruption whose external outcome nobody can
           * testify to.
           *
           * The compensable record is what makes the tier-2 restore REAL: a
           * rewind classifies the doomed suffix by its boundary rows, so a
           * compensable action that recorded only its pre-image snapshot left
           * nothing for the rewind to restore against — the suffix archived
           * "completed" while the tree kept the discarded future's bytes. The
           * record names the attempt's anchored `changeId` so the evidence and
           * the pointer travel together.
           *
           * The settlement is uninterruptible: cancellation must not strand an
           * effect that has already crossed without at least attempting to say
           * so. Sealed work is deliberately outside this — a sealed result is
           * cache evidence, and replay answers it from the recorded cache
           * entry rather than an operator decision.
           */
          const effect = input.tier === "irreversible" || input.tier === "compensable"
            ? {
              id: `${deps.runId}:${stepKeyDigest}:${input.attempt}`,
              kind: actionKind(input.action),
              tier: input.tier,
              runId: deps.runId,
              lineageId,
              sourceId: deps.sourceId,
              attempt: input.attempt,
              ...(deps.idempotencyKey === undefined ? {} : { idempotencyKey: deps.idempotencyKey }),
              ...(snapshotId === undefined ? {} : { changeId: snapshotId })
            } satisfies EffectRecords.Descriptor
            : undefined
          /**
           * Whether a failing exit ends this dispatch in a durable PARK rather
           * than a settlement (N-08). A body that reaches a wait point marks
           * its instance suspended and interrupts, so an interrupt-only exit
           * under a suspended instance is a run that parked. Quarantine from
           * a nested action also parks its wrapper: resume must re-enter it
           * to consume the inner action's preserved outcome. Both the effect
           * boundary and the attempt row read it: a park closes neither.
           */
          const parked = (cause: Cause.Cause<unknown>) =>
            Effect.map(
              Effect.serviceOption(FlowRuntime.FlowInstance),
              (instance) =>
                evidenceQuarantined(cause) !== undefined ||
                (Option.getOrUndefined(instance)?.suspended === true && Cause.hasInterruptsOnly(cause))
            )
          /**
           * The row's meta as this dispatch last wrote it. The crossing writes
           * below patch `meta` wholesale, so everything the attempt already
           * carries — the adopted incarnation's fields, the tier declaration,
           * the compensable pre-image — has to be carried across with it.
           */
          const dispatchMeta = {
            ...runningMeta,
            ...declarationMeta,
            admittedBy: deps.owner,
            ...snapshotMeta
          } satisfies AttemptMeta
          /**
           * Commits a crossing into the attempt row, with the boundary record
           * that describes it when there is one, as ONE transaction.
           *
           * The row is what recovery reads (see `AttemptMeta.effectCrossing`),
           * so a crash must never leave the two disagreeing: a record without
           * the row would re-dispatch a crossed effect, and a row without the
           * record would settle a run from evidence the audit cannot show. A
           * refused patch is a lost fence, surfaced as self-interruption like
           * every other fence outcome here, and reported from OUTSIDE the
           * transaction so the transaction's own failures stay storage
           * failures.
           */
          const recordCrossing = (
            crossing: NonNullable<AttemptMeta["effectCrossing"]>,
            patch: AttemptStore.AttemptPatch,
            record?: JournalEvent.Input
          ) =>
            Effect.flatMap(
              atomically(Effect.gen(function*() {
                if (record !== undefined) {
                  yield* emitLifecycle(record)
                }
                const patched = yield* attempts.patch(
                  attemptId,
                  {
                    ...patch,
                    meta: attemptPayload({ ...dispatchMeta, effectCrossing: crossing } satisfies AttemptMeta)
                  },
                  deps.owner
                )
                return patched._tag === "Patched"
              })),
              (recorded) => recorded ? Effect.void : Effect.interrupt
            )
          const dispatch = effect === undefined
            ? execute(input, stepKeyDigest)
            : Effect.uninterruptibleMask((restore) =>
              Effect.gen(function*() {
                yield* recordCrossing("intended", {}, EffectRecords.boundary(effect, "intended"))
                const exit = yield* Effect.exit(restore(execute(input, stepKeyDigest)))
                yield* Exit.isSuccess(exit)
                  ? recordCrossing(
                    "succeeded",
                    { outcome: attemptPayload(exit.value) },
                    EffectRecords.boundary(effect, "succeeded", exit.value)
                  )
                  // A park leaves the boundary OPEN. The terminal record says
                  // the effect finished and nobody can testify to how; a parked
                  // dispatch has not finished, and the next drive re-enters the
                  // SAME attempt. Writing it here made a routine park and
                  // resume read `intended, unknown, intended, succeeded` in the
                  // journal a rewind classifies a doomed suffix from.
                  //
                  // The park is still recorded in the ROW, with no record to
                  // pair it with: a park and a SIGKILL mid-body leave the same
                  // `running` row and the same open boundary, and only this
                  // says which one happened. Without it the resumed wait looked
                  // like an unresolved crossing and the refusal above made every
                  // keyless irreversible wait unresumable.
                  : Effect.flatMap(
                    parked(exit.cause),
                    (isPark) =>
                      isPark
                        ? recordCrossing("parked", {})
                        : Effect.ignore(emitLifecycle(EffectRecords.boundary(effect, "unknown")))
                  )
                return yield* exit
              })
            )
          const outcome = isolated === undefined
            ? yield* dispatch.pipe(Effect.exit)
            : Exit.map(isolated, (settled) => settled.result)
          if (Exit.isFailure(outcome)) {
            /**
             * A DURABLE PARK IS NOT A SETTLEMENT (N-08). A body that reaches a
             * wait point ends its fiber by self-interruption — `Flow.suspend`
             * marks the instance and interrupts — so an interrupt-only exit
             * from a dispatch whose instance is suspended describes a run that
             * parked, not an attempt that failed. Settling it below wrote a
             * `failed` row carrying the interrupt cause, and the replay branch
             * above then rethrew that cause on every later drive: the run died
             * with "All fibers interrupted without error" instead of resuming.
             * The memory engine kept no attempt row and so never saw it, which
             * is why `HumanTask.timeoutMs`, `Action.raceAll`, and every durable
             * wait raced against a timer worked in memory and not on SQLite.
             *
             * The row therefore stays `running`, which is exactly the shape the
             * adoption path above re-enters: the next drive re-executes the
             * body under the SAME attempt number, so the park costs nothing
             * against the retry budget and the raced deferreds re-register
             * against their persisted completions. `running` is also the only
             * in-progress state the attempt store admits, so a later settlement
             * of this attempt is an ordinary fenced `finish`.
             */
            if (yield* parked(outcome.cause)) {
              return yield* Effect.failCause(outcome.cause)
            }
            const finishedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
            // A boundary violation raised while the body ran is classified
            // like one raised at settle time (issue #109): the row records it
            // so a post-crash replay can re-emit the violation record, which
            // the persisted cause alone cannot distinguish.
            const violation = declarationViolated(outcome.cause)
            const finished = yield* settleAttempt({
              ...attemptId,
              state: "failed",
              finishedAtMs,
              error: attemptPayload(persistCause(outcome.cause)),
              meta: attemptPayload(
                {
                  ...declarationMeta,
                  ...(violation ? { hardViolation: true as const } : {}),
                  ...snapshotMeta
                } satisfies AttemptMeta
              )
            }, [
              ...(violation
                ? [
                  JournalRecords.hardViolation(attemptSource("hard-violation"), {
                    ...attemptId,
                    error: outcome.cause
                  })
                ]
                : []),
              JournalRecords.attemptFinished(attemptSource("finished"), { ...attemptId, state: "failed" })
            ])
            if (!finished) {
              return yield* Effect.interrupt
            }
            return yield* Effect.failCause(outcome.cause)
          }
          if (settlement !== undefined) {
            // Forensics requires both halves as journal facts, never inferred
            // from an absence: what the
            // transaction proposed, and that it reached the host.
            yield* emitConverging(
              JournalRecords.diffBundleCaptured(attemptSource("diff-bundle"), {
                ...attemptId,
                bundleIdentity: settlement.bundleIdentity,
                changedPaths: settlement.files.map((change) => change.path),
                deviations: settlement.deviations
              })
            )
            // THE DISPATCH STAGE. Queued effects fire here — after copy-back
            // settled, outside the transaction, deduplicated by idempotency
            // key so a body that queued the same key twice, and a bundle that
            // rebased before it landed, both send exactly once.
            const dispatcher = Option.getOrUndefined(
              yield* Effect.serviceOption(WorkspaceSandbox.EffectDispatcher)
            )
            const deduped = new Set<string>()
            for (const queued of settlement.effects) {
              if (deduped.has(queued.idempotencyKey)) continue
              deduped.add(queued.idempotencyKey)
              if (dispatcher !== undefined) yield* dispatcher.dispatch(queued)
            }
            yield* emitConverging(
              JournalRecords.copyBackSettled(attemptSource("copy-back"), {
                ...attemptId,
                bundleIdentity: settlement.bundleIdentity,
                rebases: settlement.rebases,
                queued: [...deduped],
                dispatched: dispatcher === undefined ? [] : [...deduped]
              })
            )
          }

          const settled = prepared === undefined || boundary === undefined
            ? undefined
            : yield* boundary.settle(prepared).pipe(Effect.exit)
          yield* settled === undefined ? Effect.void : Metric.update(
            EngineStoreMetrics.boundarySettlement[
              Exit.isSuccess(settled)
                ? settled.value.deviation === undefined ? "Clean" : "Deviation"
                : settlementViolated(settled.cause)
                ? "Violation"
                : "Refused"
            ],
            1
          )
          if (settled !== undefined && Exit.isFailure(settled)) {
            return yield* failBoundaryAttempt(settled.cause)
          }
          const settledEvidence = settled === undefined ? undefined : settled.value
          /**
           * THE RETIRED LIMITATION. `StepBoundary`'s filesystem layer omits
           * `wholeTreeWritesVerified` because it can only re-measure paths it
           * was told about, and only `layerTest` ever set it — so under the
           * production composition nothing could enter the shared cache.
           *
           * An isolated execution answers the question the boundary could not:
           * the transaction *is* the tree, so a write outside the declared set
           * is a map comparison rather than an inference. The claim is made
           * here, by the code that knows the body ran in isolation, and only
           * when the whole-tree diff found no deviation — the same whole-tree
           * view also supplies a deviation the boundary's declared-read scan
           * would have missed entirely.
           */
          const evidence = settledEvidence === undefined || settlement === undefined
            ? settledEvidence
            : {
              ...settledEvidence,
              ...(settlement.deviations.length === 0
                ? {
                  wholeTreeWritesVerified: true as const,
                  // `StepSandbox` is the injectable façade; the
                  // `WorkspaceSandbox` service is the same isolated
                  // transaction backend and proves the same read property.
                  hermeticReadsVerified: true as const
                }
                : {
                  deviation: {
                    _tag: "ExpectedSetDeviation" as const,
                    paths: settlement.deviations,
                    diffIdentity: settlement.bundleIdentity
                  }
                })
            }
          const finishedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
          // The declared read set is the key input; the prepare-time
          // measurement is the evidence it described reality when the body
          // ran (issue #106). A mismatch means the result was computed from
          // different inputs than the key claims — the attempt itself is
          // fine, but the completion must never enter the shared cache.
          const readSetVerified = prepared !== undefined && StepBoundary.readSetMatches(prepared)
          const meta: AttemptMeta = {
            ...declarationMeta,
            ...snapshotMeta,
            ...(evidence === undefined ? {} : { boundary: evidence }),
            ...(readSetVerified ? { readSetVerified: true as const } : {})
          }
          const finished = yield* settleAttempt(
            {
              ...attemptId,
              state: "succeeded",
              finishedAtMs,
              outcome: attemptPayload(outcome.value),
              meta: attemptPayload(meta)
            },
            [
              ...(evidence?.deviation === undefined ? [] : [
                JournalRecords.expectedSetDeviation(attemptSource("deviation"), {
                  ...attemptId,
                  ...evidence.deviation
                })
              ]),
              JournalRecords.attemptFinished(attemptSource("finished"), { ...attemptId, state: "succeeded" })
            ]
          )
          if (!finished) return yield* Effect.interrupt

          const admission = CacheAdmission.completion(cacheDeclaration, meta, false)
          if (admission._tag === "PublishCompletion") {
            yield* recordCache({ result: outcome.value, admission, createdAtMs: finishedAtMs })
          } else if (admission.reason === "unverified-recorded-reads") {
            // Visible, not silent (issue #106): the run continues on its
            // own result, but the stale declaration is journalled so the
            // missing cache entry is explainable.
            yield* emitConverging(
              JournalRecords.cacheProvenance(cacheSource("unverified_read_set"), {
                keyDigest,
                action: "unverified_read_set"
              })
            )
          }
          return outcome.value
        })
      )
    }).pipe(
      // The operation's own span is annotated above once the digest exists;
      // this ambient context gives every child store, boundary, and sandbox
      // span the dispatch identity as it opens.
      //
      // `stepKey`, never `key`: `@smthrs/journal`'s `Redaction.isSensitiveKey`
      // treats a standalone trailing `key` word as a credential name and
      // replaces the value, and `RedactedLogger` applies that rule to every
      // log annotation under a real host. The span uses the same name so a
      // trace and a log line name the dispatch identically.
      Effect.annotateSpans({
        runId: deps.runId,
        stepKey: input.key,
        attempt: input.attempt,
        tier: input.tier
      }),
      Effect.annotateLogs({
        runId: deps.runId,
        stepKey: input.key,
        attempt: input.attempt,
        tier: input.tier
      }),
      EngineStoreMetrics.observe({
        timer: EngineStoreMetrics.dispatchDuration,
        counter: EngineStoreMetrics.dispatch
      }),
      // A dispatch that settled without reaching the gate was served from a
      // durable record: a recorded success, or a recorded failure it rethrew.
      // An interruption or a defect settled nothing and reports nothing.
      Effect.onExit((exit) => {
        const replayOnly = deps.replayOnly
        const stepKeyDigest = replay.stepKeyDigest
        if (replayOnly === undefined || replay.gated || stepKeyDigest === undefined) return Effect.void
        if (Exit.isFailure(exit) && (Cause.hasInterrupts(exit.cause) || Cause.hasDies(exit.cause))) return Effect.void
        return replayOnly.observe({
          runId: deps.runId,
          stepKeyDigest,
          attempt: input.attempt,
          action: actionKind(input.action),
          tier: input.tier,
          outcome: "replayed"
        })
      })
    )
  })
}

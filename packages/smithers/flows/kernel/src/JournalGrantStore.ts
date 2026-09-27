/**
 * Journal-backed persistence and replay for capability decisions.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Journal Queue.md`.
 *
 * @since 1.0.0-rc.0
 */

import * as Capability from "@smthrs/capability/Capability"
import { GrantStoreError, Rule } from "@smthrs/capability/Permission"
import * as JournalModule from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import { decode, type GrantEvent, GrantEventSchema } from "./GrantEvent.ts"
import * as GrantStore from "./GrantStore.ts"
import { Workspace } from "./Workspace.ts"

/**
 * Configuration for a journal-backed grant store.
 *
 * `policyRunId` is a deliberately dedicated run containing remembered-policy
 * events. The journal has no global grant projection, so callers that want
 * remembered grants to span operational runs must keep this id stable.
 * `planDigest` binds run grants and envelopes to the exact active plan.
 * `sourceId` is also checked during replay; events from other producers cannot
 * activate kernel authority.
 *
 * The journal is authoritative permission storage: SqlJournal must use the
 * `reject` overflow policy. Drop-capable overflow policies are unsupported,
 * because a dropped grant decision cannot safely be treated as persisted.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface JournalGrantStoreOptions {
  readonly runId: string
  readonly policyRunId: string
  readonly sourceId: string
  readonly planDigest: string
  readonly attended?: boolean
  readonly rules?: ReadonlyArray<ReadonlyArray<Rule>>
  readonly envelope?: {
    readonly patterns: ReadonlyArray<Capability.CapabilityPattern>
    readonly scope?: "run" | "remembered" | undefined
  }
}

const journalFailed = (message: string, cause: unknown): GrantStoreError =>
  new GrantStoreError({
    code: "journal_failed",
    message,
    cause
  })

const knownEventTypes: ReadonlySet<string> = new Set([
  "flows.kernel.grant.once.v1",
  "flows.kernel.grant.run.v1",
  "flows.kernel.grant.run.v2",
  "flows.kernel.grant.remembered.v1",
  "flows.kernel.grant.denied.v1",
  "flows.kernel.grant.envelope.v1"
])

const invalidReplay = (message: string): GrantStoreError => new GrantStoreError({ code: "invalid_resolution", message })

const appendReplayedRule = (
  rules: Array<NonNullable<GrantStore.MakeOptions["runRules"]>[number]>,
  seen: Set<string>,
  pattern: Capability.CapabilityPattern
): void => {
  const rule = new Rule({ effect: "allow", pattern })
  const key = Capability.format(rule.pattern)
  if (seen.has(key)) return
  seen.add(key)
  rules.push(rule)
}

const validId = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0 || value.length > GrantStore.maximumIdentityLength) return false
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit === 0) return false
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

const encodeGrantEvent = Schema.encodeSync(GrantEventSchema)

// Replay reads two runs (`policyRunId` and `runId`) and journal sequences are
// per run, so every refusal names the run it was replaying: the operator then
// knows which journal run to inspect. Replay always reads a run from its start
// and never consults a checkpoint, so compacting a run it replays makes every
// later construction fail `compacted`.
const decodeTrustedEntry = (
  entry: JournalEvent.Entry,
  sourceId: string,
  runId: string
): Effect.Effect<GrantEvent | undefined, GrantStoreError> => {
  if (entry.sourceId !== sourceId || !knownEventTypes.has(entry.eventType)) {
    return Effect.succeed(undefined)
  }
  if (entry.eventType === "flows.kernel.grant.run.v1") {
    return Effect.fail(
      invalidReplay(`legacy run grant has no captured ceiling in run ${runId} at journal sequence ${entry.seq}`)
    )
  }
  const event = decode(entry.payload)
  if (event._tag === "Failure") {
    return Effect.fail(invalidReplay(`invalid grant payload in run ${runId} at journal sequence ${entry.seq}`))
  }
  if (event.success.eventType !== entry.eventType) {
    return Effect.fail(
      invalidReplay(`grant envelope/payload type mismatch in run ${runId} at journal sequence ${entry.seq}`)
    )
  }
  return Effect.succeed(event.success)
}

// One construction-envelope critical section per Journal service instance.
// Two concurrent constructors sharing one service object can both replay the
// envelope's absence before either persists it; the lock serializes the
// re-check-then-append so exactly one construction envelope lands.
//
// The guarantee stops at the service object. The lock is a WeakMap keyed by
// the in-memory `Journal.Service`, and the persisted Input carries no
// `sourceSeq` or `dedupe` key, so two service objects over one backing journal
// (two processes, or two connections in one process) each hold their own
// permit and can both append the envelope. Replay tolerates the duplicate:
// the signature set collapses it and the rules are identical.
const constructionLocks = new WeakMap<JournalModule.Service, Semaphore.Semaphore>()

const constructionLock = (journal: JournalModule.Service): Semaphore.Semaphore => {
  const existing = constructionLocks.get(journal)
  if (existing !== undefined) {
    return existing
  }
  const created = Semaphore.makeUnsafe(1)
  constructionLocks.set(journal, created)
  return created
}

const replayRememberedRules = (
  policyRunId: string,
  sourceId: string,
  workspaceRoot: string
) =>
  Effect.gen(function*() {
    const journal = yield* JournalModule.Journal
    const rules: Array<Rule> = []
    const seenRules = new Set<string>()
    const envelopeSignatures = new Set<string>()
    let after: JournalEvent.Seq | undefined

    do {
      const page = yield* journal.entries({
        runId: policyRunId as JournalEvent.RunId,
        ...(after === undefined ? {} : { after }),
        limit: 256
      })
      const last = page.entries.at(-1)
      if (last !== undefined && after !== undefined && last.seq <= after) {
        // A page that does not advance past the cursor it was asked for is
        // corrupt journal output. Following it would replay the same events
        // forever; accepting it would double-apply them. Refuse construction.
        return yield* Effect.fail(
          invalidReplay(`non-advancing journal page in run ${policyRunId} at sequence ${last.seq}`)
        )
      }
      for (const entry of page.entries) {
        const event = yield* decodeTrustedEntry(entry, sourceId, policyRunId)
        if (event === undefined) {
          continue
        }
        if (event.eventType === "flows.kernel.grant.remembered.v1") {
          if (!GrantStore.isValidGrantPattern(event.pattern, event.capability, event.tier, workspaceRoot)) {
            return yield* Effect.fail(
              invalidReplay(`unsafe remembered grant event in run ${policyRunId} at sequence ${entry.seq}`)
            )
          }
          appendReplayedRule(rules, seenRules, event.pattern)
          continue
        }
        if (event.eventType === "flows.kernel.grant.envelope.v1" && event.scope === "remembered") {
          if (event.patterns.some((pattern) => !GrantStore.isValidEnvelopePattern(pattern, workspaceRoot))) {
            return yield* Effect.fail(
              invalidReplay(`unsafe remembered envelope event in run ${policyRunId} at sequence ${entry.seq}`)
            )
          }
          for (const pattern of event.patterns) appendReplayedRule(rules, seenRules, pattern)
          envelopeSignatures.add(GrantStore.envelopeSignature(event.planDigest, event.scope, event.patterns))
          continue
        }
        return yield* Effect.fail(
          invalidReplay(`run-scoped event found in policy journal run ${policyRunId} at sequence ${entry.seq}`)
        )
      }
      after = last?.seq
      if (!page.hasMore) {
        return { rules, envelopeSignatures }
      }
    } while (after !== undefined)

    return { rules, envelopeSignatures }
  })

const replayRunRules = (
  runId: string,
  sourceId: string,
  planDigest: string,
  workspaceRoot: string
) =>
  Effect.gen(function*() {
    const journal = yield* JournalModule.Journal
    const rules: Array<NonNullable<GrantStore.MakeOptions["runRules"]>[number]> = []
    const seenRules = new Set<string>()
    const envelopeSignatures = new Set<string>()
    let after: JournalEvent.Seq | undefined

    do {
      const page = yield* journal.entries({
        runId: runId as JournalEvent.RunId,
        ...(after === undefined ? {} : { after }),
        limit: 256
      })
      const last = page.entries.at(-1)
      if (last !== undefined && after !== undefined && last.seq <= after) {
        // See the identical guard in `replayRememberedRules`.
        return yield* Effect.fail(invalidReplay(`non-advancing journal page in run ${runId} at sequence ${last.seq}`))
      }
      for (const entry of page.entries) {
        const event = yield* decodeTrustedEntry(entry, sourceId, runId)
        if (event === undefined) {
          continue
        }
        if (event.runId !== runId) {
          return yield* Effect.fail(
            invalidReplay(`grant payload run mismatch in run ${runId} at journal sequence ${entry.seq}`)
          )
        }
        if (event.eventType === "flows.kernel.grant.once.v1" || event.eventType === "flows.kernel.grant.denied.v1") {
          continue
        }
        if (event.eventType === "flows.kernel.grant.run.v2") {
          if (event.planDigest !== planDigest) {
            continue
          }
          if (!GrantStore.isValidGrantPattern(event.pattern, event.capability, event.tier, workspaceRoot)) {
            return yield* Effect.fail(invalidReplay(`unsafe run grant event in run ${runId} at sequence ${entry.seq}`))
          }
          const key = `run:${JSON.stringify([event.pattern, event.ceiling])}`
          if (!seenRules.has(key)) {
            seenRules.add(key)
            rules.push({ rule: new Rule({ effect: "allow", pattern: event.pattern }), ceiling: event.ceiling })
          }
          continue
        }
        if (event.eventType === "flows.kernel.grant.envelope.v1" && event.scope === "run") {
          if (event.planDigest !== planDigest) {
            continue
          }
          if (event.patterns.some((pattern) => !GrantStore.isValidEnvelopePattern(pattern, workspaceRoot))) {
            return yield* Effect.fail(
              invalidReplay(`unsafe run envelope event in run ${runId} at sequence ${entry.seq}`)
            )
          }
          for (const pattern of event.patterns) appendReplayedRule(rules, seenRules, pattern)
          envelopeSignatures.add(GrantStore.envelopeSignature(event.planDigest, event.scope, event.patterns))
          continue
        }
        return yield* Effect.fail(
          invalidReplay(`remembered event found in run journal ${runId} at sequence ${entry.seq}`)
        )
      }
      after = last?.seq
      if (!page.hasMore) {
        return { rules, envelopeSignatures }
      }
    } while (after !== undefined)

    return { rules, envelopeSignatures }
  })

/**
 * Makes a grant store that replays remembered policy from, and writes decisions
 * to, the supplied journal.
 *
 * `emitDurable` commits before `GrantStore` activates a remembered or
 * run-scoped rule (or resolves a denial). Any journal failure is mapped to
 * `journal_failed`, so permission decisions fail closed.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = (options: JournalGrantStoreOptions) =>
  Effect.gen(function*() {
    const runId = options.runId
    const policyRunId = options.policyRunId
    const sourceId = options.sourceId
    const planDigest = options.planDigest
    if (!validId(runId)) return yield* Effect.fail(invalidReplay("runId must be non-empty, bounded, well-formed text"))
    if (!validId(policyRunId)) {
      return yield* Effect.fail(invalidReplay("policyRunId must be non-empty, bounded, well-formed text"))
    }
    if (!validId(sourceId)) {
      return yield* Effect.fail(invalidReplay("sourceId must be non-empty, bounded, well-formed text"))
    }
    if (!validId(planDigest)) {
      return yield* Effect.fail(invalidReplay("planDigest must be non-empty, bounded, well-formed text"))
    }
    if (runId === policyRunId) {
      return yield* Effect.fail(invalidReplay("runId and policyRunId must be distinct"))
    }
    const journal = yield* JournalModule.Journal
    const workspace = yield* Workspace
    const replayPolicy = replayRememberedRules(
      policyRunId,
      sourceId,
      workspace.root
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof GrantStoreError ? cause : journalFailed("could not replay remembered grants", cause)
      )
    )
    const replayRun = replayRunRules(
      runId,
      sourceId,
      planDigest,
      workspace.root
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof GrantStoreError ? cause : journalFailed("could not replay run grants", cause)
      )
    )
    let replayedPolicy = yield* replayPolicy
    let replayedRun = yield* replayRun
    const persist = (event: GrantEvent): Effect.Effect<void, GrantStoreError> => {
      const payload = encodeGrantEvent(event)
      return Effect.gen(function*() {
        // Unfenced: the grant store is the kernel's own ledger, not a run's
        // lifecycle — it owns no run, and grant admissions are
        // first-writer-wins records replayed by every later process.
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: (
              event.eventType === "flows.kernel.grant.remembered.v1"
                || (event.eventType === "flows.kernel.grant.envelope.v1" && event.scope === "remembered")
                ? policyRunId
                : runId
            ) as JournalEvent.RunId,
            sourceId: sourceId as JournalEvent.SourceId,
            eventType: event.eventType,
            payload
          })
        )
      }).pipe(
        Effect.mapError((cause) => journalFailed("could not persist grant event", cause)),
        Effect.asVoid
      )
    }
    const envelope = options.envelope
    const build = () => {
      const configuredCount = options.rules?.reduce((count, rules) => count + rules.length, 0) ?? 0
      const rememberedCount = replayedPolicy.rules.length
      const runCount = replayedRun.rules.length
      const total = configuredCount + rememberedCount + runCount
      if (total > GrantStore.maximumRules) {
        return Effect.fail(
          invalidReplay(
            `policy run ${policyRunId} replayed ${rememberedCount} remembered rules; configured rules (${configuredCount}) and replayed run rules (${runCount}) bring the total to ${total}, which exceeds the ${GrantStore.maximumRules}-rule ceiling; remove configured rules or start a new policyRunId and grant again`
          )
        )
      }
      // Envelope signatures accumulate in the policy journal exactly the way
      // remembered rules do, and `GrantStore.make` refuses more than
      // `maximumRules` of them with a message that names neither the journal
      // nor the counts. Diagnose it here instead, so an operator reading the
      // failure knows which policy run filled rather than which field overflowed.
      const policySignatureCount = replayedPolicy.envelopeSignatures.size
      const runSignatureCount = replayedRun.envelopeSignatures.size
      const signatureTotal = policySignatureCount + runSignatureCount
      if (signatureTotal > GrantStore.maximumRules) {
        return Effect.fail(
          invalidReplay(
            `policy run ${policyRunId} replayed ${policySignatureCount} remembered envelope signatures; replayed run envelope signatures (${runSignatureCount}) bring the total to ${signatureTotal}, which exceeds the ${GrantStore.maximumRules}-envelope-signature ceiling; start a new policyRunId and grant again`
          )
        )
      }
      // GrantStore's shared envelope admission adds only patterns not already
      // replayed for a seeded envelope, and checks the combined rule and
      // signature counts before any construction event is persisted.
      return GrantStore.make({
        runId,
        planDigest,
        ...(options.attended === undefined ? {} : { attended: options.attended }),
        rules: options.rules === undefined || options.rules.length === 0
          ? [[], replayedPolicy.rules]
          : [...options.rules, replayedPolicy.rules],
        runRules: replayedRun.rules,
        envelopeSignatures: [
          ...replayedPolicy.envelopeSignatures,
          ...replayedRun.envelopeSignatures
        ],
        ...(envelope === undefined ? {} : {
          envelope: {
            planDigest,
            patterns: envelope.patterns,
            ...(envelope.scope === undefined ? {} : { scope: envelope.scope })
          }
        }),
        persist
      })
    }
    if (envelope === undefined || envelope.patterns.length === 0) {
      return yield* build()
    }
    const scope = envelope.scope ?? "run"
    const signature = GrantStore.envelopeSignature(planDigest, scope, envelope.patterns)
    const replayedSignatures = scope === "remembered"
      ? replayedPolicy.envelopeSignatures
      : replayedRun.envelopeSignatures
    if (replayedSignatures.has(signature)) {
      // Already durable: the seeded signature makes the construction envelope
      // activate without persisting again.
      return yield* build()
    }
    // The envelope was absent when this constructor replayed, but a concurrent
    // constructor sharing this Journal service may persist it before we do.
    // Re-replay the target run inside the per-service critical section, so
    // exactly one such constructor appends the envelope and every other one
    // replays it instead.
    return yield* constructionLock(journal).withPermit(
      Effect.gen(function*() {
        if (scope === "remembered") {
          replayedPolicy = yield* replayPolicy
        } else {
          replayedRun = yield* replayRun
        }
        return yield* build()
      })
    )
  })

/**
 * Provides a journal-backed `GrantStore`.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (options: JournalGrantStoreOptions) => Layer.effect(GrantStore.GrantStore)(make(options))

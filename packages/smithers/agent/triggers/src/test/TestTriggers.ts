/** @since 0.1.0 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ClaimDecision from "../ClaimDecision.ts"
import * as Overlap from "../Overlap.ts"
import * as Schedule from "../Schedule.ts"
import * as Trigger from "../Trigger.ts"
import { fromSchemaError, TriggerError } from "../TriggerError.ts"
import {
  type Claim,
  type ClaimFire,
  compareNewestFirst,
  type FireRecord,
  type Heartbeat,
  historyLimit,
  historyPage,
  isAfterCursor,
  isReservation,
  type Listed,
  listed,
  type Outcome,
  pruneCutoff,
  type Registered,
  reservationId,
  reservationOccurrence,
  resultRefusal,
  type Service,
  TriggerStore
} from "../TriggerStore.ts"

/**
 * The columns the SQL store keeps on `flows_triggers` and `flows_trigger_fires`,
 * spread across maps so one trigger's state can be replaced without copying the
 * rest.
 *
 * `active` holds one record per trigger with a run or reservation, so a claim,
 * an expiry, a launch and a clear each replace or delete one entry rather than
 * keeping parallel maps in step. A launch keeps the run but drops `claimedAt`,
 * which is how the SQL store spells a reservation that predates the lease
 * column.
 *
 * One invariant lets the readers below index without a fallback, and this
 * module alone writes it: `fireRunIds` names a run only for a fire that a
 * claim or a result attached one to, and every such run was recorded
 * `launched` first, so `runOccurrences` knows the occurrence it belongs to.
 *
 * `fireErrors` and `heartbeats` are the SQL store's `error` column and its
 * `flows_scheduler_heartbeat` table.
 */
/**
 * A registered declaration as this layer keeps it: the SQL store persists
 * `input` as a JSON string, so holding the same string is what makes every
 * reading an independent value rather than an alias of the caller's object.
 */
interface Stored extends Omit<Registered, "input"> {
  readonly input: string
}

const registered = (stored: Stored): Registered => ({ ...stored, input: JSON.parse(stored.input) })

const byId = (left: Stored, right: Stored): number => left.id < right.id ? -1 : 1

/**
 * The run or reservation a trigger holds: the `active_run_id` and
 * `active_claimed_at_ms` columns of one `flows_triggers` row.
 */
interface Active {
  readonly runId: string
  readonly claimedAt?: number
}

interface State {
  readonly triggers: ReadonlyMap<string, Stored>
  readonly fires: ReadonlyMap<string, Outcome | null>
  readonly fireRunIds: ReadonlyMap<string, string>
  readonly fireErrors: ReadonlyMap<string, string>
  readonly heartbeats: ReadonlyMap<string, number>
  readonly runOccurrences: ReadonlyMap<string, number>
  readonly pending: ReadonlyMap<string, number>
  readonly active: ReadonlyMap<string, Active>
}

const key = (triggerId: string, occurrence: number) => `${triggerId}:${occurrence}`

// The occurrence is the numeric tail, so a trigger id holding a colon still
// splits at the right place.
const fireRecord = (current: State, fireKey: string, outcome: Outcome | null): FireRecord => {
  const at = fireKey.lastIndexOf(":")
  const runId = current.fireRunIds.get(fireKey)
  const error = current.fireErrors.get(fireKey)
  return {
    triggerId: fireKey.slice(0, at),
    occurrence: Number(fireKey.slice(at + 1)),
    outcome,
    ...(runId === undefined ? {} : { runId }),
    ...(error === undefined ? {} : { error })
  }
}
const unknown = (triggerId: string) =>
  new TriggerError({ code: "unknown_trigger", message: `unknown trigger ${triggerId}` })

const advanced = (trigger: Stored, occurrence: number): Stored => ({
  ...trigger,
  lastFiredAt: Math.max(trigger.lastFiredAt ?? occurrence, occurrence)
})

type Decision =
  | { readonly _tag: "Failure"; readonly error: TriggerError }
  | { readonly _tag: "Success"; readonly claim: Claim; readonly state: State }

const fireSnapshot = (current: State, fireKey: string): ClaimDecision.Fire | undefined => {
  if (!current.fires.has(fireKey)) return undefined
  const runId = current.fireRunIds.get(fireKey)
  return { outcome: current.fires.get(fireKey) ?? null, ...(runId === undefined ? {} : { runId }) }
}

/**
 * Gathers the rows {@link ClaimDecision.decide} reads, then applies the writes
 * it answers. The protocol itself lives in that module, so this layer refuses
 * and reclaims exactly what the SQL store does rather than restating the rules
 * over maps.
 */
const applyClaim = (
  trigger: Stored,
  fire: ClaimFire,
  current: State,
  claimedAt: number
): Decision => {
  const fireKey = key(fire.triggerId, fire.occurrence)
  const existingFire = fireSnapshot(current, fireKey)
  const held = current.active.get(fire.triggerId)
  const activeRunId = held?.runId
  const activeOccurrence = activeRunId !== undefined && isReservation(activeRunId)
    ? reservationOccurrence(activeRunId)
    : undefined
  // The SQL store reads the reservation's row after inserting the claimed
  // occurrence, so a row this claim creates reads back as unsettled.
  const activeFire = activeOccurrence === undefined
    ? undefined
    : activeOccurrence === fire.occurrence
    ? existingFire ?? { outcome: null }
    : fireSnapshot(current, key(fire.triggerId, activeOccurrence))
  const claimedAtMs = held?.claimedAt
  const pendingAt = current.pending.get(fire.triggerId)
  const decision = ClaimDecision.decide({
    fire,
    claimedAt,
    reservationId: reservationId(fire.triggerId, fire.occurrence, globalThis.crypto.randomUUID()),
    snapshot: {
      revision: trigger.revision,
      enabled: trigger.enabled,
      overlap: trigger.overlap,
      ...(activeRunId === undefined ? {} : { activeRunId }),
      ...(claimedAtMs === undefined ? {} : { activeClaimedAt: claimedAtMs }),
      ...(pendingAt === undefined ? {} : { pending: pendingAt }),
      ...(existingFire === undefined ? {} : { existingFire }),
      ...(activeFire === undefined ? {} : { activeFire })
    }
  })
  if (decision._tag === "Refused") return { _tag: "Failure", error: decision.error }
  if (!decision.claim.claimed) return { _tag: "Success", claim: decision.claim, state: current }
  const triggers = new Map(current.triggers)
  const fires = new Map(current.fires)
  const fireRunIds = new Map(current.fireRunIds)
  const pending = new Map(current.pending)
  const active = new Map(current.active)
  if (!fires.has(fireKey)) fires.set(fireKey, null)
  for (const write of decision.writes) {
    switch (write._tag) {
      case "SetOutcome": {
        const target = key(fire.triggerId, write.occurrence)
        // The decision and application are one Ref.modify operation. An
        // active reservation's fire cannot settle between these two steps.
        fires.set(target, write.outcome)
        break
      }
      case "SetRunId": {
        fireRunIds.set(key(fire.triggerId, write.occurrence), write.runId)
        break
      }
      case "ReleaseReservation": {
        // The decision and its writes share this Ref.modify snapshot; the
        // expected reservation cannot change between them.
        if (write.activeRunId === undefined) active.delete(fire.triggerId)
        else active.set(fire.triggerId, { runId: write.activeRunId })
        if (write.pending === undefined) pending.delete(fire.triggerId)
        else pending.set(fire.triggerId, write.pending)
        break
      }
      case "AdvanceCursor": {
        triggers.set(fire.triggerId, advanced(trigger, write.occurrence))
        break
      }
      case "SetPending": {
        pending.set(fire.triggerId, write.occurrence)
        break
      }
      case "Reserve": {
        active.set(fire.triggerId, { runId: write.reservationId, claimedAt: write.claimedAt })
        break
      }
    }
  }
  return {
    _tag: "Success",
    claim: decision.claim,
    state: { ...current, triggers, fires, fireRunIds, pending, active }
  }
}

/**
 * Provides an in-memory {@link TriggerStore} for tests: real claim and
 * overlap semantics, no database.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<TriggerStore> = Layer.effect(TriggerStore)(Effect.gen(function*() {
  const state = yield* Ref.make<State>({
    triggers: new Map(),
    fires: new Map(),
    fireRunIds: new Map(),
    fireErrors: new Map(),
    heartbeats: new Map(),
    runOccurrences: new Map(),
    pending: new Map(),
    active: new Map()
  })
  const get: Service["get"] = (triggerId) =>
    Ref.get(state).pipe(Effect.map((current) => {
      const trigger = current.triggers.get(triggerId)
      return trigger === undefined ? Option.none() : Option.some(registered(trigger))
    }))
  const requireTrigger = <A>(
    triggerId: string,
    modify: (trigger: Stored, current: State) => readonly [A, State]
  ): Effect.Effect<A, TriggerError> =>
    Ref.modify(state, (current): readonly [Effect.Effect<A, TriggerError>, State] => {
      const trigger = current.triggers.get(triggerId)
      if (trigger === undefined) return [Effect.fail(unknown(triggerId)), current]
      const [value, next] = modify(trigger, current)
      return [Effect.succeed(value), next]
    }).pipe(Effect.flatten)
  const claimFire: Service["claimFire"] = (fire) =>
    Effect.flatMap(
      Clock.currentTimeMillis,
      (claimedAt) =>
        Ref.modify(state, (current): readonly [Effect.Effect<Claim, TriggerError>, State] => {
          const trigger = current.triggers.get(fire.triggerId)
          if (trigger === undefined) return [Effect.fail(unknown(fire.triggerId)), current]
          const decision = applyClaim(trigger, fire, current, claimedAt)
          return decision._tag === "Failure"
            ? [Effect.fail(decision.error), current]
            : [Effect.succeed(decision.claim), decision.state]
        }).pipe(Effect.flatten)
    )
  return TriggerStore.of({
    // Registration decodes and serializes at the call boundary, before the
    // returned Effect runs, so the declaration this layer keeps is the one the
    // caller passed rather than whatever its object became later. The SQL
    // store does the same, and its lazy schedule validation runs here too.
    register: (declaration) => {
      const decoded = Schema.decodeUnknownResult(Trigger.Trigger)(declaration)
      if (Result.isFailure(decoded)) {
        return Effect.fail(fromSchemaError("invalid_trigger", "Trigger declaration is invalid", decoded.failure))
      }
      const snapshot = decoded.success
      let input: string | undefined
      try {
        input = JSON.stringify(snapshot.input)
      } catch (cause) {
        return Effect.fail(
          new TriggerError({ code: "store", message: "trigger input is not JSON-serializable", cause })
        )
      }
      if (input === undefined) {
        return Effect.fail(
          new TriggerError({
            code: "invalid_trigger",
            message: "trigger input has no JSON representation",
            path: "input"
          })
        )
      }
      const serialized = input
      return Effect.suspend(() =>
        Schedule.validate(snapshot).pipe(
          Effect.andThen(Ref.modify(state, (current) => {
            const prior = current.triggers.get(snapshot.id)
            const stored: Stored = {
              ...snapshot,
              input: serialized,
              revision: (prior?.revision ?? 0) + 1,
              ...(prior?.lastFiredAt === undefined ? {} : { lastFiredAt: prior.lastFiredAt })
            }
            return [registered(stored), { ...current, triggers: new Map(current.triggers).set(snapshot.id, stored) }]
          }))
        )
      )
    },
    get,
    list: () =>
      Ref.get(state).pipe(
        Effect.map((current) =>
          // Nothing writes a declaration this layer cannot read back, so every
          // listed row decodes. The SQL store is where a corrupt `input_json`
          // can arrive.
          [...current.triggers.values()].sort(byId).map((stored): Listed => {
            const activeRunId = current.active.get(stored.id)?.runId
            const pendingAt = current.pending.get(stored.id)
            return listed(registered(stored), {
              ...(activeRunId === undefined ? {} : { activeRunId }),
              ...(pendingAt === undefined ? {} : { pendingAt })
            })
          })
        )
      ),
    listEnabled: () =>
      Ref.get(state).pipe(
        Effect.map((current) =>
          [...current.triggers.values()].filter((trigger) => trigger.enabled).sort(byId).map(registered)
        )
      ),
    claimFire,
    claimPending: (fire) =>
      Effect.flatMap(Clock.currentTimeMillis, (claimedAt) =>
        Ref.modify(state, (current): readonly [
          ReturnType<Service["claimPending"]>,
          State
        ] => {
          const trigger = current.triggers.get(fire.triggerId)
          if (trigger === undefined) return [Effect.fail(unknown(fire.triggerId)), current]
          const occurrence = current.pending.get(fire.triggerId)
          if (occurrence === undefined) return [Effect.succeed(Option.none()), current]
          const decision = applyClaim(
            trigger,
            {
              triggerId: fire.triggerId,
              occurrence,
              expectedRevision: fire.expectedRevision,
              resumeBuffered: true
            },
            current,
            claimedAt
          )
          if (decision._tag === "Failure") return [Effect.fail(decision.error), current]
          let next = decision.state
          if (decision.claim.claimed && decision.claim.action !== "buffer") {
            const pending = new Map(decision.state.pending)
            pending.delete(fire.triggerId)
            next = { ...decision.state, pending }
          }
          return [Effect.succeed(Option.some({ occurrence, claim: decision.claim })), next]
        }).pipe(Effect.flatten)),
    recordResult: (result) =>
      requireTrigger(result.triggerId, (trigger, current): readonly [Effect.Effect<void, TriggerError>, State] => {
        const existingOutcome = current.fires.get(key(result.triggerId, result.occurrence))
        const existing = existingOutcome === undefined
          ? undefined
          : fireRecord(current, key(result.triggerId, result.occurrence), existingOutcome)
        const refusal = resultRefusal(result, existing, current.active.get(result.triggerId)?.runId)
        if (refusal !== undefined) return [Effect.fail(refusal), current]
        if (result.outcome !== "launched" && existing?.outcome === result.outcome) return [Effect.void, current]
        const triggers = new Map(current.triggers).set(result.triggerId, advanced(trigger, result.occurrence))
        const active = new Map(current.active)
        const fires = new Map(current.fires)
        const fireRunIds = new Map(current.fireRunIds)
        const fireErrors = new Map(current.fireErrors)
        const runOccurrences = new Map(current.runOccurrences)
        const fireKey = key(result.triggerId, result.occurrence)
        const recordedRunId = current.fireRunIds.get(fireKey)
        const terminal = result.outcome === "completed" ||
          result.outcome === "failed" ||
          result.outcome === "superseded"
        // resultRefusal proved this ledger entry exists and can transition.
        fires.set(fireKey, result.outcome)
        if (result.runId !== undefined) fireRunIds.set(fireKey, result.runId)
        else if (!terminal) fireRunIds.delete(fireKey)
        // The SQL store overwrites the error column on every result.
        if (result.error === undefined) fireErrors.delete(fireKey)
        else fireErrors.set(fireKey, result.error)
        if (result.outcome === "launched") {
          active.set(result.triggerId, { runId: result.runId })
          runOccurrences.set(result.runId, result.occurrence)
        } else if (terminal) {
          const currentRunId = active.get(result.triggerId)?.runId
          const resultOwner = existing?.outcome === "launched"
            ? recordedRunId
            : result.reservationId ?? result.runId ?? currentRunId
          if (currentRunId === resultOwner) active.delete(result.triggerId)
        } else {
          // A changed skip/buffer decision passed the reservation fence above.
          active.delete(result.triggerId)
        }
        return [Effect.void, { ...current, triggers, fires, fireRunIds, fireErrors, runOccurrences, active }]
      }).pipe(Effect.flatten),
    restorePending: (fire) =>
      requireTrigger(fire.triggerId, (_trigger, current): readonly [Effect.Effect<void, TriggerError>, State] => {
        const outcome = current.fires.get(key(fire.triggerId, fire.occurrence))
        if (
          current.active.get(fire.triggerId)?.runId !== fire.reservationId ||
          reservationOccurrence(fire.reservationId) !== fire.occurrence || (outcome !== null && outcome !== "buffered")
        ) {
          return [
            Effect.fail(
              new TriggerError({ code: "stale_owner", message: "pending restoration no longer owns reservation" })
            ),
            current
          ]
        }
        const pending = new Map(current.pending).set(
          fire.triggerId,
          Overlap.pendingAfter({ running: false, pending: current.pending.get(fire.triggerId), due: fire.occurrence })
        )
        const active = new Map(current.active)
        const predecessor = current.fireRunIds.get(key(fire.triggerId, fire.occurrence))
        const predecessorOccurrence = predecessor === undefined ? undefined : current.runOccurrences.get(predecessor)
        if (
          predecessor !== undefined && predecessorOccurrence !== undefined &&
          current.fires.get(key(fire.triggerId, predecessorOccurrence)) === "launched"
        ) {
          active.set(fire.triggerId, { runId: predecessor })
        } else {
          active.delete(fire.triggerId)
        }
        return [Effect.void, { ...current, pending, active }]
      }).pipe(Effect.flatten),
    setPending: (fire) =>
      requireTrigger(fire.triggerId, (_trigger, current) => {
        const pending = new Map(current.pending)
        pending.set(
          fire.triggerId,
          Overlap.pendingAfter({ running: true, pending: pending.get(fire.triggerId), due: fire.occurrence })
        )
        return [undefined, { ...current, pending }]
      }),
    activeRun: (triggerId) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        requireTrigger(triggerId, (_trigger, current) => {
          const held = current.active.get(triggerId)
          const runId = held?.runId
          const occurrence = runId !== undefined && isReservation(runId) ? reservationOccurrence(runId) : undefined
          const unfinished = occurrence === undefined
            ? undefined
            : fireSnapshot(current, key(triggerId, occurrence))
          const claimedAt = held?.claimedAt
          const pendingAt = current.pending.get(triggerId)
          const lease = ClaimDecision.lease({
            now,
            ...(runId === undefined ? {} : { activeRunId: runId }),
            ...(claimedAt === undefined ? {} : { activeClaimedAt: claimedAt }),
            ...(pendingAt === undefined ? {} : { pending: pendingAt }),
            ...(unfinished === undefined || (unfinished.outcome !== null && unfinished.outcome !== "buffered")
              ? {}
              : { unfinished })
          })
          if (lease._tag === "Idle") return [Option.none(), current]
          if (lease._tag === "Held") return [Option.some(lease.runId), current]
          const active = new Map(current.active)
          const pending = new Map(current.pending)
          if (lease.pending !== undefined) pending.set(triggerId, lease.pending)
          if (lease.recovered === undefined) active.delete(triggerId)
          else active.set(triggerId, { runId: lease.recovered })
          return [
            lease.recovered === undefined ? Option.none() : Option.some(lease.recovered),
            { ...current, active, pending }
          ]
        })),
    activeOccurrence: (triggerId, runId) =>
      requireTrigger(triggerId, (_trigger, current) => {
        const reserved = reservationOccurrence(runId)
        const launched = current.runOccurrences.get(runId)
        const occurrence = reserved ??
          (launched !== undefined && current.fires.get(key(triggerId, launched)) === "launched" ? launched : undefined)
        return [occurrence === undefined ? Option.none() : Option.some(occurrence), current]
      }),
    clearActive: (triggerId, runId) =>
      Ref.update(state, (current) => {
        if (current.active.get(triggerId)?.runId !== runId) return current
        const active = new Map(current.active)
        active.delete(triggerId)
        return { ...current, active }
      }),
    history: (query = {}) =>
      Effect.flatMap(historyLimit(query.limit), (limit) =>
        Ref.get(state).pipe(Effect.map((current) => {
          const records = [...current.fires.entries()]
            .map(([fireKey, outcome]) => fireRecord(current, fireKey, outcome))
            .filter((record) =>
              (query.triggerId === undefined || record.triggerId === query.triggerId) &&
              (query.runId === undefined || record.runId === query.runId) &&
              (query.outcome === undefined || record.outcome === query.outcome) &&
              (query.cursor === undefined || isAfterCursor(record, query.cursor))
            )
            .sort(compareNewestFirst)
          return historyPage(records, limit)
        }))),
    pruneFires: ({ olderThan }) =>
      Effect.flatMap(pruneCutoff(olderThan), (cutoff) =>
        Ref.modify(state, (current) => {
          const fires = new Map(current.fires)
          const fireRunIds = new Map(current.fireRunIds)
          const fireErrors = new Map(current.fireErrors)
          const runOccurrences = new Map(current.runOccurrences)
          let removed = 0
          for (const [fireKey, outcome] of current.fires) {
            if (
              outcome !== "completed" && outcome !== "failed" && outcome !== "skipped" && outcome !== "superseded"
            ) continue
            const record = fireRecord(current, fireKey, outcome)
            if (record.occurrence >= cutoff) continue
            if (current.pending.get(record.triggerId) === record.occurrence) continue
            if (record.runId !== undefined && current.active.get(record.triggerId)?.runId === record.runId) continue
            fires.delete(fireKey)
            fireErrors.delete(fireKey)
            if (record.runId !== undefined) {
              fireRunIds.delete(fireKey)
              if (runOccurrences.get(record.runId) === record.occurrence) runOccurrences.delete(record.runId)
            }
            removed += 1
          }
          return [removed, { ...current, fires, fireRunIds, fireErrors, runOccurrences }]
        })),
    inspect: (triggerId) =>
      requireTrigger(triggerId, (_trigger, current) => {
        const activeRunId = current.active.get(triggerId)?.runId
        const pendingAt = current.pending.get(triggerId)
        return [
          {
            ...(activeRunId === undefined ? {} : { activeRunId }),
            ...(pendingAt === undefined ? {} : { pendingAt })
          },
          current
        ]
      }),
    heartbeat: (host) =>
      Effect.flatMap(
        Clock.currentTimeMillis,
        (tickedAt) =>
          Ref.update(state, (current) => ({ ...current, heartbeats: new Map(current.heartbeats).set(host, tickedAt) }))
      ),
    lastHeartbeat: () =>
      Ref.get(state).pipe(Effect.map((current) => {
        let latest: Heartbeat | undefined
        for (const [host, tickedAt] of current.heartbeats) {
          // Newest wins; equal times fall to the lower host name, as the SQL
          // store's ORDER BY does.
          if (
            latest === undefined || tickedAt > latest.tickedAt || (tickedAt === latest.tickedAt && host < latest.host)
          ) {
            latest = { host, tickedAt }
          }
        }
        return latest === undefined ? Option.none() : Option.some(latest)
      }))
  })
}))

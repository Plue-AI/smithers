/** Native lifecycle facts captured using the owning store transaction.
 * @since 1.0.0
 */

import * as Sha256 from "@smthrs/crypto/Sha256"
import { FlowEngine } from "@smthrs/engine"
import { DurableDeferred } from "@smthrs/flow"
import { ExecutionFact, type Journal, Redaction } from "@smthrs/journal"
import type { RunStore } from "@smthrs/run-store"
import { Effect, Option, Schema } from "effect"
import type * as DurableEngineState from "./DurableEngineState.ts"
import * as JournalRecords from "./internal/JournalRecords.ts"
import * as StateTransaction from "./internal/StateTransaction.ts"

/** Captured native services; never substitute an ambient control journal.
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly runs: RunStore.Service
  readonly state: Pick<DurableEngineState.Service, "waiting" | "runParents" | "transaction">
  readonly journal: Journal.Service
  readonly sourceId: string
}

/** Read the semantic subset shared with ExecutionSnapshot inside its caller's transaction.
 * @category queries
 * @since 1.0.0
 */
export const observe = (
  row: RunStore.RunRow,
  state: Pick<Options["state"], "waiting" | "runParents">
): Effect.Effect<ExecutionFact.Observation, Schema.SchemaError> =>
  Effect.gen(function*() {
    const waiting = yield* state.waiting(row.runId)
    const parents = row.parentRunId === null ? yield* state.runParents(row.runId) : []
    const firstParent = [...parents].sort((a, b) => a.seq - b.seq || a.parentId.localeCompare(b.parentId))[0]
    const encoded = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          flowName: Schema.NonEmptyString,
          onParentExit: Schema.optional(Schema.Literals(["cancel", "detach"]))
        })
      )
    )(row.stateJson)
    let point: string | null = null
    if (Option.isSome(waiting) && waiting.value.token !== null) {
      try {
        const { deferredName } = DurableDeferred.TokenParsed.fromString(waiting.value.token)
        if (deferredName.startsWith("WaitFor/")) {
          point = deferredName.slice("WaitFor/".length)
        }
      } catch { /* An opaque plugin token remains an operational address only. */ }
    }
    return yield* Schema.decodeUnknownEffect(ExecutionFact.Observation)({
      executionId: row.runId,
      flowName: encoded.flowName,
      status: row.status,
      createdAtMs: row.createdAtMs,
      startedAtMs: row.startedAtMs,
      finishedAtMs: row.finishedAtMs,
      parentRunId: row.parentRunId ?? firstParent?.parentId ?? null,
      lineageId: row.lineageId ?? row.runId,
      roundOrdinal: row.roundOrdinal ?? 0,
      cancelRequestedAtMs: row.cancelRequestedAtMs,
      treeVersion: 1,
      parentPolicy: encoded.onParentExit ?? "cancel",
      waiting: Option.isNone(waiting) ? null : {
        reason: waiting.value.reason,
        wakeAtMs: waiting.value.wakeAt,
        tokenDigest: waiting.value.token === null ? null : Sha256.digestSync(waiting.value.token),
        point,
        request: waiting.value.request === undefined ? null : Redaction.redact(waiting.value.request)
      }
    })
  })

/** Fact admission and cancellation intent share the same native writer transaction.
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options) => {
  const transactState = StateTransaction.make(options.state, options.journal)
  const fact = (executionId: string, baseline: "created" | "legacy" = "legacy") =>
    options.runs.get(executionId).pipe(
      Effect.flatMap((row) => observe(row, options.state)),
      Effect.map((observation) => ({ version: 1 as const, baseline, observation })),
      // Invalid semantic metadata must not prevent the driver's existing
      // corruption/invalid-round path from settling the run. Record a named
      // coverage failure; never normalize a bad ordinal or invent ancestry.
      Effect.catchTag("SchemaError", () =>
        Effect.succeed({ version: 1 as const, unavailable: "invalid-observation" as const }))
    )
  const cancelled = (executionId: string) =>
    Effect.gen(function*() {
      const executionFact = yield* fact(executionId)
      yield* options.journal.emitDurableUnfenced(JournalRecords.runDecision({
        runId: executionId,
        lineageId: FlowEngine.Lineage.root(executionId),
        sourceId: options.sourceId
      }, { decision: "cancel-requested", executionFact }))
    })
  const requestCancel = (executionId: string, at: number) =>
    transactState(Effect.gen(function*() {
      const outcome = yield* options.runs.requestCancel(executionId, at)
      if (outcome._tag === "CancelRequested") yield* cancelled(executionId)
      return outcome
    }))
  const requestCancelLineage = (executionId: string, at: number) =>
    transactState(Effect.gen(function*() {
      const before = yield* options.runs.lineage(executionId)
      const outcome = yield* options.runs.requestCancelLineage(executionId, at)
      if (outcome._tag === "CancelRequested") {
        // The set update excludes terminal/already-requested rows. Record exactly
        // the rows it changed, not a guessed terminal cancellation timestamp.
        for (const row of before) {
          if (row.cancelRequestedAtMs === null && !["completed", "failed", "cancelled"].includes(row.status)) {
            yield* cancelled(row.runId)
          }
        }
      }
      return outcome
    }))
  return { fact, requestCancel, requestCancelLineage }
}

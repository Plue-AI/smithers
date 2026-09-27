/**
 * Durable trigger launch handles that retain the exact plan awaiting approval.
 *
 * @since 1.0.0
 */

import * as Control from "@smthrs/control/Control"
import { PlanCard } from "@smthrs/control/ControlSchema"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import { TriggerError } from "@smthrs/triggers/TriggerError"
import { Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { databaseLayer } from "./Store.ts"

const prefix = "trigger-plan:"
const states = Schema.Literals([
  "waiting-approval",
  "launching",
  "running",
  "cancelling",
  "completed",
  "cancelled",
  "failed"
])
const stored = Schema.Struct({
  handle: Schema.String,
  idempotencyKey: Schema.String,
  plan: PlanCard,
  status: states,
  runId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String)
})

/**
 * The original approval card and eventual Control run behind a scheduler handle.
 * @category models
 * @since 1.0.0
 */
export type StoredPlan = typeof stored.Type

interface Row {
  readonly handle: string
  readonly idempotency_key: string
  readonly plan_json: string
  readonly status: StoredPlan["status"]
  readonly run_id: string | null
  readonly error: string | null
}

const failure = (message: string, cause?: unknown) => new TriggerError({ code: "runner", message, cause })
const translated = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => cause instanceof TriggerError ? cause : failure(operation, cause)))

const makeStore = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter
  yield* translated(
    "Could not initialize durable trigger plans",
    writer.write(sql`
      CREATE TABLE IF NOT EXISTS control_trigger_plans (
        handle TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        plan_json TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        error TEXT
      )
    `)
  )
  const read = (handle: string) =>
    translated(
      "Could not read the durable trigger plan",
      sql<Row>`SELECT * FROM control_trigger_plans WHERE handle = ${handle}`.pipe(
        Effect.flatMap((rows) => {
          const row = rows[0]
          if (row === undefined) return Effect.succeed(null)
          return Effect.try(() => JSON.parse(row.plan_json) as unknown).pipe(
            Effect.flatMap((plan) =>
              Schema.decodeUnknownEffect(stored)({
                handle: row.handle,
                idempotencyKey: row.idempotency_key,
                plan,
                status: row.status,
                runId: row.run_id,
                error: row.error
              })
            )
          )
        })
      )
    )
  const write = <A, E>(effect: Effect.Effect<A, E>) =>
    translated("Could not update the durable trigger plan", writer.write(effect))
  return { sql, read, write }
})

/**
 * Reads the unchanged approval payload and launch state for a scheduler handle.
 * @category queries
 * @since 1.0.0
 */
export const inspect = (root: string, handle: string): Promise<StoredPlan | null> =>
  handle.startsWith(prefix)
    ? Effect.runPromise(
      makeStore.pipe(Effect.flatMap((store) => store.read(handle)), Effect.provide(databaseLayer(root)))
    )
    : Promise.resolve(null)

const terminalErrors = new Set(["PlanDenied", "PlanNotFound", "PlanDigestMismatch", "EnvelopeMismatch", "InvalidInput"])
const settled = new Set(["cancelled", "completed", "failed"])
const stateOf = (status: StoredPlan["status"] | undefined): Scheduler.RunState =>
  status === undefined
    ? "missing"
    : status === "cancelled" || status === "completed" || status === "failed"
    ? status
    : "active"

/**
 * Provides recoverable scheduled launches without approving or timing out a plan.
 *
 * The stable handle is recorded as the trigger's active run. Its monitor can
 * restart in another process, re-offer the persisted card, and attach the real
 * run only after Control accepts it. Control's durable plan and run keys close
 * the crash gaps on either side of this adapter's own writes.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (root: string) =>
  Layer.effect(
    Scheduler.Runner,
    Effect.gen(function*() {
      const control = yield* Control.Control
      const { read, sql, write } = yield* makeStore
      const cancelRun = (runId: string) =>
        translated(
          `Could not cancel scheduled run ${runId}`,
          control.cancel({ runId, idempotencyKey: `trigger-cancel:${runId}` }).pipe(
            Effect.flatMap((receipt) =>
              receipt._tag === "Conflict"
                ? Effect.fail(failure(`Control refused scheduled cancellation: ${receipt.message}`))
                : Effect.void
            )
          )
        )
      const mark = (handle: string, status: StoredPlan["status"], error: string | null = null) =>
        write(sql`
          UPDATE control_trigger_plans SET status = ${status}, error = ${error}
          WHERE handle = ${handle} AND status NOT IN ('cancelled', 'cancelling')
        `).pipe(Effect.asVoid)
      const rememberFailure = (entry: StoredPlan, error: unknown) => {
        const tag = typeof error === "object" && error !== null && "_tag" in error
          ? String(error._tag).split("/").at(-1) ?? ""
          : ""
        const message = error instanceof Error ? error.message : "Control could not inspect this scheduled launch"
        return write(sql`
          UPDATE control_trigger_plans
          SET status = CASE
                WHEN status = 'cancelled' THEN status
                WHEN ${terminalErrors.has(tag) ? 1 : 0}
                  THEN CASE WHEN status = 'cancelling' THEN 'cancelled' ELSE 'failed' END
                ELSE status END,
              error = ${message}
          WHERE handle = ${entry.handle}
        `).pipe(
          Effect.andThen(read(entry.handle)),
          Effect.map((current): Scheduler.RunState =>
            current?.status === "cancelling" || !terminalErrors.has(tag) ? "active" : stateOf(current?.status)
          )
        )
      }
      const findRun = (runId: string) =>
        translated(
          `Could not inspect scheduled run ${runId}`,
          control.list({ _tag: "runs", filters: { runId }, limit: 1 }).pipe(
            Effect.flatMap((response) => {
              const run = response._tag === "runs" ? response.items.find((run) => run.runId === runId) : undefined
              return run === undefined
                ? Effect.fail(failure(`Control has no durable record for scheduled run ${runId}`))
                : Effect.succeed(run)
            })
          )
        )
      return Scheduler.makeRunner({
        start: (input) =>
          translated(
            "Could not prepare the scheduled plan",
            Effect.gen(function*() {
              const handle = `${prefix}${input.idempotencyKey}`
              // SqlControlRuntime persists this key together with the card.
              // A crash before our INSERT therefore cannot create a new plan.
              const plan = yield* control.plan(input)
              yield* write(sql`
                INSERT INTO control_trigger_plans (handle, idempotency_key, plan_json, status)
                VALUES (${handle}, ${input.idempotencyKey}, ${JSON.stringify(plan)}, 'waiting-approval')
                ON CONFLICT (handle) DO NOTHING
              `)
              return handle
            })
          ),
        inspect: (handle) =>
          Effect.gen(function*() {
            if (!handle.startsWith(prefix)) {
              return yield* findRun(handle).pipe(
                Effect.map((run): Scheduler.RunState =>
                  settled.has(run.status) ? stateOf(run.status as StoredPlan["status"]) : "active"
                )
              )
            }
            const entry = yield* read(handle)
            if (entry === null) return yield* Effect.fail(failure(`Unknown scheduled launch ${handle}`))
            if ((entry.status === "cancelled" || entry.status === "cancelling") && entry.runId !== null) {
              return yield* cancelRun(entry.runId).pipe(
                Effect.andThen(write(sql`
                  UPDATE control_trigger_plans SET status = 'cancelled', error = NULL WHERE handle = ${handle}
                `)),
                Effect.as<Scheduler.RunState>("cancelled"),
                Effect.catch(() => Effect.succeed<Scheduler.RunState>("active"))
              )
            }
            if (settled.has(entry.status)) return stateOf(entry.status)
            if (entry.runId !== null) {
              return yield* findRun(entry.runId).pipe(
                Effect.flatMap((run) =>
                  run.status === "completed" || run.status === "failed" || run.status === "cancelled"
                    ? mark(handle, run.status).pipe(Effect.as<Scheduler.RunState>(run.status))
                    : Effect.succeed<Scheduler.RunState>("active")
                ),
                Effect.catch((error) => rememberFailure(entry, error))
              )
            }
            // The existing idempotency key is the durable launch identity.
            // Claim the attempt before Control can accept it; cancellation of
            // an untouched waiting plan wins this write and never calls run.
            const launching = yield* write(sql`
              UPDATE control_trigger_plans
              SET status = CASE WHEN status = 'waiting-approval' THEN 'launching' ELSE status END
              WHERE handle = ${handle} AND status IN ('waiting-approval', 'launching', 'cancelling') AND run_id IS NULL
              RETURNING handle
            `)
            if (launching.length === 0) return "active"
            return yield* control.run({
              _tag: "Plan",
              planId: entry.plan.planId,
              digest: entry.plan.digest,
              envelope: entry.plan.envelope,
              idempotencyKey: entry.idempotencyKey
            }).pipe(
              Effect.flatMap((receipt) =>
                Effect.gen(function*() {
                  if (receipt._tag === "Parked") {
                    yield* write(sql`
                      UPDATE control_trigger_plans
                      SET status = CASE WHEN status = 'cancelling' THEN 'cancelled' ELSE 'waiting-approval' END
                      WHERE handle = ${handle} AND status IN ('launching', 'cancelling') AND run_id IS NULL
                    `)
                    return (yield* read(handle))?.status === "cancelled" ? "cancelled" : "active"
                  }
                  if (receipt._tag === "Conflict") {
                    yield* write(sql`
                      UPDATE control_trigger_plans
                      SET status = CASE WHEN status = 'cancelling' THEN 'cancelled' ELSE 'failed' END,
                          error = ${receipt.message}
                      WHERE handle = ${handle} AND status != 'cancelled' AND run_id IS NULL
                    `)
                    return stateOf((yield* read(handle))?.status)
                  }
                  const runId = receipt.runId
                  if (runId === undefined) {
                    return yield* Effect.fail(failure(`Control ${receipt._tag} receipt omitted its run id`))
                  }
                  yield* write(sql`
                    UPDATE control_trigger_plans
                    SET run_id = ${runId}, status = CASE WHEN status IN ('cancelled', 'cancelling') THEN status ELSE 'running' END,
                        error = NULL
                    WHERE handle = ${handle}
                  `)
                  // A superseding scheduler may cancel between our read and
                  // Control's acceptance. Do not leave that accepted run live.
                  const current = yield* read(handle)
                  if (current?.status === "cancelled" || current?.status === "cancelling") {
                    yield* cancelRun(runId)
                    yield* write(sql`
                      UPDATE control_trigger_plans SET status = 'cancelled', error = NULL WHERE handle = ${handle}
                    `)
                    return "cancelled"
                  }
                  return "active"
                })
              ),
              Effect.catch((error) => rememberFailure(entry, error))
            )
          }),
        cancel: (handle) =>
          Effect.gen(function*() {
            if (!handle.startsWith(prefix)) return yield* cancelRun(handle)
            const entry = yield* read(handle)
            if (entry === null) return yield* Effect.fail(failure(`Unknown scheduled launch ${handle}`))
            // Decide from the current row, not the earlier read: a launch
            // may have begun while this cancellation was being scheduled.
            yield* write(sql`
              UPDATE control_trigger_plans
              SET status = CASE
                    WHEN status IN ('launching', 'cancelling') AND run_id IS NULL THEN 'cancelling'
                    ELSE 'cancelled' END,
                  error = NULL
              WHERE handle = ${handle}
            `)
            const current = yield* read(handle)
            if (current?.runId != null) yield* cancelRun(current.runId)
            if (current?.status === "cancelling" && current.runId === null) {
              // Scheduler restores the active handle when cancel fails. Do
              // not let supersession discard its only recovery monitor.
              return yield* Effect.fail(failure(`Scheduled launch ${handle} is awaiting cancellation reconciliation`))
            }
          })
      })
    })
  ).pipe(Layer.provide(databaseLayer(root)))

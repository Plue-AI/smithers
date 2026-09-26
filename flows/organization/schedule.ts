/**
 * The host's scheduler: the durable trigger store in the state directory
 * (`triggers.db`) and `@smthrs/triggers`' scheduler over it, launching each
 * occurrence as an organization run through the host's own control plane.
 *
 * Schedules are cron expressions in an IANA zone, so a weekly slot keeps its
 * wall time across daylight saving; an occurrence's run is keyed by the
 * trigger and the occurrence, so a restart or a second poll joins the run it
 * started. At startup the host registers `organization-meetings:plan`, which
 * plans the weekly one-on-ones every day at 06:00 UTC; the plan registers each
 * role's prepare, open, and follow-up triggers (`meetings.ts`).
 */
import { Control } from "@smthrs/control"
import { type Duration, Effect, Layer, Result } from "effect"
import { join } from "node:path"
import * as Scheduler from "../../packages/smithers/agent/triggers/src/Scheduler.ts"
import * as SqlTriggerStore from "../../packages/smithers/agent/triggers/src/SqlTriggerStore.ts"
import * as Trigger from "../../packages/smithers/agent/triggers/src/Trigger.ts"
import { TriggerError } from "../../packages/smithers/agent/triggers/src/TriggerError.ts"
import * as TriggerStore from "../../packages/smithers/agent/triggers/src/TriggerStore.ts"
import type * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import { type Control as ControlPort, ControlRefused, operations } from "./client.ts"

/** The trigger store's database in the state directory. */
export const database = (stateDir: string) => join(stateDir, "triggers.db")

/** The durable trigger store over the state directory's `triggers.db`. */
export const store = (platform: NativeControl.Platform, stateDir: string) =>
  SqlTriggerStore.layer.pipe(Layer.provide(platform.database(database(stateDir))), Layer.orDie)

/** The host's control plane as the port the client operations use. */
const port = (control: Control.Control["Service"]): ControlPort => {
  const methods = {
    Plan: control.plan,
    Approve: control.approve,
    Run: control.run,
    List: control.list,
    Signal: control.signal
  } as const
  return {
    call: (tag, payload) => {
      const method = methods[tag] as (input: unknown) => Effect.Effect<unknown, { _tag: string; message: string }>
      return Effect.runPromise(
        method(payload).pipe(Effect.mapError((error) => new ControlRefused(error._tag, tag, error.message)))
      )
    }
  }
}

const failed = (message: string) => (cause: unknown) => new TriggerError({ code: "runner", message, cause })

/**
 * Launches a scheduled occurrence the way the CLI starts a run (plan,
 * approve, run, each keyed by the occurrence), and reads its state back.
 */
export const runner = Layer.effect(Scheduler.Runner)(Effect.gen(function*() {
  const control = yield* Control.Control
  const ops = operations(port(control))
  return Scheduler.makeRunner({
    start: (input) =>
      Effect.tryPromise({
        try: async () => (await ops.start(input.flowId, input.input, input.idempotencyKey)).runId,
        catch: failed(`the host could not start ${input.flowId}`)
      }),
    inspect: (runId) =>
      Effect.tryPromise({
        try: async () => {
          const [view] = await ops.runs({ runId })
          if (view === undefined) return "missing" as const
          return view.status === "completed" || view.status === "failed" || view.status === "cancelled"
            ? view.status
            : "active" as const
        },
        catch: failed(`the host could not inspect run ${runId}`)
      }),
    cancel: (runId) =>
      control.cancel({ runId, idempotencyKey: `trigger-cancel:${runId}` }).pipe(
        Effect.asVoid,
        Effect.mapError(failed(`the host could not cancel run ${runId}`))
      )
  })
}))

/** The daily meetings plan trigger. */
export const planTrigger = {
  id: "organization-meetings:plan",
  flowId: "organization/meetings-plan",
  input: {},
  cron: "0 6 * * *",
  timezone: "UTC",
  overlap: "skip",
  catchUp: "one",
  maxCatchUp: 1,
  enabled: true
} as const

/** A trigger declaration, before it is checked. */
export type Declaration = typeof planTrigger | {
  readonly id: string
  readonly flowId: string
  readonly input: unknown
  readonly cron: string
  readonly timezone: string
  readonly overlap: "skip"
  readonly catchUp: "none" | "one"
  readonly maxCatchUp?: number
  readonly enabled: boolean
}

/** The prefix of every routine's trigger id. */
export const routinePrefix = "organization-routine:"

/** The UTC cron expression that fires once a year at `at`'s minute: a once routine's, disabled after it ran. */
export const onceCron = (at: number) => {
  const date = new Date(at)
  return `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`
}

/** What the organization's own work schedules: the intake, the digest, and each routine. */
export interface Autonomy {
  /** The intake's schedule and how many items it works at once; absent without an autonomy section. */
  readonly intake?: { readonly cron: string; readonly timezone: string; readonly max: number } | undefined
  readonly digest?: { readonly cron: string; readonly timezone: string } | undefined
  readonly routines: ReadonlyArray<{
    readonly routine: {
      readonly id: string
      readonly cron?: string | undefined
      readonly timezone?: string | undefined
      readonly enabled: boolean
    }
    readonly input: unknown
    /** When a once or onboarding routine fires; `null` once it ran. */
    readonly at?: number | null | undefined
  }>
}

/** The trigger declarations of the organization's own work. */
export const autonomyTriggers = (autonomy: Autonomy): ReadonlyArray<Declaration> => [
  ...(autonomy.intake === undefined ? [] : [{
    id: "organization-work:intake",
    flowId: "organization/work",
    input: { max: autonomy.intake.max },
    cron: autonomy.intake.cron,
    timezone: autonomy.intake.timezone,
    overlap: "skip" as const,
    catchUp: "none" as const,
    enabled: true
  }]),
  ...(autonomy.digest === undefined ? [] : [{
    id: "organization-digest:daily",
    flowId: "organization/digest",
    input: {},
    cron: autonomy.digest.cron,
    timezone: autonomy.digest.timezone,
    overlap: "skip" as const,
    catchUp: "one" as const,
    maxCatchUp: 1,
    enabled: true
  }]),
  ...autonomy.routines.map(({ at, input, routine }) => ({
    id: `${routinePrefix}${routine.id}`,
    flowId: "organization/routine",
    input,
    cron: routine.cron ?? onceCron(at ?? 0),
    timezone: routine.cron === undefined ? "UTC" : routine.timezone ?? "UTC",
    overlap: "skip" as const,
    catchUp: "one" as const,
    maxCatchUp: 1,
    enabled: routine.enabled && (routine.cron !== undefined || (at !== null && at !== undefined))
  }))
]

/**
 * Registers the daily plan trigger and `declarations`, disables the
 * routine triggers the routines page no longer names, then runs the
 * scheduler until the host stops.
 */
export const layer = (options: {
  readonly pollInterval?: Duration.Input | undefined
  readonly declarations?: ReadonlyArray<Declaration> | undefined
} = {}) =>
  Layer.effectDiscard(Effect.gen(function*() {
    const triggers = yield* TriggerStore.TriggerStore
    yield* triggers.register(yield* Trigger.make(planTrigger))
    const declared = options.declarations ?? []
    for (const declaration of declared) yield* triggers.register(yield* Trigger.make(declaration))
    const ids = new Set(declared.map((declaration) => declaration.id))
    for (const listed of yield* triggers.list()) {
      if (Result.isFailure(listed.trigger)) continue
      const { lastFiredAt: _fired, revision: _revision, ...trigger } = listed.trigger.success
      if (!trigger.id.startsWith(routinePrefix) || ids.has(trigger.id) || !trigger.enabled) continue
      yield* triggers.register(yield* Trigger.make({ ...trigger, enabled: false }))
    }
  })).pipe(
    Layer.provideMerge(Scheduler.layer({ pollInterval: options.pollInterval ?? "15 seconds", host: "organization" })),
    Layer.provide(runner),
    Layer.orDie
  )

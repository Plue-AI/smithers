/**
 * Durable trigger administration and a Control-backed scheduler host.
 * @since 1.0.0
 */

import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as SqlTriggerStore from "@smthrs/triggers/SqlTriggerStore"
import * as Trigger from "@smthrs/triggers/Trigger"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Effect, Layer, Option, Result } from "effect"
import { Cli, z } from "incur"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import * as Presentation from "../cli/Presentation.ts"
import * as NodeControl from "../NodeControl.ts"
import { databaseLayer, localFields, type LocalOptions, localRoot } from "./Store.ts"
import * as TriggerPlans from "./TriggerPlans.ts"

// Every operator command reports failures as operator_failed.
const execute = <A>(context: Presentation.Failing, body: () => Promise<A>) =>
  Presentation.guard(context, body, {
    code: "operator_failed",
    next: Presentation.runs({
      otherwise: [
        { command: "triggers list", description: "Inspect schedules and active launches" },
        { command: "triggers show --help", description: "Inspect the exact approval card for a scheduled launch" }
      ]
    })
  })

/** Executes one operation against the shared durable trigger store.
 * @category execution
 * @since 1.0.0
 */
export const withTriggers = <A, E>(options: LocalOptions, effect: Effect.Effect<A, E, TriggerStore.TriggerStore>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqlTriggerStore.layer.pipe(Layer.provide(databaseLayer(localRoot(options))))))
  )

const required = (store: TriggerStore.Service, id: string) =>
  store.get(id).pipe(
    Effect.flatMap((value) =>
      Option.isSome(value) ? Effect.succeed(value.value) : Effect.fail(new Error(`Unknown trigger ${id}`))
    )
  )

/** Hosts durable polling using the caller's Control service; it never approves a plan.
 * @category layers
 * @since 1.0.0
 */
export const layerTriggerScheduler = (root: string, pollIntervalMs = 1000) =>
  Scheduler.layer({ pollInterval: pollIntervalMs }).pipe(
    Layer.provide(TriggerPlans.layer(root)),
    Layer.provide(SqlTriggerStore.layer.pipe(Layer.provide(databaseLayer(root))))
  )

/** Builds commands for registration, inspection and durable manual scheduling.
 * @category constructors
 * @since 1.0.0
 */
export const createTriggersCli = (runtime: { readonly signal?: AbortSignal | undefined } = {}) => {
  const options = z.object(localFields)
  const args = z.object({ id: z.string().min(1) })
  const cli = Cli.create("triggers", { description: "Manage durable schedules and manually queued occurrences" })
    .command("list", {
      description: "List all durable trigger registrations",
      mcp: { annotations: { readOnlyHint: true } },
      options,
      run: (context) =>
        execute(context, () =>
          withTriggers(
            context.options,
            Effect.gen(function*() {
              const listing = yield* (yield* TriggerStore.TriggerStore).list()
              // The listing isolates a row it could not decode so a scheduler
              // tick can skip it. An operator asking for the registrations
              // wants the failure instead, naming the row that needs repair.
              return yield* Effect.forEach(
                listing,
                (row) =>
                  Result.isFailure(row.trigger) ? Effect.fail(row.trigger.failure) : Effect.succeed(row.trigger.success)
              )
            })
          ))
    })
    .command("show", {
      description: "Show a trigger, its active run and the exact approval payload awaiting a decision",
      mcp: { annotations: { readOnlyHint: true } },
      args,
      options,
      run: (context) =>
        execute(context, async () => {
          const result = await withTriggers(
            context.options,
            Effect.gen(function*() {
              const store = yield* TriggerStore.TriggerStore
              return {
                trigger: yield* required(store, context.args.id),
                activeRun: Option.getOrNull(yield* store.activeRun(context.args.id))
              }
            })
          )
          return {
            ...result,
            activePlan: result.activeRun === null ?
              null :
              await TriggerPlans.inspect(localRoot(context.options), result.activeRun)
          }
        })
    })
    .command("register", {
      description: "Register or update a validated cron trigger from flags or a JSON file",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ id: z.string().min(1).optional() }),
      options: options.extend({
        file: z.string().optional().describe("JSON trigger declaration relative to the project root"),
        flow: z.string().optional(),
        cron: z.string().optional(),
        input: z.string().default("{}"),
        timezone: z.string().optional(),
        overlap: z.enum(["skip", "buffer-one", "supersede"]).default("skip"),
        catchUp: z.enum(["none", "one", "all"]).default("none"),
        maxCatchUp: z.number().int().nonnegative().default(0),
        enabled: z.boolean().default(true)
      }),
      run: (context) =>
        execute(context, () => {
          const input: unknown = context.options.file === undefined ?
            {
              id: context.args.id,
              flowId: context.options.flow,
              cron: context.options.cron,
              input: JSON.parse(context.options.input),
              timezone: context.options.timezone,
              overlap: context.options.overlap,
              catchUp: context.options.catchUp,
              maxCatchUp: context.options.maxCatchUp,
              enabled: context.options.enabled
            } :
            JSON.parse(readFileSync(resolve(localRoot(context.options), context.options.file), "utf8"))
          return withTriggers(
            context.options,
            Effect.gen(function*() {
              const declaration = yield* Trigger.make(input)
              if (context.args.id !== undefined && declaration.id !== context.args.id) {
                return yield* Effect.fail(new Error("Trigger file ID does not match the requested ID"))
              }
              return yield* (yield* TriggerStore.TriggerStore).register(declaration)
            })
          )
        })
    })
    .command("fire", {
      description: "Queue one manual occurrence for triggers serve or smthrs serve; approvals remain required",
      mcp: { annotations: { readOnlyHint: false } },
      args,
      options: options.extend({
        occurrence: z.number().int().nonnegative().max(8_640_000_000_000_000).optional().describe(
          "Unix milliseconds used as the retry identity; defaults to now"
        )
      }),
      run: (context) =>
        execute(context, () =>
          withTriggers(
            context.options,
            Effect.gen(function*() {
              const store = yield* TriggerStore.TriggerStore
              const trigger = yield* required(store, context.args.id)
              if (!trigger.enabled) {
                return yield* Effect.fail(new Error("Enable this trigger before queueing a manual occurrence"))
              }
              const occurrence = context.options.occurrence ?? Date.now()
              const idempotencyKey = Scheduler.idempotencyKey(trigger.id, occurrence)
              yield* store.setPending({ triggerId: trigger.id, occurrence })
              return { triggerId: trigger.id, occurrence, queued: true, idempotencyKey }
            })
          ))
    })
    .command("serve", {
      mcp: false,
      description: "Run the durable scheduler until interrupted, preserving Control approvals",
      options: options.extend({ pollIntervalMs: z.number().int().positive().default(1000) }),
      run: (context) =>
        execute(context, () => {
          const root = localRoot(context.options)
          return Effect.runPromise(
            Layer.launch(
              layerTriggerScheduler(root, context.options.pollIntervalMs).pipe(
                Layer.provide(NodeControl.layerControl({ root }))
              )
            ),
            { signal: runtime.signal }
          )
        })
    })
  for (const [command, enabled] of [["enable", true], ["disable", false]] as const) {
    cli.command(command, {
      description: `${enabled ? "Enable" : "Disable"} future occurrences without cancelling an active run`,
      mcp: { annotations: { readOnlyHint: false } },
      args,
      options,
      run: (context) =>
        execute(context, () =>
          withTriggers(
            context.options,
            Effect.gen(function*() {
              const store = yield* TriggerStore.TriggerStore
              const current = yield* required(store, context.args.id)
              const declaration = yield* Trigger.make({ ...current, enabled })
              return yield* store.register(declaration)
            })
          ))
    })
  }
  return cli
}

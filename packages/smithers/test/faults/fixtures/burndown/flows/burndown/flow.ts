import { Action, Fault, Flow, Interpreter } from "@smthrs/flow"
import { Unreachable } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { execFile } from "node:child_process"
import { appendFileSync, existsSync } from "node:fs"
import { promisify } from "node:util"
import { ridingOutages } from "./host.ts"

// A real module evaluation delay; no loader, clock, or engine is replaced.
const payload = {
  root: Schema.String,
  seconds: Schema.Number,
  count: Schema.Number,
  modelProbe: Schema.optional(Schema.Boolean)
}
const Work = Action.make("burndown/Work", {
  implementationVersion: "fault-3367/v1",
  payload: { ...payload, index: Schema.Number },
  success: Schema.String,
  error: Schema.Unknown,
  nondeterministic: true,
  tier: "irreversible"
})
export const Land = Action.make("burndown/Land", {
  implementationVersion: "fault-3367/v1",
  payload: { root: Schema.String, count: Schema.Number, index: Schema.Number },
  success: Schema.String,
  error: Schema.Unknown,
  nondeterministic: true,
  tier: "irreversible"
})
const ModelNetworkProbe = Action.make("burndown/ModelNetworkProbe", {
  implementationVersion: "fault-3367/v2",
  payload: { root: Schema.String, index: Schema.Number },
  success: Schema.String,
  error: Unreachable.Unreachable,
  nondeterministic: true,
  tier: "sealed",
  idempotencyKey: ({ root, index }) => ({ operation: "model-network-read", root, index })
})
export const Child = Flow.make("burndown/Child", {
  payload: Work.payloadSchema,
  success: Schema.String,
  error: Schema.Unknown,
  body: Node.capture(
    { work: Work.name, probe: ModelNetworkProbe.name },
    (input) =>
      input.modelProbe && input.index === 1
        ? Work.call(input).pipe(Node.andThen(ModelNetworkProbe.call({ root: input.root, index: input.index })))
        : Work.call(input)
  )
})
export const layer = Layer.mergeAll(
  Interpreter.layer(Child),
  Work.toLayer(({ root, seconds, index, count }) =>
    Effect.tryPromise({
      try: async (signal) =>
        (await promisify(execFile)(process.execPath, [
          `${root}/agent.mjs`,
          root,
          String(index),
          String(seconds),
          String(count)
        ], { signal })).stdout.trim(),
      catch: (error) => String(error)
    }), { implementationVersion: "fault-3367/v1" }),
  ModelNetworkProbe.toLayer(({ root, index }) =>
    Effect.tryPromise({
      try: async (signal) =>
        (await promisify(execFile)(process.execPath, [`${root}/network.mjs`, root, "model"], { signal })).stdout.trim(),
      catch: (error) => {
        const failure = Unreachable.classifyExit(String(error))
        if (failure === undefined) throw error
        appendFileSync(
          `${root}/network-faults.jsonl`,
          JSON.stringify({ index, ...Fault.of(failure), _tag: failure._tag }) + "\n"
        )
        return failure
      }
    }), { implementationVersion: "fault-3367/v2" }),
  Land.toLayer(({ root, count, index }) =>
    Effect.tryPromise({
      try: async (signal) => {
        if (existsSync(`${root}/landing-network.json`)) {
          await Effect.runPromise(
            ridingOutages(Effect.tryPromise({
              try: async (retrySignal) => {
                appendFileSync(`${root}/landing-attempts`, `${index}\n`)
                await promisify(execFile)(process.execPath, [`${root}/network.mjs`, root, "landing"], {
                  signal: retrySignal
                })
              },
              catch: (error) => ({ message: String(error) })
            })),
            { signal }
          )
        }
        return (await promisify(execFile)(process.execPath, [
          `${root}/agent.mjs`,
          root,
          `land-${index}`,
          "0",
          String(count)
        ], { signal })).stdout.trim()
      },
      catch: (error) => String(error)
    }), { implementationVersion: "fault-3367/v1" })
)
export default Flow.make("burndown", {
  description: "Deterministic infrastructure fault fixture.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload,
  success: Schema.String,
  error: Schema.Unknown,
  body: Node.capture({}, ({ root, seconds, count, modelProbe }) => {
    const children = Object.fromEntries(
      Array.from(
        { length: count },
        (_, n) => [String(n + 1), Child.child({ root, seconds, count, index: n + 1, modelProbe })]
      )
    )
    let plan = Node.all(children).pipe(Node.andThen(Land.call({ root, count, index: 1 })))
    for (let index = 2; index <= count; index++) plan = plan.pipe(Node.andThen(Land.call({ root, count, index })))
    return plan
  })
})

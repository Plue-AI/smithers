import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { appendFileSync, readFileSync, statfsSync, writeFileSync } from "node:fs"
import { Child, Land, layer as childLayer } from "../burndown/flow.ts"
// The harness verifies and copies the complete owning module bytes, with its real SDK import.
import { awaitDisk } from "./vm.ts"
const Gate = Action.make("disk/Gate", {
  implementationVersion: "fault-3367/v1",
  payload: { root: Schema.String },
  success: Schema.Void,
  error: Schema.Unknown,
  nondeterministic: true,
  tier: "irreversible"
})
export const layer = Layer.mergeAll(
  childLayer,
  Gate.toLayer(({ root }) =>
    Effect.gen(function*() {
      const { path, floor } = JSON.parse(readFileSync(`${root}/disk.json`, "utf8"))
      const free = () => {
        const fs = statfsSync(path)
        const bytes = fs.bavail * fs.bsize
        appendFileSync(`${root}/statfs.jsonl`, JSON.stringify({ bytes, floor, at: Date.now() }) + "\n")
        return bytes
      }
      writeFileSync(`${root}/disk-waiting`, String(free()))
      yield* awaitDisk(free, floor, "100 millis")
      writeFileSync(`${root}/disk-cleared`, "ready")
    }), { implementationVersion: "fault-3367/v1" })
)
export default Flow.make("disk", {
  description: "Wait below the real burndown disk floor.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { root: Schema.String, seconds: Schema.Number, count: Schema.Number },
  success: Schema.String,
  error: Schema.Unknown,
  body: Node.capture({}, ({ root, seconds, count }) => {
    const children = Object.fromEntries(
      Array.from({ length: count }, (_, n) => [String(n + 1), Child.child({ root, seconds, count, index: n + 1 })])
    )
    let plan = Gate.call({ root }).pipe(
      Node.andThen(Node.all(children)),
      Node.andThen(Land.call({ root, count, index: 1 }))
    )
    for (let index = 2; index <= count; index++) plan = plan.pipe(Node.andThen(Land.call({ root, count, index })))
    return plan
  })
})

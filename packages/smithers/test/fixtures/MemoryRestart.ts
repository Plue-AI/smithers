import * as ControlRuntime from "@smthrs/control/ControlRuntime"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import { Effect } from "effect"
import * as NodeControl from "../../src/NodeControl.ts"

const [operation, root] = process.argv.slice(2)
if (root === undefined) throw new Error("A project root is required")
const result = operation === "write"
  ? await Effect.runPromise(
    Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({
        namespace: { kind: "global", id: "release" },
        key: "runbook",
        value: "retained across commands",
        provenance: { runId: "writer" }
      })
      return { written: true }
    }).pipe(Effect.provide(NodeControl.layerMemory(root)))
  )
  : await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* ControlRuntime.ControlRuntime
      return {
        flows: yield* control.listFlows,
        plans: yield* Effect.map(control.pagePlanIds({ limit: 500 }), (page) => page.ids)
      }
    }).pipe(Effect.provide(NodeControl.engineDurable(root).runtime))
  )
process.stdout.write(JSON.stringify(result))

import * as Cell from "@smthrs/harness/Cell"
import { Context, Effect, Option } from "effect"
import { expect, test } from "vitest"
import { CellHistory, FlowStore, makeMemoryStore, makeNoopHistory, promoteSource } from "../tools/promote.ts"

test("write-flow refuses a source that fails typecheck before storing it", async () => {
  const written = new Map<string, string>()
  const source = promoteSource(Context.make(FlowStore, makeMemoryStore(written)).pipe(Context.add(CellHistory, makeNoopHistory())))
  const bindings = await Effect.runPromise(source.bindings())
  const binding = bindings.find((entry) => entry.descriptor.name === "flows/write-flow")!
  const result = await Effect.runPromise(binding.run(new Cell.Call({
    flowName: "flows/write-flow",
    input: {
      id: "bad-flow",
      description: "Bad cast",
      flowSource: "export default 1 as string",
      testSource: "export {}",
      fixtureJson: "{}"
    },
    capabilities: ["fs:write:/flows/**"],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.none(),
    identity: new Cell.CallIdentity({
      session: "test", frame: 0, cell: "cell", ordinal: 0, declaration: "test", layers: []
    })
  })))
  expect(result.code).toBe("flow_failed")
  expect(result.message).toMatch(/TS2352/)
  expect(result.message).toContain("flows/write-flow")
  expect(written.size).toBe(0)
  expect(written.has("flows/bad-flow/flow.ts")).toBe(false)
})

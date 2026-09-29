import * as Cell from "@smthrs/harness/Cell"
import * as CellHistory from "@smthrs/harness/CellHistory"
import { Context, Effect, Option } from "effect"
import { expect, test } from "vitest"
import { FlowStore, makeMemoryStore, promoteSource, sessionSource } from "../tools/promote.ts"

test("write-flow refuses a source that fails typecheck before storing it", async () => {
  const written = new Map<string, string>()
  const source = promoteSource(Context.make(FlowStore, makeMemoryStore(written)).pipe(Context.add(CellHistory.CellHistory, CellHistory.makeNoop())))
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

const showScript = (cells: ReadonlyArray<CellHistory.ExecutedCell>) =>
  new Cell.Call({
    flowName: "flows/show-script",
    input: {},
    capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.none(),
    identity: new Cell.CallIdentity({
      session: "test", frame: 0, cell: "cell", ordinal: cells.length, declaration: "test", layers: []
    })
  })

test("show-script reads the harness CellHistory in execution order", async () => {
  const history = await Effect.runPromise(CellHistory.make)
  await Effect.runPromise(history.record("const a = 1"))
  await Effect.runPromise(history.record("print(a)"))
  const source = promoteSource(Context.make(CellHistory.CellHistory, history).pipe(Context.add(FlowStore, makeMemoryStore())))
  const bindings = await Effect.runPromise(source.bindings())
  const binding = bindings.find((entry) => entry.descriptor.name === "flows/show-script")!
  const result = await Effect.runPromise(binding.run(showScript([])))
  expect(result.outcome).toBe("success")
  expect((result.value as { cells: unknown }).cells).toEqual([
    { ordinal: 0, source: "const a = 1" },
    { ordinal: 1, source: "print(a)" }
  ])
})

test("sessionSource reports cells appended after the source was built", async () => {
  const cells: Array<CellHistory.ExecutedCell> = []
  const source = sessionSource({ writeFlow: () => ({ files: [] }), listFlows: () => [] }, cells)
  const bindings = await Effect.runPromise(source.bindings())
  const binding = bindings.find((entry) => entry.descriptor.name === "flows/show-script")!
  const empty = await Effect.runPromise(binding.run(showScript(cells)))
  expect((empty.value as { cells: unknown }).cells).toEqual([])
  cells.push({ ordinal: 0, source: "1 + 1" })
  const one = await Effect.runPromise(binding.run(showScript(cells)))
  expect((one.value as { cells: unknown }).cells).toEqual([{ ordinal: 0, source: "1 + 1" }])
})

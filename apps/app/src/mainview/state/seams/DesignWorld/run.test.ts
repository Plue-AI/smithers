import { describe, expect, test } from "bun:test"
import { FlowCardSchema } from "@smthrs/rpc/FlowCard"
import { MonitorCardSchema } from "@smthrs/rpc/MonitorCard"
import { seedDesignWorld } from "./index"
import { activeTraces, attemptsOf, flowCardOf, flowNames, flowTitle, monitorOf, traceNamed } from "./run"

const world = seedDesignWorld()

describe("DesignWorld run and flow seam", () => {
  test("every seeded trace maps to a MonitorCard that parses, attempts oldest first, phases keyed to a step instance", () => {
    expect(world.traces.length).toBeGreaterThan(0)
    for (const trace of world.traces) {
      const model = monitorOf(world, trace.id)
      expect(model).toBeDefined()
      expect(MonitorCardSchema.parse(model)).toEqual(model!)
      expect(model!.attempts.map(attempt => attempt.n)).toEqual([...model!.attempts.map(attempt => attempt.n)].sort((left, right) => left - right))
      expect(model!.attempts.at(-1)?.run_id).toBe(trace.id)
      for (const attempt of model!.attempts) {
        for (const phase of attempt.phases) expect(attempt.steps.some(step => step.key === phase.step)).toBe(true)
        for (const step of attempt.steps) expect(attempt.graph.some(node => node.id === step.id)).toBe(true)
      }
    }
  })

  test("T9's second attempt waits on its question beside the interrupted first attempt", () => {
    const model = monitorOf(world, "run-retry")!
    expect(model.todo).toBe(9)
    expect(model.state).toBe("waiting")
    expect(model.attempts.map(attempt => attempt.state)).toEqual(["interrupted", "waiting"])
    const question = world.todos.find(todo => todo.id === "t-retry")!.question!.text
    expect(model.waits).toEqual([{ id: "p-ask", kind: "question", label: question, since: "10:42" }])
    const second = model.attempts[1]!
    /* It thrashed in Implement and asked in Verify, where it waits. */
    expect(second.graph.map(node => `${node.id}:${node.state}`)).toEqual(["plan:done", "implement:done", "verify:waiting", "review:next", "propose:next", "merge:next"])
    expect(second.phases.map(phase => phase.step)).toEqual(["plan#1", "implement#1", "implement#1", "verify#1"])
    expect(second.steps.map(step => `${step.key}:${step.state}`)).toEqual(["plan#1:done", "implement#1:done", "verify#1:waiting"])
    expect(second.phases.find(phase => phase.tone === "thrash")?.step).toBe("implement#1")
    expect(second.steps[0]!.usage!.tokens).toBeGreaterThan(0)
    expect(model.tokens).toBeGreaterThan(0)
    expect(model.time_s).toBeGreaterThan(0)
    /* Attempt 1 alone: its own card shows no later attempt. */
    expect(monitorOf(world, "run-retry-1")!.attempts.map(attempt => attempt.n)).toEqual([1])
    expect(attemptsOf(world, world.traces[0]!).map(trace => trace.attempt)).toEqual([1, 2])
  })

  test("a step the run returns to gets a second instance key", () => {
    const trace = world.traces.find(each => each.id === "run-retry")!
    const rebased = {
      ...world,
      traces: [{ ...trace, state: "held" as const, held: { since: "10:52" }, phases: [
        ...trace.phases,
        { id: "p-verify", step: "verify", title: "Run the checks", summary: "", took: 50, tone: "ok" as const, cells: [] },
        { id: "p-propose", step: "propose", title: "Open the PR", summary: "", took: 40, tone: "ok" as const, cells: [] },
        { id: "p-recheck", step: "verify", title: "Recheck", summary: "", took: 60, tone: "ok" as const, cells: [] }
      ] }]
    }
    const model = monitorOf(rebased, "run-retry")!
    const attempt = model.attempts.at(-1)!
    expect(attempt.phases.map(phase => phase.step)).toEqual(["plan#1", "implement#1", "implement#1", "verify#1", "verify#1", "propose#1", "verify#2"])
    expect(attempt.steps.map(step => step.key)).toEqual(["plan#1", "implement#1", "verify#1", "propose#1", "verify#2"])
    expect(attempt.graph.find(node => node.id === "merge")?.state).toBe("held")
    expect(model.state).toBe("held")
    expect(model.waits).toEqual([])
  })

  test("traceNamed resolves a run id, a TODO id, its ref or its number to the latest attempt", () => {
    for (const name of ["run-retry", "t-retry", "T9", "t9", "9"]) expect(traceNamed(world, name)?.id).toBe("run-retry")
    expect(traceNamed(world, "run-retry-1")?.id).toBe("run-retry-1")
    expect(traceNamed(world, "nope")).toBeUndefined()
    expect(traceNamed(world, "T8")).toBeUndefined()
  })

  test("activeTraces lists each TODO's latest attempt that is still going", () => {
    expect(activeTraces(world).map(trace => trace.id)).toEqual(["run-retry"])
    expect(monitorOf(world, "nope")).toBeUndefined()
  })

  test("flow cards parse; the TODO flow has a source and a wait, the system flow is built in", () => {
    expect(flowNames(world)).toEqual(["todo", "merge"])
    const todo = flowCardOf(world, "todo")!
    expect(FlowCardSchema.parse(todo)).toEqual(todo)
    expect(todo.source).toEqual({ path: "flows/todo/flow.ts" })
    expect(todo.versions.map(version => `${version.id}:${version.state}`)).toEqual(["v1:active", "v2:proposed"])
    expect(todo.versions[1]!.steps.map(step => step.id)).toContain("changelog")
    expect(todo.versions[0]!.steps.at(-1)).toMatchObject({ id: "merge", wait: true })
    expect(todo.versions[0]!.steps.find(step => step.id === "plan")).toMatchObject({ agent: "Fable 5.1" })
    const merge = flowCardOf(world, "merge")!
    expect(FlowCardSchema.parse(merge)).toEqual(merge)
    expect(merge.source).toEqual({ builtin: true })
    expect(merge.versions[0]!.steps.some(step => "wait" in step)).toBe(false)
    expect(flowCardOf(world, "nope")).toBeUndefined()
    expect([flowTitle("todo"), flowTitle("merge"), flowTitle("release")]).toEqual(["TODO flow", "Merge flow", "release flow"])
  })
})

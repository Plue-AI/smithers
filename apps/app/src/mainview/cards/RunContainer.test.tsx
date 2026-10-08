import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MonitorCardSchema, type MonitorCard, type RunViewProps } from "@smthrs/rpc/MonitorCard"
import { fixtures } from "@smthrs/rpc/fixtures/Monitor"
import { RunContainer } from "./RunContainer"
import { contextMonitor } from "../state/ContextMonitor"

const mount = (model: MonitorCard | undefined, maximized: boolean) => {
  let props!: RunViewProps
  const calls: Array<{ tag: string; input: unknown }> = []
  renderToStaticMarkup(<RunContainer model={model} dispatch={(tag, input) => { calls.push({ tag, input }) }}
    View={value => { props = value; return null }} view={{ maximized }} onView={() => {}} />)
  return { props, calls }
}

test("a completed app-agent answer is Done, while a merged TODO retains Merged", () => {
  const model = contextMonitor({ id: "attempt", turnId: "turn", legId: "leg", status: "complete",
    receivedText: true, claimBuffer: "", createdAt: 1, revision: 1,
    preflight: { context: [], candidates: [], model: "owner-fast", durationMs: 12 } })
  const render = (value: MonitorCard | undefined) => renderToStaticMarkup(<RunContainer model={value} dispatch={() => {}}
    view={{ maximized: false }} onView={() => {}} />)
  expect(render(model)).toContain(">Done<")
  expect(render(model)).not.toContain(">Merged<")
  expect(render({ ...model!, todo: 10 })).toContain(">Merged<")
})
const tags = (model: MonitorCard, maximized: boolean) => mount(model, maximized).props.actions.map(action => action.tag)

test("every Monitor fixture parses and every bound press dispatches its own tag", () => {
  for (const fixture of Object.values(fixtures)) for (const maximized of [false, true]) {
    const h = mount(fixture.model, maximized)
    expect(MonitorCardSchema.parse(h.props.model)).toEqual(h.props.model)
    expect(h.props.gestures).toEqual({})
    for (const action of h.props.actions) {
      const before = h.calls.length
      h.props.onAction(action.tag, action.args)
      expect(h.calls).toHaveLength(before + 1)
      expect(h.calls.at(-1)?.tag).toBe(action.tag)
    }
  }
  expect(mount(undefined, false).props).toBeUndefined()
})

test("embedded offers Inspect; the monitor offers Answer, Steer and Stop; a failed or interrupted run offers Retry", () => {
  expect(tags(fixtures.running.model, false)).toEqual(["run.inspect"])
  expect(tags(fixtures.running.model, true)).toEqual(["todo.steer", "todo.stop"])
  expect(tags(fixtures.waiting.model, true)).toEqual(["todo.answer", "todo.steer"])
  // A settled question is answered; an open approval is not a question.
  expect(tags(fixtures.two_attempts.model, true)).toEqual(["todo.steer"])
  expect(tags(fixtures.held.model, true)).toEqual(["todo.steer"])
  expect(tags(fixtures.failed.model, false)).toEqual(["run.inspect", "todo.retry"])
  expect(tags(fixtures.failed.model, true)).toEqual(["todo.retry"])
  expect(tags(fixtures.interrupted.model, true)).toEqual(["todo.retry"])
  expect(tags(fixtures.done.model, true)).toEqual([])
  // A background run has no TODO to steer.
  expect(tags(fixtures.background.model, false)).toEqual(["run.inspect"])
  expect(tags(fixtures.background.model, true)).toEqual([])
})

test("the monitor selects the latest attempt's newest cell when nothing is selected; embedded and a chosen selection pass through", () => {
  for (const fixture of Object.values(fixtures)) {
    const newest = fixture.model.attempts.at(-1)?.phases.flatMap(phase => phase.cells).at(-1)?.id
    expect(mount(fixture.model, true).props.view.selected).toBe(newest)
    expect(mount(fixture.model, false).props.view.selected).toBeUndefined()
  }
  const model: MonitorCard = { ...fixtures.running.model, attempts: fixtures.running.model.attempts.map((attempt, index, all) => index < all.length - 1 ? attempt
    : { ...attempt, phases: [...attempt.phases, { ...attempt.phases.at(-1)!, id: "phase-empty", cells: [] }] }) }
  expect(mount(model, true).props.view.selected).toBe(fixtures.running.model.attempts.at(-1)?.phases.at(-1)?.cells.at(-1)?.id)
  let props!: RunViewProps
  renderToStaticMarkup(<RunContainer model={fixtures.running.model} dispatch={() => {}} View={value => { props = value; return null }}
    view={{ maximized: true, selected: "chosen" }} onView={() => {}} />)
  expect(props.view.selected).toBe("chosen")
})

test("presses carry the run id, the TODO number, the wait and what was typed", () => {
  const embedded = mount(fixtures.failed.model, false)
  embedded.props.onAction("run.inspect")
  embedded.props.onAction("todo.retry")
  expect(embedded.calls).toEqual([{ tag: "run.inspect", input: { id: "run-41" } }, { tag: "todo.retry", input: { n: 12 } }])
  const monitor = mount(fixtures.waiting.model, true)
  monitor.props.onAction("todo.answer", { answer: "Yes, include them" })
  monitor.props.onAction("todo.steer", { text: "Use backoff()" })
  expect(monitor.calls).toEqual([
    { tag: "todo.answer", input: { n: 12, wait: "wait-question-1", answer: "Yes, include them" } },
    { tag: "todo.steer", input: { n: 12, text: "Use backoff()" } }
  ])
  const running = mount(fixtures.running.model, true)
  running.props.onAction("todo.stop")
  running.props.onAction("run.inspect")
  expect(running.calls).toEqual([{ tag: "todo.stop", input: { n: 12 } }])
})

test("native colon-bearing step instances select I/O in the mounted Run View", () => {
  const model = MonitorCardSchema.parse(fixtures.running.model)
  const attempt = model.attempts.at(-1)!
  const step = attempt.steps[0]!
  const prior = step.id
  step.id = "engine-node:child:root.action"
  step.key = `${step.id}#${step.k}`
  for (const node of attempt.graph) if (node.id === prior) node.id = step.id
  for (const phase of attempt.phases) if (phase.step === `${prior}#${step.k}`) phase.step = step.key
  step.input = { nativeInput: "input-receipt" }
  step.output = { nativeOutput: "output-receipt" }
  const html = renderToStaticMarkup(<RunContainer model={model} dispatch={() => {}}
    view={{ maximized: true, selected: `step:${attempt.run_id}:${step.id}` }} onView={() => {}} />)
  expect(html).toContain('aria-label="Selected step"')
  expect(html).toContain("input-receipt")
  expect(html).toContain("output-receipt")
  expect(model.attempts.at(-1)!.steps[0]!.id).toBe("engine-node:child:root.action")
})


test("declared custom text uses the shipped slot and remains inert; absent presentation mounts no slot", () => {
  const model = MonitorCardSchema.parse({ ...fixtures.running.model, presentation: { kind: "text", text: "Hello, Ada <script>globalThis.runCanary = true</script>" } })
  const html = renderToStaticMarkup(<RunContainer model={model} dispatch={() => {}}
    view={{ maximized: true }} onView={() => {}} />)
  expect(html).toContain('aria-label="Custom view"')
  expect(html).toContain("Hello, Ada &lt;script&gt;")
  expect(html).not.toContain("<script>")
  expect((globalThis as { runCanary?: boolean }).runCanary).toBeUndefined()
  const absent = renderToStaticMarkup(<RunContainer model={fixtures.running.model} dispatch={() => {}}
    view={{ maximized: true }} onView={() => {}} />)
  expect(absent).not.toContain('aria-label="Custom view"')
  for (const presentation of [{ kind: "module", text: "./view.ts" }, { kind: "text", text: "hello", module: "./view.ts" }]) {
    expect(MonitorCardSchema.safeParse({ ...model, presentation }).success).toBe(false)
  }
})

test("priced steps sum repeated instances once; unpriced steps show no dollars", () => {
  const model = MonitorCardSchema.parse(fixtures.running.model)
  const attempt = model.attempts.at(-1)!
  const step = attempt.steps[0]!
  step.usage = { tokens: 1200, cost_usd: 0.12 }
  attempt.steps.push({ ...step, key: `${step.id}#2`, k: 2, usage: { tokens: 200, cost_usd: 0.03 } })
  const html = renderToStaticMarkup(<RunContainer model={model} dispatch={() => {}}
    view={{ maximized: true, selected: `step:${attempt.run_id}:${step.id}` }} onView={() => {}} />)
  expect(html).toContain("$0.15")
  expect(html).toContain("1.4k tokens")
  const withoutUsage = MonitorCardSchema.parse(fixtures.running.model)
  for (const attempt of withoutUsage.attempts) for (const step of attempt.steps) delete step.usage
  const unpriced = renderToStaticMarkup(<RunContainer model={withoutUsage} dispatch={() => {}}
    view={{ maximized: true }} onView={() => {}} />)
  expect(unpriced).not.toContain("$")
})


test("the monitor retains every durable wait and one collapsed Engine row across attempts", () => {
  const model = MonitorCardSchema.parse(fixtures.two_attempts.model)
  model.waits = ["question", "approval", "pause", "sleep", "signal", "external_job"].map((kind, index) => ({
    id: `wait-${index}`, kind: kind as MonitorCard["waits"][number]["kind"], label: `wait receipt ${index}`,
    since: "2026-10-06T10:00:00Z", ...(index % 2 === 0 ? { settled: { by: { kind: "system" as const, color_index: 7 as const }, at: "2026-10-06T10:02:00Z" } } : {})
  }))
  model.engine = [{ label: "Checkpoint", detail: "agent/trace/checkpoint" }, { label: "Boundary", detail: "<seal-step>" }]
  const html = renderToStaticMarkup(<RunContainer model={model} dispatch={() => {}}
    view={{ maximized: true }} onView={() => {}} />)
  expect(html.match(/<summary>Engine<\/summary>/g)).toHaveLength(1)
  expect(html).not.toContain("<details open")
  for (let index = 0; index < 6; index++) expect(html).toContain(`wait receipt ${index}`)
  expect(html.match(/dateTime="2026-10-06T10:00:00Z"/g)).toHaveLength(6)
  expect(html.match(/dateTime="2026-10-06T10:02:00Z"/g)).toHaveLength(3)
  expect(html).toContain("answered by Smithers")
  expect(html).toContain("settled by Smithers")
  const noEngine = renderToStaticMarkup(<RunContainer model={{ ...model, engine: [] }} dispatch={() => {}}
    view={{ maximized: true }} onView={() => {}} />)
  expect(noEngine).not.toContain("<summary>Engine</summary>")
})


test("metered sub-cent costs stay visible and unmetered token counts survive", () => {
  const model = MonitorCardSchema.parse(fixtures.running.model)
  const attempt = model.attempts.at(-1)!
  const step = attempt.steps[0]!
  step.usage = { tokens: 1, cost_usd: 0.000000001 }
  const render = () => renderToStaticMarkup(<RunContainer model={model} dispatch={() => {}}
    view={{ maximized: true, selected: `step:${attempt.run_id}:${step.id}` }} onView={() => {}} />)
  expect(render()).toContain("$0.000000001")
  delete step.usage
  step.tokens = 1200
  expect(render()).toContain("1.2k tokens")
})

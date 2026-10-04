import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MonitorCardSchema, type MonitorCard, type RunViewProps } from "@smthrs/rpc/MonitorCard"
import { fixtures } from "@smthrs/rpc/fixtures/Monitor"
import { RunContainer } from "./RunContainer"

const mount = (model: MonitorCard | undefined, maximized: boolean) => {
  let props!: RunViewProps
  const calls: Array<{ tag: string; input: unknown }> = []
  renderToStaticMarkup(<RunContainer model={model} dispatch={(tag, input) => { calls.push({ tag, input }) }}
    View={value => { props = value; return null }} view={{ maximized }} onView={() => {}} />)
  return { props, calls }
}
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

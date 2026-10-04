import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { HomeCardSchema, type HomeViewProps } from "@smthrs/rpc/HomeCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { fixtures } from "@smthrs/rpc/fixtures/Home"
import { HomeCard, HomeContainer } from "./HomeContainer"
const allowed = new Set<CatalogTag>(["todo.new", "github", "todo", "todo.answer", "todo.retry", "todo.drop", "branch", "merge", "stack.move", "order.ok", "main.reset-to-github", "background.retry", "background.dismiss"])
const mount = (model: unknown, role: "owner" | "maintainer" | "member" = "owner", admission = allowed) => {
  let props!: HomeViewProps
  const calls: unknown[] = []
  renderToStaticMarkup(<HomeContainer model={model} role={role} allowed={admission} dispatch={(tag, input) => { calls.push({ tag, input }) }}
    View={value => { props = value; return null }} view={{ maximized: false }} onView={() => {}} />)
  return { props, calls }
}
test("Home fixtures parse and every supplied row control dispatches through catalog bindings", () => {
  for (const fixture of Object.values(fixtures)) {
    const h = mount(fixture.model)
    expect(HomeCardSchema.parse(h.props.model)).toEqual(h.props.model)
    expect(h.props.gestures).toEqual({})
    const actions = [...h.props.actions, ...h.props.model.attention.flatMap(row => row.actions), ...h.props.model.items.flatMap(row => row.actions), ...h.props.model.background_runs.flatMap(row => row.actions)]
    for (const action of actions) {
      const before = h.calls.length
      h.props.onAction(action.tag, action.args)
      if (action.disabled) expect(h.calls).toHaveLength(before)
      else expect((h.calls.at(-1) as { tag: string }).tag).toBe(action.tag)
    }
    expect(h.calls).toHaveLength(actions.filter(action => !action.disabled).length)
  }
})
test("reset is owner-only and binds the actual main revision", () => {
  const base = Object.values(fixtures)[0]!.model
  const model = { ...base, attention: [{ kind: "force_push", text: "Main moved", actions: [{ tag: "main.reset-to-github", label: "Reset to GitHub main" }] }] }
  const owner = mount(model)
  owner.props.onAction("main.reset-to-github")
  expect(owner.calls).toEqual([{ tag: "main.reset-to-github", input: { revision: base.main.sha } }])
  for (const role of ["member", "maintainer"] as const) {
    const h = mount(model, role)
    expect(h.props.model.attention).toEqual([])
    h.props.onAction("main.reset-to-github")
    expect(h.calls).toEqual([])
  }
})
test("lack of admission removes all controls, and unavailable models never render", () => {
  const h = mount(Object.values(fixtures)[0]!.model, "member", new Set())
  expect(h.props.actions).toEqual([])
  expect(h.props.model.items.flatMap(row => row.actions)).toEqual([])
  h.props.onAction("todo.drop")
  expect(h.calls).toEqual([])
  expect(mount(undefined).props).toBeUndefined()
  expect(() => mount({})).toThrow()
})
test("row identity, direction and background run identity stay bound across multiple controls", () => {
  const base = Object.values(fixtures).find(fixture => fixture.model.items.length > 0)!.model
  const row = base.items[0]!
  const model = { ...base, attention: [], items: [{ ...row, n: 42, state: "needs_you", actions: [
    { tag: "todo.answer", label: "Answer" },
    { tag: "stack.move", label: "Move up", args: { direction: "up" } },
    { tag: "stack.move", label: "Move down", args: { direction: "down" } }
  ] }], background_runs: [{ id: "failed-run", title: "Refresh", state: "failed", actions: [
    { tag: "background.retry", label: "Retry" }, { tag: "background.dismiss", label: "Dismiss" }
  ] }] }
  const h = mount(model)
  h.props.onAction("todo.answer", { n: "999", answer: "Keep it" })
  h.props.onAction("stack.move", { n: "42", direction: "up" })
  h.props.onAction("stack.move", { n: "42", direction: "down" })
  h.props.onAction("background.retry", { id: "failed-run" })
  h.props.onAction("background.dismiss", { id: "failed-run" })
  expect(h.calls).toEqual([
    { tag: "todo.answer", input: { n: 42, answer: "Keep it" } },
    { tag: "stack.move", input: { n: 42, direction: "up" } },
    { tag: "stack.move", input: { n: 42, direction: "down" } },
    { tag: "background.retry", input: { id: "failed-run" } },
    { tag: "background.dismiss", input: { id: "failed-run" } }
  ])
  const settled = mount({ ...model, items: [{ ...model.items[0], state: "merged" }] })
  expect(settled.props.model.items[0]!.actions).toEqual([])
})
test("Merge is absent for members and for blocked, later or draft rows", () => {
  const base = Object.values(fixtures).find(fixture => fixture.model.items.length > 0)!.model
  const row = { ...base.items[0]!, state: "in_review", place: 1, merge: { state: "ready", on_github: false }, pr: { number: 123, draft: false }, actions: [{ tag: "merge", label: "Merge" }] }
  for (const role of ["owner", "maintainer", "member"] as const) {
    const h = mount({ ...base, attention: [], items: [row] }, role)
    expect(h.props.model.items[0]!.actions.map(action => action.tag)).toEqual(role === "member" ? [] : ["merge"])
    h.props.onAction("merge", { n: String(row.n) })
    expect(h.calls).toHaveLength(role === "member" ? 0 : 1)
  }
  for (const patch of [{ place: 2 }, { merge: { state: "blocked", on_github: false } }, { pr: { number: 123, draft: true } }]) {
    const h = mount({ ...base, attention: [], items: [{ ...row, ...patch }] })
    expect(h.props.model.items[0]!.actions).toEqual([])
  }
})

test("Home stays unmounted without the complete production composition", () => {
  expect(renderToStaticMarkup(<HomeCard />)).toBe("")
})

test("only the first unmerged row can offer one Merge, even with duplicate supplied controls", () => {
  const base = Object.values(fixtures).find(fixture => fixture.model.items.length > 0)!.model
  const row = { ...base.items[0]!, state: "in_review", place: 1, merge: { state: "ready", on_github: false }, pr: { number: 123, draft: false }, actions: [{ tag: "merge", label: "Merge" }, { tag: "merge", label: "Merge" }] }
  const h = mount({ ...base, items: [row, { ...row, n: 99 }] })
  expect(h.props.model.items.map(item => item.actions.map(action => action.tag))).toEqual([["merge"], []])
  const waiting = mount({ ...base, items: [{ ...row, state: "working", actions: [] }, { ...row, n: 99 }] })
  expect(waiting.props.model.items.flatMap(item => item.actions)).toEqual([])
})

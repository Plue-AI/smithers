import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { FlowCardSchema, type FlowViewProps } from "@smthrs/rpc/FlowCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { fixtures } from "@smthrs/rpc/fixtures/Flow"
import { FlowContainer } from "./FlowContainer"

const mount = (model: unknown, system = false, allowed = new Set<CatalogTag>(["flow.source", "flow.plan", "flow.run", "flow.edit"])) => {
  let props!: FlowViewProps
  const calls: unknown[] = []
  renderToStaticMarkup(<FlowContainer model={model} system={system} allowed={allowed} dispatch={(tag, input) => { calls.push({ tag, input }) }}
    View={value => { props = value; return null }} view={{ maximized: false }} onView={() => {}} />)
  return { props, calls }
}
test("Flow schema fixtures project and every control dispatches a catalog tag with the bound name", () => {
  for (const fixture of Object.values(fixtures)) {
    const h = mount(fixture.model)
    expect(FlowCardSchema.parse(h.props.model)).toEqual(h.props.model)
    expect(h.props.actions.map(action => action.tag)).toEqual(["flow.source", "flow.plan", "flow.run", "flow.edit"])
    expect(h.props.gestures).toEqual({})
    for (const action of h.props.actions) h.props.onAction(action.tag)
    expect(h.calls).toEqual(["flow.source", "flow.plan", "flow.run", "flow.edit"].map(tag => ({ tag, input: { name: fixture.model.name } })))
  }
})
test("system flows and members lacking command admission get no mutation control", () => {
  const model = Object.values(fixtures)[0]!.model
  const system = mount(model, true)
  expect(system.props.actions.map(action => action.tag)).toEqual(["flow.plan"])
  system.props.onAction("flow.edit")
  expect(system.calls).toEqual([])
  const member = mount(model, false, new Set(["flow.plan"]))
  expect(member.props.actions.map(action => action.tag)).toEqual(["flow.plan"])
  member.props.onAction("flow.run")
  expect(member.calls).toEqual([])
})
test("added steps compare to Active and invalid or missing projections do not render", () => {
  const h = mount({ name: "todo", source: { builtin: true }, versions: [
    { id: "a", state: "active", steps: [{ id: "check", label: "Check", added: true }] },
    { id: "b", state: "proposed", steps: [{ id: "check", label: "Check" }, { id: "review", label: "Review" }] }
  ] })
  expect(h.props.model.versions.map(version => version.steps.map(step => "added" in step ? step.added : undefined))).toEqual([[false], [false, true]])
  expect(mount(undefined).props).toBeUndefined()
  expect(() => mount({})).toThrow()
})

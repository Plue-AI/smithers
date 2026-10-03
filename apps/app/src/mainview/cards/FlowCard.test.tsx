import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { WorkflowListCardBody } from "./FlowCard"
import type { Card } from "../state/AppState"
test("flow rows lead with their human description and retain an identifier fallback", () => {
  const card: Extract<Card, { kind: "workflow-list" }> = {
    id: "flows", kind: "workflow-list", title: "Flows", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "practice:smithersai/hello-server", workflows: [
      { key: "issue/repro", description: "Research and reproduce before implementation" },
      { key: "lint", description: null },
    ] },
  }
  const html = renderToStaticMarkup(<WorkflowListCardBody card={card} onRunCommand={() => {}} />)
  expect(html).toContain("<strong>Research and reproduce before implementation</strong>")
  expect(html).toContain("<span>issue.repro</span>")
  expect(html).toContain("<strong>lint</strong>")
})

test("a pending catalog offers no launch and a failed catalog offers a source-bound Retry", () => {
  const card: Extract<Card, { kind: "workflow-list" }> = {
    id: "workflow-list-owner/repo", kind: "workflow-list", title: "Flows", status: "active", loading: true, createdAt: 1, ordinal: 1,
    payload: { repo: "owner/repo", gatewayBindingVersion: 1, workflows: [{ key: "check", description: null }],
      catalogRequest: { id: "catalog-request", owner: "owner", state: "pending" } }
  }
  const render = () => renderToStaticMarkup(<WorkflowListCardBody card={card} onRunCommand={() => {}} />)
  expect(render()).not.toContain('data-flow="flow.run"')
  card.loading = false
  card.status = "error"
  card.body = "Upstream unavailable"
  card.payload.catalogRequest!.state = "failed"
  const failed = render()
  expect(failed).toContain('role="alert"')
  expect(failed).toContain("Upstream unavailable")
  expect(failed).toContain('data-flow="flow.list"')
  expect(failed).toContain(">Retry</button>")
  expect(failed).not.toContain('data-flow="flow.run"')
})

import { FlowCardSchema, type FlowViewProps } from "@smthrs/rpc/FlowCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { fixtures } from "@smthrs/rpc/fixtures/Flow"
import { FlowCard } from "./FlowCard"

const mount = (model: FlowViewProps["model"] | undefined, system = false, allowed = new Set<CatalogTag>(["flow.source", "flow.plan", "flow.run", "flow.edit"])) => {
  let props!: FlowViewProps
  const calls: unknown[] = []
  renderToStaticMarkup(<FlowCard model={model} system={system} allowed={allowed} dispatch={(tag, input) => { calls.push({ tag, input }) }}
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
test("added steps compare to Active and missing projections do not render", () => {
  const h = mount({ name: "todo", source: { builtin: true }, versions: [
    { id: "a", state: "active", steps: [{ id: "check", label: "Check", added: true }] },
    { id: "b", state: "proposed", steps: [{ id: "check", label: "Check" }, { id: "review", label: "Review" }] }
  ] })
  expect(h.props.model.versions.map(version => version.steps.map(step => "added" in step ? step.added : undefined))).toEqual([[false], [false, true]])
  expect(mount(undefined).props).toBeUndefined()
})


test("without Active there is no added-step comparison, and failed loads preserve their error", () => {
  const h = mount({ name: "todo", source: { builtin: true }, versions: [
    { id: "bad", state: "merged-failed", error: "Cannot load review", steps: [{ id: "check", label: "Check" }] }
  ] }, false, new Set())
  expect(h.props.model.versions).toEqual([
    { id: "bad", state: "merged-failed", error: "Cannot load review", steps: [{ id: "check", label: "Check", added: false }] }
  ])
  h.props.onAction("flow.run")
  expect(h.calls).toEqual([])
})

test("the card forwards each member's view and callback without sharing selection state", () => {
  const model: FlowViewProps["model"] = { name: "todo", source: { builtin: true }, versions: [] }
  const left = { maximized: false, tab: "active" }
  const right = { maximized: true, tab: "proposed" }
  const patches: unknown[] = []
  const onView = (patch: unknown) => { patches.push(patch) }
  let props!: FlowViewProps
  const render = (view: FlowViewProps["view"]) => renderToStaticMarkup(<FlowCard model={model} system={false}
    allowed={new Set()} dispatch={() => {}} view={view} onView={onView} View={value => { props = value; return null }} />)
  render(left)
  expect(props.view).toBe(left)
  expect(props.onView).toBe(onView)
  props.onView({ tab: "proposed" })
  expect(patches).toEqual([{ tab: "proposed" }])
  render(right)
  expect(props.view).toBe(right)
  expect(left).toEqual({ maximized: false, tab: "active" })
})

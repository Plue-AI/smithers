import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import type { ProposalViewProps } from "@smthrs/rpc/ProposalCard"
import { renderProposalCard as ProposalContainer } from "./CardRenderers"
import { LiveProposalContainer } from "./ProposalContainer"
const model = { id: "check:lint@review", title: "Run lint", evidence: ["3 of the last 5"], refs: [], state: "open" }
const mount = (source: unknown = model, tags: CatalogTag[] = ["learning.accept", "learning.dismiss", "todo"]) => {
  let props!: ProposalViewProps
  const calls: unknown[] = []
  renderToStaticMarkup(<ProposalContainer model={source} allowed={new Set(tags)} dispatch={(tag, input) => { calls.push({ tag, input }) }}
    View={value => { props = value; return null }} view={{ maximized: false }} onView={() => {}} />)
  return { props, calls }
}
test("renderer binds Make TODO and Dismiss to catalog dispatch with exact note identity", () => {
  const { props, calls } = mount()
  expect(props.actions.map(action => action.label)).toEqual(["Make TODO", "Dismiss"])
  for (const action of props.actions) props.onAction(action.tag, action.args)
  expect(calls).toEqual([{ tag: "learning.accept", input: { id: "check:lint@review" } }, { tag: "learning.dismiss", input: { id: "check:lint@review" } }])
})
test("closed proposals never offer mutation; accepted proposal navigates to its TODO", () => {
  const h = mount({ ...model, state: "accepted", todo: { n: 12, title: "Run lint" } })
  expect(h.props.actions).toEqual([])
  h.props.onAction("todo", h.props.gestures.todo?.args)
  expect(h.calls).toEqual([{ tag: "todo", input: { n: 12 } }])
  expect(mount({ ...model, state: "dismissed" }).props.actions).toEqual([])
})
test("missing descriptors and unavailable projections expose no actions or fabricated data", () => {
  const h = mount(model, [])
  expect(h.props.actions).toEqual([])
  h.props.onAction("learning.accept")
  h.props.onAction("learning.dismiss")
  expect(h.calls).toEqual([])
  expect(mount(null).props).toBeUndefined()
  expect(() => mount({})).toThrow()
})
test("the live seam retains the seeded fallback until it actually serves a proposal", () => {
  expect(renderToStaticMarkup(<LiveProposalContainer id="check:lint@review" fallback={<span>Seeded proposal</span>}
    allowed={new Set()} dispatch={() => {}} view={{ maximized: false }} onView={() => {}} />)).toBe("<span>Seeded proposal</span>")
})

test("a proposals topic replaces only the matching seed and its buttons dispatch; invalid data restores the seed", async () => {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator")
  const { createRoot } = await import("react-dom/client")
  const { act } = await import("react")
  const { LiveChannel } = await import("../runtime/LiveChannel")
  GlobalRegistrator.register()
  const socket = { readyState: 1, onopen: null as (() => void) | null, onclose: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null, send() {}, close() {} }
  const channel = new LiveChannel({ socket: () => socket })
  const host = document.createElement("div")
  const root = createRoot(host)
  const calls: unknown[] = []
  try {
    await act(async () => root.render(<LiveProposalContainer id="check:lint@review" fallback={<span>Seeded proposal</span>} channel={channel}
      allowed={new Set(["learning.accept", "learning.dismiss"])} dispatch={(tag, input) => { calls.push({ tag, input }) }}
      view={{ maximized: false }} onView={() => {}} />))
    expect(host.textContent).toBe("Seeded proposal")
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: 1, cursor: 1, data: [{ ...model, id: "other" }] }) }))
    expect(host.textContent).toBe("Seeded proposal")
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: 1, cursor: 2, data: [model] }) }))
    expect(host.textContent).toContain("3 of the last 5")
    const buttons = host.querySelectorAll<HTMLButtonElement>("button[data-flow]")
    await act(async () => { for (const button of buttons) button.click() })
    expect(calls).toEqual([{ tag: "learning.accept", input: { id: "check:lint@review" } }, { tag: "learning.dismiss", input: { id: "check:lint@review" } }])
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: 1, cursor: 3, data: [{ id: model.id }] }) }))
    expect(host.textContent).toBe("Seeded proposal")
  } finally {
    await act(async () => root.unmount())
    channel.dispose()
    GlobalRegistrator.unregister()
  }
})

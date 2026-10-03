import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { fixtures } from "@smthrs/rpc/fixtures/Confirm"
import type { ConfirmViewProps } from "@smthrs/rpc/ConfirmCard"
import { ConfirmView } from "./ConfirmView"
import { confirmStories } from "./ConfirmView.stories"

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = "" })
afterAll(() => GlobalRegistrator.unregister())
function render(props: ConfirmViewProps) {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<ConfirmView {...props} />))
  return host
}
const callbacks = { onAction: () => {}, onView: () => {} }
// Literal receipts reviewed independently of the fixture action arrays.
const expectedActions = {
  one_click: [["todo.amend", { n: "12" }], ["confirm.cancel", { confirmation: "confirm-one_click", revision: "1b2c3d4" }]],
  drop: [["todo.drop", { n: "12" }], ["confirm.cancel", { confirmation: "confirm-drop", revision: "1b2c3d4" }]],
  branch: [["branch.add-to-stack", { branch: "scratch/repro" }], ["confirm.cancel", { confirmation: "confirm-branch", revision: "a1b2c3d" }]],
  flow: [["flow.edit", { name: "todo" }], ["confirm.cancel", { confirmation: "confirm-flow", revision: "v3" }]],
  agent: [["todo.new", { text: "Prefer small commits" }], ["confirm.cancel", { confirmation: "confirm-agent", revision: "e3f9a10" }]],
  wiki: [["wiki.page", { name: "Retry policy" }]],
  review_merge: [["merge.confirm", { n: "12", revision: "4bc79ae" }], ["pr", { number: "3475" }], ["confirm.cancel", { confirmation: "confirm-review_merge", revision: "4bc79ae" }]],
  stale_approval: [["pr", { number: "3475" }], ["confirm.cancel", { confirmation: "confirm-stale_approval", revision: "9e8f7a6" }]],
  reviewing: [["pr", { number: "3475" }], ["confirm.cancel", { confirmation: "confirm-reviewing", revision: "4bc79ae" }]],
  done: [], cancelled: [], expired: []
} as const
for (const key of Object.keys(expectedActions) as Array<keyof typeof expectedActions>) {
  test(`${key} forwards every literal action in order`, () => {
    const calls: unknown[] = []
    const host = render({ ...fixtures[key], ...callbacks, onAction: (tag, input) => calls.push([tag, input]) })
    act(() => { for (const button of host.querySelectorAll("button")) button.click() })
    expect(calls).toEqual(expectedActions[key])
  })
}
for (const [name, story] of Object.entries(confirmStories)) {
  test(`renders ${name}`, () => {
    const host = render({ ...story, ...callbacks })
    expect(host.querySelector("h2")).not.toBeNull()
    for (const text of story.expect) expect(host.textContent).toContain(text)
  })
}
test("approval and Cancel dispatch literal supplied bindings, never the initiating command", () => {
  const calls: unknown[] = []
  const host = render({ ...fixtures.one_click, model: { ...fixtures.one_click.model, action: { tag: "todo.drop", verb: "Amend" } }, actions: [
    { tag: "merge.confirm", label: "Amend", args: { n: "12", revision: "1b2c3d4" }, primary: true },
    { tag: "confirm.cancel", label: "Cancel", args: { confirmation: "confirm-one_click", revision: "1b2c3d4" } }
  ], onAction: (tag, input) => calls.push([tag, input]), onView: () => { throw new Error("Unexpected view patch") } })
  const buttons = host.querySelectorAll("button")
  expect(Array.from(buttons).map(button => button.dataset.flow)).toEqual(["merge.confirm", "confirm.cancel"])
  act(() => { buttons[0]!.click(); buttons[1]!.click() })
  expect(calls).toEqual([["merge.confirm", { n: "12", revision: "1b2c3d4" }], ["confirm.cancel", { confirmation: "confirm-one_click", revision: "1b2c3d4" }]])
})
test("merge binds the reviewed revision once", () => {
  const calls: unknown[] = []
  const host = render({ ...fixtures.review_merge, ...callbacks, onAction: (tag, input) => calls.push([tag, input]) })
  act(() => host.querySelector<HTMLButtonElement>('[data-flow="merge.confirm"]')!.click())
  expect(calls).toEqual([["merge.confirm", { n: "12", revision: "4bc79ae" }]])
  expect(host.textContent).toContain("rev 4bc79ae")
  expect(host.textContent).toContain("Schemas match the spec")
})
test("disabled action gives its reason and cannot dispatch", () => {
  const host = render({ ...confirmStories.disabled, ...callbacks, onAction: () => { throw new Error("Disabled dispatch") } })
  expect(host.textContent).toContain("Revision moved")
  expect(host.querySelector("button")!.disabled).toBe(true)
  act(() => host.querySelector("button")!.click())
})
test("missing approval leaves only supplied controls", () => {
  const host = render({ ...fixtures.one_click, ...callbacks, actions: [{ tag: "confirm.cancel", label: "Cancel", args: { confirmation: "confirm-one_click", revision: "1b2c3d4" } }] })
  expect(host.querySelectorAll("button").length).toBe(1)
  expect(host.querySelector("button")!.textContent).toBe("Cancel")
})
test("stale approval is distinct from an expired receipt", () => {
  const host = render({ ...fixtures.stale_approval, ...callbacks })
  expect(host.textContent).toContain("You approved 1b2c3d4. Review 9e8f7a6.")
  expect(host.textContent).toContain("Reviewed 1b2c3d4 · same change")
  expect(host.textContent).not.toContain("Expired")
})
for (const [key, text] of [["done", "Amended T12"], ["cancelled", "Cancelled"], ["expired", "Expired"]] as const) {
  test(`${key} receipt has no supplied controls`, () => {
    const host = render({ ...fixtures[key], ...callbacks })
    expect(host.textContent).toContain(text)
    expect(host.querySelectorAll("button").length).toBe(0)
  })
}
test("hostile command text stays exact, inert text", () => {
  const host = render({ ...fixtures.one_click, ...callbacks, model: { ...fixtures.one_click.model, text: '<script>alert("x")</script>\n$(touch /tmp/no)' } })
  expect(host.querySelector(".confirm-text")!.textContent).toBe('<script>alert("x")</script>\n$(touch /tmp/no)')
  expect(host.querySelector("script")).toBeNull()
})

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { fixtures } from "@smthrs/rpc/fixtures/Draft"
import type { DraftViewProps } from "@smthrs/rpc/DraftCard"
import config from "../../../../playwright.config"
import { DraftView } from "./DraftView"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root
const calls: unknown[] = []
function render(props: Partial<DraftViewProps> = {}) {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<DraftView {...fixtures.append} onAction={(...args) => calls.push(args)} onView={() => { throw new Error("Unexpected view patch") }} {...props} />))
  return host
}
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; calls.length = 0 })
afterAll(() => GlobalRegistrator.unregister())
const blur = (element: HTMLElement) => act(() => element.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
const change = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => act(() => {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value)
  element.dispatchEvent(new Event("input", { bubbles: true }))
  element.dispatchEvent(new Event("change", { bubbles: true }))
})
const press = (element: HTMLElement) => act(() => element.click())

for (const [name, fixture] of Object.entries(fixtures)) {
  test(`Draft fixture ${name} renders`, () => {
    const host = render(fixture)
    for (const expected of fixture.expect) {
      const contents = host.textContent + Array.from(host.querySelectorAll("input,textarea")).map(element => (element as HTMLInputElement).value).join(" ")
      expect(contents).toContain(expected)
    }
    expect(host.querySelector(".draft-private") !== null).toBe(!fixture.model.committed && fixture.model.private)
  })
}
test("local fields encode at render and forward bound arguments", () => {
  const host = render({ model: { ...fixtures.issue_fixes.model, place: { mode: "append", options: [{ n: 12, title: "Keep edits", state: "queued" }] } } })
  const title = host.querySelector<HTMLInputElement>(".draft-field input")!
  change(title, "  Literal title  "); blur(title)
  const [prompt, acceptance] = host.querySelectorAll<HTMLTextAreaElement>("textarea")
  change(prompt!, "Literal\nprompt"); blur(prompt!)
  change(acceptance!, "passes checks\nkeeps edits"); blur(acceptance!)
  const place = host.querySelector("select")!
  change(place, '{"mode":"before","n":12}'); blur(place)
  change(place, '{"mode":"amend","n":12}'); blur(place)
  change(place, '{"mode":"append"}'); blur(place)
  const fixes = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  press(fixes); blur(fixes)
  press(fixes); blur(fixes)
  expect(calls).toEqual([
    ["form.set", { entry: "entry-draft-1", field: "title", value: "  Literal title  " }],
    ["form.set", { entry: "entry-draft-1", field: "prompt", value: "Literal\nprompt" }],
    ["form.set", { entry: "entry-draft-1", field: "acceptance", value: '["passes checks","keeps edits"]' }],
    ["form.set", { entry: "entry-draft-1", field: "place", value: '{"mode":"before","n":12}' }],
    ["form.set", { entry: "entry-draft-1", field: "place", value: '{"mode":"amend","n":12}' }],
    ["form.set", { entry: "entry-draft-1", field: "place", value: '{"mode":"append"}' }],
    ["form.set", { entry: "entry-draft-1", field: "fixes", value: "false" }],
    ["form.set", { entry: "entry-draft-1", field: "fixes", value: "true" }]
  ])
})
test("Commit forwards full supplied input once; Discard only deletes Draft", () => {
  const host = render({ actions: [
    { tag: "todo.new", label: "Commit", primary: true, args: { title: "Keep edits", prompt: "Implement", acceptance: '["passes"]', place: '{"mode":"append"}', issue: "42", fixes: "true", seed: '["a.ts"]' } },
    { tag: "draft.discard", label: "Discard", args: { draft: "entry-draft-1" } }
  ] })
  press(host.querySelector('[data-flow="todo.new"]')!)
  press(host.querySelector('[data-flow="draft.discard"]')!)
  expect(calls).toEqual([
    ["todo.new", { title: "Keep edits", prompt: "Implement", acceptance: '["passes"]', place: '{"mode":"append"}', issue: "42", fixes: "true", seed: '["a.ts"]' }],
    ["draft.discard", { draft: "entry-draft-1" }]
  ])
  expect(Array.from(host.querySelectorAll("button")).map(button => button.dataset.flow)).toEqual(["todo.new", "draft.discard"])
})
test("missing Commit and gesture create no authority", () => {
  const host = render({ actions: [{ tag: "draft.discard", label: "Discard", args: { draft: "entry-draft-1" } }], gestures: {} })
  expect(host.querySelector('[data-flow="todo.new"]')).toBeNull()
  expect(host.querySelector("input")!.readOnly).toBe(true)
  blur(host.querySelector("input")!)
  expect(calls).toEqual([])
})
test("disabled actions and gestures show reasons and never dispatch", () => {
  const host = render({ ...fixtures.empty_stack, gestures: { set: { tag: "form.set", label: "Edit", disabled: { reason: "Draft is read-only" } } } })
  expect(host.textContent).toContain("Add a title")
  expect(host.textContent).toContain("Draft is read-only")
  press(host.querySelector('[data-flow="todo.new"]')!)
  blur(host.querySelector("input")!)
  expect(calls).toEqual([])
})
test("committed amendment has +1 and seed remains data only", () => {
  const host = render(fixtures.committed_amendment)
  expect(host.textContent).toContain("Committed as T9")
  expect(host.textContent).toContain("+1")
  expect(host.querySelector("input")).toBeNull()
  act(() => root.render(<DraftView {...fixtures.seed} onAction={(...args) => calls.push(args)} onView={() => {}} />))
  expect(host.querySelector(".draft-seed")!.textContent).toContain("Read-only")
  expect(host.querySelectorAll(".draft-seed button").length).toBe(0)
  expect(calls).toEqual([])
})

test("empty acceptance clears; amendment forwards its bound item", () => {
  const host = render(fixtures.amend)
  const acceptance = host.querySelectorAll<HTMLTextAreaElement>("textarea")[1]!
  change(acceptance, ""); blur(acceptance)
  press(host.querySelector('[data-flow="todo.amend"]')!)
  expect(calls).toEqual([
    ["form.set", { entry: "entry-draft-1", field: "acceptance", value: "[]" }],
    ["todo.amend", { n: "9" }]
  ])
})
test("hostile seed text is literal, with no executable surface", () => {
  const host = render({ model: { ...fixtures.seed.model, seed: { files: ['<script>alert("seed")</script>'] } } })
  expect(host.querySelector(".draft-seed")!.textContent).toContain('<script>alert("seed")</script>')
  expect(host.querySelector("script")).toBeNull()
})

test("unavailable placement stays selected and focus/blur never appends", () => {
  for (const mode of ["before", "amend"] as const) {
    const host = render({ model: { ...fixtures.append.model, place: { mode, n: 99, options: [] } } })
    const select = host.querySelector("select")!
    expect(select.selectedOptions[0]!.textContent).toBe(`${mode === "before" ? "Before" : "Amend"} T99 (unavailable)`)
    expect(select.value).toBe(JSON.stringify({ mode, n: 99 }))
    act(() => select.focus()); blur(select)
    expect(calls).toEqual([])
    act(() => root.unmount()); host.remove(); root = undefined!
  }
})
test("checkbox and select dispatch once on change without focus or blur", () => {
  const host = render(fixtures.issue_fixes)
  const fixes = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  const initial = fixes.checked
  press(fixes)
  expect(calls).toEqual([["form.set", { entry: "entry-draft-1", field: "fixes", value: String(!initial) }]])
  blur(fixes)
  expect(calls.length).toBe(1)
  change(host.querySelector("select")!, '{"mode":"append"}')
  expect(calls[1]).toEqual(["form.set", { entry: "entry-draft-1", field: "place", value: '{"mode":"append"}' }])
  expect(calls.length).toBe(2)
})
test("Commit has no unsupported Enter hint", () => {
  const host = render()
  expect(host.querySelector('[data-flow="todo.new"]')!.textContent).toBe("Commit")
})
test("committed receipt has no unsupported link hint", () => {
  const host = render(fixtures.committed)
  expect(host.querySelector(".draft-receipt")!.textContent).not.toContain("↗")
})
test("main browser tier excludes the isolated Draft stories", () => {
  expect(config.testIgnore).toContain("**/draft-view-stories.spec.ts")
})

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { fixtures } from "@smthrs/rpc/fixtures/Draft"
import type { DraftViewProps } from "@smthrs/rpc/DraftCard"
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
test("blur sends literal string fields and bound arguments", () => {
  const host = render({ model: { ...fixtures.issue_fixes.model, place: { mode: "append", options: [{ n: 12, title: "Keep edits", state: "queued" }] } } })
  const title = host.querySelector<HTMLInputElement>(".draft-field input")!
  title.value = "  Literal title  "; blur(title)
  const [prompt, acceptance] = host.querySelectorAll<HTMLTextAreaElement>("textarea")
  prompt!.value = "Literal\nprompt"; blur(prompt!)
  acceptance!.value = "passes checks\nkeeps edits"; blur(acceptance!)
  const place = host.querySelector("select")!
  place.value = "before:12"; blur(place)
  place.value = "amend:12"; blur(place)
  place.value = "append"; blur(place)
  const fixes = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  fixes.checked = true; blur(fixes)
  fixes.checked = false; blur(fixes)
  expect(calls).toEqual([
    ["form.set", { entry: "entry-draft-1", field: "title", value: "  Literal title  " }],
    ["form.set", { entry: "entry-draft-1", field: "prompt", value: "Literal\nprompt" }],
    ["form.set", { entry: "entry-draft-1", field: "acceptance", value: '["passes checks","keeps edits"]' }],
    ["form.set", { entry: "entry-draft-1", field: "place", value: '{"mode":"before","n":12}' }],
    ["form.set", { entry: "entry-draft-1", field: "place", value: '{"mode":"amend","n":12}' }],
    ["form.set", { entry: "entry-draft-1", field: "place", value: '{"mode":"append"}' }],
    ["form.set", { entry: "entry-draft-1", field: "fixes", value: "true" }],
    ["form.set", { entry: "entry-draft-1", field: "fixes", value: "false" }]
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
  expect(host.textContent).toContain("Committed as T9 ↗")
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
  acceptance.value = ""; blur(acceptance)
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

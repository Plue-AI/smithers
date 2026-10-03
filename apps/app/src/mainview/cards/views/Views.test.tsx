import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Glob } from "bun"
import { createRoot } from "react-dom/client"
import { act } from "react"
import { readFileSync } from "node:fs"
import type { StoryModule, ViewStory } from "./stories"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterAll(() => GlobalRegistrator.unregister())
let consoleError: ReturnType<typeof spyOn>
beforeEach(() => { consoleError = spyOn(console, "error").mockImplementation(() => {}) })
afterEach(() => {
  const calls = [...consoleError.mock.calls]
  consoleError.mockRestore()
  expect(calls).toEqual([])
})
const paths = [...new Glob("*View.stories.tsx").scanSync({ cwd: import.meta.dir })].sort()
if (!paths.length) throw new Error("No View stories discovered")

async function mounted(story: ViewStory, removed = false) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const onAction = mock((_tag: string, _args?: Record<string, string>) => {})
  const onView = mock((_patch: Record<string, unknown>) => {})
  await act(async () => root.render(story.render({ onAction, onView }, removed ? story.actions?.slice(1) : story.actions)))
  return { host, onAction, onView, close: async () => { await act(async () => root.unmount()); host.remove() } }
}
for (const path of paths) {
  const { stories } = await import(new URL(path, import.meta.url).href) as StoryModule
  if (!stories?.length) throw new Error(`${path} exports no stories`)
  for (const story of stories) for (const theme of ["light", "dark"]) {
    test(`${path}/${story.name} ${theme} DOM`, async () => {
      document.documentElement.dataset.theme = theme
      const mountedStory = await mounted(story)
      const { host, onAction, onView } = mountedStory
      try {
        if (story.name.startsWith("state-")) expect(host.textContent).toBe(story.expect[0])
        for (const text of story.expect) {
          if (story.name.startsWith("actor-")) {
            const chips = host.querySelectorAll(".mvp-avatar"); expect(chips.length).toBeGreaterThan(0)
            for (const chip of chips) expect(story.name === "actor-fixture-system" ? chip.getAttribute("data-kind") : chip.getAttribute("aria-label")).toContain(text)
          } else expect(host.textContent).toContain(text)
        }
        const interactions = story.interactions ?? []
        const gestureControls = new Set(interactions.filter(item => item.gesture).map(item => host.querySelector(item.selector)))
        const controls = [...host.querySelectorAll<HTMLButtonElement>("[data-flow]")].filter(control => !gestureControls.has(control))
        const actions = story.actions ?? []
        expect(controls.map(control => control.dataset.flow)).toEqual(actions.map(action => action.tag))
        for (let index = 0; index < actions.length; index++) {
          const action = actions[index]!, control = controls[index]!
          expect(control.textContent || control.getAttribute("aria-label")).toContain(action.label)
          onAction.mockClear(); onView.mockClear()
          if (action.disabled) {
            expect(control.disabled).toBe(true)
            expect(host.textContent).toContain(action.disabled.reason)
          }
          await act(async () => control.click())
          expect(onView).toHaveBeenCalledTimes(0)
          if (action.disabled) expect(onAction).toHaveBeenCalledTimes(0)
          else {
            expect(onAction).toHaveBeenCalledTimes(1)
            expect(onAction.mock.calls[0]).toEqual([action.tag, action.args ?? {}])
          }
        }
        const covered = new Set(controls)
        for (const interaction of interactions) {
          const control = host.querySelector<HTMLElement>(interaction.selector)
          expect(control).not.toBeNull()
          covered.add(control as HTMLButtonElement)
          onAction.mockClear(); onView.mockClear()
          const gesture = interaction.gesture ? story.gestures?.[interaction.gesture] : undefined
          const expectedAction = interaction.action ?? (gesture ? { tag: gesture.tag, args: gesture.args ?? {} } : undefined)
          await act(async () => {
            if (interaction.value !== undefined) {
              const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
              Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, interaction.value)
            }
            control!.dispatchEvent(interaction.event === "keydown"
              ? new KeyboardEvent("keydown", { key: interaction.key, bubbles: true })
              : new Event(interaction.event ?? "click", { bubbles: true }))
          })
          expect(onAction).toHaveBeenCalledTimes(expectedAction ? 1 : 0)
          expect(onView).toHaveBeenCalledTimes(interaction.patch ? 1 : 0)
          if (expectedAction) expect(onAction.mock.calls[0]).toEqual([expectedAction.tag, expectedAction.args])
          if (interaction.patch) expect(onView.mock.calls[0]).toEqual([interaction.patch])
        }
        for (const gesture of Object.keys(story.gestures ?? {})) {
          expect(interactions.filter(interaction => interaction.gesture === gesture)).toHaveLength(1)
        }
        // Every local/view control needs a declared interaction and callback expectation.
        for (const control of host.querySelectorAll("button, input, select, textarea, [role=button]")) {
          expect(covered.has(control as HTMLButtonElement)).toBe(true)
        }
      } finally { await mountedStory.close() }
      if (story.actions?.length) {
        const removed = await mounted(story, true)
        try { expect([...removed.host.querySelectorAll<HTMLElement>("[data-flow]")].filter(control => !(story.interactions ?? []).some(item => item.gesture && control.matches(item.selector))).map(control => control.dataset.flow)).toEqual(story.actions.slice(1).map(action => action.tag)) }
        finally { await removed.close() }
      }
    })
  }
}

// Assert independent status mappings in both themes; no test reads design specs.
for (const theme of ["light", "dark"]) test(`Paper tone mappings ${theme}`, () => {
  document.documentElement.dataset.theme = theme
  const css = document.createElement("style")
  css.textContent = readFileSync(new URL("../../styles/tokens.css", import.meta.url), "utf8") + readFileSync(new URL("../../styles/views/primitives.css", import.meta.url), "utf8")
  document.head.append(css)
  try {
    for (const [tone, token] of [["live", "--brand"], ["attention", "--attention"], ["failed", "--danger"], ["done", "--text-muted"], ["quiet", "--text-muted"]]) {
      const node = document.createElement("span")
      node.dataset.tone = tone
      document.body.append(node)
      expect(getComputedStyle(node).getPropertyValue("--tone").trim()).toBe(getComputedStyle(document.documentElement).getPropertyValue(token).trim())
      node.remove()
    }
  } finally { css.remove() }
})

for (const styleCase of ["starting", "in_review", "merged", "harness"]) test(`primitive style ${styleCase}`, () => {
  const css = document.createElement("style")
  css.textContent = readFileSync(new URL("../../styles/tokens.css", import.meta.url), "utf8") + readFileSync(new URL("../../styles/views/primitives.css", import.meta.url), "utf8")
  if (styleCase === "harness") css.textContent += readFileSync(new URL("./view-stories.css", import.meta.url), "utf8")
  document.head.append(css)
  const state = document.createElement("span")
  state.className = "mvp-state"
  state.dataset.state = styleCase
  const node = document.createElement("span")
  state.append(node)
  document.body.append(state)
  try {
    node.className = styleCase === "starting" ? "mvp-dot" : styleCase === "harness" ? "view-story" : "mvp-glyph"
    node.dataset.state = styleCase
    if (styleCase === "starting") expect(getComputedStyle(node).animation).toContain("mvp-blink")
    else if (styleCase === "harness") {
      expect(getComputedStyle(node).maxWidth).toBe("900px")
      expect(getComputedStyle(node).boxSizing).toBe("border-box")
      expect(getComputedStyle(node).padding).toBe("24px")
      expect(getComputedStyle(node).margin).toBe("24px auto")
    }
    else expect(getComputedStyle(node).color).toBe(getComputedStyle(document.documentElement).getPropertyValue(styleCase === "merged" ? "--text-faint" : "--text-muted").trim())
  } finally { state.remove(); css.remove() }
})

import { fixtures } from "@smthrs/rpc/fixtures/Confirm"
import type { ConfirmViewProps } from "@smthrs/rpc/ConfirmCard"
import { ConfirmView } from "./ConfirmView"
import { actorName } from "./ActorChip"
import { confirmStories } from "./ConfirmView.stories"

describe("ConfirmView named cases", () => {
let root: ReturnType<typeof createRoot> | undefined
let confirmHost: HTMLElement | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; confirmHost?.remove(); confirmHost = undefined })
function render(props: ConfirmViewProps) {
  const host = document.createElement("div")
  document.body.append(host)
  confirmHost = host
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
    expect(calls).toEqual([...expectedActions[key]])
  })
}
for (const [name, story] of Object.entries(confirmStories)) {
  test(`renders ${name}`, () => {
    const host = render({ ...story, ...callbacks })
    expect(host.querySelector("h2")).not.toBeNull()
    for (const text of story.expect) expect(host.textContent).toContain(text)
    if (story.model.kind === "one_click" && !story.model.receipt) {
      const label = actorName(story.model.asked_by)
      expect(host.querySelector(".mvp-avatar")?.getAttribute("aria-label")).toBe(label)
      expect(host.querySelector(".confirm-asker")?.textContent).toContain(label)
    }
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

})

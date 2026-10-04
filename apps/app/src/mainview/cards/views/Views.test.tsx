import type { Action } from "@smthrs/rpc/CardAction"
import { stories as secretsStories } from "./SecretsView.stories"
import { SecretsView } from "./SecretsView"
import type { SecretsViewProps } from "@smthrs/rpc/SecretsCard"
import { BranchView } from "./BranchView"
import { fixtures as branchFixtures } from "@smthrs/rpc/fixtures/Branch"
import { TerminalView } from "./TerminalView"
import { terminalSlot } from "../TerminalCard"
import { fixtures as terminalFixtures } from "@smthrs/rpc/fixtures/Terminal"
import { stories as terminalStories } from "./TerminalView.stories"
import { createRoot } from "./testDom"
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Glob } from "bun"

import { act } from "react"
import { readFileSync } from "node:fs"
import type { StoryModule, ViewStory } from "./stories"

let consoleError: ReturnType<typeof spyOn>
beforeEach(() => { consoleError = spyOn(console, "error").mockImplementation(() => {}) })
afterEach(() => {
  const calls = [...consoleError.mock.calls]
  consoleError.mockRestore()
  expect(calls).toEqual([])
})
const paths = [...new Glob("*.stories.tsx").scanSync({ cwd: import.meta.dir })].sort()
if (!paths.length) throw new Error("No View stories discovered")

async function mounted(story: ViewStory, removed = false) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const onAction = mock((_tag: string, _args?: Record<string, string>) => {})
  const onView = mock((_patch: Record<string, unknown>) => {})
  await act(async () => root.render(story.render({ onAction, onView }, removed ? story.actions?.slice(1) : undefined)))
  return { host, root, onAction, onView, close: async () => { await act(async () => root.unmount()); host.remove() } }
}
for (const path of paths) {
  const { stories } = await import(new URL(path, import.meta.url).href) as StoryModule
  if (!stories?.length) throw new Error(`${path} exports no stories`)
  for (const story of stories) for (const theme of ["light", "dark"]) {
    test(`${path}/${story.name} ${theme} DOM`, async () => {
      document.documentElement.dataset.theme = theme
      const mountedStory = await (path === "TerminalView.stories.tsx" ? mountedTerminal(story) : mounted(story))
      const { host, onAction, onView } = mountedStory
      try {
        // Pierre renders asynchronously into a shadow root; read the production surface.
        if (path === "DiffSurface.stories.tsx" && host.querySelector("diffs-container")) {
          const deadline = Date.now() + 4000
          while (!host.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-column-number]") && Date.now() < deadline) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
        }
        if (story.name.startsWith("state-")) expect(host.textContent).toBe(story.expect[0])
        // T-UI-10 / C-UI-12: fixture copy spans locally selected versions.
        const displays = [host.textContent]
        if (path.endsWith("FlowView.stories.tsx")) {
          for (const button of host.querySelectorAll<HTMLButtonElement>(".mvp-version")) {
            await act(async () => button.click())
            displays.push(host.textContent)
          }
          expect(onAction).toHaveBeenCalledTimes(0)
          expect(onView).toHaveBeenCalledTimes(0)
        }
        for (const text of story.expect) {
          if (story.name.startsWith("actor-")) {
            const chips = host.querySelectorAll(".mvp-avatar"); expect(chips.length).toBeGreaterThan(0)
            for (const chip of chips) expect(story.name === "actor-fixture-system" ? chip.getAttribute("data-kind") : chip.getAttribute("aria-label")).toContain(text)
          } else expect([...displays, host.querySelector("diffs-container")?.shadowRoot?.textContent ?? "", ...[...host.querySelectorAll<HTMLInputElement>("input:not([type=password]),textarea")].map(input => input.value)].join("\n")).toContain(text)
        }
        // Layout and virtualized hunk controls are covered by the production Chromium stories.
        if (story.interactionSuite === "TODO") {
          const fixture = todoStories[story.name as keyof typeof todoStories]
          const supplied = [...fixture.actions, ...fixture.model.waits.flatMap(wait => wait.actions)]
          for (const button of host.querySelectorAll<HTMLButtonElement>("button[data-flow]")) {
            const action = supplied.find(action => action.tag === button.dataset.flow && action.label === button.textContent)
            expect(action).toBeDefined()
            const inputArgs: Record<string, string> = {}
            const form = button.closest("form")
            await act(async () => {
              for (const field of form?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select") ?? []) {
                const definition = action!.input!.find(input => input.label === field.getAttribute("aria-label"))!
                const value = definition.value ?? (definition.kind === "choice" ? definition.choices![0]! : "Fixture input")
                inputArgs[definition.name] = value
                const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
                Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value)
                field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }))
              }
            })
            onAction.mockClear(); onView.mockClear()
            await act(async () => {
              if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
              else button.click()
            })
            expect(onAction.mock.calls).toEqual([[action!.tag, { ...action!.args, ...inputArgs }]])
            expect(onView).toHaveBeenCalledTimes(0)
          }
          return
        }
        if (path === "SetupView.stories.tsx" || path === "SettingsView.stories.tsx") {
          // Form actions project one submit or two stepper controls, with draft fields.
          const fixture = Object.values(path.startsWith("Setup") ? { ...setup, ...personOnlyFixtures } : settings).find(item => item.name === story.name)!
          const supplied = ([...(fixture.model.this_mac.capacity === 0 && fixture.model.this_mac.limit ? [fixture.model.this_mac.limit.fix] : []), ...fixture.actions] as import("@smthrs/rpc/CardAction").Action[]).map(action => ({ ...action, input: action.input?.map(field => ({ ...field })) }))
          if (path === "SettingsView.stories.tsx") {
            const order = ["machine", "address", "fast", "coding", "jev", "capacity", "parallel", "todo_daily_admissions", "health", "notifications", "obsidian"]
            const rank = (action: import("@smthrs/rpc/CardAction").Action) => order.indexOf(action.tag === "github" ? "health" : action.tag === "docs" ? "notifications" : action.args?.role ?? action.args?.field ?? action.args?.step ?? "")
            supplied.sort((a, b) => rank(a) - rank(b))
            for (const action of supplied) for (const field of action.input ?? []) {
              const model = fixture.model as import("@smthrs/rpc/SettingsCard").SettingsCard
              const value = action.args?.field === "capacity" ? model.capacity : action.args?.field === "parallel" ? model.parallel : action.args?.field === "todo_daily_admissions" ? model.todo_daily_admissions : action.args?.field === "obsidian" ? model.obsidian?.path : undefined
              if (value !== undefined) field.value = String(value)
            }
            expect(host.textContent).not.toMatch(/jev/i)
            for (const element of host.querySelectorAll("*")) for (const attribute of element.attributes) expect(attribute.value).not.toMatch(/jev/i)
          }
          const forms = [...host.querySelectorAll<HTMLFormElement>("form[data-flow]")]
          expect(forms.map(form => form.dataset.flow)).toEqual(supplied.map(action => action.tag))
          for (const [index, form] of forms.entries()) {
            const action = supplied[index]!
            const values = Object.fromEntries((action.input ?? []).map(field => [field.name, field.value ?? field.choices?.[0] ?? ""]))
            const buttons = [...form.querySelectorAll<HTMLButtonElement>("button")]
            for (const button of buttons) expect(button.disabled).toBe(!!action.disabled)
            if (action.disabled) expect(form.textContent).toContain(action.disabled.reason)
            for (const button of buttons) {
              onAction.mockClear()
              await act(async () => action.disabled ? button.click() : button.type === "submit"
                ? form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
                : button.click())
              expect(onAction).toHaveBeenCalledTimes(action.disabled ? 0 : 1)
              if (!action.disabled) expect(onAction.mock.calls[0]?.[0]).toBe(action.tag)
              if (!action.disabled && button.type === "submit") expect(onAction.mock.calls[0]).toEqual([action.tag, { ...action.args, ...values }])
            }
          }
          return
        }
        if (path === "BranchView.stories.tsx") {
          for (const tab of host.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
            onAction.mockClear(); onView.mockClear()
            await act(async () => tab.click())
            expect(onView.mock.calls).toEqual([[{ tab: tab.dataset.tab }]])
            expect(onAction).toHaveBeenCalledTimes(0)
          }
          expect(host.querySelectorAll('[aria-label="Copy SSH line"]')).toHaveLength(1)
          const controls = [...host.querySelectorAll<HTMLElement>(".branch-actions > [data-flow], .branch-actions .flow-control > button")]
          expect(controls.map(control => control.dataset.flow)).toEqual(story.actions!.map(action => action.tag))
          for (const [index, control] of controls.entries()) {
            const action = story.actions![index]! as Action
            const values = Object.fromEntries((action.input ?? []).map(field => [field.name, field.value ?? field.choices?.[0] ?? "Fixture input"]))
            await act(async () => {
              for (const field of control.querySelectorAll<HTMLInputElement>("input")) {
                const definition = action.input!.find(input => input.label === field.getAttribute("aria-label"))!
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, values[definition.name])
                field.dispatchEvent(new Event("input", { bubbles: true }))
              }
            })
            onAction.mockClear(); onView.mockClear()
            const button = control instanceof HTMLButtonElement ? control : control.querySelector<HTMLButtonElement>("button")!
            expect(button.disabled).toBe(!!action.disabled)
            if (action.disabled) expect(host.textContent).toContain(action.disabled.reason)
            await act(async () => {
              if (action.disabled || control instanceof HTMLButtonElement) button.click()
              else control.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
            })
            expect(onAction.mock.calls).toEqual(action.disabled ? [] : [[action.tag, { ...action.args, ...values }]])
            expect(onView).toHaveBeenCalledTimes(0)
          }
          return
        }
        if (path === "SecretsView.stories.tsx") return // Literal write-only interaction cases below.
        const interactions = story.interactions ?? []
        const gestureControls = new Set(interactions.filter(item => item.gesture).map(item => host.querySelector(item.selector)))
        const controls = [...host.querySelectorAll<HTMLButtonElement>("button[data-flow]")].filter(control => !gestureControls.has(control))
        const actions = story.actions ?? []
        expect(controls.map(control => control.dataset.flow)).toEqual(actions.map(action => action.tag))
        for (let index = 0; index < actions.length; index++) {
          const action = actions[index]!, control = controls[index]!
          expect(control.getAttribute("aria-label") || control.textContent).toContain(action.label)
          onAction.mockClear(); onView.mockClear()
          if (action.disabled) {
            expect(control.disabled).toBe(true)
            expect(host.textContent).toContain(action.disabled.reason)
          }
          const form = control.closest("form.setup-action")
          const inputArgs: Record<string, string> = {}
          await act(async () => {
            for (const field of form?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea") ?? []) {
              const name = field.id.split("-").at(-1)!
              const value = field.tagName === "TEXTAREA" ? '{"capacity":2}' : "12"
              inputArgs[name] = value
              Object.getOwnPropertyDescriptor(field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(field, value)
              field.dispatchEvent(new Event("input", { bubbles: true }))
              field.dispatchEvent(new Event("change", { bubbles: true }))
            }
          })
          await act(async () => control.click())
          expect(onView).toHaveBeenCalledTimes(0)
          if (action.disabled) expect(onAction).toHaveBeenCalledTimes(0)
          else {
            expect(onAction).toHaveBeenCalledTimes(1)
            expect(onAction.mock.calls[0]).toEqual([action.tag, { ...action.args, ...inputArgs }])
          }
        }
        const covered = new Set<Element>(controls)
        for (const control of controls) for (const field of control.closest("form")?.querySelectorAll("input,textarea") ?? []) covered.add(field)
        for (const interaction of interactions) {
          const control = host.querySelector<HTMLElement>(interaction.selector)
          expect(control).not.toBeNull()
          covered.add(control as HTMLButtonElement)
          onAction.mockClear(); onView.mockClear()
          const gesture = interaction.gesture ? story.gestures?.[interaction.gesture] : undefined
          const expectedAction = interaction.action === null ? undefined : interaction.action ?? (gesture ? { tag: gesture.tag, args: gesture.args ?? {} } : undefined)
          await act(async () => {
            if (interaction.value !== undefined) {
              const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
              Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, interaction.value)
            }
            if (!interaction.event || interaction.event === "click") control!.click()
            else control!.dispatchEvent(interaction.event === "keydown"
              ? new KeyboardEvent("keydown", { key: interaction.key, ctrlKey: interaction.gesture === "hover", bubbles: true })
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
        try { expect([...removed.host.querySelectorAll<HTMLElement>("button[data-flow]")].filter(control => !(story.interactions ?? []).some(item => item.gesture && control.matches(item.selector))).map(control => control.dataset.flow)).toEqual(story.actions.slice(1).map(action => action.tag)) }
        finally { await removed.close() }
      }
    })
  }
}

// Assert independent status mappings in both themes; no test reads design specs.
for (const theme of ["light", "dark"]) test(`Paper tone mappings ${theme}`, () => {
  document.documentElement.dataset.theme = theme
  const css = document.createElement("style")
  css.textContent = readFileSync(new URL("../../styles/tokens.css", import.meta.url), "utf8") + readFileSync(new URL("../../styles/cards.css", import.meta.url), "utf8")
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
  css.textContent = readFileSync(new URL("../../styles/tokens.css", import.meta.url), "utf8") + readFileSync(new URL("../../styles/cards.css", import.meta.url), "utf8")
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
import { TodoView } from "./TodoView";
import { todoStories } from "./TodoView.stories";
function mount(story = todoStories.needs_you) {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const calls: unknown[] = [];
  act(() => root.render(<TodoView {...story} onAction={(...args) => calls.push(args)} onView={() => {}} />));
  return {
    element,
    calls,
    rerender: (next: typeof story) =>
      act(() => root.render(<TodoView {...next} onAction={(...args) => calls.push(args)} onView={() => {}} />)),
    close: () => {
      act(() => root.unmount());
      element.remove();
    },
  };
}
for (const [name, story] of Object.entries(todoStories))
  test(`renders ${name}`, () => {
    const view = mount(story);
    for (const text of story.expect) expect(view.element.textContent?.toLowerCase()).toContain(text.toLowerCase());
    view.close();
  });
test("Answer preserves bound wait and typed input", () => {
  const view = mount();
  const input = view.element.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Yes, optional");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() =>
    view.element.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(view.calls).toEqual([["todo.answer", { n: "12", wait: "wait-question-1", answer: "Yes, optional" }]]);
  view.close();
});
test("two wait rows keep independent actions", () => {
  const view = mount(todoStories.question_moved_off);
  expect([...view.element.querySelectorAll("[data-wait-id]")].map((row) => row.getAttribute("data-wait-id"))).toEqual([
    "wait-question-1",
    "wait-moved-off-1",
  ]);
  act(() => (view.element.querySelector('[data-flow="todo.keep-moved"]') as HTMLButtonElement).click());
  expect(view.calls).toEqual([["todo.keep-moved", { n: "12" }]]);
  view.close();
});
test("Merge is one supplied action; removal leaves the same readiness", () => {
  const view = mount(todoStories.in_review);
  act(() => (view.element.querySelector('[data-flow="merge"]') as HTMLButtonElement).click());
  expect(view.calls).toEqual([["merge", { n: "12" }]]);
  view.close();
  const removed = mount({ ...todoStories.in_review, actions: [] });
  expect(removed.element.querySelector('[data-flow="merge"]')).toBeNull();
  expect(removed.element.textContent).toContain("Ready · a maintainer merges");
  removed.close();
});
test("disabled Merge is text and cannot dispatch", () => {
  const view = mount(todoStories.draft_pr);
  expect(view.element.querySelector('[data-flow="merge"]')).toBeNull();
  expect(view.element.textContent).toContain("Waiting for T8");
  expect(view.calls).toEqual([]);
  view.close();
});

test("late answer keeps the question draft as Send as steer", () => {
  const view = mount();
  const input = view.element.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "My late answer");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  view.rerender(todoStories.late_answer);
  expect(view.element.textContent).toContain("Ben answered");
  expect(view.element.querySelector("textarea")!.value).toBe("My late answer");
  act(() =>
    view.element.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(view.calls).toEqual([["todo.steer", { n: "12", text: "My late answer" }]]);
  view.close();
});
for (const [name, tag, label, args] of [
  ["failed", "todo.retry", "Retry", { n: "12" }],
  ["failed", "todo.retry-current-flow", "Retry with the current flow", { n: "12" }],
  ["owner_removed", "todo.takeover", "Take over", { n: "12" }],
  ["paused", "todo.resume", "Resume", { n: "12" }],
] as const)
  test(`supplied ${label} dispatches once and removal removes it`, () => {
    const story = todoStories[name];
    const view = mount(story);
    act(() => (view.element.querySelector(`[data-flow="${tag}"]`) as HTMLButtonElement).click());
    expect(view.calls).toEqual([[tag, args]]);
    view.close();
    const removed = mount({ ...story, actions: story.actions.filter((action) => action.tag !== tag) });
    expect(removed.element.querySelector(`[data-flow="${tag}"]`)).toBeNull();
    removed.close();
  });
test("approval carries its wait and choice", () => {
  const view = mount(todoStories.approval);
  act(() => {
    const select = view.element.querySelector("select")!;
    select.value = "Approve";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() =>
    view.element.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(view.calls).toEqual([["todo.answer", { n: "12", wait: "wait-approval-1", answer: "Approve" }]]);
  view.close();
});

for (const [name, tag, label, args] of [
  ["queued", "todo.drop", "Drop", { n: "12" }],
  ["working", "todo.stop", "Stop", { n: "12" }],
  ["working", "run.inspect", "Inspect", { id: "run-41" }],
  ["working", "branch", "Open branch", { name: "todo/12" }],
  ["rebase_pending", "branch.rebase-now", "Rebase now", { branch: "todo/12" }],
  ["blocked_on_github", "pr", "Open PR", { number: "3475" }],
  ["moved_off", "todo.return-to-item", "Return to T12", { n: "12" }],
  [
    "foreign_push",
    "branch.bring-in",
    "Bring in",
    { branch: "todo/12", revision: "4bc79aef91d66ea28c90b706d584d3b9b48e14ea" },
  ],
  [
    "foreign_push",
    "branch.discard-foreign",
    "Discard",
    { branch: "todo/12", revision: "4bc79aef91d66ea28c90b706d584d3b9b48e14ea" },
  ],
] as const)
  test(`${label} uses literal catalog arguments`, () => {
    const view = mount(todoStories[name]);
    act(() => (view.element.querySelector(`[data-flow="${tag}"]`) as HTMLButtonElement).click());
    expect(view.calls).toEqual([[tag, args]]);
    view.close();
  });

test("queued edit uses supplied prefilled inputs", () => {
  const view = mount({
    ...todoStories.queued,
    actions: [
      {
        tag: "todo.amend",
        label: "Edit",
        args: { n: "12" },
        input: [{ name: "text", label: "Prompt", kind: "text", required: true, value: "Publish card projections" }],
      },
    ],
  });
  expect(view.element.querySelector("input")!.value).toBe("Publish card projections");
  act(() =>
    view.element.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(view.calls).toEqual([["todo.amend", { n: "12", text: "Publish card projections" }]]);
  view.close();
});

test("clean rebase lights Check from step while checks rerun", () => {
  const view = mount(todoStories.clean_rebase);
  expect([...view.element.querySelectorAll(".todo-steps li")].map(row => row.getAttribute("data-phase"))).toEqual(["done", "done", "current", "next", "next"]);
  const checks = view.element.querySelectorAll(".todo-evidence-row [data-check]");
  expect([...checks].map(row => row.getAttribute("data-check"))).toEqual(["running", "pending"]);
  expect(view.element.querySelectorAll(".todo-spinner").length).toBe(2);
  expect(view.element.textContent).toContain("Reviewed 4bc79ae · same change");
  expect(view.element.textContent).toContain("Checks running");
  expect(Boolean(checks[1]!.compareDocumentPosition(view.element.querySelector(".todo-merge-reason")!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  view.close();
});
test("passed checks complete Propose and hold the dashed merge wait", () => {
  const view = mount(todoStories.checks_passed);
  expect([...view.element.querySelectorAll(".todo-steps li")].map(row => row.getAttribute("data-phase"))).toEqual(["done", "done", "done", "done", "held"]);
  expect(view.element.querySelector('.todo-steps [data-phase="held"]')?.getAttribute("data-wait")).toBe("true");
  expect(view.element.querySelectorAll(".todo-spinner").length).toBe(0);
  expect(view.element.querySelector("header")!.textContent).toContain("In reviewNext to mergetodo/12");
  view.close();
});

test("an open merge wait is current without a step label", () => {
  const view = mount({ ...todoStories.checks_passed, model: { ...todoStories.checks_passed.model, step: undefined } });
  // The step strip names the step as the mock's strip does (parts.tsx): "Merge".
  expect(view.element.querySelector('.todo-steps [data-phase="held"]')?.textContent).toBe("Merge");
  view.close();
});
test("a question holds the named step, not the first unfinished step", () => {
  const view = mount({ ...todoStories.needs_you, model: { ...todoStories.needs_you.model, steps: [
    { id: "plan", label: "Plan", state: "next" },
    { id: "implement", label: "Implement", state: "next" },
    { id: "merge", kind: "wait", state: "next" },
  ] } });
  expect([...view.element.querySelectorAll(".todo-steps li")].map(row => row.getAttribute("data-phase"))).toEqual(["done", "waiting", "next"]);
  view.close();
});
import { fixtures as setup, personOnlyFixtures } from "@smthrs/rpc/fixtures/Setup"
import { fixtures as settings } from "@smthrs/rpc/fixtures/Settings"
import { SetupView } from "./SetupView"
import { SettingsView } from "./SettingsView"
let root: import("react-dom/client").Root | undefined
function render(element: React.ReactNode) { const host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root!.render(element)); return host }
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = "" })

for (const [id, story] of Object.entries(setup)) test(`Setup ${id}`, () => {
  const host = render(<SetupView {...story} onAction={() => {}} onView={() => {}} />)
  for (const text of story.expect) expect([host.textContent, ...[...host.querySelectorAll<HTMLInputElement>("input:not([type=password])")].map(input => input.value)].join("\n")).toContain(text)
  expect([...host.querySelectorAll("[data-step]")].map(row => row.getAttribute("data-step"))).toEqual(["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"])
  expect(host.textContent).toContain("Decisions")
  expect(host.querySelector('input[aria-label="AI Gateway key"]')?.getAttribute("type")).toBe("password")
})
for (const [id, story] of Object.entries(settings)) test(`Settings ${id}`, () => {
  const host = render(<SettingsView {...story} onAction={() => {}} onView={() => {}} />)
  for (const text of story.expect) expect([host.textContent, ...[...host.querySelectorAll<HTMLInputElement>("input:not([type=password])")].map(input => input.value)].join("\n")).toContain(text)
  expect(host.textContent).toContain("700 MB")
})
test("Address submits literal bound step and edited fields once", () => {
  const calls: unknown[] = []
  const host = render(<SetupView {...setup.fresh} onAction={(...args) => calls.push(args)} onView={() => { throw new Error("Unexpected view patch") }} />)
  const input = host.querySelector('input[id$="-bind"]') as HTMLInputElement
  act(() => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; setter.call(input, "0.0.0.0:8080"); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })) })
  act(() => host.querySelector<HTMLButtonElement>('button[data-flow="settings"]')!.click())
  expect(calls).toEqual([["settings", { step: "address", listen: "mac", bind: "0.0.0.0:8080" }]])
})
test("Missing actions omit controls; disabled reason stays visible", () => {
  const host = render(<SetupView {...setup.fresh} actions={[]} onAction={() => { throw new Error("Unexpected dispatch") }} onView={() => {}} />)
  expect(host.querySelector("button")).toBeNull()
  act(() => root!.render(<SetupView {...setup.fresh} actions={[{ tag: "settings", label: "Save address", disabled: { reason: "Address unavailable" } }]} onAction={() => { throw new Error("Unexpected dispatch") }} onView={() => {}} />))
  expect(host.textContent).toContain("Address unavailable")
  expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true)
})
test("Blocked repository links to the supplied fix; capacity explains limit", () => {
  const host = render(<SetupView {...setup.squash_blocked} onAction={() => {}} onView={() => {}} />)
  expect(host.querySelector("a")!.href).toBe("https://github.com/smithersai/smithers/settings")
  act(() => root!.render(<SetupView {...setup.no_capacity} onAction={() => {}} onView={() => {}} />))
  expect(host.textContent).toContain("No machine fits · memory · Close apps to free 6 GB")
})
test("Model keys stay masked and submit only supplied fields", () => {
  const calls: unknown[] = []
  const host = render(<SetupView {...setup.models_validating} onAction={(...args) => calls.push(args)} onView={() => {}} />)
  const input = host.querySelector('input[id$="-jev"]') as HTMLInputElement
  expect(input.type).toBe("password")
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "private-key"); input.dispatchEvent(new Event("input", { bubbles: true })) })
  act(() => host.querySelector<HTMLButtonElement>('button[data-flow="settings"]')!.click())
  expect(calls).toEqual([["settings", { step: "models", fast: "", coding: "", jev: "private-key" }]])
  expect(host.textContent).not.toContain("private-key")
})
test("Machines stepper dispatches the supplied field and string values", () => {
  const calls: unknown[] = []
  const host = render(<SettingsView {...settings.ready} onAction={(...args) => calls.push(args)} onView={() => {}} />)
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="More Machines"]')!.click())
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Fewer Machines"]')!.click())
  expect(calls).toEqual([["settings", { field: "capacity", value: "3" }], ["settings", { field: "capacity", value: "1" }]])
})
test("Settings shows literal sync health and Obsidian receipts", () => {
  const host = render(<SettingsView {...settings.obsidian} onAction={() => {}} onView={() => {}} />)
  expect(host.textContent).toContain("2026-10-02T17:40:00.000Z")
  expect(host.textContent).toContain("GitHub rate budget · 4812/5000")
  expect(host.textContent).toContain("Disk free · 412 GB")
  expect(host.textContent).toContain("Process · ok")
})
test("Owner action forms retain literal order and model arguments", () => {
  const calls: unknown[] = []
  const host = render(<SettingsView {...settings.ready} onAction={(...args) => calls.push(args)} onView={() => {}} />)
  expect([...host.querySelectorAll('.setup-action')].map(form => form.getAttribute('data-flow'))).toEqual(['settings.model.set', 'settings.model.set', 'settings.model.set', 'settings', 'settings', 'github', 'settings'])
  for (const button of host.querySelectorAll<HTMLButtonElement>('.setup-action button[type="submit"]')) act(() => button.click())
  expect(calls).toEqual([
    ['settings.model.set', { role: 'fast', model: 'llama-4-scout' }],
    ['settings.model.set', { role: 'coding', model: 'gpt-6.1-sol' }],
    ['settings.model.set', { role: 'jev', model: 'typesafe-ai/jev' }],
    ['github', {}],
    ['settings', { field: 'obsidian', path: '' }]
  ])
})

test("Failed address keeps the live bind and shows the attempted bind and reason", () => {
  const host = render(<SettingsView {...settings.address_failed} onAction={() => {}} onView={() => {}} />)
  const failed = settings.address_failed.model.address.failed!
  expect(host.textContent).toContain(settings.address_failed.model.address.bind)
  const row = host.querySelector(".setup-settings dd")!
  expect(row.textContent).toContain("In effect: 0.0.0.0:8080")
  expect(row.querySelector<HTMLInputElement>('input[id$="-bind"]')?.value).toBe("0.0.0.0:9090")
  expect(row.querySelector('button[type="submit"]')?.textContent).toBe("Retry")
  expect([...host.querySelectorAll("dt")].map(dt => dt.textContent)).not.toContain("Address")
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(failed.reason.message)
})

test("Rejected key retry submits a write-only secret; agent projection has no retry input", () => {
  const calls: unknown[] = []
  const host = render(<SetupView {...setup.models_failed} onAction={(...args) => calls.push(args)} onView={() => {}} />)
  const input = host.querySelector<HTMLInputElement>('input[id$="-key"]')!
  expect(input.type).toBe("password")
  expect(input.value).toBe("")
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "replacement-key")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  act(() => host.querySelector<HTMLFormElement>('form[data-flow="settings.model-key"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  expect(calls).toEqual([["settings.model-key", { role: "jev", provider: "AI Gateway", key: "replacement-key" }]])
  expect(host.textContent).not.toContain("replacement-key")
  act(() => root!.render(<SetupView {...personOnlyFixtures.models_failed_agent} onAction={() => {}} onView={() => {}} />))
  expect(host.querySelector('input[id$="-key"]')).toBeNull()
})

test("No-capacity fix dispatches its supplied tag and arguments", () => {
  const calls: unknown[] = []
  const host = render(<SetupView {...setup.no_capacity} onAction={(...args) => calls.push(args)} onView={() => {}} />)
  act(() => host.querySelector<HTMLButtonElement>(".setup-capacity button")!.click())
  const fix = setup.no_capacity.model.this_mac.limit!.fix
  expect(calls).toEqual([[fix.tag, fix.args ?? {}]])
})

const reachActions: Action[] = [
  { tag: "settings.address", label: "Save", args: { field: "address", listen: "mac" } },
  { tag: "settings.address", label: "Save", args: { field: "address", listen: "network" }, input: [
    { name: "bind", label: "Bind", kind: "text", required: true, value: "0.0.0.0:8080" },
    { name: "origins", label: "Origins", kind: "text", required: true, value: "http://mac-mini.local:8080" }
  ] }
]
test("Settings Address: This Mac only shows no Bind; choosing Network reveals prefilled Bind and Origins and saves them", () => {
  const calls: unknown[] = [], patches: unknown[] = []
  const mac = { ...settings.ready.model, address: { listen: "mac" as const, bind: "127.0.0.1:8080", origins: ["http://localhost:8080"] } }
  const host = render(<SettingsView {...settings.ready} model={mac} actions={reachActions} view={{ maximized: false }} onAction={(...args) => calls.push(args)} onView={patch => patches.push(patch)} />)
  const choices = () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Who can reach it"] button')].map(button => [button.textContent, button.getAttribute("aria-pressed")])
  expect(choices()).toEqual([["This Mac only", "true"], ["Network", "false"]])
  expect(host.querySelector('input[id$="-bind"]')).toBeNull()
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Who can reach it"] button:last-child')!.click())
  expect(patches).toEqual([{ tab: "network" }])
  act(() => root!.render(<SettingsView {...settings.ready} model={mac} actions={reachActions} view={{ maximized: false, tab: "network" }} onAction={(...args) => calls.push(args)} onView={patch => patches.push(patch)} />))
  expect(choices()).toEqual([["This Mac only", "false"], ["Network", "true"]])
  const row = [...host.querySelectorAll("dt")].find(dt => dt.textContent === "This Mac")!.nextElementSibling!
  expect([...row.querySelectorAll("label")].map(label => label.textContent)).toEqual(["Bind", "Origins"])
  expect(row.querySelector<HTMLInputElement>('input[id$="-bind"]')!.value).toBe("0.0.0.0:8080")
  expect(row.querySelector<HTMLInputElement>('input[id$="-origins"]')!.value).toBe("http://mac-mini.local:8080")
  act(() => row.querySelector<HTMLButtonElement>('button[data-flow="settings.address"]')!.click())
  expect(calls).toEqual([["settings.address", { field: "address", listen: "network", bind: "0.0.0.0:8080", origins: "http://mac-mini.local:8080" }]])
})
test("Settings Address: a network install choosing This Mac only saves with one press", () => {
  const calls: unknown[] = []
  const host = render(<SettingsView {...settings.ready} actions={reachActions} view={{ maximized: false, tab: "mac" }} onAction={(...args) => calls.push(args)} onView={() => {}} />)
  expect(host.querySelector('input[id$="-bind"]')).toBeNull()
  act(() => host.querySelector<HTMLButtonElement>('button[data-flow="settings.address"]')!.click())
  expect(calls).toEqual([["settings.address", { field: "address", listen: "mac" }]])
})
const roleKeys: Action[] = [
  { tag: "settings.model-key", label: "Save", args: { step: "models", role: "fast" }, input: [{ name: "value", label: "Cerebras key", kind: "secret", required: true }] },
  { tag: "settings.model-key", label: "Save", args: { step: "models", role: "coding" }, input: [
    { name: "provider", label: "Provider", kind: "choice", required: true, value: "OpenAI", choices: ["OpenAI", "Anthropic", "OpenRouter"] },
    { name: "value", label: "API key", kind: "secret", required: true }] },
  { tag: "settings.model-key", label: "Save", args: { step: "models", role: "jev" }, input: [{ name: "value", label: "AI Gateway key", kind: "secret", required: true }] }
]
test("Setup Model access: three named roles, each with its own key control and key state", () => {
  const calls: unknown[] = []
  const model = { ...setup.models_validating.model, models: [
    { role: "fast" as const, provider: "Cerebras", key: "saved" as const },
    { role: "coding" as const, provider: "OpenAI", key: "validating" as const },
    { role: "jev" as const, provider: "AI Gateway", key: "failed" as const, error: "401 invalid API key" }
  ] }
  const host = render(<SetupView {...setup.models_validating} model={model} actions={roleKeys} onAction={(...args) => calls.push(args)} onView={() => {}} />)
  const rows = [...host.querySelectorAll('[data-step="models"] .setup-model')]
  expect(rows.map(row => row.firstElementChild!.textContent)).toEqual(["Fast model", "Coding model", "Decisions"])
  expect(rows.map(row => row.getAttribute("data-state"))).toEqual(["saved", "validating", "failed"])
  expect(rows.map(row => row.querySelector(".setup-key-state")!.textContent)).toEqual(["Saved", "Validating", "Failed"])
  expect(rows[2]!.querySelector('[role="alert"]')!.textContent).toBe("401 invalid API key")
  expect(rows.map(row => row.querySelector<HTMLInputElement>('input[type="password"]')!.getAttribute("aria-label"))).toEqual(["Cerebras key", "API key", "AI Gateway key"])
  expect(rows[1]!.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!.value).toBe("OpenAI")
  expect(host.textContent).not.toMatch(/jev|fast|coding/)
  expect(host.querySelector('select option[value="jev"]')).toBeNull()
  const input = rows[2]!.querySelector<HTMLInputElement>('input[type="password"]')!
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "gateway-key"); input.dispatchEvent(new Event("input", { bubbles: true })) })
  act(() => rows[2]!.querySelector<HTMLButtonElement>('button[data-flow="settings.model-key"]')!.click())
  expect(calls).toEqual([["settings.model-key", { step: "models", role: "jev", value: "gateway-key" }]])
  expect(host.textContent).not.toContain("gateway-key")
  expect(host.querySelectorAll('[data-step="models"] form').length).toBe(3)
})

test("Settings actions live in their rows and unassigned actions retain order", () => {
  const host = render(<SettingsView {...settings.ready} actions={[...settings.ready.actions, { tag: "flows", label: "Add" }, { tag: "docs", label: "Docs" }]} onAction={() => {}} onView={() => {}} />)
  const row = (label: string) => [...host.querySelectorAll("dt")].find(dt => dt.textContent === label)!.nextElementSibling!
  expect(row("Machines").textContent).toBe("−2+")
  expect(row("TODOs per day").textContent).toBe("−12+")
  expect(row("Decisions").textContent).toBe("AI GatewaySavedChange")
  expect(row("Health").querySelector('button[data-flow="github"]')!.textContent).toBe("Repair")
  expect(row("Obsidian folder").querySelector("button")!.textContent).toBe("Change")
  expect([...host.querySelectorAll(".setup-view > .setup-actions button")].map(button => button.textContent)).toEqual(["Add", "Docs"])
})

// T-UI-07: spec §14.1.5, §14.5.1 and ui-components T-UI-07 literal oracles.
test("Conversation shell renders branch navigation, entries and Earlier", async () => {
  const { EntryRow } = await import("../../EntryRow")
  const { BranchTree } = await import("../../BranchTree")
  const { EarlierArchive } = await import("../../EarlierArchive")
  const { fixtures } = await import("@smthrs/rpc/fixtures/EntryRow")
  const { fixtures: branches } = await import("@smthrs/rpc/fixtures/BranchTreeNode")
  const row = await mounted({ name: "tombstone", expect: [], render: ({ onAction }) => <EntryRow {...fixtures.tombstone.model} private action={{ tag: "merge", label: "Merge", args: { n: "12" } }} card={<button>Forbidden body</button>} onAction={onAction} /> })
  try {
    expect(row.host.textContent).toBe("Card model contracts")
    expect(row.host.querySelectorAll("button, .mvp-avatar, .mvp-locked")).toHaveLength(0)
    expect(row.host.querySelector(".mvp-tombstone")).not.toBeNull()
  } finally { await row.close() }
  const tree = await mounted({ name: "ancestry", expect: [], render: ({ onAction, onView }) => <BranchTree nodes={[branches.main.model]} view={{ selected_branch: "todo-12" }} onAction={onAction} onView={onView} /> })
  try {
    expect([...tree.host.querySelectorAll(".mvp-tree-name")].map(node => node.textContent)).toEqual(["main", "todo/12", "scratch/repro", "Earlier · 3"])
    expect([...tree.host.querySelectorAll("li")].map(node => node.getAttribute("data-depth"))).toEqual(["0", "1", "2", "0"])
    expect(tree.host.querySelector('[aria-current="page"]')?.textContent).toContain("todo/12")
    await act(async () => tree.host.querySelector<HTMLButtonElement>('[data-node="scratch-repro"]')!.click())
    expect(tree.onAction.mock.calls).toEqual([["branch", { name: "scratch/repro" }]])
    await act(async () => tree.host.querySelector<HTMLButtonElement>('[data-node="earlier"]')!.click())
    expect(tree.onView.mock.calls).toEqual([[{ selected_branch: "earlier" }]])
  } finally { await tree.close() }
  const archive = await mounted({ name: "archive", expect: [], render: ({ onView }) => <EarlierArchive model={{ node: { ...branches.earlier.model, kind: "earlier", archive_count: 3 }, read_only: true, archives: [{ id: "old", title: "Earlier question", entries: [<EntryRow key="entry" {...fixtures.tombstone.model} onAction={() => {}} />] }] }} view={{ selected_archive: "old" }} onView={onView} /> })
  try {
    expect(archive.host.textContent).toBe("Earlier · 3Read-onlyEarlier questionCard model contracts")
    expect(archive.host.querySelector("[data-flow]")).toBeNull()
    await act(async () => archive.host.querySelector<HTMLButtonElement>("button")!.click())
    expect(archive.onView.mock.calls).toEqual([[{ selected_archive: "old" }]])
    expect(archive.onAction.mock.calls).toEqual([])
  } finally { await archive.close() }
})

// §14.5.1 and §15.1.2: hostile imported strings are text; only supplied actions dispatch.
test("shell text is inert; private, empty and disabled boundaries", async () => {
  const { EntryRow } = await import("../../EntryRow")
  const { ContextLine } = await import("../../ContextLine")
  const { BranchTree } = await import("../../BranchTree")
  const { fixtures: actors } = await import("@smthrs/rpc/fixtures/ActorChip")
  const { fixtures: branches } = await import("@smthrs/rpc/fixtures/BranchTreeNode")
  const hostile = '<script>throw Error("executed")</script>'
  const row = await mounted({ name: "hostile", expect: [], render: ({ onAction }) => <EntryRow kind="answer" author={actors.system.model.actor} title={hostile} summary={hostile} tone="quiet" onAction={onAction} /> })
  try {
    expect(row.host.querySelector(".mvp-entry-title")?.textContent).toBe(hostile)
    expect(row.host.querySelector(".mvp-entry-summary")?.textContent).toBe(hostile)
    expect(row.host.querySelector(".mvp-avatar")?.getAttribute("aria-label")).toBe("Install event")
    expect(row.host.querySelector("script")).toBeNull()
    expect(row.host.querySelector("button")).toBeNull()
  } finally { await row.close() }
  const context = await mounted({ name: "empty", expect: [], render: ({ onView }) => <ContextLine count={0} items={[]} expanded={false} onView={onView} /> })
  try {
    expect(context.host.textContent).toBe("Context · 0")
    expect(context.host.querySelector(".mvp-context-chip")).toBeNull()
    await act(async () => context.host.querySelector<HTMLButtonElement>("button")!.click())
    expect(context.onView.mock.calls).toEqual([[{ expanded: true }]])
    expect(context.onAction.mock.calls).toEqual([])
  } finally { await context.close() }
  const disabled = await mounted({ name: "disabled branch", expect: [], render: ({ onAction, onView }) => <BranchTree nodes={[{ ...branches.scratch.model, action: { tag: "branch", label: "Open", args: { name: "scratch/repro" }, disabled: { reason: "Repository access refused" } } }]} view={{}} onAction={onAction} onView={onView} /> })
  try {
    const control = disabled.host.querySelector<HTMLButtonElement>("button")!
    expect(control.dataset.flow).toBe("branch")
    expect(control.disabled).toBe(true)
    expect(disabled.host.textContent).toContain("Repository access refused")
    await act(async () => control.click())
    expect(disabled.onAction.mock.calls).toEqual([])
    expect(disabled.onView.mock.calls).toEqual([])
  } finally { await disabled.close() }
})

// T-UI-07 §14.2.1: every supplied action retains its tag, args and refusal at every door.
for (const disabled of [false, true]) test(`ancestor crumb preserves action contract disabled=${disabled}`, async () => {
  const { BranchCrumbs } = await import("../../BranchTree")
  const { fixtures } = await import("@smthrs/rpc/fixtures/BranchTreeNode")
  const node = { ...fixtures.main.model, action: { tag: "branch" as const, label: "Open", args: { name: "parent" }, ...(disabled ? { disabled: { reason: "Repository access refused" } } : {}) } }
  const row = await mounted({ name: "ancestor", expect: [], render: ({ onAction, onView }) => <BranchCrumbs nodes={[node]} view={{ selected_branch: "scratch-repro" }} onAction={onAction} onView={onView} /> })
  try {
    const button = row.host.querySelector<HTMLButtonElement>('[data-branch="main"]')!
    expect(button.dataset.flow).toBe("branch")
    expect(button.disabled).toBe(disabled)
    if (disabled) expect(row.host.textContent).toContain("Repository access refused")
    await act(async () => button.click())
    expect(row.onAction.mock.calls).toEqual(disabled ? [] : [["branch", { name: "parent" }]])
    expect(row.onView.mock.calls).toEqual([])
  } finally { await row.close() }
})
test("missing selected branch has no unnamed crumb; popover arrows move and go to parent", async () => {
  const { BranchCrumbs } = await import("../../BranchTree")
  const { fixtures } = await import("@smthrs/rpc/fixtures/BranchTreeNode")
  const missing = await mounted({ name: "missing", expect: [], render: ({ onAction, onView }) => <BranchCrumbs nodes={[fixtures.main.model]} view={{ selected_branch: "closed" }} onAction={onAction} onView={onView} /> })
  try { expect(missing.host.querySelector("button")).toBeNull() } finally { await missing.close() }
  const row = await mounted({ name: "keys", expect: [], render: ({ onAction, onView }) => <BranchCrumbs nodes={[fixtures.main.model]} view={{ selected_branch: "scratch-repro" }} onAction={onAction} onView={onView} /> })
  try {
    const trigger = row.host.querySelector<HTMLButtonElement>(".mvp-crumb-here")!
    await act(async () => { trigger.click(); trigger.focus() })
    const press = async (key: string) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })) })
    await press("ArrowDown")
    expect((document.activeElement as HTMLElement).dataset.node).toBe("main")
    await press("ArrowDown")
    expect((document.activeElement as HTMLElement).dataset.node).toBe("todo-12")
    await press("ArrowDown")
    expect((document.activeElement as HTMLElement).dataset.node).toBe("scratch-repro")
    expect(document.activeElement!.getAttribute("aria-label")).toContain("Open scratch/repro")
    await press("ArrowLeft")
    expect((document.activeElement as HTMLElement).dataset.node).toBe("todo-12")
    await press("ArrowUp")
    expect((document.activeElement as HTMLElement).dataset.node).toBe("main")
    await press("Escape")
    expect(document.activeElement).toBe(trigger)
    expect(row.host.querySelector(".mvp-tree")).toBeNull()
  } finally { await row.close() }
})

// T-UI-14: Appendix A literal copy, presentation-only policy and inert text.
const { CommandsView } = await import("./CommandsView")
test("Commands renders supplied policies and order without dispatch or role filtering", async () => {
  const { fixtures } = await import("@smthrs/rpc/fixtures/Commands")
  const story: ViewStory = { name: "commands", expect: [], render: callbacks => <CommandsView {...fixtures.maintainer} {...callbacks} /> }
  const mountedStory = await mounted(story)
  try {
    expect([...mountedStory.host.querySelectorAll("h3, summary")].map(node => node.textContent)).toEqual(["TODOs", "People", "Advanced"])
    expect([...mountedStory.host.querySelectorAll(".mvp-command-policy")].map(node => node.textContent)).toEqual(["Asks first", "Only you", "Only you"])
    expect(mountedStory.host.querySelector(".mvp-command")!.querySelector(".mvp-command-policy")).toBeNull()
    expect(mountedStory.onAction).not.toHaveBeenCalled()
    expect(mountedStory.onView).not.toHaveBeenCalled()
  } finally { await mountedStory.close() }
})
test("Commands treats hostile synopsis and descriptions as inert text", async () => {
  const { stories } = await import("./CommandsView.stories")
  const mountedStory = await mounted(stories.find(story => story.name === "Inert text")!)
  try {
    expect(mountedStory.host.textContent).toContain("<script>alert(1)</script>")
    expect(mountedStory.host.textContent).toContain("<img src=x onerror=alert(1)>")
    expect(mountedStory.host.querySelectorAll("script, img, a, button")).toHaveLength(0)
    expect(mountedStory.onAction).not.toHaveBeenCalled()
  } finally { await mountedStory.close() }
})

// ui-components Rules (1): bound arguments plus every supplied form field.
test("Commands supplied action fields validate and forward literal input once", async () => {
  const story: ViewStory = { name: "input", expect: [], render: callbacks => <CommandsView gestures={{}} view={{ maximized: false }} model={{ groups: [] }} actions={[{ tag: "search", label: "Search", args: { source: "fixture", query: "" }, input: [{ name: "query", label: "Query", kind: "text", required: true }, { name: "scope", label: "Scope", kind: "choice", choices: ["code", "wiki"], value: "code", required: true }, { name: "token", label: "Token", kind: "secret", required: false }, { name: "notes", label: "Notes", kind: "text", multiline: true, required: false }] }]} {...callbacks} /> }
  const result = await mounted(story)
  try {
    const button = result.host.querySelector("button")!
    expect(button.disabled).toBe(true)
    await act(async () => button.click())
    expect(result.onAction).not.toHaveBeenCalled()
    expect(result.host.querySelector('input[type="password"]')).not.toBeNull()
    expect(result.host.querySelector("textarea")).not.toBeNull()
    expect([...result.host.querySelectorAll("select option")].map(option => option.textContent)).toEqual(["code", "wiki"])
    for (const [name, value] of [["query", "needle"], ["scope", "wiki"], ["token", "secret"], ["notes", "line 1\nline 2"]]) {
      const field = result.host.querySelector<HTMLInputElement>(`[name="${name}"]`)!
      await act(async () => {
        const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value)
        field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }))
      })
    }
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
    expect(result.onAction.mock.calls).toEqual([["search", { source: "fixture", query: "needle", scope: "wiki", token: "secret", notes: "line 1\nline 2" }]])
    expect(result.onView).not.toHaveBeenCalled()
  } finally { await result.close() }
})
test("Commands action without bound args forwards an empty object and has no body title", async () => {
  const result = await mounted({ name: "empty args", expect: [], render: callbacks => <CommandsView gestures={{}} view={{ maximized: false }} model={{ groups: [] }} actions={[{ tag: "help", label: "Open" }]} {...callbacks} /> })
  try {
    expect(result.host.querySelector("h2")).toBeNull()
    await act(async () => result.host.querySelector("button")!.click())
    expect(result.onAction.mock.calls).toEqual([["help", {}]])
  } finally { await result.close() }

})

// T-UI-09 / spec §14.3: colors belong to people, not roster positions.
test("Members reordered colors and absent owner actions", async () => {
  const { MembersView } = await import("./MembersView")
  const { fixtures } = await import("@smthrs/rpc/fixtures/Members")
  const host = document.createElement("div")
  const root = createRoot(host)
  try {
    await act(async () => root.render(<MembersView {...fixtures.team} model={{ ...fixtures.team.model, members: [...fixtures.team.model.members].reverse() }} onAction={() => {}} onView={() => {}} />))
    expect([...host.querySelectorAll<HTMLElement>(".mvp-avatar")].map(node => node.style.getPropertyValue("--who"))).toEqual(["var(--lane-2)", "var(--lane-0)", "var(--lane-1)"])
    expect(host.querySelector('[data-login="williamcory"]')?.querySelectorAll("button[data-flow]").length).toBe(0)
  } finally { await act(async () => root.unmount()) }
})

// C-UI-12: supplied disabled actions and untrusted names never grant authority.
test("Members disabled actions and names rendered as text", async () => {
  const { MembersView } = await import("./MembersView")
  const { fixtures } = await import("@smthrs/rpc/fixtures/Members")
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const onAction = mock(() => {})
  try {
    await act(async () => root.render(<MembersView {...fixtures.empty} model={{ ...fixtures.empty.model, members: [{ ...fixtures.empty.model.members[0]!, name: '<img src=x onerror="alert(1)">' }] }} actions={[{ tag: "members.add", label: "Add", disabled: { reason: "Checking access" } }]} onAction={onAction} onView={() => {}} />))
    expect(host.textContent).toContain('<img src=x onerror="alert(1)">')
    expect(host.querySelectorAll('img[src="x"]')).toHaveLength(0)
    expect(host.textContent).toContain("Checking access")
    const button = host.querySelector<HTMLButtonElement>('button')!
    expect(button.disabled).toBe(true)
    await act(async () => button.click())
    expect(onAction).toHaveBeenCalledTimes(0)
    expect(host.querySelectorAll('a')).toHaveLength(0)
  } finally { await act(async () => root.unmount()); host.remove() }
})

// C-UI-12 / ui-components Rules: supplied choice input, local draft, opaque callback.
test("Members choice default and refreshed input match submitted values", async () => {
  const { MembersView } = await import("./MembersView")
  const { fixtures } = await import("@smthrs/rpc/fixtures/Members")
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const calls: unknown[] = []
  const onAction = (tag: string, args?: Record<string, string>) => { calls.push([tag, args]) }
  const action = { tag: "members.role" as const, label: "Role", args: { login: "ben" }, input: [{ name: "role", label: "Role", kind: "choice" as const, choices: ["maintainer", "member"], required: true }] }
  try {
    await act(async () => root.render(<MembersView {...fixtures.team} onView={() => {}} model={{ ...fixtures.team.model, members: [] }} actions={[action]} onAction={onAction} />))
    expect(host.querySelector("select")!.value).toBe("maintainer")
    await act(async () => host.querySelector("button")!.click())
    expect(calls).toEqual([["members.role", { login: "ben", role: "maintainer" }]])
    await act(async () => {
      const select = host.querySelector("select")!
      select.value = "member"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(host.querySelector("select")!.value).toBe("member")
    await act(async () => root.render(<MembersView {...fixtures.team} onView={() => {}} model={{ ...fixtures.team.model, members: [] }} actions={[{ ...action, input: [{ ...action.input[0]!, choices: ["owner", "maintainer", "member"], value: "owner" }] }]} onAction={onAction} />))
    expect(host.querySelector("select")!.value).toBe("owner")
    await act(async () => host.querySelector("button")!.click())
    expect(calls).toEqual([["members.role", { login: "ben", role: "maintainer" }], ["members.role", { login: "ben", role: "owner" }]])
  } finally { await act(async () => root.unmount()); host.remove() }
})

test("Members story renders unexpected supplied owner actions for oracle detection", async () => {
  const { fixtures } = await import("@smthrs/rpc/fixtures/Members")
  const { stories } = await import("./MembersView.stories")
  const owner = fixtures.team.model.members[0]!
  const previous = owner.actions
  owner.actions = [{ tag: "members.remove", label: "Remove", args: { login: "williamcory" } }]
  try {
    const rendered = await mounted(stories.find(story => story.name === "team")!)
    try { expect(rendered.host.querySelectorAll('[data-login="williamcory"] button[data-flow="members.remove"]')).toHaveLength(1) }
    finally { await rendered.close() }
  } finally { owner.actions = previous }
})

// T-UI-10 / C-UI-12: literal state and action oracles, selection is local.
import { fixtures as flows } from "@smthrs/rpc/fixtures/Flow"
import { FlowView } from "./FlowView"
for (const [id, fixture] of Object.entries(flows)) test(`Flow ${id}`, () => {
  const host = render(<FlowView {...fixture} onAction={() => {}} onView={() => {}} />)
  const displays = [host.textContent]
  for (const button of host.querySelectorAll<HTMLButtonElement>(".mvp-version")) {
    act(() => button.click())
    displays.push(host.textContent)
  }
  for (const text of fixture.expect) expect(displays.join("\n")).toContain(text)
})
test("Flow version selection is local and marks only supplied added true", () => {
  const calls = mock((..._args: unknown[]) => {})
  const host = render(<FlowView {...flows.proposed} onAction={calls} onView={calls} />)
  expect(host.querySelector('[aria-pressed="true"]')?.textContent).toContain("Active")
  act(() => host.querySelector<HTMLButtonElement>('[data-state="proposed"]')!.click())
  expect(host.textContent).toContain("Update docs")
  expect(host.querySelectorAll('[data-added="true"]').length).toBe(1)
  expect(host.querySelector('[data-added="true"]')?.textContent).toContain("Update docs")
  expect(calls).toHaveBeenCalledTimes(0)
  act(() => root!.render(<FlowView {...flows.proposed} model={{ ...flows.proposed.model, versions: [{ id: "v4", state: "proposed", steps: [{ id: "docs", label: "Update docs", added: false }, { id: "other", label: "Other" }] }] }} onAction={calls} onView={calls} />))
  expect(host.querySelectorAll("[data-added]").length).toBe(0)
})
test("Flow actions retain literal order and bindings; omitted and disabled controls", () => {
  const calls = mock((..._args: unknown[]) => {})
  const host = render(<FlowView {...flows.active} onAction={calls} onView={() => { throw new Error("Unexpected view patch") }} />)
  expect([...host.querySelectorAll('[data-flow]')].map(button => button.textContent)).toEqual(["Source", "Plan", "Run", "Edit"])
  for (const button of host.querySelectorAll<HTMLButtonElement>('[data-flow]')) act(() => button.click())
  expect(calls.mock.calls).toEqual([["flow.source", { name: "todo" }], ["flow.plan", { name: "todo" }], ["flow.run", { name: "todo" }], ["flow.edit", { name: "todo" }]])
  act(() => root!.render(<FlowView {...flows.active} actions={[{ tag: "flow.run", label: "Run", disabled: { reason: "No machine available" } }]} onAction={calls} onView={() => {}} />))
  expect(host.querySelector('[data-flow="flow.source"]')).toBeNull()
  expect(host.textContent).toContain("No machine available")
  act(() => host.querySelector<HTMLButtonElement>('[data-flow="flow.run"]')!.click())
  expect(calls).toHaveBeenCalledTimes(4)
})
test("Flow source is inert text and merge signals use supplied targets", () => {
  const host = render(<FlowView {...flows.active} model={{ ...flows.active.model, source: { path: '<script>throw new Error("executed")</script>' } }} onAction={() => {}} onView={() => {}} />)
  expect(host.querySelector("script")).toBeNull()
  expect(host.textContent).toContain('<script>throw new Error("executed")</script>')
  expect(host.textContent).toContain("Wait for merge")
  expect(host.textContent).toContain("rebase ↺ check")
  expect(host.textContent).toContain("steer ↺ implement")
})
// spec §11.3 / ui-components T-UI-10: state copy is literal, Active survives failed loading.
for (const [fixture, labels] of [
  [flows.proposed, ["Active", "ProposedT12"]],
  [flows.merged_syncing, ["Merged · active after syncT12", "Active"]],
  [flows.merged_failed, ["Merged · not activeT12", "Active"]],
  [flows.previous, ["Active", "Previous"]],
] as const) test(`Flow version words: ${labels.join(", ")}`, () => {
  const host = render(<FlowView {...fixture} onAction={() => {}} onView={() => {}} />)
  expect([...host.querySelectorAll(".mvp-version")].map(chip => chip.textContent)).toEqual([...labels])
  expect(host.querySelector('.mvp-version[aria-pressed="true"]')?.textContent).toBe("Active")
})

// Mock Flow.tsx: the visible title and accessible name agree; signal arrows are decorative.
test("Flow accessible title and decorative signal arrows", () => {
  const host = render(<FlowView {...flows.active} onAction={() => {}} onView={() => {}} />)
  expect(host.querySelector("section")?.getAttribute("aria-label")).toBe("TODO flow")
  expect([...host.querySelectorAll('.mvp-signal [aria-hidden="true"]')].map(node => node.textContent)).toEqual(["↺", "↺"])
})

// Flow mock: only the selected failed version owns its error; Active remains usable.
test("Flow load failure belongs to selected version", () => {
  const host = render(<FlowView {...flows.merged_failed} onAction={() => {}} onView={() => {}} />)
  expect(host.textContent).not.toContain("Load failed")
  act(() => host.querySelector<HTMLButtonElement>('[data-state="merged-failed"]')!.click())
  expect(host.textContent).toContain("Load failed")
  const details = host.querySelector<HTMLDetailsElement>(".flow-failure details")!
  expect(details).not.toBeNull()
  expect(details.open).toBe(false)
  expect(details.querySelector("summary")?.textContent).toBe("Details")
  expect(details.querySelector("pre")?.textContent).toBe("Flow validation failed")
  expect(host.querySelector(".flow-failure b")?.textContent).toBe("Load failed")
  act(() => host.querySelector<HTMLButtonElement>('[data-state="active"]')!.click())
  expect(host.textContent).not.toContain("Load failed")
})

// FlowCard error is optional: absent/blank diagnostics do not invent detail text.
test("Flow failed version without diagnostics has no disclosure", () => {
  for (const diagnostic of [undefined, "", "   "]) {
    const host = render(<FlowView {...flows.merged_failed} model={{ ...flows.merged_failed.model, versions: [{ id: "failed", state: "merged-failed", steps: [], error: diagnostic }] }} onAction={() => {}} onView={() => {}} />)
    expect(host.querySelector(".flow-failure b")?.textContent).toBe("Load failed")
    expect(host.querySelector(".flow-failure details")).toBeNull()
    expect(host.textContent).not.toContain("undefined")
  }
})

import { unifiedPatch } from "../DiffSurface"
import { fixtures as diffs } from "@smthrs/rpc/fixtures/Diff"
// T-UI-11 Changes: literal file headers, context/removal/addition counts, zero ranges.
test("Diff supplied hunks serialize exact modified, added, deleted and renamed patches", () => {
  expect(unifiedPatch(diffs.item_base.model)).toBe('diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\n--- a/flows/todo/flow.ts\n+++ b/flows/todo/flow.ts\n@@ -2,2 +2,2 @@\n export default Flow.make("todo", {\n-  description: "Build",\n+  description: "Complete one TODO",\n')
  expect(unifiedPatch(diffs.fork.model)).toBe('diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\n--- /dev/null\n+++ b/flows/todo/flow.ts\n@@ -0,0 +1,1 @@\n+export const repro = true\n')
  expect(unifiedPatch(diffs.deleted.model)).toBe('diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\n--- a/flows/todo/flow.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-export const legacy = true\n')
  expect(unifiedPatch(diffs.renamed.model)).toBe('diff --git a/flows/todo/flow.ts b/flows/todo-next/flow.ts\nrename from flows/todo/flow.ts\nrename to flows/todo-next/flow.ts\n--- a/flows/todo/flow.ts\n+++ b/flows/todo-next/flow.ts\n')
  expect(unifiedPatch({ ...diffs.item_base.model, path: 'x.ts', hunks: [{ old_start: 0, new_start: 1, lines: [{ op: '+', text: 'one' }] }, { old_start: 4, new_start: 5, lines: [{ op: ' ', text: 'same' }, { op: '-', text: 'old' }] }] })).toBe('diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1,1 @@\n+one\n@@ -4,2 +5,1 @@\n same\n-old\n')
})
import { DiffCardSurface } from "../DiffSurface"
test("Diff Restore binds the supplied burst; removing it leaves no control", () => {
  const calls: unknown[] = []
  const host = render(<DiffCardSurface {...diffs.burst} onAction={(...args) => calls.push(args)} onView={() => {}} />)
  act(() => host.querySelector<HTMLButtonElement>('button[data-flow="file.restore"]')!.click())
  expect(calls).toEqual([["file.restore", { path: "flows/todo/flow.ts", revision: "burst-17" }]])
  act(() => root!.render(<DiffCardSurface {...diffs.burst} actions={[]} onAction={() => {}} onView={() => {}} />))
  expect(host.querySelector('button')).toBeNull()
})
test("Diff bases, binary sizes and disabled reason render without inventing controls", () => {
  for (const fixture of [diffs.item_base, diffs.fork, diffs.binary]) {
    const host = render(<DiffCardSurface {...fixture} onAction={() => {}} onView={() => {}} />)
    expect(host.querySelector('button')).toBeNull()
    expect(host.querySelector('[data-against]')!.getAttribute('data-against')).toBe(fixture.model.against.kind)
    if (fixture === diffs.binary) expect(host.textContent).toContain('Binary file · 18.2 kB → 19.7 kB')
  }
  const calls: unknown[] = []
  const host = render(<DiffCardSurface {...diffs.burst} actions={[{ tag: 'file.restore', label: 'Restore this file', disabled: { reason: 'Revision changed' } }]} onAction={(...args) => calls.push(args)} onView={() => {}} />)
  act(() => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(calls).toEqual([])
  expect(host.textContent).toContain('Revision changed')
})

import { fixtures as draftFixtures } from "@smthrs/rpc/fixtures/Draft"
import type { DraftViewProps } from "@smthrs/rpc/DraftCard"
import { DraftView } from "./DraftView"
describe("Draft", () => {
const fixtures = draftFixtures
let draftRoot: ReturnType<typeof createRoot>
const calls: unknown[] = []
function renderDraft(props: Partial<DraftViewProps> = {}) {
  const host = document.createElement("div")
  document.body.append(host)
  draftRoot = createRoot(host)
  act(() => draftRoot.render(<DraftView {...fixtures.append} onAction={(...args) => calls.push(args)} onView={() => { throw new Error("Unexpected view patch") }} {...props} />))
  return host
}
afterEach(() => { act(() => draftRoot?.unmount()); document.body.innerHTML = ""; calls.length = 0 })
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
    const host = renderDraft(fixture)
    for (const expected of fixture.expect) {
      const contents = host.textContent + Array.from(host.querySelectorAll("input,textarea")).map(element => (element as HTMLInputElement).value).join(" ")
      expect(contents).toContain(expected)
    }
    expect(host.querySelector(".draft-private") !== null).toBe(!fixture.model.committed && fixture.model.private)
  })
}
test("DraftView submits fields and renders private and committed drafts", () => {
  const host = renderDraft({ model: { ...fixtures.issue_fixes.model, place: { mode: "append", options: [{ n: 12, title: "Keep edits", state: "queued" }] } } })
  expect(host.querySelector(".draft-private")!.textContent).toBe("Only you")
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
    ["form.set", { entry: "entry-draft-1", field: "fixes", value: "false" }]
  ])
  act(() => draftRoot.render(<DraftView {...fixtures.committed} onAction={(...args) => calls.push(args)} onView={() => {}} />))
  expect(host.textContent).toContain("Committed as T12")
  expect(host.querySelector(".draft-private")).toBeNull()
})
test("Commit forwards full supplied input once; Discard only deletes Draft", () => {
  const host = renderDraft({ actions: [
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
  const host = renderDraft({ actions: [{ tag: "draft.discard", label: "Discard", args: { draft: "entry-draft-1" } }], gestures: {} })
  expect(host.querySelector('[data-flow="todo.new"]')).toBeNull()
  expect(host.querySelector("input")!.readOnly).toBe(true)
  blur(host.querySelector("input")!)
  expect(calls).toEqual([])
})
test("disabled actions and gestures show reasons and never dispatch", () => {
  const host = renderDraft({ ...fixtures.empty_stack, gestures: { set: { tag: "form.set", label: "Edit", disabled: { reason: "Draft is read-only" } } } })
  expect(host.textContent).toContain("Add a title")
  expect(host.textContent).toContain("Draft is read-only")
  press(host.querySelector('[data-flow="todo.new"]')!)
  blur(host.querySelector("input")!)
  expect(calls).toEqual([])
})
test("committed amendment has +1 and seed remains data only", () => {
  const host = renderDraft(fixtures.committed_amendment)
  expect(host.textContent).toContain("Committed as T9")
  expect(host.textContent).toContain("+1")
  expect(host.querySelector("input")).toBeNull()
  act(() => draftRoot.render(<DraftView {...fixtures.seed} onAction={(...args) => calls.push(args)} onView={() => {}} />))
  expect(host.querySelector(".draft-seed")!.textContent).toContain("Read-only")
  expect(host.querySelectorAll(".draft-seed button").length).toBe(0)
  expect(calls).toEqual([])
})

test("empty acceptance clears; amendment forwards its bound item", () => {
  const host = renderDraft(fixtures.amend)
  const acceptance = host.querySelectorAll<HTMLTextAreaElement>("textarea")[1]!
  change(acceptance, ""); blur(acceptance)
  press(host.querySelector('[data-flow="todo.amend"]')!)
  expect(calls).toEqual([
    ["form.set", { entry: "entry-draft-1", field: "acceptance", value: "[]" }],
    ["todo.amend", { n: "9" }]
  ])
})
test("hostile seed text is literal, with no executable surface", () => {
  const host = renderDraft({ model: { ...fixtures.seed.model, seed: { files: ['<script>alert("seed")</script>'] } } })
  expect(host.querySelector(".draft-seed")!.textContent).toContain('<script>alert("seed")</script>')
  expect(host.querySelector("script")).toBeNull()
})

test("unavailable placement stays selected and focus/blur never appends", () => {
  for (const mode of ["before", "amend"] as const) {
    const host = renderDraft({ model: { ...fixtures.append.model, place: { mode, n: 99, options: [] } } })
    const select = host.querySelector("select")!
    expect(select.selectedOptions[0]!.textContent).toBe(`${mode === "before" ? "Before" : "Amend"} T99 (unavailable)`)
    expect(select.value).toBe(JSON.stringify({ mode, n: 99 }))
    act(() => select.focus()); blur(select)
    expect(calls).toEqual([])
    act(() => draftRoot.unmount()); host.remove(); draftRoot = undefined!
  }
})
test("checkbox and select dispatch once on change without focus or blur", () => {
  const host = renderDraft(fixtures.issue_fixes)
  const fixes = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  const initial = fixes.checked
  press(fixes)
  expect(calls).toEqual([["form.set", { entry: "entry-draft-1", field: "fixes", value: String(!initial) }]])
  blur(fixes)
  expect(calls.length).toBe(1)
  change(host.querySelector("select")!, '{"mode":"append"}')
  expect(calls.length).toBe(1)
})
test("Commit has no unsupported Enter hint", () => {
  const host = renderDraft()
  expect(host.querySelector('[data-flow="todo.new"]')!.textContent).toBe("Commit")
})
test("committed receipt has no unsupported link hint", () => {
  const host = renderDraft(fixtures.committed)
  expect(host.querySelector(".draft-receipt")!.textContent).not.toContain("↗")
})

test("agent model updates resync every field and unchanged blur never dispatches", () => {
  const host = renderDraft(fixtures.issue_fixes)
  change(host.querySelector("input")!, "Unsent title")
  const model = { ...fixtures.issue_fixes.model, title: "Agent title", prompt: "Agent prompt", acceptance: ["Agent acceptance"], place: { mode: "before" as const, n: 9, options: fixtures.issue_fixes.model.place.options }, issue: { ...fixtures.issue_fixes.model.issue!, fixes: false } }
  act(() => draftRoot.render(<DraftView {...fixtures.issue_fixes} model={model} onAction={(...args) => calls.push(args)} onView={() => {}} />))
  const title = host.querySelector("input")!
  expect(title.value).toBe("Agent title"); blur(title)
  const areas = host.querySelectorAll("textarea")
  expect(areas[0]!.value).toBe("Agent prompt"); blur(areas[0]!)
  expect(areas[1]!.value).toBe("Agent acceptance"); blur(areas[1]!)
  expect(host.querySelector("select")!.value).toBe('{"mode":"before","n":9}')
  change(host.querySelector("select")!, '{"mode":"before","n":9}')
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false)
  expect(calls).toEqual([])
})
test("issue arrow requires the model GitHub href", () => {
  const host = renderDraft(fixtures.issue_fixes)
  const issue = host.querySelector(".draft-issue")!
  expect(issue.getAttribute("href")).toBe(fixtures.issue_fixes.model.issue!.url!)
  expect(issue.textContent).toContain("↗")
  act(() => draftRoot.render(<DraftView {...fixtures.issue_fixes} model={{ ...fixtures.issue_fixes.model, issue: { ...fixtures.issue_fixes.model.issue!, url: undefined as unknown as string } }} onAction={() => {}} onView={() => {}} />))
  expect(host.querySelector(".draft-issue")!.textContent).not.toContain("↗")
})

test("one model field update preserves other unsubmitted edits", () => {
  const host = renderDraft(fixtures.append)
  const prompt = host.querySelector("textarea")!
  change(prompt, "Human prompt")
  act(() => draftRoot.render(<DraftView {...fixtures.append} model={{ ...fixtures.append.model, title: "Agent title" }} onAction={(...args) => calls.push(args)} onView={() => {}} />))
  expect(host.querySelector("input")!.value).toBe("Agent title")
  expect(prompt.value).toBe("Human prompt")
  blur(host.querySelector("input")!); blur(prompt)
  expect(calls).toEqual([["form.set", { entry: "entry-draft-1", field: "prompt", value: "Human prompt" }]])
})

test("unchanged acceptance is silent for empty entries and embedded newlines", () => {
  const host = renderDraft()
  for (const acceptance of [[], [""], ["First\nSecond"]]) {
    act(() => draftRoot.render(<DraftView {...fixtures.append} model={{ ...fixtures.append.model, acceptance }} onAction={(...args) => calls.push(args)} onView={() => {}} />))
    const field = host.querySelectorAll("textarea")[1]!
    expect(field.value).toBe(acceptance.join("\n")); blur(field)
    expect(calls).toEqual([])
  }
})

})

async function mountedTerminal(story: ViewStory) {
  const item = await mounted(story)
  const { host } = item
  if (host.querySelector(".terminal-view")) {
    const deadline = Date.now() + 4000
    while (!host.querySelector(".xterm-helper-textarea") && Date.now() < deadline) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(host.querySelector(".xterm-helper-textarea")).not.toBeNull()
  }
  return item
}
// T-UI-17: literal presentation oracles, independent of production copy.
for (const [name, watching, frozen] of [
  ["Owner's idle terminal", false, false],
  ["Someone else's terminal", true, false],
  ["The coding agent's terminal", true, false],
  ["Frozen while rebasing", false, true],
  ["Watching while rebasing", true, true],
] as const) test(`Terminal ${name}: input focus and state`, async () => {
  const item = await mountedTerminal(terminalStories.find(story => story.name === name)!)
  try {
    expect(item.host.querySelector(".terminal-output > div")!.hasAttribute("inert")).toBe(watching || frozen)
    expect(item.host.textContent!.includes("Watching")).toBe(watching)
    expect(item.host.textContent!.includes("Rebasing…")).toBe(frozen)
    expect(item.host.querySelector(".terminal-output")!.getAttribute("role")).toBe("region")
    expect(item.host.textContent).not.toContain("Ask to type")
    expect(item.host.textContent).not.toContain("Add to machine image")
  } finally { await item.close() }
})
test("Terminal forwards owner bytes and suppresses watcher/frozen bytes through the real adapter", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  const bytes = mock((_data: string) => {})
  try {
    for (const [viewer_is_owner, frozen, inert] of [[true, false, false], [false, false, true], [true, true, true], [false, true, true], [true, false, false]] as const) {
      // The card file's production slot (T-UI-17); the View only places it inside its inert gate.
      const model = { ...terminalFixtures.idle.model, viewer_is_owner, frozen }
      await act(async () => root.render(<TerminalView {...terminalFixtures.idle} model={model}
        onAction={() => {}} onView={() => {}} terminal={terminalSlot(model, undefined, bytes)} />))
      const deadline = Date.now() + 4000
      while (!host.querySelector(".xterm-helper-textarea") && Date.now() < deadline) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
      const input = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!
      expect(input).not.toBeNull()
      expect(host.querySelector(".terminal-output > div")!.hasAttribute("inert")).toBe(inert)
      expect(document.activeElement).not.toBe(input)
      bytes.mockClear()
      // Force a key at the emulator boundary even when the browser's inert gate would block it.
      await act(async () => input.dispatchEvent(new KeyboardEvent("keypress", { key: "a", charCode: 97, keyCode: 97, bubbles: true })))
      expect(bytes.mock.calls).toEqual(inert ? [] : [["a"]])
      if (!inert) { input.focus(); expect(document.activeElement).toBe(input) }
    }
  } finally { await act(async () => root.unmount()); host.remove() }
})
test("Terminal gives the working agent its own avatar and acting-for label", async () => {
  const item = await mountedTerminal(terminalStories.find(story => story.name === "Claude Code working in Ben's terminal")!)
  try {
    expect(item.host.querySelectorAll('.mvp-avatar[data-kind="agent"]')).toHaveLength(1)
    expect(item.host.querySelectorAll('.mvp-avatar[data-kind="person"]')).toHaveLength(1)
    expect(item.host.textContent).toContain("Claude Code for Ben")
    expect(item.host.querySelector('.mvp-avatar[data-kind="agent"]')!.hasAttribute("data-live")).toBe(true)
  } finally { await item.close() }
})

test("Branch actions retain burst identities, forms, omissions and supplied order", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  const onAction = mock((_tag: string, _args?: Record<string, string>) => {}), onView = mock(() => {})
  try {
    await act(async () => root.render(<BranchView {...branchFixtures.active} onAction={onAction} onView={onView} />))
    expect(host.textContent!.match(/Changed outside Smithers/g)).toHaveLength(1)
    expect([...host.querySelectorAll(".branch-actions button[data-flow], .branch-activity button[data-flow]")].map(button => button.textContent)).toEqual(["Diff", "Steer", "New terminal", "Fork"])
    await act(async () => host.querySelectorAll<HTMLButtonElement>('button[data-flow="diff"]')[0]!.click())
    expect(onAction.mock.calls).toEqual([["diff", { branch: "todo/12", burst: "burst-6" }]])
    onAction.mockClear()
    await act(async () => host.querySelector<HTMLButtonElement>('.branch-location button[data-flow="file"]')!.click())
    expect(onAction.mock.calls).toEqual([["file", { branch: "todo/12", path: "flows/todo/flow.ts", line: "12" }]])
    onAction.mockClear()
    await act(async () => host.querySelector<HTMLButtonElement>('.branch-muted button[data-flow="terminal.watch"]')!.click())
    expect(onAction.mock.calls).toEqual([["terminal.watch", { id: "terminal-2" }]])
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Steer"]') ?? host.querySelector<HTMLInputElement>("input")!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Check cancellation")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    onAction.mockClear()
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    expect(onAction.mock.calls).toEqual([["todo.steer", { n: "12", text: "Check cancellation" }]])
    expect(onView).toHaveBeenCalledTimes(0)
    await act(async () => root.render(<BranchView {...branchFixtures.active} actions={[]} gestures={{}} model={{ ...branchFixtures.active.model, activity: [] }} onAction={onAction} onView={onView} />))
    expect(host.querySelectorAll("button[data-flow]")).toHaveLength(0)
    expect(host.textContent).toContain("flows/todo/flow.ts:12")
    expect(host.textContent).toContain("watching Implement")
    await act(async () => root.render(<BranchView {...branchFixtures.active} view={{ maximized: false, tab: "terminals" }} onAction={onAction} onView={onView} />))
    expect(host.textContent).toContain("pnpm check")
    expect(host.textContent).toContain("Rebasing…")
    expect(host.querySelectorAll(".branch-watchers .mvp-avatar")).toHaveLength(2)
    await act(async () => root.render(<BranchView {...branchFixtures.active} view={{ maximized: false, tab: "files" }} onAction={onAction} onView={onView} />))
    expect(host.textContent).toContain("flows/todo/prompt.md → flows/todo/instructions/implementer.md")
    expect(host.querySelectorAll(".branch-list .mvp-avatar")).toHaveLength(6)
  } finally { await act(async () => root.unmount()); host.remove() }
})

test("Branch inline steer stays a placeholdered input and submits its tag", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  const onAction = mock((_tag: string, _args?: Record<string, string>) => {}), onView = mock(() => {})
  try {
    await act(async () => root.render(<BranchView {...branchFixtures.active} onAction={onAction} onView={onView} />))
    const form = host.querySelector<HTMLFormElement>('form[data-flow="todo.steer"]')!
    expect(form.querySelector("textarea")).toBeNull()
    const input = form.querySelector<HTMLInputElement>("input")!
    expect(input.tagName).toBe("INPUT")
    expect(input.placeholder).toBe("Steer the coding agent")
    expect(input.getAttribute("aria-label")).toBe("Steer the coding agent")
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Keep it small")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    expect(onAction.mock.calls).toEqual([["todo.steer", { n: "12", text: "Keep it small" }]])
    expect(onView).toHaveBeenCalledTimes(0)
  } finally { await act(async () => root.unmount()); host.remove() }
})

test("Branch conflict disables Done with its reason and retains bound revisions", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  const onAction = mock((_tag: string, _args?: Record<string, string>) => {}), onView = mock(() => {})
  try {
    await act(async () => root.render(<BranchView {...branchFixtures.scratch_conflict} onAction={onAction} onView={onView} />))
    const done = host.querySelector<HTMLButtonElement>('button[data-flow="branch.rebase"]')!
    expect(done.disabled).toBe(true); expect(host.textContent).toContain("Unresolved paths")
    await act(async () => done.click()); expect(onAction).toHaveBeenCalledTimes(0)
    await act(async () => host.querySelector<HTMLButtonElement>('button[data-flow="terminal"]')!.click())
    expect(onAction.mock.calls).toEqual([["terminal", { branch: "scratch/repro" }]])
    await act(async () => root.render(<BranchView {...branchFixtures.scratch_conflict} actions={[{ tag: "branch.rebase", label: "Done", args: { branch: "scratch/repro", conflict_change: "conflict-1", onto_revision: "main-revision" } }]} onAction={onAction} onView={onView} />))
    onAction.mockClear()
    await act(async () => host.querySelector<HTMLButtonElement>('button[data-flow="branch.rebase"]')!.click())
    expect(onAction.mock.calls).toEqual([["branch.rebase", { branch: "scratch/repro", conflict_change: "conflict-1", onto_revision: "main-revision" }]])
  } finally { await act(async () => root.unmount()); host.remove() }
})

const branchStateOracles = [
  ["awake", "Awake", "Sleep", "box.suspend", { branch: "todo/12" }],
  ["asleep", "Asleep", "Wake", "box.resume", { branch: "todo/12" }],
  ["failed", "Image build failed", "Retry", "box.resume", { branch: "todo/12" }],
  ["rebase_pending", "Rebase pending onto T8", "Rebase now", "branch.rebase-now", { branch: "todo/12" }],
  ["moved_off", "Needs you", "Return to T15", "todo.return-to-item", { n: "15" }],
] as const
for (const [key, copy, label, tag, args] of branchStateOracles) test(`Branch ${key} projects its control`, async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  const onAction = mock((_tag: string, _args?: Record<string, string>) => {}), onView = mock(() => {})
  try {
    await act(async () => root.render(<BranchView {...branchFixtures[key]} onAction={onAction} onView={onView} />))
    expect(host.textContent).toContain(copy)
    const button = [...host.querySelectorAll<HTMLButtonElement>("button[data-flow]")].find(button => button.textContent === label)!
    await act(async () => button.click())
    expect(onAction.mock.calls).toEqual([[tag, args]])
    await act(async () => root.render(<BranchView {...branchFixtures[key]} actions={[]} onAction={onAction} onView={onView} />))
    expect(host.querySelectorAll("button[data-flow]")).toHaveLength(0)
  } finally { await act(async () => root.unmount()); host.remove() }
})

test("Branch SSH copies the supplied host line without a flow", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  const writeText = mock(async (_text: string) => {})
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  const onAction = mock(() => {}), onView = mock(() => {})
  try {
    await act(async () => root.render(<BranchView {...branchFixtures.awake} onAction={onAction} onView={onView} />))
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy SSH line"]')!.click())
    expect(writeText.mock.calls).toEqual([["ssh -p 2222 todo-12@mac-mini.local"]])
    expect(onAction).toHaveBeenCalledTimes(0); expect(onView).toHaveBeenCalledTimes(0)
  } finally {
    await act(async () => root.unmount()); host.remove()
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor)
    else Reflect.deleteProperty(navigator, "clipboard")
  }
})

test("Branch activity limits embedded rows and retains full-list answer ordering", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  const onAction = mock(() => {}), onView = mock(() => {})
  try {
    await act(async () => root.render(<BranchView {...branchFixtures.active} onAction={onAction} onView={onView} />))
    expect(host.querySelectorAll(".branch-activity li[data-kind]")).toHaveLength(5)
    expect(host.querySelector(".branch-activity li")!.textContent).toBe("5 earlier")
    expect(host.textContent).not.toContain("Implement card projections")
    expect(host.querySelectorAll('.branch-activity button[data-flow="diff"]')).toHaveLength(1)
    await act(async () => root.render(<BranchView {...branchFixtures.active} view={{ tab: "activity", maximized: true }} onAction={onAction} onView={onView} />))
    expect(host.querySelectorAll(".branch-activity li[data-kind]")).toHaveLength(10)
    expect(host.textContent).toContain("Implement card projections")
    expect(host.textContent).not.toContain("5 earlier")
    expect(host.querySelectorAll(".branch-activity [data-unanswered]")).toHaveLength(0)
    const activity = branchFixtures.active.model.activity
    await act(async () => root.render(<BranchView {...branchFixtures.active} model={{ ...branchFixtures.active.model, activity: [...activity, { ...activity[2]!, id: "new-question", text: "Still waiting?" }] }} onAction={onAction} onView={onView} />))
    expect(host.querySelector(".branch-activity li")!.textContent).toBe("6 earlier")
    expect(host.querySelectorAll(".branch-activity [data-unanswered]")).toHaveLength(1)
    expect(host.querySelector(".branch-activity [data-unanswered]")!.textContent).toContain("Still waiting?")
    expect(onAction).toHaveBeenCalledTimes(0)
    expect(onView).toHaveBeenCalledTimes(0)
  } finally { await act(async () => root.unmount()); host.remove() }
})

test("Branch place, plain branch presence and unknown terminal use product copy", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  const onAction = mock(() => {}), onView = mock(() => {})
  try {
    await act(async () => root.render(<BranchView {...branchFixtures.answered} model={{ ...branchFixtures.answered.model, item: { ...branchFixtures.answered.model.item!, place: 1 } }} onAction={onAction} onView={onView} />))
    expect(host.textContent).toContain("Next to merge")
    expect(host.querySelector(".branch-presence .branch-location")).toBeNull()
    expect(host.querySelector(".branch-presence .branch-muted")!.textContent).toBe("here")
    await act(async () => root.render(<BranchView {...branchFixtures.rebase_waiting_for} model={{ ...branchFixtures.rebase_waiting_for.model, terminals: [] }} onAction={onAction} onView={onView} />))
    expect(host.querySelector(".branch-notice .branch-muted")!.textContent).toBe("Waiting for Ben · a terminal")
    expect(host.textContent).not.toContain("terminal-1")
    await act(async () => root.render(<BranchView {...branchFixtures.waking} onAction={onAction} onView={onView} />))
    expect(host.querySelector(".branch-spin")!.getAttribute("aria-hidden")).toBe("true")
  } finally { await act(async () => root.unmount()); host.remove() }
})

// T-UI-16: live updates retain the surface; gone states retain their snapshot.
import { CodeEditorView as CodeSurface } from "./CodeEditorView"
import { fixtures as liveFileFixtures } from "@smthrs/rpc/fixtures/File"
test("File live notices, snapshot and Compare use supplied data", async () => {
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  const onAction = mock((_tag: string, _args?: Record<string, string>) => {}), onView = mock((_patch: unknown) => {})
  const render = async (fixture: typeof liveFileFixtures.text) => act(async () => root.render(<CodeSurface {...fixture} onAction={onAction} onView={onView} />))
  try {
    await render(liveFileFixtures.text)
    const liveEditor = host.querySelector(".cm-editor")!
    await render(liveFileFixtures.deleted)
    expect(host.querySelector(".cm-editor")).toBe(liveEditor)
    expect(host.querySelector(".code-file-editor")!.hasAttribute("data-snapshot")).toBe(true)
    expect(host.querySelector(".code-writer")).toBeNull()
    expect(host.querySelector(".code-file-notice > span")!.textContent).toBe("Deleted by Ben")
    expect(host.querySelector(".code-snapshot-cap")!.textContent).toBe("Snapshot")
    expect(host.querySelector(".cm-content")!.textContent).toContain("Complete one TODO")
    await act(async () => host.querySelector<HTMLButtonElement>("button[data-flow]")!.click())
    expect(onAction.mock.calls).toEqual([["file.restore-deleted", { path: "flows/todo/flow.ts" }]])
    await render(liveFileFixtures.renamed)
    expect(host.querySelector(".code-file-notice > span")!.textContent).toBe("Renamed to flow.ts by Ben")
    expect(host.querySelector(".code-file-notice code")!.getAttribute("title")).toBe("flows/todo-next/flow.ts")
    await act(async () => host.querySelector<HTMLButtonElement>("button[data-flow]")!.click())
    expect(onAction.mock.calls[1]).toEqual(["file.follow-rename", { path: "flows/todo/flow.ts" }])
    await render(liveFileFixtures.comparing)
    expect(host.querySelector(".code-file-notice > span")!.textContent).toBe("Changed outside Smithers")
    expect(host.querySelector(".code-compare")).toBeNull()
    expect(host.querySelector(".code-snapshot-cap")).toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>("button[data-flow]")!.click())
    expect(onAction.mock.calls[2]).toEqual(["file.compare", { path: "flows/todo/flow.ts" }])
    await render({ ...liveFileFixtures.comparing, model: { ...liveFileFixtures.comparing.model, gone: liveFileFixtures.deleted.model.gone }, actions: [] })
    expect(host.querySelector(".code-compare")).toBeNull()
    expect(host.querySelector("button[data-flow]")).toBeNull()
    expect(host.querySelector(".code-file-notice > span")!.textContent).toBe("Deleted by Ben")
    const editor = host.querySelector(".cm-editor")!
    const scroller = host.querySelector(".cm-editor")!; scroller.scrollTop = 40
    await render({ ...liveFileFixtures.text, model: { ...liveFileFixtures.text.model, digest: "sha256:next", content: { kind: "text", text: "export const updated = true\n" } } })
    expect(host.querySelector(".cm-editor")).toBe(editor)
    expect(host.querySelector(".cm-editor")).toBe(scroller)
    expect(scroller.scrollTop).toBe(40)
    expect(host.querySelector(".cm-content")!.textContent).toContain("export const updated = true")
    expect(host.querySelector(".code-compare")).toBeNull()
    expect(onView.mock.calls).toEqual([[{ line: 1 }], [{ line: 1 }]])
  } finally { await act(async () => root.unmount()); host.remove() }
})

test("File disabled and unavailable controls cannot dispatch", async () => {
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host), onAction = mock(() => {})
  try {
    await act(async () => root.render(<CodeSurface {...liveFileFixtures.deleted} actions={liveFileFixtures.deleted.actions.map(action => ({ ...action, disabled: { reason: "Waiting for a machine" } }))} onAction={onAction} onView={() => {}} />))
    const button = host.querySelector<HTMLButtonElement>("button")!
    expect(button.disabled).toBe(true)
    expect(host.querySelector(".code-action-reason")!.textContent).toBe("Waiting for a machine")
    button.click(); expect(onAction).toHaveBeenCalledTimes(0)
    await act(async () => root.render(<CodeSurface {...liveFileFixtures.deleted} actions={[]} onAction={onAction} onView={() => {}} />))
    expect(host.querySelector("button")).toBeNull()
  } finally { await act(async () => root.unmount()); host.remove() }
})
// T-APP-14a: the restored editor stays read-only without live authority.
for (const saved of ["saving", "saved"] as const) test(`File production ignores unwired co-editing fields (${saved})`, async () => {
  const { CodeEditorView: CodeSurface } = await import("./CodeEditorView")
  const { fixtures } = await import("@smthrs/rpc/fixtures/File")
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  const onAction = mock(() => {})
  try {
    await act(async () => root.render(<CodeSurface {...fixtures.live} actions={[]} gestures={{}}
      model={{ ...fixtures.live.model, saved, unsaved: { count: 2, text: "retained edit" } }}
      onAction={onAction} onView={() => {}} />))
    expect(host.querySelector('[data-mode="read_only"]')).not.toBeNull()
    expect(host.querySelector(".cm-editor")).not.toBeNull()
    expect(host.querySelector(".cm-ySelection, .code-name-flag, .code-avatar-stack, .code-saved")).toBeNull()
    expect(host.querySelector("button, [contenteditable=true]")).toBeNull()
    expect(host.textContent).not.toMatch(/Saving|Saved to the machine|weren't saved|retained edit/)
    expect(host.querySelector("diffs-container")).toBeNull()
    expect(onAction).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); host.remove() }
})

test("File recovery renders hostile text inert and copies the literal buffer", async () => {
  const { FilePresenceView } = await import("./FilePresenceView")
  const { fixtures } = await import("@smthrs/rpc/fixtures/File")
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  const writeText = mock(async (_text: string) => {})
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  const onAction = mock((_tag: string, _args?: Record<string, string>) => {})
  try {
    await act(async () => root.render(<FilePresenceView {...fixtures.unsaved}
      model={{ ...fixtures.unsaved.model, path: "<script>throw 1</script>",
        unsaved: { count: 2, text: '<img src=x onerror="throw 2">\n<script>throw 3</script>' } }}
      actions={[{ tag: "file.reapply", label: "Reapply", args: { path: "<script>throw 1</script>" } }]}
      onAction={onAction} onView={() => {}} />))
    expect(host.querySelector("script, img")).toBeNull()
    expect(host.querySelector("h2")?.textContent).toBe("<script>throw 1</script>")
    expect(host.querySelector("pre")?.textContent).toBe('<img src=x onerror="throw 2">\n<script>throw 3</script>')
    expect(host.textContent).toContain("2 edits weren't saved")
    await act(async () => host.querySelector<HTMLButtonElement>(".code-notice button:not([data-flow])")!.click())
    expect(writeText.mock.calls).toEqual([['<img src=x onerror="throw 2">\n<script>throw 3</script>']])
    expect(onAction).not.toHaveBeenCalled()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-flow="file.reapply"]')!.click())
    expect(onAction.mock.calls).toEqual([["file.reapply", { path: "<script>throw 1</script>" }]])
  } finally {
    await act(async () => root.unmount()); host.remove()
    if (previous) Object.defineProperty(navigator, "clipboard", previous)
    else Reflect.deleteProperty(navigator, "clipboard")
  }
})

test("File Copy writes the recovered edit, with singular recovery copy", async () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const writeText = mock(async (_text: string) => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  try {
    const onAction = mock(() => {})
    const { FilePresenceView } = await import("./FilePresenceView")
    const { fileStories } = await import("./FilePresenceView.stories")
    const host = document.createElement("div"); document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(<FilePresenceView {...fileStories.unsaved_one} onAction={onAction} onView={() => {}} />))
    expect(host.textContent).toContain("1 edit wasn't saved")
    await act(async () => host.querySelector<HTMLButtonElement>('.code-notice button')!.click())
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('Recovered text')
    expect(onAction).toHaveBeenCalledTimes(0)
  } finally {
    if (previous) Object.defineProperty(navigator, 'clipboard', previous)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

describe("File presence review regressions", () => {
  test("presence without binding shares undelegated agent colour with avatar", async () => {
    const { FilePresenceView } = await import("./FilePresenceView")
    const { fixtures } = await import("@smthrs/rpc/fixtures/File")
    const agent = { kind: "agent" as const, agent: "coding" as const, id: "agent-1", avatar_url: "", name: "Agent", color_index: 2 as const }
    const host = document.createElement("div"); document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(<FilePresenceView {...fixtures.live} model={{ ...fixtures.live.model, editors: [{ actor: agent, line: 1 }] }} onAction={() => {}} onView={() => {}} />))
    expect(host.querySelector(".code-name-flag")).not.toBeNull()
    const flag = host.querySelector<HTMLElement>(".code-name-flag")!
    const avatar = host.querySelector<HTMLElement>(".code-avatar-stack .mvp-avatar")!
    expect(flag.style.getPropertyValue("--who")).toBe("var(--lane-6)")
    expect(flag.style.getPropertyValue("--who")).toBe(avatar.style.getPropertyValue("--who"))
    expect(host.querySelector(".cm-editor")).toBeNull()
    await act(async () => root.unmount())
  })
  test("recovery notice owns primary Reapply and reports Copy failure", async () => {
    const { stories } = await import("./FilePresenceView.stories")
    const { host, onAction, close } = await mounted(stories.find(story => story.name === "unsaved")!)
    const action = host.querySelector<HTMLButtonElement>('.code-notice [data-flow="file.reapply"]')!
    expect(action.dataset.primary).toBe("true")
    await act(async () => action.click())
    expect(onAction.mock.calls).toEqual([["file.reapply", { path: "flows/todo/flow.ts" }]])
    const write = spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("unavailable"))
    const exec = Object.getOwnPropertyDescriptor(document, "execCommand")
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false })
    try {
      await act(async () => host.querySelector<HTMLButtonElement>(".code-notice button")!.click())
      expect(write).toHaveBeenCalledWith('  description: "Build",\n')
      expect(host.querySelector('[role="status"]')?.textContent).toBe("Copy failed")
    } finally {
      write.mockRestore()
      if (exec) Object.defineProperty(document, "execCommand", exec)
      else delete (document as unknown as Record<string, unknown>).execCommand
      await close()
    }
  })
  test("outside notice owns Compare", async () => {
    const { stories } = await import("./FilePresenceView.stories")
    const { host, close } = await mounted(stories.find(story => story.name === "outside")!)
    expect(host.querySelector('.code-notice[data-tone="outside"] [data-flow="file.compare"]')?.textContent).toBe("Compare")
    expect(host.querySelector(".code-actions")).toBeNull()
    await close()
  })
})
test("File editor avatars overlap and cap at four", async () => {
  const { stories } = await import("./FilePresenceView.stories")
  const { host, close } = await mounted(stories.find(story => story.name === "five_editors")!)
  expect(host.querySelectorAll(".code-avatar-stack .mvp-avatar")).toHaveLength(4)
  expect(host.querySelector(".code-avatar-stack")?.textContent).toContain("+1")
  expect(host.querySelector(".code-avatar-stack")?.getAttribute("aria-label")).toBe("Ben, Claude Code for Ben, Ben, Claude Code for Ben, Ben")
  await close()
})
test("File over-limit text uses the co-editing limit copy", async () => {
  const { stories } = await import("./FilePresenceView.stories")
  const { host, close } = await mounted(stories.find(story => story.name === "too_large")!)
  expect(host.querySelector(".code-file-size")?.textContent).toContain("Too large to co-edit · 2.4 MB")
  expect(host.querySelector('[data-slot="code-view"]')).toBeNull()
  await close()
})

// T-UI-20: proposal evidence remains inspectable after acceptance.
import { ProposalView, LessonsReceiptView } from "./ProposalView"
import { fixtures as proposalFixtures, receipts as lessonFixtures } from "@smthrs/rpc/fixtures/Proposal"

test("Proposal evidence starts open only before acceptance; refs retain destinations", async () => {
  const host = document.createElement("div")
  const root = createRoot(host)
  const callbacks = { onAction: mock(() => {}), onView: mock(() => {}) }
  try {
    await act(async () => root.render(<ProposalView {...proposalFixtures.open} {...callbacks} />))
    expect(host.querySelector("details")?.open).toBe(true)
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://github.com/smithersai/smithers/pull/3474")
    await act(async () => root.render(<ProposalView {...proposalFixtures.accepted} {...callbacks} />))
    expect(host.querySelector("details")?.open).toBe(false)
    expect(host.textContent).toContain("T14 · Keep completion receipts in toasts")
    expect(host.querySelectorAll("button")).toHaveLength(0)
    await act(async () => root.render(<ProposalView {...proposalFixtures.dismissed} {...callbacks} />))
    expect(host.textContent).toContain("Dismissed")
    expect(host.querySelector("details")?.open).toBe(false)
    expect(callbacks.onAction).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()) }
})

test("Lessons receipt names pages without inventing navigation", async () => {
  const host = document.createElement("div")
  const root = createRoot(host)
  try {
    await act(async () => root.render(<LessonsReceiptView {...lessonFixtures.lessons} onAction={() => {}} onView={() => {}} />))
    expect(host.textContent).toBe("2 lessonsRetry policyKeep completion receipts")
    expect(host.querySelectorAll("button")).toHaveLength(0)
    expect(host.querySelector("[data-state]")).toBeNull()
    expect(host.querySelector("[data-keyboard-pane]")).toBeNull()
    await act(async () => root.render(<LessonsReceiptView {...lessonFixtures.lessons} model={{ todo: 12, lessons: [] }} onAction={() => {}} onView={() => {}} />))
    expect(host.innerHTML).toBe("")
  } finally { await act(async () => root.unmount()) }
})

// T-UI-21: document safety at the actual wiki-adapter boundary, plus absent gestures.
import { DocsView } from "./DocsView"
import { fixtures as docsFixtures } from "@smthrs/rpc/fixtures/Docs"
describe("DocsView", () => {
  test("raw HTML stays inert in the read-only document", async () => {
    const fixture = { ...docsFixtures.hostile, model: { ...docsFixtures.hostile.model, page: {
      ...docsFixtures.hostile.model.page,
      markdown: docsFixtures.hostile.model.page.markdown + "\n`a < b`\n\n```html\n<div>example</div>\n```\n"
    } } }
    const rendered = await mounted({ name: "hostile", expect: [], render: callbacks => <DocsView {...fixture} {...callbacks} /> })
    try {
      expect(rendered.host.querySelector("script,img,iframe")).toBeNull()
      const source = rendered.host.querySelector<HTMLTextAreaElement>("textarea")!
      expect(source.readOnly).toBe(true)
      expect(source.value).toContain("    <div>")
      expect(source.value).not.toContain("# Quickstart")
      expect([...rendered.host.querySelectorAll("h1,h2")].filter(h => h.textContent === "Quickstart")).toHaveLength(1)
      expect(source.value).not.toContain("javascript:")
      expect(source.value).toContain("Reference")
      expect(source.value).not.toContain("[r]")
      expect(source.value).toContain("<script>alert(1)</script>")
      expect(source.value).toContain("<img src=x onerror=alert(1)>")
      expect(source.value).toContain("`a < b`")
      expect(source.value).toContain("```html\n<div>example</div>\n```")
      await act(async () => rendered.host.querySelectorAll<HTMLAnchorElement>("nav a")[1]!.click())
      expect(rendered.onAction.mock.calls).toEqual([["docs", { source: "docs-card", page: "todos" }]])
    } finally { await rendered.close() }
  })
  test("absent and disabled navigation cannot dispatch", async () => {
    for (const fixture of [docsFixtures.inert, docsFixtures.disabled]) {
      const rendered = await mounted({ name: "inert", expect: [], render: callbacks => <DocsView {...fixture} {...callbacks} /> })
      try {
        const buttons = [...rendered.host.querySelectorAll<HTMLAnchorElement>("nav a")]
        expect(buttons.map(button => button.getAttribute("aria-disabled"))).toEqual(fixture === docsFixtures.inert ? [] : ["true", "true", "true"])
        await act(async () => buttons[1]?.click())
        expect(rendered.onAction).toHaveBeenCalledTimes(0)
        if (fixture === docsFixtures.disabled) expect(rendered.host.textContent).toContain("Unavailable")
      } finally { await rendered.close() }
    }
  })
  test("supplied actions retain order, args, and disabled reason", async () => {
    const actions: import("@smthrs/rpc/CardAction").Action[] = [
      { tag: "docs", label: "Open", args: { page: "flows", source: "button" } },
      { tag: "docs", label: "Retry", disabled: { reason: "Unavailable" } },
    ]
    const rendered = await mounted({ name: "actions", expect: [], render: callbacks => <DocsView {...docsFixtures.page} actions={actions} {...callbacks} /> })
    try {
      const buttons = [...rendered.host.querySelectorAll<HTMLButtonElement>("footer button")]
      expect(buttons.map(button => button.textContent)).toEqual(["Open", "Retry"])
      await act(async () => { buttons[0]!.click(); buttons[1]!.click() })
      expect(rendered.onAction.mock.calls).toEqual([["docs", { page: "flows", source: "button" }]])
      expect(buttons[1]!.disabled).toBe(true)
      expect(rendered.host.querySelector("footer")?.textContent).toBe("OpenRetryUnavailable")
    } finally { await rendered.close() }
  })
  test("missing page shows the requested slug and supplied fallback", async () => {
    const rendered = await mounted({ name: "missing", expect: [], render: callbacks => <DocsView {...docsFixtures.not_found} {...callbacks} /> })
    try {
      expect(rendered.host.querySelector(".mvp-docs-missing")?.textContent).toBe("Page not found: deploy-to-kubernetes")
      expect(rendered.host.querySelector("h2")?.textContent).toBe("Quickstart")
      expect(rendered.host.querySelector('[aria-current="page"]')?.textContent).toBe("Quickstart")
    } finally { await rendered.close() }
  })
})

import { stories as debugStories } from "./DebugApiView.stories"
import { DebugApiView } from "./DebugApiView"
describe("DebugApiView", () => {
  test("selection projects persisted view state and action removal on the same mount", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const onAction = mock(() => {})
    const onView = mock((_patch: Record<string, unknown>) => {})
    const props = {
      model: { operations: [
        { id: "health", method: "GET" as const, path: "/api/health", summary: "Health", group: "Install" },
        { id: "settings", method: "PATCH" as const, path: "/api/settings", summary: "Settings", group: "Install" }
      ], selected: "health" },
      view: { maximized: false, selected: "settings" }, gestures: {},
      actions: [{ tag: "debug-api" as const, label: "Send", args: { operation: "settings" } }], onAction, onView
    }
    try {
      await act(async () => root.render(<DebugApiView {...props} />))
      expect(host.querySelector('nav button[aria-pressed="true"]')!.textContent).toBe("PATCH /api/settingsSettings")
      const health = host.querySelector<HTMLButtonElement>("nav button")!
      health.focus()
      expect(document.activeElement).toBe(health)
      expect(health.type).toBe("button")
      await act(async () => health.click())
      expect(onView.mock.calls).toEqual([[{ selected: "health" }]])
      expect(onAction).toHaveBeenCalledTimes(0)
      await act(async () => root.render(<DebugApiView {...props} actions={[]} view={{ maximized: false, selected: "health" }} />))
      expect(host.querySelector('nav button[aria-pressed="true"]')!.textContent).toBe("GET /api/healthHealth")
      expect(host.querySelector("button[data-flow]")).toBeNull()
      expect(onAction).toHaveBeenCalledTimes(0)
    } finally { await act(async () => root.unmount()); host.remove() }
  })

  for (const story of debugStories) test(story.name, async () => {
    const { host, root, onView, onAction, close } = await mounted(story)
    try {
      if (story.name === "empty") {
        expect(host.textContent).toContain("No operations")
        expect(host.querySelectorAll("nav button")).toHaveLength(0)
        expect(host.querySelectorAll("button[data-flow]")).toHaveLength(0)
      }
      expect(onAction).toHaveBeenCalledTimes(0)
      await act(async () => root.render(story.render({ onAction, onView })))
      expect(onAction).toHaveBeenCalledTimes(0)
      if (story.name === "unauthorized") expect(host.textContent).toContain("unauthorized · 401")
      if (story.name === "forbidden") {
        expect(host.textContent).toContain("forbidden · 403")
        expect(host.textContent).toContain("Access denied")
      }
      if (story.name === "hostile") {
        expect(host.textContent).toContain('<img src=x onerror="window.__pwned=1">')
        expect(host.textContent).toContain('<script>window.__pwned=1</script>')
        expect(host.querySelector("img, script")).toBeNull()
        expect(Reflect.get(window, "__pwned")).toBeUndefined()
      }
      const operationIds = ["getHealth", "getTodo", "dropTodo", "headTodo", "putSecret", "deleteSecret", "patchSettings"]
      for (const [index, button] of [...host.querySelectorAll<HTMLButtonElement>("nav button")].entries()) {
        onView.mockClear()
        await act(async () => button.click())
        expect(onView.mock.calls).toEqual([[{ selected: operationIds[index] }]])
        expect(onAction).toHaveBeenCalledTimes(0)
      }
      // Restore the fixture before testing its form; selection clears local drafts.
      const fresh = await mounted(story)
      try {
        if (story.name === "disabled") {
          expect(fresh.host.textContent).toContain("Sign in again")
          expect(fresh.host.querySelector<HTMLButtonElement>("button[data-flow]")!.disabled).toBe(true)
          expect(fresh.host.querySelector<HTMLInputElement>("input")!.disabled).toBe(true)
          await act(async () => fresh.host.querySelector<HTMLButtonElement>("button[data-flow]")!.click())
          await act(async () => fresh.host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
          expect(fresh.onAction).toHaveBeenCalledTimes(0)
        }
        for (const form of story.name === "disabled" ? [] : fresh.host.querySelectorAll<HTMLFormElement>("form")) {
          await act(async () => {
            for (const field of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea")) {
              const prototype = field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
              Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, field.tagName === "TEXTAREA" ? '{"capacity":2}' : "12")
              field.dispatchEvent(new Event("change", { bubbles: true }))
              field.dispatchEvent(new Event("input", { bubbles: true }))
            }
          })
          await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
          expect(fresh.onAction).toHaveBeenCalledTimes(1)
          const expected: Record<string, string> = story.name.startsWith("pending_") ? { operation: ({ pending_mutation: "dropTodo", pending_put: "putSecret", pending_patch: "patchSettings", pending_delete: "deleteSecret" } as Record<string, string>)[story.name]!, confirm: "true" } : story.name === "patch_body" ? { operation: "patchSettings", body: '{"capacity":2}' } : { operation: "getTodo", n: "12" }
          expect(fresh.onAction.mock.calls[0]).toEqual(["debug-api", expected])
        }
        if (story.name === "get_200") {
          expect(fresh.host.textContent).toContain("200 · 18 ms")
          expect(fresh.host.textContent).toContain("content-typeapplication/json")
          expect(fresh.host.querySelector("pre")!.textContent).toBe('{"n":12,"state":"working"}')
          expect(fresh.host.querySelector("input")!.required).toBe(true)
        }
        if (story.name === "patch_body") expect(fresh.host.querySelector("textarea")!.required).toBe(true)
        if (story.name.startsWith("pending_")) {
          expect(fresh.host.querySelectorAll("button[data-flow]")).toHaveLength(1)
          const labels: Record<string, string> = { pending_mutation: "Confirm POST /api/todos/12/drop", pending_put: "Confirm PUT /api/secrets/key", pending_patch: "Confirm PATCH /api/settings", pending_delete: "Confirm DELETE /api/secrets/key" }
          expect(fresh.host.querySelector("button[data-flow]")!.textContent).toBe(labels[story.name])
        }
        if (story.name.startsWith("pending_")) expect(fresh.host.querySelector('[aria-label="Exchange"]')).toBeNull()
      } finally { await fresh.close() }
      const removed = await mounted(story, true)
      try { expect(removed.host.querySelector("button[data-flow]")).toBeNull() }
      finally { await removed.close() }

    } finally { await close() }
  })
})

// T-UI-15: literal projection oracles supplement the reused stories.
for (const [key, text] of [
  ["waking", "Waking"], ["waiting", "Waiting for a machine · #2"], ["closed", "Closed"],
  ["rebasing", "Rebasing… onto T8"], ["scratch_main", "Forked from main"],
  ["scratch_item", "Forked from T12 Card model contracts"], ["scratch_branch", "Forked from scratch/repro"],
] as const) test(`Branch ${key} literal state`, async () => {
  const item = await mounted({ name: key, expect: [], render: callbacks => <BranchView {...branchFixtures[key]} {...callbacks} /> })
  try {
    expect(item.host.textContent).toContain(text)
    expect(item.onAction).toHaveBeenCalledTimes(0)
    expect(item.onView).toHaveBeenCalledTimes(0)
  } finally { await item.close() }
})

test("Branch hostile display data opens no connection or mount callback", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => { throw new Error("View fetched") }, { preconnect: fetch.preconnect }))
  const socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")!
  const socketSpy = mock(() => { throw new Error("View connected") })
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: socketSpy })
  const hostile = '<script>alert("branch")</script><img src=x onerror=alert(1)>'
  const base = branchFixtures.active
  const item = await mounted({ name: "hostile", expect: [], render: callbacks => <BranchView {...base} {...callbacks}
    model={{ ...base.model, name: hostile, presence: [{ ...base.model.presence[0]!, where: { kind: "file", path: hostile } }],
      activity: [{ ...base.model.activity[0]!, text: hostile }], changed_files: [{ path: hostile, change: "added", authors: [] }] }} /> })
  try {
    expect(item.host.textContent).toContain(hostile)
    expect(item.host.querySelectorAll("script, img[src=x]")).toHaveLength(0)
    expect(fetchSpy).toHaveBeenCalledTimes(0)
    expect(socketSpy).toHaveBeenCalledTimes(0)
    expect(item.onAction).toHaveBeenCalledTimes(0)
    expect(item.onView).toHaveBeenCalledTimes(0)
  } finally { await item.close(); fetchSpy.mockRestore(); Object.defineProperty(globalThis, "WebSocket", socketDescriptor) }
})

test("Branch disabled location and watcher gestures refuse activation", async () => {
  const item = await mounted({ name: "disabled", expect: [], render: callbacks => <BranchView {...branchFixtures.active} {...callbacks}
    gestures={{ file: { tag: "file", label: "Open", disabled: { reason: "Access refused" } },
      terminal: { tag: "terminal.watch", label: "Watch", disabled: { reason: "Access refused" } } }} /> })
  try {
    for (const button of item.host.querySelectorAll<HTMLButtonElement>(".branch-presence button")) {
      expect(button.disabled).toBe(true)
      await act(async () => button.click())
    }
    expect(item.onAction).toHaveBeenCalledTimes(0)
  } finally { await item.close() }
})

for (const key of ["awake", "asleep", "waking", "waiting", "closed", "failed", "moved_off", "rebase_pending", "scratch_conflict"] as const)
  test(`Branch ${key} copy blocks use product words`, async () => {
    const item = await mounted({ name: key, expect: [], render: callbacks => <BranchView {...branchFixtures[key]} {...callbacks} /> })
    try {
      const banned = /\b(workflows?|threads?|tasks?|lanes?|boxes?|workspaces?|mythicals?|sandboxes?|VMs?|seats?|profiles?|Jev|forges?)\b/i
      for (const block of item.host.querySelectorAll("h2, button, label, .branch-machine, .branch-notice > span, .branch-notice > b, .branch-item > span")) {
        expect(block.textContent).not.toMatch(banned)
        expect(block.textContent!.trim().split(/\s+/).length).toBeLessThanOrEqual(12)
        expect((block.textContent!.match(/[!?]|\.(?:\s|$)/g) ?? []).length).toBeLessThanOrEqual(1)
      }
    } finally { await item.close() }
  })

// Literal oracles for T-UI-18; no fixture expectations or schemas supply these cases.
describe("SecretsView write-only controls", () => {
  const add: Action = { tag: "secrets.set", label: "Add", input: [
    { name: "name", label: "Name", kind: "text", required: true },
    { name: "value", label: "Value", kind: "secret", required: true, value: "never-prefill" },
    { name: "scope", label: "Scope", kind: "choice", required: true, choices: ["all_branches", "main_only"] },
    { name: "hosts", label: "Hosts", kind: "text", required: false }
  ] }
  async function mount(model: SecretsViewProps["model"], actions: Action[] = []) {
    return mounted({ name: "literal", expect: [], render: callbacks => <SecretsView model={model} actions={actions} gestures={{}} view={{ maximized: false }} {...callbacks} /> })
  }
  async function fill(host: HTMLElement, label: string, value: string) {
    const input = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!
    await act(async () => {
      Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value)
      input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }))
    })
  }
  test("empty list and member with no actions render no controls", async () => {
    for (const secrets of [[], [{ name: "NPM_TOKEN", scope: "all_branches" as const, actions: [] }]]) {
      const m = await mount({ secrets })
      try { expect(m.host.querySelectorAll("button,input,select,summary")).toHaveLength(0); expect(m.host.textContent).toContain("Secrets") }
      finally { await m.close() }
    }
  })
  test("both scope words and hostile names render as text", async () => {
    const m = await mount({ secrets: [
      { name: '<img src=x onerror="alert(1)">', scope: "all_branches", hosts: ["<script>evil</script>"], actions: [] },
      { name: "RELEASE_TOKEN", scope: "main_only", actions: [] }
    ] })
    try {
      expect(m.host.textContent).toContain('<img src=x onerror="alert(1)">')
      expect(m.host.textContent).toContain("all branches")
      expect(m.host.textContent).toContain("main only")
      expect(m.host.querySelector("img,script")).toBeNull()
    } finally { await m.close() }
  })
  for (const replace of [false, true]) test(`${replace ? "Replace" : "Add"} inputs, optional Hosts, submit and cancel clear Value`, async () => {
    const action: Action = replace ? { ...add, label: "Replace", args: { name: "STRIPE_KEY" }, input: add.input!.slice(1) } : add
    const m = await mount({ secrets: replace ? [{ name: "STRIPE_KEY", scope: "main_only", actions: [action] }] : [] }, replace ? [] : [action])
    try {
      const password = m.host.querySelector<HTMLInputElement>('input[type="password"]')!
      expect(password.value).toBe("")
      expect(m.host.querySelector("form")!.dataset.flow).toBe("secrets.set")
      if (!replace) await fill(m.host, "Name", "NEW_TOKEN")
      await fill(m.host, "Value", "literal-write")
      await fill(m.host, "Scope", "main_only")
      await fill(m.host, "Hosts", "<script>evil</script>")
      expect(m.host.querySelector("script")).toBeNull()
      await act(async () => m.host.querySelector<HTMLButtonElement>('button[type="button"]')!.click())
      expect(password.value).toBe("")
      expect(m.onAction).toHaveBeenCalledTimes(0)
      if (!replace) await fill(m.host, "Name", "NEW_TOKEN")
      await fill(m.host, "Value", "literal-write")
      await fill(m.host, "Scope", "main_only")
      await fill(m.host, "Hosts", "api.example.com")
      await act(async () => m.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
      expect(m.onAction).toHaveBeenCalledTimes(1)
      const [tag, args] = m.onAction.mock.calls[0]!
      expect(tag).toBe("secrets.set")
      // Compare the secret in memory without recording it in assertion output.
      expect(args?.value === "literal-write").toBe(true)
      expect<Record<string, string>>({ ...args, value: "[redacted]" }).toEqual({ name: replace ? "STRIPE_KEY" : "NEW_TOKEN", value: "[redacted]", scope: "main_only", hosts: "api.example.com" })
      m.onAction.mockClear()
      expect(password.value).toBe("")
      expect(m.onView).toHaveBeenCalledTimes(0)
    } finally { m.onAction.mockClear(); await m.close() }
  })
  test("disabled Add and Delete refuse clicks and form submission", async () => {
    const m = await mount({ secrets: [{ name: "DEPLOY_TOKEN", scope: "main_only", actions: [{ tag: "secrets.delete", label: "Delete", args: { name: "DEPLOY_TOKEN" }, disabled: { reason: "Change pending" } }] }] }, [{ ...add, disabled: { reason: "Change pending" } }])
    try {
      for (const form of m.host.querySelectorAll("form")) await act(async () => {
        form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      })
      expect(m.host.querySelectorAll("input:disabled,select:disabled")).toHaveLength(4)
      expect(m.onAction).toHaveBeenCalledTimes(0)
    } finally { await m.close() }
  })
  test("Delete forwards supplied name exactly once", async () => {
    const m = await mount({ secrets: [{ name: "TOKEN", scope: "main_only", actions: [{ tag: "secrets.delete", label: "Delete", args: { name: "TOKEN" } }] }] })
    try {
      await act(async () => m.host.querySelector<HTMLButtonElement>("button")!.click())
      expect(m.onAction.mock.calls).toEqual([["secrets.delete", { name: "TOKEN" }]])
    } finally { await m.close() }
  })
})

test("Secrets stories keep minimal product copy and redact submitted values", async () => {
  for (const story of secretsStories) {
    const m = await mounted(story)
    try {
      const forbidden = /\b(workflows?|threads?|tasks?|lanes?|boxes?|workspaces?|mythical|sandboxes?|VMs?|seats?|profiles?|Jev|forges?)\b/i
      expect(m.host.textContent).not.toMatch(forbidden)
      for (const block of m.host.querySelectorAll("p,li,h2,label,button,td")) {
        expect(block.textContent!.trim().split(/\s+/).length).toBeLessThanOrEqual(12)
      }
      if (story.name === "no_hosts_field") expect(m.host.querySelector('[aria-label="Hosts"]')).toBeNull()
      if (story.name === "empty") {
        for (const [label, value] of [["Name", "NEW_TOKEN"], ["Value", "write-only"]]) {
          const input = m.host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
          await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
            input.dispatchEvent(new Event("input", { bubbles: true }))
          })
        }
        await act(async () => m.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
        expect(m.onAction.mock.calls).toEqual([["secrets.set", { name: "NEW_TOKEN", value: "[redacted]", scope: "all_branches", hosts: "" }]])
      }
    } finally { await m.close() }
  }
})

import { fixtures as homeFixtures } from "@smthrs/rpc/fixtures/Home"
import type { HomeViewProps } from "@smthrs/rpc/HomeCard"
import { HomeView } from "./HomeView"
import { useState } from "react"
describe("HomeView", () => {
  const withBranch = (): HomeViewProps["model"] => {
    const base = homeFixtures.active.model
    const row = base.items[0]!
    return { ...base, attention: [], background_runs: [], items: [{ ...row, actions: [{ tag: "branch", label: row.branch.name, args: { n: String(row.n), door: "branch" } }] }] }
  }
  test("the branch chip dispatches the row's own branch action; a row without one shows its name as text", async () => {
    const host = document.createElement("div"); document.body.append(host)
    const root = createRoot(host)
    const onAction = mock((_tag: string, _args?: Record<string, string>) => {})
    const onView = mock((_patch: Record<string, unknown>) => {})
    const model = withBranch()
    const row = model.items[0]!
    try {
      await act(async () => root.render(<HomeView model={model} actions={[]} gestures={{}} view={{ maximized: false }} onAction={onAction} onView={onView} />))
      const chip = host.querySelector<HTMLButtonElement>(".mvp-stack-row button.mvp-branch-chip")!
      expect(chip.dataset.flow).toBe("branch")
      expect(chip.textContent).toBe(row.branch.name)
      // The chip is the branch action's only control: it is not repeated among the row's end actions.
      expect(host.querySelectorAll('.mvp-row-end [data-flow="branch"]')).toHaveLength(0)
      await act(async () => chip.click())
      expect(onAction.mock.calls).toEqual([["branch", { n: String(row.n), door: "branch" }]])
      expect(onView).toHaveBeenCalledTimes(0)
      await act(async () => root.render(<HomeView model={{ ...model, items: [{ ...row, actions: [] }] }} actions={[]} gestures={{}} view={{ maximized: false }} onAction={onAction} onView={onView} />))
      expect(host.querySelector(".mvp-branch-chip")).toBeNull()
      expect(host.querySelector(".mvp-where")?.firstChild?.nodeType).toBe(Node.TEXT_NODE)
      expect(host.querySelector(".mvp-where")?.firstChild?.textContent).toBe(row.branch.name)
    } finally { await act(async () => root.unmount()); host.remove() }
  })

  test("visibility reports only changes, through one observer, even when every report re-renders with a new onView", async () => {
    const observers: Array<{ callback: (entries: Array<{ isIntersecting: boolean }>) => void; disconnected: boolean }> = []
    const original = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    Object.assign(globalThis, { IntersectionObserver: class {
      record: { callback: (entries: Array<{ isIntersecting: boolean }>) => void; disconnected: boolean }
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { this.record = { callback, disconnected: false }; observers.push(this.record) }
      observe() {}
      disconnect() { this.record.disconnected = true }
    } })
    const patches: unknown[] = []
    let renders = 0
    const Parent = ({ initial }: { readonly initial: HomeViewProps["view"] }) => {
      const [view, setView] = useState(initial)
      renders += 1
      // A careless parent: a fresh callback identity on every render that replaces state unconditionally.
      return <HomeView model={withBranch()} actions={[]} gestures={{}} view={view} onAction={() => {}}
        onView={patch => { patches.push(patch); setView(current => ({ ...current, ...patch })) }} />
    }
    const host = document.createElement("div"); document.body.append(host)
    const root = createRoot(host)
    const report = async (isIntersecting: boolean) => { await act(async () => observers.at(-1)!.callback([{ isIntersecting }])) }
    try {
      await act(async () => root.render(<Parent initial={{ maximized: false }} />))
      await report(true)
      await report(true)
      await report(true)
      await report(false)
      await report(false)
      expect(patches).toEqual([{ on_screen: true }, { on_screen: false }])
      expect(observers).toHaveLength(1)
      expect(observers[0]!.disconnected).toBe(false)
      expect(renders).toBeLessThan(6)
      await act(async () => root.unmount())
      expect(observers[0]!.disconnected).toBe(true)
      // A view that already says on screen needs no first report.
      const again = createRoot(host)
      patches.length = 0
      await act(async () => again.render(<Parent initial={{ maximized: false, on_screen: true }} />))
      await report(true)
      expect(patches).toEqual([])
      await act(async () => again.unmount())
    } finally {
      host.remove()
      if (original === undefined) delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
      else Object.assign(globalThis, { IntersectionObserver: original })
    }
  })
})

// T-UI-16: literal inputs keep presentation expectations independent of shared fixtures.
test("File literal live states preserve the selected line and data-only snapshot", async () => {
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host), calls: unknown[] = []
  const model: import("@smthrs/rpc/FileCard").FileCard = {
    path: "src/keep.ts", branch: "scratch/alice", language: "typescript", digest: "blob-before",
    content: { kind: "text", text: 'const first = 1\n<script>alert("file")</script>\n' },
    mode: "read_only", diagnostics: [], authors: [], editors: [],
    gone: { kind: "deleted", by: { kind: "person", login: "alice", name: "Alice", avatar_url: "https://example.com/alice.png", color_index: 0 } },
  }
  const callbacks = { onAction: (...args: unknown[]) => calls.push(args), onView: () => {} }
  const draw = (next: typeof model, actions: Action[]) => act(async () => root.render(
    <CodeSurface model={next} actions={actions} gestures={{}} view={{ maximized: false, line: 2 }} {...callbacks} />))
  try {
    await draw(model, [{ tag: "file.restore-deleted", label: "Restore", args: { path: "src/keep.ts" } }])
    expect(host.querySelector(".code-file-notice > span")?.textContent).toBe("Deleted by Alice")
    expect(host.querySelector(".code-snapshot-cap")?.textContent).toBe("Snapshot")
    expect(host.querySelector(".cm-content")?.textContent).toContain('<script>alert("file")</script>')
    expect(host.querySelector("script")).toBeNull()
    const editor = host.querySelector<HTMLElement>(".cm-editor")!
    editor.scrollTop = 67
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click())
    await draw({ ...model, gone: { kind: "renamed", to: "src/next.ts", by: { kind: "person", login: "alice", name: "Alice", avatar_url: "https://example.com/alice.png", color_index: 0 } } },
      [{ tag: "file.follow-rename", label: "Follow", args: { path: "src/keep.ts" } }])
    expect(host.querySelector(".code-file-notice > span")?.textContent).toBe("Renamed to next.ts by Alice")
    expect(host.querySelector(".code-file-notice code")?.getAttribute("title")).toBe("src/next.ts")
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click())
    await draw({ ...model, gone: undefined, digest: "blob-after", content: { kind: "text", text: "const first = 2\nconst second = 3\n" }, outside: { version: "outside-42", at: "2026-10-04T10:00:00Z" } },
      [{ tag: "file.compare", label: "Compare", args: { path: "src/keep.ts" } }])
    expect(host.querySelector(".code-file-notice > span")?.textContent).toBe("Changed outside Smithers")
    expect(host.querySelector(".cm-editor")).toBe(editor)
    expect(editor.scrollTop).toBe(67)
    expect(host.querySelector(".cm-content")?.textContent).toContain("const second = 3")
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click())
    expect(calls).toEqual([
      ["file.restore-deleted", { path: "src/keep.ts" }],
      ["file.follow-rename", { path: "src/keep.ts" }],
      ["file.compare", { path: "src/keep.ts" }],
    ])
    for (const label of ["Deleted by Alice", "Renamed to next.ts by Alice", "Changed outside Smithers", "Snapshot", "Restore", "Follow", "Compare"]) {
      expect(label.split(/\s+/).length).toBeLessThanOrEqual(12)
      expect(label).not.toMatch(/\b(workflows?|threads?|tasks?|lanes?|boxes?|workspaces?|mythical|sandboxes?|VMs?|seats?|profiles?|Jev|forges?)\b/i)
    }
    await draw(model, [])
    expect(host.querySelector("button")).toBeNull()
  } finally { await act(async () => root.unmount()); host.remove() }
})

test("Diff literal revisions and bytes never offer Restore outside a burst", async () => {
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host), calls: unknown[] = []
  const model: import("@smthrs/rpc/DiffCard").DiffCard = {
    path: "assets/old.bin", renamed_to: "assets/new.bin", branch: "scratch/alice", change: "renamed",
    against: { kind: "item_base", rev: "candidate-17" }, binary: { before_bytes: 2000, after_bytes: 3000 }, hunks: [],
  }
  const draw = (against: typeof model.against, actions: Action[]) => act(async () => root.render(
    <DiffCardSurface model={{ ...model, against }} actions={actions} gestures={{}} view={{ maximized: false }} onAction={(...args) => calls.push(args)} onView={() => {}} />))
  const restore: Action = { tag: "file.restore", label: "Restore this file", args: { path: "assets/old.bin", revision: "burst-42" } }
  try {
    for (const against of [{ kind: "item_base", rev: "candidate-17" }, { kind: "fork", rev: "fork-23" }] as const) {
      await draw(against, [restore])
      expect(host.querySelector(".code-diff-base")?.textContent).toBe(against.rev)
      expect(host.querySelector("h2")?.textContent).toBe("assets/new.bin")
      expect(host.querySelector(".code-file-size")?.textContent).toBe("Binary file · 2.0 kB → 3.0 kB")
      expect(host.querySelector("button")).toBeNull()
    }
    const burst = { kind: "burst", burst: "burst-42", actor: { kind: "outside", color_index: 7 }, at: "2026-10-04T10:00:00Z" } as const
    await draw(burst, [restore])
    const surface = host.querySelector("section")!
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click())
    expect(calls).toEqual([["file.restore", { path: "assets/old.bin", revision: "burst-42" }]])
    await draw(burst, [{ ...restore, disabled: { reason: "Revision changed" } }])
    host.querySelector<HTMLButtonElement>("button")!.click()
    expect(calls).toHaveLength(1)
    expect(host.querySelector("section")).toBe(surface)
    await draw(burst, [])
    expect(host.querySelector("button")).toBeNull()
  } finally { await act(async () => root.unmount()); host.remove() }
})

test("Diff patch reload retains its mounted surface and scroll", async () => {
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  const model: import("@smthrs/rpc/DiffCard").DiffCard = {
    path: "src/reload.ts", branch: "scratch/alice", change: "modified", against: { kind: "fork", rev: "fork-23" },
    hunks: [{ old_start: 1, new_start: 1, lines: [{ op: "-", text: "const value = 1" }, { op: "+", text: "const value = 2" }] }],
  }
  const draw = (next: typeof model) => act(async () => root.render(<DiffCardSurface model={next} actions={[]} gestures={{}}
    view={{ maximized: false }} onAction={() => {}} onView={() => {}} />))
  try {
    await draw(model)
    const card = host.querySelector<HTMLElement>("section")!
    const diff = host.querySelector("diffs-container")!
    expect(diff).not.toBeNull()
    card.scrollTop = 43
    await draw({ ...model, hunks: [{ old_start: 1, new_start: 1, lines: [{ op: "-", text: "const value = 1" }, { op: "+", text: "const value = 3" }] }] })
    expect(host.querySelector("section")).toBe(card)
    expect(host.querySelector("diffs-container")).toBe(diff)
    expect(card.scrollTop).toBe(43)
    expect(host.querySelector(".code-diff-base")?.textContent).toBe("fork-23")
  } finally { await act(async () => root.unmount()); host.remove() }
})

// T-UI-20: literal DOM oracles for Proposal, the lessons receipt and the shared count.
import { fixtures as homeReceiptFixtures } from "@smthrs/rpc/fixtures/Home"

test("Proposal supplied actions preserve order and callback arguments; absent actions stay dark", async () => {
  const host = document.createElement("div"), root = createRoot(host)
  const onAction = mock((_tag: string, _args?: Record<string, string>) => {})
  try {
    await act(async () => root.render(<ProposalView {...proposalFixtures.open} onAction={onAction} onView={() => {}} />))
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")]
    expect(buttons.map(button => button.textContent)).toEqual(["Make TODO", "Dismiss"])
    expect(buttons.map(button => button.dataset.flow)).toEqual(["learning.accept", "learning.dismiss"])
    for (const button of buttons) await act(async () => button.click())
    expect(onAction.mock.calls).toEqual([["learning.accept", { id: "proposal-12" }], ["learning.dismiss", { id: "proposal-12" }]])
    await act(async () => root.render(<ProposalView {...proposalFixtures.open} actions={[]} onAction={onAction} onView={() => {}} />))
    expect(host.querySelectorAll("button")).toHaveLength(0)
    expect(onAction).toHaveBeenCalledTimes(2)
  } finally { await act(async () => root.unmount()) }
})

test("Proposal hostile evidence and refs remain inert text", async () => {
  const host = document.createElement("div"), root = createRoot(host)
  try {
    for (const url of ["javascript:alert(1)", "java\nscript:alert(1)", "https://example.com/\u0000bad", "data:text/html,unsafe", "file:///etc/passwd", "https://", "//example.com", "https://example.com/\\bad"]) {
      await act(async () => root.render(<ProposalView {...proposalFixtures.open} model={{ ...proposalFixtures.open.model,
        evidence: ['<script>alert("evidence")</script>'], refs: [{ label: "<img src=x onerror=alert(1)>", url }],
      }} onAction={() => {}} onView={() => {}} />))
      expect(host.querySelector("script,img,a")).toBeNull()
      expect(host.textContent).toContain('<script>alert("evidence")</script>')
      expect(host.textContent).toContain("<img src=x onerror=alert(1)>")
    }
    await act(async () => root.render(<ProposalView {...proposalFixtures.open} model={{ ...proposalFixtures.open.model,
      refs: [{ label: "Checks", url: "http://example.com/checks" }],
    }} onAction={() => {}} onView={() => {}} />))
    expect(host.querySelector("a")?.getAttribute("href")).toBe("http://example.com/checks")
  } finally { await act(async () => root.unmount()) }
})

test("Accepted TODO and lessons navigate only through supplied gestures", async () => {
  const host = document.createElement("div"), root = createRoot(host)
  const onAction = mock((_tag: string, _args?: Record<string, string>) => {})
  try {
    await act(async () => root.render(<ProposalView {...proposalFixtures.accepted} gestures={{ todo: { tag: "todo", label: "TODO", args: { n: "14" } } }} onAction={onAction} onView={() => {}} />))
    expect(host.querySelector("button")?.textContent).toBe("T14 · Keep completion receipts in toasts")
    await act(async () => (host.querySelector("button") as HTMLButtonElement).click())
    await act(async () => root.render(<LessonsReceiptView {...lessonFixtures.lessons} model={{ todo: 12, lessons: [{ title: '<script>alert("lesson")</script>', ref: "wiki:Retry policy" }] }}
      gestures={{ "wiki:Retry policy": { tag: "wiki.page", label: "Wiki", args: { name: "Retry policy" } } }} onAction={onAction} onView={() => {}} />))
    expect(host.textContent).toBe('1 lesson<script>alert("lesson")</script>')
    expect(host.querySelector("script")).toBeNull()
    await act(async () => (host.querySelector("button") as HTMLButtonElement).click())
    expect(onAction.mock.calls).toEqual([["todo", { n: "14" }], ["wiki.page", { name: "Retry policy" }]])
  } finally { await act(async () => root.unmount()) }
})

test("TODO and Home share absent, zero, one and multiple lesson counts without changing Merged", async () => {
  const host = document.createElement("div"), root = createRoot(host)
  try {
    for (const [lessons, label] of [[undefined, null], [0, "0 lessons"], [1, "1 lesson"], [3, "3 lessons"]] as const) {
      await act(async () => root.render(<TodoView {...todoStories.merged} model={{ ...todoStories.merged.model, lessons }} onAction={() => {}} onView={() => {}} />))
      expect(host.querySelector(".mvp-state")?.textContent).toBe("Merged")
      if (label) expect(host.textContent).toContain(label)
      else expect(host.textContent).not.toContain("lesson")
      const item = homeReceiptFixtures.active.model.items[0]!
      await act(async () => root.render(<HomeView {...homeReceiptFixtures.active} model={{ ...homeReceiptFixtures.active.model, items: [{ ...item, state: "merged", lessons }] }} onAction={() => {}} onView={() => {}} />))
      expect(host.querySelector('.mvp-stack-row [data-state="merged"]')?.textContent).toBe("Merged")
      if (label) expect(host.querySelector(".mvp-stack-row")?.textContent).toContain(label)
      else expect(host.querySelector(".mvp-stack-row")?.textContent).not.toContain("lesson")
    }
  } finally { await act(async () => root.unmount()) }
})

test("Proposal copy blocks use product words and stay brief", async () => {
  for (const state of ["open", "accepted", "dismissed"] as const) {
    const story = proposalFixtures[state]
    const { host, close } = await mounted({ name: story.name, expect: [], render: callbacks => <ProposalView {...story} {...callbacks} /> })
    try {
      expect(host.textContent).not.toMatch(/\b(thread|task|workflow|fork|rewind)\b/i)
      for (const block of host.querySelectorAll("h2,summary,p,button,.proposal-status")) {
        expect(block.textContent!.length).toBeLessThanOrEqual(80)
      }
    } finally { await close() }
  }
})

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Glob } from "bun"

import { act } from "react"
import { readFileSync } from "node:fs"
import type { StoryModule, ViewStory } from "./stories"

GlobalRegistrator.register()
const { createRoot } = await import("react-dom/client")
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import("react-dom/client")
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
          const supplied: import("@smthrs/rpc/CardAction").Action[] = [...(fixture.model.this_mac.capacity === 0 && fixture.model.this_mac.limit ? [fixture.model.this_mac.limit.fix] : []), ...fixture.actions]
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
  expect(view.element.querySelector('.todo-steps [data-phase="held"]')?.textContent).toBe("Wait for merge");
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
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = "" })

for (const [id, story] of Object.entries(setup)) test(`Setup ${id}`, () => {
  const host = render(<SetupView {...story} onAction={() => {}} onView={() => {}} />)
  for (const text of story.expect) expect(host.textContent).toContain(text)
  expect([...host.querySelectorAll("[data-step]")].map(row => row.getAttribute("data-step"))).toEqual(["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"])
  expect(host.textContent).toContain("Decisions")
  expect(host.querySelector('input[aria-label="AI Gateway key"]')?.getAttribute("type")).toBe("password")
})
for (const [id, story] of Object.entries(settings)) test(`Settings ${id}`, () => {
  const host = render(<SettingsView {...story} onAction={() => {}} onView={() => {}} />)
  for (const text of story.expect) expect(host.textContent).toContain(text)
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
  expect([...host.querySelectorAll('.setup-action')].map(form => form.getAttribute('data-flow'))).toEqual(['settings.model.set', 'settings.model.set', 'settings.model.set', 'github', 'settings', 'settings', 'settings'])
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

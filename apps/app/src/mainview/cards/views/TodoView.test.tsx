import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";
import { act } from "react";

import { TodoView } from "./TodoView";
import { todoStories } from "./TodoView.stories";
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
afterAll(() => GlobalRegistrator.unregister());
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

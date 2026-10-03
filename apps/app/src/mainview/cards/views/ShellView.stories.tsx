import { fixtures, stacks, edgeMaps } from "@smthrs/rpc/fixtures/Toast"
import { fixtures as timelines } from "@smthrs/rpc/fixtures/Timeline"
import { ToastStack } from "../../ToastStackView"
import { EdgeMap } from "../../EdgeMap"
import { Timeline } from "../../Timeline"
import type { ToastCard, ShellView } from "@smthrs/rpc/ToastCard"
import type { ViewStory, StoryAction, StoryCallbacks } from "./stories"
// Literal oracles: ui-components T-UI-08, spec §14.4–14.6.
const actions: Record<string, StoryAction[]> = {
  needs_you: [{ tag: "todo.answer", label: "Answer", args: { n: "12" } }],
  approval: [{ tag: "todo.answer", label: "Answer", args: { n: "12" } }],
  in_review: [{ tag: "merge", label: "Merge", args: { n: "12" } }],
  failed: [{ tag: "todo.retry", label: "Retry", args: { n: "12" } }],
  conflict: [{ tag: "branch", label: "Resolve", args: { name: "todo/12" } }],
  merged: [{ tag: "todo", label: "Open", args: { n: "12" } }],
  progress: [{ tag: "stop", label: "Stop" }],
  allow_notifications: [{ tag: "notifications.allow", label: "Allow notifications" }],
  no_action: [],
}
const callbacksFor = (callbacks: StoryCallbacks) => ({ onAction: callbacks.onAction, onView: (patch: ShellView) => callbacks.onView({ ...patch }) })
const suppliedAction = (action: ToastCard["action"], supplied: readonly StoryAction[] | undefined) =>
  action && supplied?.some(candidate => candidate.tag === action.tag && candidate.label === action.label) ? action : undefined
export const stories: ViewStory[] = Object.entries(fixtures).map(([key, fixture]) => ({
  name: `toast-${key}`, expect: fixture.expect, actions: actions[key],
  render: (callbacks, supplied = actions[key]) => <ToastStack toasts={[{ ...fixture.model, action: suppliedAction((fixture.model as ToastCard).action, supplied) }]} more={0} {...callbacksFor(callbacks)} />,
  interactions: [{ selector: ".mvp-notice-hide", patch: { toast_hidden: ({ needs_you: "toast-12", approval: "toast-approval", in_review: "toast-review", failed: "toast-failed", conflict: "toast-conflict", merged: "toast-merged", progress: "toast-progress", allow_notifications: "toast-allow", no_action: "toast-done" } as Record<string, string>)[key] } }],
}))
stories.push({ name: "toast-disabled", expect: ["Retry", "Checks running"], actions: [{ tag: "todo.retry", label: "Retry", args: { n: "12" }, disabled: { reason: "Checks running" } }],
  render: (callbacks, supplied = [{ tag: "todo.retry", label: "Retry", args: { n: "12" }, disabled: { reason: "Checks running" } }]) => <ToastStack toasts={[{ ...fixtures.failed.model, action: suppliedAction({ ...fixtures.failed.model.action!, disabled: { reason: "Checks running" } }, supplied) }]} more={0} {...callbacksFor(callbacks)} />,
  interactions: [{ selector: ".mvp-notice-hide", patch: { toast_hidden: "toast-failed" } }],
})
for (const [key, fixture] of Object.entries(timelines)) stories.push({
  name: `timeline-${key}`, expect: fixture.expect,
  render: callbacks => <Timeline {...fixture.model} onView={callbacksFor(callbacks).onView} />,
  interactions: (key === "one_entry" ? ["entry-10"] : ["entry-10", "entry-11", "entry-12", "entry-13", "entry-14", "entry-15"]).map(id => ({ selector: `[data-entry="${id}"] button`, patch: { jump_to: id } })),
})
// Edge interaction and disclosure boundaries are exercised in the dedicated shell tests.
for (const [key, fixture] of Object.entries(edgeMaps)) stories.push({ name: `edge-${key}`, expect: fixture.expect, render: (callbacks, supplied = key === "below_only" ? actions.conflict : [...actions.needs_you!, ...actions.progress!, ...actions.failed!]) => <EdgeMap {...fixture.model} above={fixture.model.above.map(toast => ({ ...toast, action: suppliedAction(toast.action, supplied) }))} below={fixture.model.below.map(toast => ({ ...toast, action: suppliedAction(toast.action, supplied) }))} {...callbacksFor(callbacks)} />,
  actions: key === "below_only" ? actions.conflict : [...actions.needs_you!, ...actions.progress!, ...actions.failed!],
  interactions: key === "below_only" ? [
    { selector: ".mvp-edge-pill", patch: { jump_to: "entry-12" } }, { selector: ".mvp-tl-row", patch: { jump_to: "entry-12" } },
  ] : [
    { selector: '[data-edge="above"] .mvp-edge-pill', patch: { jump_to: "entry-12" } },
    { selector: '[data-edge="below"] .mvp-edge-pill', patch: { jump_to: "entry-12" } },
    { selector: '[data-edge="above"] li:nth-child(1) .mvp-tl-row', patch: { jump_to: "entry-12" } },
    { selector: '[data-edge="above"] li:nth-child(2) .mvp-tl-row', patch: { jump_to: "entry-13" } },
    { selector: '[data-edge="below"] .mvp-tl-row', patch: { jump_to: "entry-12" } },
    { selector: '.mvp-tl-more', patch: { jump_to: "entry-12" } },
  ],
})

stories.push({ name: "toast-three-and-more", expect: ["T12 needs you", "T12 failed", "Refreshing wiki", "+2 more"], actions: [...actions.needs_you!, ...actions.failed!, ...actions.progress!],
  render: (callbacks, supplied = [...actions.needs_you!, ...actions.failed!, ...actions.progress!]) => <ToastStack toasts={stacks.three_and_more.model.toasts.map((toast, index) => ({ ...toast, action: index >= 3 ? toast.action : suppliedAction(toast.action, supplied) }))} more={2} {...callbacksFor(callbacks)} />,
  interactions: [
    { selector: '[data-notice="toast-12"] .mvp-notice-hide', patch: { toast_hidden: "toast-12" } },
    { selector: '[data-notice="toast-failed"] .mvp-notice-hide', patch: { toast_hidden: "toast-failed" } },
    { selector: '[data-notice="toast-progress"] .mvp-notice-hide', patch: { toast_hidden: "toast-progress" } },
    { selector: '.mvp-notice-more' },
    { selector: '[data-notice="toast-review"] [data-flow]', action: { tag: "merge", args: { n: "12" } } },
    { selector: '[data-notice="toast-merged"] [data-flow]', action: { tag: "todo", args: { n: "12" } } },
    { selector: '[data-notice="toast-review"] .mvp-notice-hide', patch: { toast_hidden: "toast-review" } },
    { selector: '[data-notice="toast-merged"] .mvp-notice-hide', patch: { toast_hidden: "toast-merged" } },
  ],
})

stories.push({ name: "toast-one", expect: ["T12 merged", "Checks passed"], actions: actions.merged,
 render: (callbacks, supplied = actions.merged) => <ToastStack toasts={[{ ...stacks.one.model.toasts[0]!, action: suppliedAction(stacks.one.model.toasts[0]!.action, supplied) }]} more={0} {...callbacksFor(callbacks)} />,
 interactions: [{ selector: ".mvp-notice-hide", patch: { toast_hidden: "toast-merged" } }],
})

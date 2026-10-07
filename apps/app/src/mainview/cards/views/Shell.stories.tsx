import type { ToastCard } from "@smthrs/rpc/ToastCard"
import type { TimelineLine } from "@smthrs/rpc/TimelineCard"
import { EdgeMap } from "../../EdgeMap"
import { Timeline } from "../../Timeline"
import { ToastStack } from "../../ToastStackView"
import type { ViewStory } from "./stories"
import "../../styles/base.css"

const above: ToastCard[] = [
  { id: "above-1", entry_id: "above-1", title: "Answer needed", tone: "attention", kind: "needs_you" },
  { id: "above-2", entry_id: "above-2", title: "Checks failed", tone: "failed", kind: "failed" },
  { id: "above-3", entry_id: "above-3", title: "Building", tone: "live", kind: "progress" },
]
const below: ToastCard[] = [
  { id: "below-1", entry_id: "below-1", title: "Testing", tone: "live", kind: "progress" },
  { id: "below-2", entry_id: "below-2", title: "Reviewing", tone: "live", kind: "progress" },
  { id: "below-3", entry_id: "below-3", title: "Preparing", tone: "live", kind: "progress" },
]
const toasts: ToastCard[] = [
  { id: "notice-1", entry_id: "line-1", title: "Allow notifications", kind: "allow_notifications", tone: "attention", action: { tag: "notifications.allow", label: "Allow" } },
  { id: "notice-2", entry_id: "line-2", title: "Needs you", kind: "needs_you", tone: "attention" },
  { id: "notice-3", entry_id: "line-3", title: "Ready", kind: "in_review", tone: "quiet" },
  { id: "notice-4", entry_id: "line-4", title: "Merged", kind: "merged", tone: "done" },
  { id: "notice-5", entry_id: "above-2", title: "Failed", kind: "failed", tone: "failed" },
]
const lines: TimelineLine[] = [
  { entry_id: "line-1", kind: "prompt", title: "Fix retries", tone: "quiet", glyph: { state: "queued" } },
  { entry_id: "line-2", kind: "card", title: "Retry policy", summary: "Asks: backoff or timeout?", tone: "attention", glyph: { state: "needs_you" } },
  { entry_id: "line-3", kind: "event", title: "Checks passed", tone: "done", glyph: { event: "ok" } },
  { entry_id: "line-4", kind: "event", title: "Merged", tone: "done", glyph: { state: "merged" } },
]

export const stories: ViewStory[] = [{
  name: "Breakpoint and controls",
  expect: ["+2 more", "↑ 3 live above", "↓ 3 live below", "Retry policy", "Asks: backoff or timeout?"],
  gestures: { allow: toasts[0]!.action! },
  render: callbacks => <aside className="rail" aria-label="Activity" data-keyboard-pane="Timeline">
    <EdgeMap above={above} below={below} narrow={false} onAction={callbacks.onAction} onView={patch => callbacks.onView({ ...patch })} />
    <Timeline lines={lines} on_screen={["line-2", "line-3"]} onAction={callbacks.onAction} onView={patch => callbacks.onView({ ...patch })} />
    <ToastStack toasts={toasts} more={2} onAction={callbacks.onAction} onView={patch => callbacks.onView({ ...patch })} />
  </aside>,
  interactions: [
    { selector: '[data-flow="notifications.allow"]', gesture: "allow", action: { tag: "notifications.allow", args: {} } },
    { selector: '[data-edge="above"] .edge-pill', patch: { jump_to: "above-3" } },
    { selector: '[data-edge="below"] .edge-pill', patch: { jump_to: "below-1" } },
    ...["above", "below"].flatMap(direction => [
      { selector: `[data-edge="${direction}"] li:nth-child(1) .tl-row`, patch: { jump_to: `${direction}-1` } },
      { selector: `[data-edge="${direction}"] li:nth-child(2) .tl-row`, patch: { jump_to: `${direction}-2` } },
      { selector: `[data-edge="${direction}"] .tl-more`, patch: { jump_to: `${direction}-3` } },
    ]),
    ...["line-1", "line-2", "line-3", "line-4"].map(id => ({ selector: `[data-entry="${id}"] > button`, patch: { jump_to: id } })),
    { selector: ".notice-more" },
    ...toasts.map(toast => ({ selector: `[data-notice="${toast.id}"] .notice-hide`, patch: { toast_hidden: toast.id } })),
  ],
}]

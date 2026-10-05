/*
 * The activity rail (T-APP-07): the card file's mapping from transcript
 * entries and toasts to the Views' props, and the three Views' controls at
 * their callback seam. Expected values are authored literals.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import type { ReactNode } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { ShellView, ToastCard } from "@smthrs/rpc/ToastCard"
import type { TimelineLine } from "@smthrs/rpc/TimelineCard"
import { EdgeMap } from "./EdgeMap"
import { railEdges, railLines, railNotices, type RailEntry } from "./ShellRail"
import type { Card, Message, Toast } from "./state/AppState"
import { Timeline } from "./Timeline"
import { ToastStack } from "./ToastStackView"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })

const mount = (node: ReactNode): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(node))
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  return host
}
/* happy-dom sets no window.event, so React cannot see the click as discrete: flush its update here. */
const click = (element: Element | null): void => { flushSync(() => { (element as HTMLButtonElement).click() }) }

const message = (id: string, role: Message["role"], text: string, status: Message["status"] = "complete"): RailEntry =>
  ({ kind: "message", message: { id, ordinal: 1, createdAt: 1, text, role, status } })
const card = (id: string, status: Card["status"], title = "Build"): RailEntry =>
  ({ kind: "card", card: { id, kind: "status", title, createdAt: 1, ordinal: 1, status, payload: {} } })
const line = (entry_id: string, tone: TimelineLine["tone"]): TimelineLine => ({ entry_id, kind: "card", title: entry_id, tone })
const toast = (id: string, status: Toast["status"], createdAt: number, extra: Partial<Toast> = {}): Toast =>
  ({ id, key: id, title: `Toast ${id}`, detail: "", status, createdAt, updatedAt: createdAt, ...extra })

describe("ShellRail maps the conversation to the rail", () => {
  test("shared entry facts keep their host title, tone and last summary", () => {
    expect(railLines([
      { kind: "entry", id: "t3-starting", entry: { kind: "event", author: { kind: "system", color_index: 7 }, title: "Starting", tone: "live", state: "starting", summary: "Preparing checks" } },
      { kind: "entry", id: "t3-review", entry: { kind: "card", author: { kind: "system", color_index: 7 }, title: "Ready for review", tone: "quiet", state: "in_review" } },
      { kind: "entry", id: "removed", entry: { kind: "answer", author: { kind: "system", color_index: 7 }, title: "Removed", tone: "quiet", summary: "Hidden content", tombstone: true } }
    ])).toEqual([
      { entry_id: "t3-starting", kind: "event", title: "Starting", tone: "live", summary: "Preparing checks" },
      { entry_id: "t3-review", kind: "card", title: "Ready for review", tone: "quiet" },
      { entry_id: "removed", kind: "answer", title: "Removed", tone: "quiet" }
    ])
  })
  test("one line per entry: prompts quoted, answers by first line, cards by status; the opening read and blank text have none", () => {
    const entries: RailEntry[] = [
      { kind: "init", message: { id: "init-state", role: "assistant", text: "Smithers here.", status: "complete", ordinal: 0, createdAt: 0 } as never },
      message("m1", "user", "\n  Fix the flaky test\nplease"),
      message("m2", "smithers", "On it.", "failed"),
      message("m3", "smithers", "   "),
      card("c1", "error"), card("c2", "acted"), card("c3", "active", "")
    ]
    expect(railLines(entries)).toEqual([
      { entry_id: "m1", kind: "prompt", title: "“Fix the flaky test”", tone: "quiet" },
      { entry_id: "m2", kind: "answer", title: "On it.", tone: "failed" },
      { entry_id: "c1", kind: "card", title: "Build", tone: "failed" },
      { entry_id: "c2", kind: "card", title: "Build", tone: "done" },
      { entry_id: "c3", kind: "card", title: "status", tone: "quiet" }
    ])
  })

  test("live lines outside the band pin to their edge, attention first, then failed, then live", () => {
    const lines = [line("a", "live"), line("b", "quiet"), line("c", "attention"), line("d", "done"), line("e", "failed"), line("f", "live"), line("g", "attention")]
    const edges = railEdges(lines, ["d", "d"])
    expect(edges.above.map(each => [each.id, each.kind])).toEqual([["c", "needs_you"], ["a", "progress"]])
    expect(edges.below.map(each => [each.id, each.kind])).toEqual([["g", "needs_you"], ["e", "failed"], ["f", "progress"]])
    expect(edges.above[0]).toEqual({ id: "c", entry_id: "c", title: "c", tone: "attention", kind: "needs_you" })
    expect(railEdges(lines, undefined)).toEqual({ above: [], below: [] })
    expect(railEdges(lines, ["zz", "d"]).above).toEqual([])
    expect(railEdges(lines, ["d", "zz"]).below).toEqual([])
  })

  test("notices read newest first with the toast's one action bound to its id", () => {
    const notices = railNotices([
      toast("old", "ok", 1, { detail: "Merged" }),
      toast("new", "failed", 3, { sourceCard: "card-7", action: { flow: "background.retry", args: "job-1", label: "Retry" } }),
      toast("mid", "running", 2), toast("off", "cancelled", 0)
    ])
    expect(notices).toEqual([
      { id: "new", title: "Toast new", tone: "failed", entry_id: "card-7", kind: "failed", action: { tag: "background.retry", label: "Retry", args: { toast: "new" } } },
      { id: "mid", title: "Toast mid", tone: "live", entry_id: "mid", kind: "progress" },
      { id: "old", title: "Toast old", detail: "Merged", tone: "done", entry_id: "old", kind: "merged" },
      { id: "off", title: "Toast off", tone: "quiet", entry_id: "off", kind: "merged" }
    ])
  })
})

const notice = (id: string, tone: ToastCard["tone"], extra: Partial<ToastCard> = {}): ToastCard => ({ id, entry_id: id, title: `Notice ${id}`, tone, kind: "progress", ...extra })

describe("the rail's Views at their callback seam", () => {
  test("three notices show, +N more discloses the rest, Hide emits its patch and a failure alone is an alert", () => {
    const views: ShellView[] = []
    const actions: Array<[string, Record<string, string> | undefined]> = []
    const toasts = [notice("1", "failed", { action: { tag: "background.retry", label: "Retry", args: { toast: "1" } } }), notice("2", "live"), notice("3", "done"), notice("4", "quiet"), notice("5", "attention")]
    const host = mount(<ToastStack toasts={toasts} more={2} onAction={(tag, args) => actions.push([tag, args])} onView={patch => views.push(patch)} />)
    expect(host.querySelectorAll(".mvp-notice").length).toBe(3)
    expect(host.querySelectorAll('.mvp-notice[role="alert"]').length).toBe(1)
    expect(host.querySelectorAll('.mvp-notice[role="status"]').length).toBe(2)
    const more = host.querySelector(".mvp-notice-more")!
    expect(more.textContent).toBe("+2 more")
    click(more)
    expect(host.querySelectorAll(".mvp-notice").length).toBe(5)
    expect(host.querySelector(".mvp-notice-more")).toBeNull()
    click(host.querySelector('[aria-label="Hide Notice 2"]'))
    expect(views).toEqual([{ toast_hidden: "2" }])
    click(host.querySelector('[data-flow="background.retry"]'))
    expect(actions).toEqual([["background.retry", { toast: "1" }]])
    expect(host.querySelectorAll(".mvp-notice").length).toBe(5)
  })

  test("an edge shows two rows and +N, its pill jumps to the nearest live entry, a disabled action emits nothing", () => {
    const views: ShellView[] = []
    const actions: string[] = []
    const above = [notice("a", "attention", { action: { tag: "todo.answer", label: "Answer", args: { todo: "9" } } }), notice("b", "failed", { action: { tag: "todo.retry", label: "Retry", disabled: { reason: "Not yours" } } }), notice("c", "live")]
    const host = mount(<EdgeMap above={above} below={[]} narrow={false} onAction={tag => actions.push(tag)} onView={patch => views.push(patch)} />)
    expect(host.querySelectorAll(".mvp-edge").length).toBe(1)
    expect(host.querySelector(".mvp-edge-pill")?.textContent).toBe("↑ 3 live above")
    expect(host.querySelector(".mvp-edge-pill")?.getAttribute("data-tone")).toBe("attention")
    expect(host.querySelectorAll(".mvp-tl-edge > li").length).toBe(3)
    expect(host.querySelector(".mvp-tl-more")?.textContent).toBe("+1 above")
    click(host.querySelector(".mvp-edge-pill"))
    click(host.querySelector(".mvp-tl-more"))
    click(host.querySelector(".mvp-tl-row"))
    expect(views).toEqual([{ jump_to: "c" }, { jump_to: "c" }, { jump_to: "a" }])
    click(host.querySelector('[data-flow="todo.answer"]'))
    click(host.querySelector('[data-flow="todo.retry"]'))
    expect(actions).toEqual(["todo.answer"])
    expect(host.querySelector(".mvp-tl-actions span")?.textContent).toBe("Not yours")
  })

  test("the timeline marks the band inclusively, a line click jumps, and visibility is reported once", () => {
    const views: ShellView[] = []
    const lines = [line("a", "quiet"), line("b", "live"), line("c", "attention"), line("d", "done")]
    const host = mount(<Timeline lines={lines} on_screen={["b", "c"]} onView={patch => views.push(patch)} />)
    expect([...host.querySelectorAll("li")].map(each => each.hasAttribute("data-in-view"))).toEqual([false, true, true, false])
    expect(views.filter(patch => "timeline_visible" in patch).length).toBe(1)
    click(host.querySelector('li[data-entry="d"] button'))
    expect(views.filter(patch => "jump_to" in patch)).toEqual([{ jump_to: "d" }])
  })
})

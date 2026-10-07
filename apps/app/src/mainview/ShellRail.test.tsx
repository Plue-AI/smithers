import { scopedControllers } from "./state/ControllerTestScope"
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
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
import { ShellRail, sharedRailLines, homeLine, railEdges, railLines, railNotices, timelineActions, type RailEntry } from "./ShellRail"
import { MessageScrollerProvider } from "@smthrs/ui"
import { ControllerTestProvider } from "./ControllerContext"
import { createAppStore } from "./state/AppStore"
import { memoryStorage, silentAgent, waitFor } from "./state/TestFixtures"
import { installFixture } from "./state/seams/InstallFixtures.test-support"
import { fixtures as todoFixtures } from "@smthrs/rpc/fixtures/Todo"
import type { Card, Message, Toast } from "./state/AppState"
import { homeFailureModel } from "./cards/HomeContainer"
import { Timeline } from "./Timeline"
import { ToastStack } from "./ToastStackView"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })
const createAppController = scopedControllers()

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
const line = (entry_id: string, tone: TimelineLine["tone"]): TimelineLine => ({ entry_id, kind: "card", title: entry_id, tone, glyph: { state: "queued" } })
const toast = (id: string, status: Toast["status"], createdAt: number, extra: Partial<Toast> = {}): Toast =>
  ({ id, key: id, title: `Toast ${id}`, detail: "", status, createdAt, updatedAt: createdAt, ...extra })

test("the mounted install rail reads the real seams and Hide runs toast.dismiss without removing the transcript", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "smithersai", admin: false, scopesPlain: null }).isPersisted.promise
  const reads: string[] = []
  const controller = createAppController(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null },
    fetchImpl: async input => {
      const path = new URL(String(input), "https://install.test").pathname
      reads.push(path)
      return path === "/api/install" ? Response.json(installFixture())
        : path === "/api/todos" ? Response.json([todoFixtures.working.model, todoFixtures.needs_you.model])
        : new Response("", { status: 404 })
    },
  })
  await store.dispatch({ type: "toast.shown", actor: "system", key: "checks", title: "Checks failed", sourceCard: "checks-entry" }).isPersisted.promise
  await store.dispatch({ type: "toast.resolved", actor: "system", key: "checks", title: "Checks failed", detail: "TestRetry failed", status: "failed" }).isPersisted.promise
  const host = mount(<ControllerTestProvider controller={controller}><MessageScrollerProvider>
    <ShellRail home={true} entries={[card("checks-entry", "error", "Checks failed")]} />
  </MessageScrollerProvider></ControllerTestProvider>)
  await waitFor(() => host.querySelector('[data-entry="home"] .tl-text b')?.textContent === "smithersai/smithers")
  expect(controller.design.enabled).toBe(false)
  expect(reads).toContain("/api/install")
  expect(reads).toContain("/api/todos")
  expect(host.querySelector('[data-entry="home"] .tl-text')?.textContent).toBe("smithersai/smithers1 need you · 1 working")
  expect(host.querySelectorAll(".notice")).toHaveLength(1)
  click(host.querySelector('[aria-label="Hide Checks failed"]'))
  await waitFor(() => host.querySelectorAll(".notice").length === 0)
  expect(store.collections.toasts.get("toast-checks")).toBeUndefined()
  expect(host.querySelector('[data-entry="checks-entry"] .tl-text b')?.textContent).toBe("Checks failed")
})

describe("ShellRail maps the conversation to the rail", () => {
  test("home prioritizes attention, includes starting work, and keeps failed reads count-free", () => {
    const model = homeFailureModel("smithersai/smithers", "unavailable")
    const answer = (needs_you: number, working: number, starting: number) => ({ kind: "served" as const, model: { ...model, counts: { ...model.counts, needs_you, working, starting } } })
    expect(homeLine(answer(2, 3, 1))).toEqual({ entry_id: "home", kind: "card", title: "smithersai/smithers", summary: "2 need you · 4 working", tone: "attention", glyph: { state: "needs_you" } })
    expect(homeLine(answer(0, 3, 0))).toEqual({ entry_id: "home", kind: "card", title: "smithersai/smithers", summary: "0 need you · 3 working", tone: "live", glyph: { state: "working" } })
    expect(homeLine(answer(0, 0, 1))).toEqual({ entry_id: "home", kind: "card", title: "smithersai/smithers", summary: "0 need you · 1 working", tone: "live", glyph: { state: "working" } })
    expect(homeLine(answer(0, 0, 0))).toEqual({ entry_id: "home", kind: "card", title: "smithersai/smithers", summary: "0 need you · 0 working", tone: "quiet", glyph: { state: "queued" } })
    expect(homeLine({ ...answer(2, 3, 1), kind: "failed" })).toEqual({ entry_id: "home", kind: "card", title: "smithersai/smithers", tone: "quiet", glyph: { state: "queued" } })
  })

  test("shared entry facts keep their host title, tone and last summary", () => {
    expect(railLines([
      { kind: "entry", id: "t3-starting", entry: { kind: "event", author: { kind: "system", color_index: 7 }, title: "Starting", tone: "live", state: "starting", summary: "Preparing checks" } },
      { kind: "entry", id: "t3-review", entry: { kind: "card", author: { kind: "system", color_index: 7 }, title: "Ready for review", tone: "quiet", state: "in_review" } },
      { kind: "entry", id: "removed", entry: { kind: "answer", author: { kind: "system", color_index: 7 }, title: "Removed", tone: "quiet", summary: "Hidden content", tombstone: true } }
    ])).toEqual([
      { entry_id: "t3-starting", kind: "event", title: "Starting", tone: "live", summary: "Preparing checks", glyph: { state: "starting" } },
      { entry_id: "t3-review", kind: "card", title: "Ready for review", tone: "quiet", glyph: { state: "in_review" } },
      { entry_id: "removed", kind: "answer", title: "Removed", tone: "quiet", glyph: { actor: { kind: "system", color_index: 7 } } }
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
      { entry_id: "m1", kind: "prompt", title: "“Fix the flaky test”", tone: "quiet", glyph: { state: "queued" } },
      { entry_id: "m2", kind: "answer", title: "On it.", tone: "failed", glyph: { actor: { kind: "agent", id: "smithers", agent: "smithers", avatar_url: PlaceholderAvatarUrl, color_index: 6 } } },
      { entry_id: "c1", kind: "card", title: "Build", tone: "failed", glyph: { state: "failed" } },
      { entry_id: "c2", kind: "card", title: "Build", tone: "done", glyph: { state: "merged" } },
      { entry_id: "c3", kind: "card", title: "status", tone: "quiet", glyph: { state: "queued" } }
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
    expect(host.querySelectorAll(".notice").length).toBe(3)
    expect(host.querySelectorAll('.notice[role="alert"]').length).toBe(1)
    expect(host.querySelectorAll('.notice[role="status"]').length).toBe(2)
    const more = host.querySelector(".notice-more")!
    expect(more.textContent).toBe("+2 more")
    click(more)
    expect(host.querySelectorAll(".notice").length).toBe(5)
    expect(host.querySelector(".notice-more")).toBeNull()
    click(host.querySelector('[aria-label="Hide Notice 2"]'))
    expect(views).toEqual([{ toast_hidden: "2" }])
    click(host.querySelector('[data-flow="background.retry"]'))
    expect(actions).toEqual([["background.retry", { toast: "1" }]])
    expect(host.querySelectorAll(".notice").length).toBe(5)
  })

  test("an edge shows two rows and +N, its pill jumps to the nearest live entry, a disabled action emits nothing", () => {
    const views: ShellView[] = []
    const actions: string[] = []
    const above = [notice("a", "attention", { action: { tag: "todo.answer", label: "Answer", args: { todo: "9" } } }), notice("b", "failed", { action: { tag: "todo.retry", label: "Retry", disabled: { reason: "Not yours" } } }), notice("c", "live")]
    const host = mount(<EdgeMap above={above} below={[]} narrow={false} onAction={tag => actions.push(tag)} onView={patch => views.push(patch)} />)
    expect(host.querySelectorAll(".edge").length).toBe(1)
    expect(host.querySelector(".edge-pill")?.textContent).toBe("↑ 3 live above")
    expect(host.querySelector(".edge-pill")?.getAttribute("data-tone")).toBe("attention")
    expect(host.querySelectorAll(".tl-edge > li").length).toBe(3)
    expect(host.querySelector(".tl-more")?.textContent).toBe("+1 above")
    click(host.querySelector(".edge-pill"))
    click(host.querySelector(".tl-more"))
    click(host.querySelector(".tl-row"))
    expect(views).toEqual([{ jump_to: "c" }, { jump_to: "c" }, { jump_to: "a" }])
    click(host.querySelector('[data-flow="todo.answer"]'))
    click(host.querySelector('[data-flow="todo.retry"]'))
    expect(actions).toEqual(["todo.answer"])
    expect(host.querySelector(".tl-actions span")?.textContent).toBe("Not yours")
  })

  test("the timeline marks the band inclusively, a line click jumps, and visibility is reported once", () => {
    const views: ShellView[] = []
    const lines = [line("a", "quiet"), line("b", "live"), line("c", "attention"), line("d", "done")]
    const host = mount(<Timeline onAction={() => {}} lines={lines} on_screen={["b", "c"]} onView={patch => views.push(patch)} />)
    expect([...host.querySelectorAll("li")].map(each => each.hasAttribute("data-in-view"))).toEqual([false, true, true, false])
    expect(views.filter(patch => "timeline_visible" in patch).length).toBe(1)
    click(host.querySelector('li[data-entry="d"] button'))
    expect(views.filter(patch => "jump_to" in patch)).toEqual([{ jump_to: "d" }])
  })
})


describe("Timeline container actions", () => {
  const entry = (id: string, state: NonNullable<import("@smthrs/rpc/EntryRowCard").EntryRowCard["state"]>, facts: Extract<RailEntry, { kind: "entry" }>["facts"] = { n: 12 }) : RailEntry => ({
    kind: "entry", id, facts, entry: { kind: "card", title: id, author: { kind: "system", color_index: 7 }, tone: "quiet", state }
  })
  test("one action from facts and role, removed when answered, merged, dropped or tombstoned", () => {
    const entries = [entry("ask", "needs_you", { n: 12, needs_you: { kind: "question" } }), entry("retry", "failed", { n: 13 }), entry("merge", "in_review", { n: 14, first_in_order: true, place: 1, merge: { state: "ready" }, pr: { draft: false } }), entry("later", "in_review", { n: 15, first_in_order: false })]
    expect(railLines(entries, { role: "maintainer" }).map(line => line.action?.tag)).toEqual(["todo.answer", "todo.retry", "merge", undefined])
    expect(railLines(entries, { role: "member" }).map(line => line.action?.tag)).toEqual(["todo.answer", "todo.retry", undefined, undefined])
    expect(railLines([entry("answered", "working"), entry("merged", "merged"), entry("dropped", "dropped"), entry("missing wait", "needs_you")], { role: "owner" }).every(line => line.action === undefined)).toBe(true)
    const removed = entry("removed", "failed") as Extract<RailEntry, { kind: "entry" }>
    expect(railLines([{ ...removed, entry: { ...removed.entry, tombstone: true } }], { role: "owner" })[0]?.action).toBeUndefined()
  })
  test("repair, review and merge retain their typed inputs; repeated TODO lines share one binding", () => {
    const entries = [entry("conflict", "needs_you", { n: 16, needs_you: { kind: "conflict" } }), entry("foreign", "needs_you", { n: 17, needs_you: { kind: "foreign_push" } }), entry("merge", "in_review", { n: 18, first_in_order: true, place: 1, merge: { state: "ready" }, pr: { draft: false } }), entry("again", "in_review", { n: 18, first_in_order: true, place: 1, merge: { state: "ready" }, pr: { draft: false } })]
    const calls: unknown[] = []
    const lines = railLines(entries, { role: "maintainer" })
    const bindings = timelineActions(lines, (tag, input) => calls.push([tag, input]))
    expect(bindings.actions).toHaveLength(3)
    for (const line of lines) bindings.onAction(line.action!.tag, line.action!.args)
    expect(calls).toEqual([["branch", { name: "T16" }], ["todo", { n: 17 }], ["merge", { n: 18 }], ["merge", { n: 18 }]])
    expect(railLines([entry("no facts", "failed", {})], { role: "owner" })[0]?.action).toBeUndefined()
  })
  test("production Timeline presses bound commands; line clicks only jump; stale actions are refused", () => {
    const calls: unknown[] = []
    const views: ShellView[] = []
    const entries = [entry("retry", "failed"), entry("other", "failed", { n: 13 }), entry("ask", "needs_you", { n: 14, needs_you: { kind: "approval" } })]
    const lines = railLines(entries, { role: "owner" })
    const bindings = timelineActions(lines, (tag, input) => calls.push([tag, input]))
    const host = mount(<Timeline lines={lines} on_screen={["retry", "ask"]} onAction={bindings.onAction} onView={patch => views.push(patch)} />)
    click(host.querySelector('[data-entry="retry"] button'))
    expect(calls).toEqual([])
    expect(views.filter(patch => patch.jump_to)).toEqual([{ jump_to: "retry" }])
    click(host.querySelector('[data-entry="retry"] [data-flow]'))
    click(host.querySelector('[data-entry="other"] [data-flow]'))
    click(host.querySelector('[data-entry="ask"] [data-flow]'))
    expect(calls).toEqual([["todo.retry", { n: 12 }], ["todo.retry", { n: 13 }], ["todo.answer", { n: 14, answer: "" }]])
    timelineActions(railLines([entry("retry", "merged")], { role: "owner" }), (tag, input) => calls.push([tag, input])).onAction("todo.retry", { n: "12" })
    expect(calls).toHaveLength(3)
    expect(lines.every(line => line.fresh === undefined)).toBe(true)
  })
})

test("a TODO notice uses the same current action as its timeline and edge", () => {
  const action = { tag: "todo.retry" as const, label: "Retry", args: { n: "12" } }
  const lines = [{ ...line("todo:12", "failed"), action }, line("visible", "quiet")]
  const notices = railNotices([toast("failed", "failed", 1, { sourceCard: "todo:12", action: { flow: "todo", args: "T12", label: "Open" } })], lines)
  expect(notices[0]!.action).toEqual(action)
  expect(railNotices([toast("settled", "ok", 1, { sourceCard: "todo:12", action: { flow: "todo.retry", args: "T12", label: "Retry" } })], [line("todo:12", "done")])[0]!.action).toBeUndefined()
  expect(railEdges(lines, ["visible", "visible"]).above[0]!.action).toEqual(action)
  const calls: unknown[] = []
  const bindings = timelineActions(lines, (tag, input) => calls.push([tag, input]))
  const host = mount(<ToastStack toasts={notices} more={0} onAction={bindings.onAction} onView={() => {}} />)
  click(host.querySelector('[data-flow="todo.retry"]'))
  expect(calls).toEqual([["todo.retry", { n: 12 }]])
})


test("the install shell keeps a missing TODO entry's notice visible without its saved Retry", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "smithersai", admin: false, scopesPlain: null }).isPersisted.promise
  const writes: string[] = []
  const controller = createAppController(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null },
    fetchImpl: async (input, init) => {
      const path = new URL(String(input), "https://install.test").pathname
      if (init?.method && init.method !== "GET") writes.push(path)
      return path === "/api/install" ? Response.json(installFixture())
        : path === "/api/todos" ? Response.json([]) : new Response("", { status: 404 })
    }
  })
  await store.dispatch({ type: "toast.shown", actor: "system", key: "old-todo", title: "Checks failed", sourceCard: "todo:24",
    action: { flow: "todo.retry", args: "T24", label: "Retry" } }).isPersisted.promise
  await store.dispatch({ type: "toast.resolved", actor: "system", key: "old-todo", title: "Checks failed", detail: "Lint failed", status: "failed" }).isPersisted.promise
  const host = mount(<ControllerTestProvider controller={controller}><MessageScrollerProvider>
    <ShellRail home={true} entries={[card("current-entry", "active", "Current conversation")]} />
  </MessageScrollerProvider></ControllerTestProvider>)
  await waitFor(() => host.querySelector('[data-entry="home"] .tl-text b')?.textContent === "smithersai/smithers")
  expect(controller.design.enabled).toBe(false)
  expect(host.querySelector(".notice")?.textContent).toContain("Checks failed")
  expect(host.querySelector('.notice [data-flow="todo.retry"]')).toBeNull()
  expect(writes).toEqual([])
  click(host.querySelector('[aria-label="Hide Checks failed"]'))
  await waitFor(() => host.querySelectorAll(".notice").length === 0)
  expect(host.querySelector('[data-entry="current-entry"] .tl-text b')?.textContent).toBe("Current conversation")
  expect(writes).toEqual([])
})

test("served wait rail actions retain the TODO and the actual branch through catalog dispatch", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "smithersai", admin: false, scopesPlain: null }).isPersisted.promise
  const model = {
    ...todoFixtures.needs_you.model,
    n: 24,
    branch: { id: "branch-24", name: "smithers/fix-retry", machine: { state: "awake" as const } },
    waits: [{ id: "conflict-24", kind: "conflict" as const, prompt: "Resolve", since: "2026-10-06T00:00:00Z", actions: [{ tag: "branch" as const, label: "Resolve" }] }]
  }
  const reads: string[] = []
  const controller = createAppController(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null },
    fetchImpl: async input => {
      const path = new URL(String(input), "https://install.test").pathname
      reads.push(path)
      return path === "/api/install" ? Response.json(installFixture())
        : path === "/api/todos" ? Response.json([model])
        : path === "/api/todos/24" ? Response.json(model) : new Response("", { status: 404 })
    }
  })
  await controller.showTodo(24)
  const entry = store.collections.cards.get("todo:24")!
  if (entry?.kind !== "todo") throw new Error("Expected served TODO")
  expect(entry).toBeDefined()
  const host = mount(<ControllerTestProvider controller={controller}><MessageScrollerProvider>
    <ShellRail home={false} entries={[{ kind: "card", card: entry }]} />
  </MessageScrollerProvider></ControllerTestProvider>)
  await waitFor(() => host.querySelector('[data-entry="todo:24"] [data-flow="branch"]') !== null)
  click(host.querySelector('[data-entry="todo:24"] [data-flow="branch"]'))
  await waitFor(() => reads.includes("/api/branches/smithers%2Ffix-retry"))
  expect(reads).not.toContain("/api/branches/undefined")
  const answerModel = { ...model, waits: [{ id: "ask-24", kind: "question" as const, prompt: "Choose", since: "2026-10-06T00:00:00Z", actions: [{ tag: "todo.answer" as const, label: "Answer" }] }] }
  const answerLine = railLines([{ kind: "card", card: { ...entry, payload: { ...entry.payload, model: answerModel } } }])[0]!
  expect(answerLine.action).toEqual({ tag: "todo.answer", label: "Answer", primary: true, args: { n: "24", wait: "ask-24" } })
  const calls: unknown[] = []
  timelineActions([answerLine], (tag, input) => calls.push([tag, input])).onAction("todo.answer", answerLine.action!.args)
  expect(calls).toEqual([["todo.answer", { n: 24, answer: "", wait: "ask-24" }]])
})
 test("edge toasts retain the shared primary action and Resume dispatch", () => {
  const lines = railLines([{ kind: "entry", id: "pause", facts: { n: 3 }, entry: { kind: "card", title: "Paused", author: { kind: "system", color_index: 7 }, tone: "attention", state: "paused" } }, { kind: "entry", id: "band", entry: { kind: "card", title: "Band", author: { kind: "system", color_index: 7 }, tone: "quiet" } }])
  const edge = railEdges(lines, ["band", "band"]).above[0]!
  expect(edge.action).toEqual({ tag: "todo.resume", label: "Resume", args: { n: "3" }, primary: true })
  const calls: unknown[] = []
  timelineActions(lines, (tag, input) => calls.push([tag, input])).onAction(edge.action!.tag, edge.action!.args)
  expect(calls).toEqual([["todo.resume", { n: 3 }]])
 })


test("install shared history feeds the rail with recorded actors and the transcript jump ids", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "smithersai", admin: false, scopesPlain: null }).isPersisted.promise
  const shared = { id: "main", entries: [{ id: "shared-1", author: 2, authorLogin: "alice", runId: "run-1", prompt: "Choose timeout\nDetails", title: "Choose timeout", tone: "live" as const, state: "running" as const, frames: [] }] }
  const controller = createAppController(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "agent", "identity"], authFlow: "none", sandbox: null },
    fetchImpl: async input => {
      const path = new URL(String(input), "https://install.test").pathname
      return path === "/api/conversations/main" ? Response.json(shared)
        : path === "/api/conversations/main/view-state" ? Response.json({})
        : path === "/api/install" ? Response.json(installFixture())
        : path === "/api/todos" ? Response.json([]) : new Response("", { status: 404 })
    }
  })
  const host = mount(<ControllerTestProvider controller={controller}><MessageScrollerProvider>
    <ShellRail home={false} entries={[message("private-local", "user", "Private old text")]} />
  </MessageScrollerProvider></ControllerTestProvider>)
  await waitFor(() => host.querySelector('[data-entry="shared-1:answer"]') !== null)
  expect(host.querySelector('[data-entry="private-local"]')).toBeNull()
  expect(host.querySelector('[data-entry="shared-1:prompt"] .tl-text b')?.textContent).toBe("Choose timeout")
  expect(host.querySelector('[data-entry="shared-1:answer"]')?.getAttribute("data-tone")).toBe("live")
  const rows = sharedRailLines(shared, { role: "member" })
  expect(rows[0]!.glyph).toEqual({ actor: { kind: "person", login: "alice", name: "alice", avatar_url: PlaceholderAvatarUrl, color_index: 2 } })
  expect(rows[1]!.glyph).toEqual({ actor: { kind: "agent", id: "run-1", agent: "smithers", for_member: { login: "alice", name: "alice", avatar_url: PlaceholderAvatarUrl }, avatar_url: PlaceholderAvatarUrl, color_index: 2 } })
})


test("member toast hiding leaves shared lines present and timeline leases use private view state", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "smithersai", admin: false, scopesPlain: null }).isPersisted.promise
  let view: Record<string, unknown> = { toasts_hidden: true, scroll_anchor: "turn:prompt" }
  const writes: Record<string, unknown>[] = []
  const controller = createAppController(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "agent", "identity"], authFlow: "none", sandbox: null },
    fetchImpl: async (input, init) => {
      const path = new URL(String(input), "https://install.test").pathname
      if (path === "/api/conversations/main/view-state") {
        if (init?.method === "PUT") { view = JSON.parse(String(init.body)); writes.push(view) }
        return Response.json(view)
      }
      return path === "/api/user" ? Response.json({ id: 1, username: "smithersai", is_admin: false }) : path === "/api/conversations/main" ? Response.json({ id: "main", entries: [{ id: "turn", author: 2, authorLogin: "alice", runId: "run", prompt: "Check tests", title: "Check tests", tone: "failed", state: "failed", frames: [] }] })
        : path === "/api/install" ? Response.json(installFixture()) : path === "/api/todos" ? Response.json([]) : new Response("", { status: 404 })
    }
  })
  await store.dispatch({ type: "toast.shown", actor: "system", key: "own-failure", title: "Tests failed", sourceCard: "turn:answer" }).isPersisted.promise
  await store.dispatch({ type: "toast.resolved", actor: "system", key: "own-failure", title: "Tests failed", detail: "Lint", status: "failed" }).isPersisted.promise
  const host = mount(<ControllerTestProvider controller={controller}><MessageScrollerProvider><ShellRail home={false} entries={[]} /></MessageScrollerProvider></ControllerTestProvider>)
  await waitFor(() => host.querySelector('[data-entry="turn:answer"]') !== null)
  expect(host.querySelectorAll(".notice")).toHaveLength(0)
  expect(store.collections.toasts.get("toast-own-failure")?.status).toBe("failed")
  await controller.sharedConversation!.saveView({ toasts_hidden: false })
  await waitFor(() => host.querySelectorAll(".notice").length === 1)
  expect(host.querySelector('[data-entry="turn:answer"]')?.getAttribute("data-tone")).toBe("failed")
  await controller.sharedConversation!.saveView({ global_toasts_hidden: true })
  await waitFor(() => host.querySelectorAll(".notice").length === 0)
  expect(host.querySelector('[data-entry="turn:answer"]')).not.toBeNull()
  await controller.sharedConversation!.saveView({ global_toasts_hidden: false })
  await waitFor(() => host.querySelectorAll(".notice").length === 1)
  const before = Date.now()
  controller.sharedConversation!.setTimelineVisible(true)
  await waitFor(() => typeof view.timeline_visible_until === "string")
  expect(Date.parse(view.timeline_visible_until as string) - before).toBeGreaterThanOrEqual(30_000)
  expect(Date.parse(view.timeline_visible_until as string) - Date.now()).toBeLessThanOrEqual(30_000)
  expect(view.scroll_anchor).toBe("turn:prompt")
  try {
    Object.defineProperty(document, "hidden", { configurable: true, value: true })
    document.dispatchEvent(new Event("visibilitychange"))
    await waitFor(() => view.timeline_visible_until === null)
    Object.defineProperty(document, "hidden", { configurable: true, value: false })
    document.dispatchEvent(new Event("visibilitychange"))
    await waitFor(() => typeof view.timeline_visible_until === "string")
  } finally { Reflect.deleteProperty(document, "hidden") }
  controller.sharedConversation!.setTimelineVisible(false)
  await waitFor(() => view.timeline_visible_until === null)
  expect(writes.at(-1)).toEqual({ toasts_hidden: false, global_toasts_hidden: false, scroll_anchor: "turn:prompt", timeline_visible_until: null })
})


test("unseen completed entries pin below and clear after the durable cursor catches up", () => {
  const conversation = { id: "main", entries: [{ id: "turn", sequence: 7, author: 2, authorLogin: "alice", runId: "run", prompt: "Done", title: "Done", tone: "done" as const, state: "completed" as const, frames: [] }] }
  const rows = sharedRailLines(conversation, { role: "member" }, 12)
  expect(rows.map(row => row.fresh)).toEqual([true, true])
  const visible = { entry_id: "visible", kind: "prompt" as const, title: "Earlier", tone: "quiet" as const, glyph: { state: "queued" as const } }
  const edges = railEdges([visible, ...rows], ["visible", "visible"])
  expect(edges.above).toEqual([])
  expect(edges.below.map(row => row.entry_id)).toEqual(["turn:prompt", "turn:answer"])
  const host = mount(<EdgeMap above={[]} below={edges.below} narrow onAction={() => {}} onView={() => {}} />)
  expect(host.textContent).toContain("↓ 2 new below")
  const mixed = mount(<EdgeMap above={[]} below={[{ id:"live",entry_id:"live",title:"Working",tone:"live",kind:"progress" }, ...edges.below]} narrow onAction={()=>{}} onView={()=>{}} />)
  expect(mixed.textContent).toContain("↓ 1 live · 2 new below")
  expect(railEdges([visible, ...sharedRailLines(conversation, { role: "member" }, 14)], ["visible", "visible"]).below).toEqual([])
  expect(sharedRailLines(conversation, { role: "member" }, 13).map(row => row.fresh)).toEqual([false, true])
})


test("a stored model summary leaves the deterministic title and tone intact", () => {
 const rows=sharedRailLines({ id:"main",entries:[{id:"turn",author:2,authorLogin:"alice",runId:"run",prompt:"Run tests",title:"Run tests",tone:"live",state:"running",summary:"Checked retry bounds",summary_rev:3,frames:[]}]},{role:"member"})
 expect(rows[1]!.title).toBe("Run tests")
 expect(rows[1]!.tone).toBe("live")
 const host=mount(<Timeline lines={rows} on_screen={["turn:prompt","turn:answer"]} onAction={()=>{}} onView={()=>{}} />)
 expect(host.querySelector('[data-summary][aria-label="Summary"]')?.textContent).toBe("Checked retry bounds")
})


test("a card added after the answer was viewed pins by its first committed address", () => {
 const model={id:"main",entries:[{id:"turn",sequence:1,entry_sequences:{"turn:prompt":1_000_000,"turn:answer":1_000_001,"new-card":1_000_006},author:2,authorLogin:"alice",runId:"run",prompt:"Read files",title:"Read files",tone:"live" as const,state:"running" as const,frames:[{type:"card" as const,runId:"run",card:{id:"new-card",kind:"file" as const,title:"retry.ts",status:"active" as const,payload:{repo:"smithersai/smithers",path:"retry.ts",content:"retry",truncated:false},createdAt:0,ordinal:0}}]}]}
 const rows=sharedRailLines(model,{role:"member"},1_000_001)
 expect(rows.map(row=>[row.entry_id,row.fresh])).toEqual([["turn:prompt",false],["turn:answer",false],["new-card",true]])
 expect(railEdges(rows,["turn:answer","turn:answer"]).below.map(row=>row.entry_id)).toEqual(["new-card"])
 expect(railEdges(sharedRailLines(model,{role:"member"},1_000_006),["turn:answer","turn:answer"]).below).toEqual([])
})

import { railNotices } from "../../ShellRail"
import { afterEach, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage, unavailableAgent, settle } from "../TestFixtures"
import { createControllerContext } from "./context"
import { browserNotificationsAvailable, createFailureController, firstNotificationAsk } from "./failures"

const originals = new Map(["window", "document", "Notification"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
afterEach(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
const browser = (secure = true, hidden = true, permission = "granted") => {
  const notices: RecordedNotification[] = []
  let focused = 0
  class RecordedNotification {
    static permission = permission
    static requestPermission() { return Promise.resolve("denied" as const) }
    onclick: (() => void) | null = null
    closed = false
    constructor(readonly title: string, readonly options: NotificationOptions) { notices.push(this) }
    close() { this.closed = true }
  }
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: { isSecureContext: secure, matchMedia: () => ({ matches: false }), focus() { focused++ } } },
    document: { configurable: true, value: { hidden, documentElement: { dataset: {} } } },
    Notification: { configurable: true, value: RecordedNotification }
  })
  return { notices, focused: () => focused, hide: () => { Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: true, documentElement: { dataset: {} } } }) }, grant: () => { RecordedNotification.permission = "granted" } }
}
const fixture = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
  const ctx = createControllerContext(store, unavailableAgent, {})
  const opens: Array<[string, Record<string, unknown>]> = []
  ctx.commands = { submit: async (request: { name: string; payload: Record<string, unknown> }) => { opens.push([request.name, request.payload]); return { status: "executed" } } } as unknown as typeof ctx.commands
  createFailureController(ctx)
  const entry = async (id: string, kind: "needs_you" | "in_review" | "failed", member = "ben") => {
    await store.dispatch({ type: "toast.shown", actor: "system", key: id, title: kind === "needs_you" ? "Needs you" : kind === "in_review" ? "In review" : "Failed",
      audience: { entryId: id, kind, member, actorLabel: "Coding agent for Ben", target: { flow: "todo" as const, n: 3 } } }).isPersisted.promise
    await settle()
  }
  return { store, ctx, opens, entry, dispose: async () => { await ctx.dispose(); await store.dispose?.() } }
}

test("live shared toast subscription delivers three kinds once, filters members and opens the TODO", async () => {
  const b = browser(), t = await fixture()
  try {
    await t.entry("q2", "needs_you")
    await t.entry("review", "in_review")
    await t.entry("retry", "failed")
    await t.entry("q2", "needs_you")
    await t.entry("other", "needs_you", "maya")
    expect(b.notices.map(n => [n.title, n.options.body, n.options.tag])).toEqual([
      ["Needs you", "Coding agent for Ben", "q2"], ["In review", "Coding agent for Ben", "review"], ["Failed", "Coding agent for Ben", "retry"]
    ])
    b.notices[1]!.onclick!()
    expect(b.focused()).toBe(1)
    expect(t.opens).toEqual([["todo", { n: 3 }]])
    await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
    expect(b.notices.every(n => n.closed && n.onclick === null)).toBe(true)
    await t.entry("ben-again", "failed")
    expect(b.notices.length).toBe(3)
    await t.entry("maya-new", "in_review", "maya")
    expect(b.notices.length).toBe(4)
    await t.ctx.dispose()
    expect(b.notices[3]!.closed).toBe(true)
    await t.entry("disposed", "failed", "maya")
    expect(b.notices.length).toBe(4)
  } finally { await t.dispose() }
})

for (const [secure, hidden, permission] of [[false, true, "granted"], [true, false, "granted"], [true, true, "denied"], [true, true, "default"]] as const) {
  test(`ordinary toasts survive secure=${secure}, hidden=${hidden}, permission=${permission}`, async () => {
    const b = browser(secure, hidden, permission), t = await fixture()
    try {
      await t.entry("q1", "needs_you")
      await t.entry("q2", "needs_you")
      expect(b.notices.length).toBe(0)
      expect(t.store.collections.toasts.size).toBe(secure && permission === "default" ? 3 : 2)
      expect(firstNotificationAsk([...t.store.collections.toasts.values()], "ben")?.key).toBe(secure && permission === "default" ? "q1" : undefined)
    } finally { await t.dispose() }
  })
}

test("unsupported browsers retain ordinary toasts without an Allow door", async () => {
  browser(); Reflect.deleteProperty(globalThis, "Notification")
  const t = await fixture()
  try { await t.entry("q", "needs_you"); expect(browserNotificationsAvailable()).toBe(false); expect(firstNotificationAsk([...t.store.collections.toasts.values()], "ben")).toBeUndefined(); expect(t.store.collections.toasts.size).toBe(1) }
  finally { await t.dispose() }
})


test("a hidden-tab update never replays earlier visible or unpermitted entries", async () => {
  const b = browser(true, false, "default"), t = await fixture()
  try {
    await t.entry("first-question", "needs_you")
    expect(b.notices.length).toBe(0)
    b.grant(); b.hide()
    await t.entry("second-question", "needs_you")
    await t.entry("first-question", "needs_you")
    expect(b.notices.map(n => n.options.tag)).toEqual(["second-question"])
  } finally { await t.dispose() }
})


test("the shared Allow notice is offered once and Hide does not request permission", async () => {
  const b = browser(true, false, "default"), t = await fixture()
  try {
    await t.entry("first", "needs_you")
    expect(t.store.collections.toasts.get("toast-notifications.allow@ben")?.action).toEqual({ flow: "notifications.allow", label: "Allow notifications" })
    await t.store.dispatch({ type: "toast.dismissed", actor: "user", id: "toast-notifications.allow@ben" }).isPersisted.promise
    await t.entry("second", "needs_you")
    expect(t.store.collections.toasts.get("toast-notifications.allow@ben")).toBeUndefined()
    expect(b.notices.length).toBe(0)
  } finally { await t.dispose() }
})

test("browser construction failure does not break shared notices or retry the same entry", async () => {
  browser()
  let attempts = 0
  class RefusedNotification {
    static permission = "granted"
    constructor() { attempts++; throw new Error("browser unavailable") }
  }
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: RefusedNotification })
  const t = await fixture()
  try {
    await t.entry("q", "needs_you"); await t.entry("q", "needs_you")
    expect(attempts).toBe(1)
    expect(t.store.collections.toasts.get("toast-q")?.title).toBe("Needs you")
  } finally { await t.dispose() }
})

test("a browser close failure cannot keep the controller subscribed", async () => {
  const b = browser(), t = await fixture()
  try {
    await t.entry("q", "needs_you")
    b.notices[0]!.close = () => { throw new Error("browser closed") }
    await t.ctx.dispose()
    expect(b.notices[0]!.onclick).toBeNull()
    await t.entry("later", "failed")
    expect(b.notices.length).toBe(1)
  } finally { await t.dispose() }
})

test("a member's failed run opens its existing card through the typed person flow", async () => {
  const b = browser(), t = await fixture()
  try {
    await t.store.dispatch({ type: "toast.shown", actor: "system", key: "own-run", title: "Failed",
      audience: { entryId: "run-failure", kind: "failed", member: "ben", actorLabel: "Smithers for Ben", target: { flow: "run", id: "run-nine" } } }).isPersisted.promise
    expect(b.notices.map(n => [n.title, n.options.body])).toEqual([["Failed", "Smithers for Ben"]])
    b.notices[0]!.onclick!()
    expect(t.opens).toEqual([["run", { id: "run-nine" }]])
    expect(b.focused()).toBe(1)
  } finally { await t.dispose() }
})


test("reusing a work slot clears its old routed audience", async () => {
  const b = browser(), t = await fixture()
  try {
    await t.entry("retry", "failed")
    await t.store.dispatch({ type: "toast.shown", actor: "system", key: "retry", title: "Retrying" }).isPersisted.promise
    expect(t.store.collections.toasts.get("toast-retry")?.audience).toBeUndefined()
    const retry = t.store.collections.toasts.get("toast-retry")!
    expect(railNotices([retry], [], "ben").map(notice => [notice.title, notice.kind, notice.tone])).toEqual([["Retrying", "progress", "live"]])
    expect(b.notices.length).toBe(1)
  } finally { await t.dispose() }
})

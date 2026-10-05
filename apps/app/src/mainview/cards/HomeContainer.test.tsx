import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { HomeCardSchema, type HomeViewProps } from "@smthrs/rpc/HomeCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { fixtures } from "@smthrs/rpc/fixtures/Home"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { HOME_TAGS, HomeCard, HomeContainer, homeFailureModel, homeSource } from "./HomeContainer"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { createDesignWorld } from "../state/seams/DesignWorld"
import { BEN, MAYA } from "../state/seams/DesignWorld/world"
import { designHomeView } from "../state/seams/DesignWorld/home"
import { liveChannel } from "../runtime/LiveChannel"
import { installFixture } from "../state/seams/InstallFixtures.test-support"
const allowed = new Set<CatalogTag>(["todo.new", "github.retry", "todo", "todo.answer", "todo.retry", "todo.drop", "branch", "merge", "stack.move", "order.ok", "main.reset-to-github", "background.retry", "background.dismiss"])
const mount = (model: unknown, role: "owner" | "maintainer" | "member" = "owner", admission = allowed) => {
  let props!: HomeViewProps
  const calls: unknown[] = []
  renderToStaticMarkup(<HomeContainer model={model} role={role} allowed={admission} dispatch={(tag, input) => { calls.push({ tag, input }) }}
    View={value => { props = value; return null }} view={{ maximized: false }} onView={() => {}} />)
  return { props, calls }
}
test("Home fixtures parse and every supplied row control dispatches through catalog bindings", () => {
  for (const fixture of Object.values(fixtures)) {
    const h = mount(fixture.model)
    expect(HomeCardSchema.parse(h.props.model)).toEqual(h.props.model)
    expect(h.props.gestures).toEqual({})
    const actions = [...h.props.actions, ...h.props.model.attention.flatMap(row => row.actions), ...h.props.model.items.flatMap(row => row.actions), ...h.props.model.background_runs.flatMap(row => row.actions)]
    for (const action of actions) {
      const before = h.calls.length
      h.props.onAction(action.tag, action.args)
      if (action.disabled) expect(h.calls).toHaveLength(before)
      else expect((h.calls.at(-1) as { tag: string }).tag).toBe(action.tag)
    }
    expect(h.calls).toHaveLength(actions.filter(action => !action.disabled).length)
  }
})
test("reset is owner-only and binds the actual main revision", () => {
  const base = Object.values(fixtures)[0]!.model
  const model = { ...base, attention: [{ kind: "force_push", text: "Main moved", actions: [{ tag: "main.reset-to-github", label: "Reset to GitHub main" }] }] }
  const owner = mount(model)
  owner.props.onAction("main.reset-to-github")
  expect(owner.calls).toEqual([{ tag: "main.reset-to-github", input: { revision: base.main.sha } }])
  for (const role of ["member", "maintainer"] as const) {
    const h = mount(model, role)
    expect(h.props.model.attention).toEqual([])
    h.props.onAction("main.reset-to-github")
    expect(h.calls).toEqual([])
  }
})
test("order OK is a maintainer's: a member sees neither the order row nor its control", () => {
  const base = Object.values(fixtures)[0]!.model
  const model = { ...base, attention: [{ kind: "order", text: "T3 merged before T2", todo: 3, actions: [{ tag: "order.ok", label: "OK" }] }] }
  for (const role of ["owner", "maintainer"] as const) {
    const h = mount(model, role)
    expect(h.props.model.attention.map(row => row.actions)).toEqual([[{ tag: "order.ok", label: "OK", args: { n: "3" } }]])
    h.props.onAction("order.ok", { n: "3" })
    expect(h.calls).toEqual([{ tag: "order.ok", input: { n: 3 } }])
  }
  const member = mount(model, "member")
  expect(member.props.model.attention).toEqual([])
  member.props.onAction("order.ok", { n: "3" })
  expect(member.calls).toEqual([])
})

test("the mounted Home admission holds Answer, order OK and Reset, so those rows keep their one action", () => {
  for (const tag of ["todo.answer", "order.ok", "main.reset-to-github", "branch", "merge", "github.retry"] as const) expect(HOME_TAGS.has(tag)).toBe(true)
})

test("sync Retry is offered only while main's sync is stale", () => {
  const base = Object.values(fixtures)[0]!.model
  const tags = (health: string) => mount({ ...base, main: { ...base.main, health, last_success_at: new Date(Date.now() - (health === "stale" ? 121_000 : 0)).toISOString() } }).props.actions.map(action => action.tag)
  expect(tags("fresh")).toEqual(["todo.new"])
  expect(tags("stale")).toEqual(["todo.new", "github.retry"])
  expect(tags("limited")).toEqual(["todo.new"])
  expect(tags("refused")).toEqual(["todo.new"])
})

test("lack of admission removes all controls, and unavailable models never render", () => {
  const h = mount(Object.values(fixtures)[0]!.model, "member", new Set())
  expect(h.props.actions).toEqual([])
  expect(h.props.model.items.flatMap(row => row.actions)).toEqual([])
  h.props.onAction("todo.drop")
  expect(h.calls).toEqual([])
  expect(mount(undefined).props).toBeUndefined()
  expect(() => mount({})).toThrow()
})
test("row identity, direction and background run identity stay bound across multiple controls", () => {
  const base = Object.values(fixtures).find(fixture => fixture.model.items.length > 0)!.model
  const row = base.items[0]!
  const model = { ...base, attention: [], items: [{ ...row, n: 42, state: "needs_you", actions: [
    { tag: "todo.answer", label: "Answer" },
    { tag: "stack.move", label: "Move up", args: { direction: "up" } },
    { tag: "stack.move", label: "Move down", args: { direction: "down" } }
  ] }], background_runs: [{ id: "failed-run", title: "Refresh", state: "failed", actions: [
    { tag: "background.retry", label: "Retry" }, { tag: "background.dismiss", label: "Dismiss" }
  ] }] }
  const h = mount(model)
  h.props.onAction("todo.answer", { n: "999", answer: "Keep it" })
  h.props.onAction("stack.move", { n: "42", direction: "up" })
  h.props.onAction("stack.move", { n: "42", direction: "down" })
  h.props.onAction("background.retry", { id: "failed-run" })
  h.props.onAction("background.dismiss", { id: "failed-run" })
  expect(h.calls).toEqual([
    { tag: "todo.answer", input: { n: 42, answer: "Keep it" } },
    { tag: "stack.move", input: { n: 42, direction: "up" } },
    { tag: "stack.move", input: { n: 42, direction: "down" } },
    { tag: "background.retry", input: { id: "failed-run" } },
    { tag: "background.dismiss", input: { id: "failed-run" } }
  ])
  const settled = mount({ ...model, items: [{ ...model.items[0], state: "merged" }] })
  expect(settled.props.model.items[0]!.actions).toEqual([])
})
test("Merge is absent for members and for blocked, later or draft rows", () => {
  const base = Object.values(fixtures).find(fixture => fixture.model.items.length > 0)!.model
  const row = { ...base.items[0]!, state: "in_review", place: 1, merge: { state: "ready", on_github: false }, pr: { number: 123, draft: false }, actions: [{ tag: "merge", label: "Merge" }] }
  for (const role of ["owner", "maintainer", "member"] as const) {
    const h = mount({ ...base, attention: [], items: [row] }, role)
    expect(h.props.model.items[0]!.actions.map(action => action.tag)).toEqual(role === "member" ? [] : ["merge"])
    h.props.onAction("merge", { n: String(row.n) })
    expect(h.calls).toHaveLength(role === "member" ? 0 : 1)
  }
  for (const patch of [{ place: 2 }, { merge: { state: "blocked", on_github: false } }, { pr: { number: 123, draft: true } }]) {
    const h = mount({ ...base, attention: [], items: [{ ...row, ...patch }] })
    expect(h.props.model.items[0]!.actions).toEqual([])
  }
})

/** `live` is the page's `/api/live` channel; without it the controller supplies none and Home subscribes to nothing. */
const seeded = (viewer: string, live = false) => {
  const submitted: unknown[] = []
  const controller = { design: createDesignWorld({ viewer, timers: { set: () => 0, clear: () => {} } }), ...(live ? { live: liveChannel() } : {}),
    commands: { submit: async (command: unknown) => { submitted.push(command); return { status: "executed" } } } } as unknown as AppController
  return { controller, submitted }
}

test("with no home provider Home renders the seeded stack, never nothing", () => {
  const h = seeded(MAYA)
  const markup = renderToStaticMarkup(<ControllerTestProvider controller={h.controller}><HomeCard /></ControllerTestProvider>)
  for (const title of ["Upgrade the Stripe SDK to v17", "Retry failed webhooks with backoff", "Fix the flaky checkout test", "Log every webhook retry attempt"]) expect(markup).toContain(title)
  expect(markup).toContain('data-flow="merge"')
  expect(markup).toContain('data-flow="todo.new"')
  expect(markup).toContain('data-flow="todo.answer"')
  expect(markup.match(/data-flow="branch"/g)).toHaveLength(4)
  // A maintainer sees Merge too; the seeded viewer's role, not a default, decides.
  expect(renderToStaticMarkup(<ControllerTestProvider controller={seeded(BEN).controller}><HomeCard /></ControllerTestProvider>)).toContain('data-flow="merge"')
})

/* A browser with a scripted `/api/live` socket: the card subscribes to `home` on mount. */
const browser = () => {
  GlobalRegistrator.register()
  const frames: Array<{ t: string; id?: number; topic?: string }> = []
  const live: { socket?: { readyState: number; onopen: (() => void) | null; onclose: (() => void) | null; onmessage: ((event: { data: unknown }) => void) | null } } = {}
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, WebSocket: class {
    readyState = 0; onopen: (() => void) | null = null; onclose: (() => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null
    constructor() { live.socket = this }
    send(frame: string) { frames.push(JSON.parse(frame)) }
    close() {}
  } })
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  /** Open the socket and answer the `home` subscription with one frame. */
  const answer = async (frame: Record<string, unknown>) => {
    live.socket!.readyState = 1; live.socket!.onopen?.()
    const sub = frames.find(each => each.t === "sub" && each.topic === "home")!
    expect(sub).toBeDefined()
    await act(async () => live.socket!.onmessage?.({ data: JSON.stringify({ ...frame, id: sub.id }) }))
  }
  // Unmounting releases the topic, which closes the socket; the channel itself is the tab's singleton.
  const close = async () => { await act(async () => root.unmount()); expect(liveChannel().getSnapshot("home")).toBeUndefined(); host.remove(); await GlobalRegistrator.unregister() }
  return { host, root, answer, close }
}
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy()
  await act(async () => (element as HTMLElement).click())
}
const SEEDED_TITLES = ["Upgrade the Stripe SDK to v17", "Retry failed webhooks with backoff", "Fix the flaky checkout test", "Log every webhook retry attempt"]

test("the mounted card composes itself from the controller: Answer opens T9's TODO, the branch chip opens its branch", async () => {
  const b = browser()
  const h = seeded(MAYA, true)
  try {
    await act(async () => b.root.render(<ControllerTestProvider controller={h.controller}><HomeCard /></ControllerTestProvider>))
    expect(b.host.querySelectorAll(".mvp-stack-row")).toHaveLength(4)
    const t9 = [...b.host.querySelectorAll(".mvp-stack-row")].find(row => row.textContent?.includes("T9"))!
    await click(t9.querySelector('button[data-flow="todo.answer"]'))
    expect(h.submitted).toEqual([{ name: "todo", payload: { n: 9 }, actor: "user" }])
    await click(t9.querySelector('button.mvp-branch-chip[data-flow="branch"]'))
    expect(h.submitted.at(-1)).toEqual({ name: "branch", payload: { name: "retry-webhooks" }, actor: "user" })
    expect(t9.querySelector("button.mvp-branch-chip")?.textContent).toBe("retry-webhooks")
  } finally { await b.close() }
})

test("the filter is the member's view state: it narrows the rows and is what a reload reads back", async () => {
  const b = browser()
  const h = seeded(MAYA, true)
  try {
    await act(async () => b.root.render(<ControllerTestProvider controller={h.controller}><HomeCard /></ControllerTestProvider>))
    await click(b.host.querySelector('[data-filter="needs_you"]'))
    expect(designHomeView(h.controller.design, MAYA)).toEqual({ maximized: false, filter: "needs_you" })
    expect([...b.host.querySelectorAll(".mvp-stack-row .mvp-ref")].map(ref => ref.textContent)).toEqual(["T9"])
    expect(b.host.querySelector('[data-filter="needs_you"]')?.getAttribute("aria-pressed")).toBe("true")
    expect(h.submitted).toEqual([])
    await click(b.host.querySelector('[data-filter="needs_you"]'))
    expect(designHomeView(h.controller.design, MAYA)).toEqual({ maximized: false })
    expect(b.host.querySelectorAll(".mvp-stack-row")).toHaveLength(4)
  } finally { await b.close() }
})

test("a host with no home provider keeps the seed; a provider that fails shows main's refused or limited row and no seeded TODO", async () => {
  expect(homeSource(undefined)).toEqual({ kind: "seed" })
  expect(homeSource({ error: "unknown_topic" })).toEqual({ kind: "seed" })
  expect(homeSource({ error: "unsupported" })).toEqual({ kind: "seed" })
  expect(homeSource({ error: "forbidden" })).toEqual({ kind: "failed", code: "forbidden" })
  expect(homeSource({ error: "internal" })).toEqual({ kind: "failed", code: "internal" })
  expect(homeSource({ data: { repository: "acme/api" } })).toEqual({ kind: "failed", code: "invalid" })
  expect(homeFailureModel("acme/api", "forbidden").main).toEqual({ sha: "", title: "main", last_success_at: "1970-01-01T00:00:00.000Z", health: "refused", cause: "Stack access refused" })
  expect(homeFailureModel("acme/api", "internal").main).toMatchObject({ health: "limited", cause: "Stack unavailable" })
  for (const [frame, health, cause] of [
    [{ t: "err", code: "forbidden" }, "refused", "Stack access refused"],
    [{ t: "err", code: "internal" }, "limited", "Stack unavailable"],
    [{ t: "snap", cursor: 1, data: { repository: "acme/api" } }, "limited", "Stack unavailable"]
  ] as const) {
    const b = browser()
    const h = seeded(MAYA, true)
    try {
      await act(async () => b.root.render(<ControllerTestProvider controller={h.controller}><HomeCard /></ControllerTestProvider>))
      await b.answer(frame)
      const text = b.host.textContent ?? ""
      for (const title of SEEDED_TITLES) expect(text).not.toContain(title)
      expect(b.host.querySelectorAll(".mvp-stack-row")).toHaveLength(0)
      expect(b.host.querySelector(".mvp-sync")?.getAttribute("data-health")).toBe(health)
      expect(b.host.querySelector(".mvp-sync")?.textContent).toBe(cause)
      expect([...b.host.querySelectorAll("button[data-flow]")].map(button => button.getAttribute("data-flow"))).toEqual(["todo.new"])
    } finally { await b.close() }
  }
  const b = browser()
  try {
    await act(async () => b.root.render(<ControllerTestProvider controller={seeded(MAYA, true).controller}><HomeCard /></ControllerTestProvider>))
    await b.answer({ t: "err", code: "unknown_topic" })
    for (const title of SEEDED_TITLES) expect(b.host.textContent).toContain(title)
  } finally { await b.close() }
})

test("a controller with no live channel keeps the seed and opens no /api/live socket", async () => {
  GlobalRegistrator.register()
  let sockets = 0
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, WebSocket: class { constructor() { sockets += 1 } } })
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ControllerTestProvider controller={seeded(MAYA).controller}><HomeCard /></ControllerTestProvider>))
    expect(host.querySelectorAll(".mvp-stack-row")).toHaveLength(4)
    expect(sockets).toBe(0)
    expect(liveChannel().getSnapshot("home")).toBeUndefined()
  } finally { await act(async () => root.unmount()); host.remove(); await GlobalRegistrator.unregister() }
})

test("production props alone keep the seed until the home topic serves data; then the topic replaces it", async () => {
  const b = browser()
  const host = b.host, root = b.root
  const calls: unknown[] = []
  const production = { role: "owner" as const, allowed, dispatch: (tag: string, input: unknown) => { calls.push({ tag, input }) }, view: { maximized: false }, onView: () => {} }
  const live = Object.values(fixtures).find(fixture => fixture.model.items.length > 0)!.model
  try {
    await act(async () => root.render(<ControllerTestProvider controller={seeded(MAYA, true).controller}><HomeCard production={production} /></ControllerTestProvider>))
    expect(host.textContent).toContain("Upgrade the Stripe SDK to v17")
    await b.answer({ t: "snap", cursor: 1, data: live })
    expect(host.textContent).not.toContain("Upgrade the Stripe SDK to v17")
    expect(host.textContent).toContain(live.items[0]!.title)
    await b.answer({ t: "gap" })
    expect(host.textContent).toContain(live.items[0]!.title)
    await b.answer({ t: "delta", cursor: 2, data: {} })
    expect(host.textContent).toContain(live.items[0]!.title)
    await b.answer({ t: "snap", cursor: 3, data: { ...live, repository: "Fresh after gap" } })
    expect(host.textContent).toContain("Fresh after gap")
  } finally { await b.close() }
})

test("sync health ages at 120 seconds and preserves refused and limited facts", () => {
  const base = Object.values(fixtures)[0]!.model
  const original = Date.now
  const synced = Date.parse("2026-10-04T00:00:00Z")
  try {
    for (const [age, expected] of [[0, "fresh"], [120_000, "fresh"], [121_000, "stale"]] as const) {
      Date.now = () => synced + age
      const h = mount({ ...base, main: { ...base.main, last_success_at: "2026-10-04T00:00:00Z", health: "fresh" } })
      expect(h.props.model.main.health).toBe(expected)
      expect(h.props.actions.map(action => action.tag)).toEqual(expected === "fresh" ? ["todo.new"] : ["todo.new", "github.retry"])
    }
    for (const health of ["refused", "limited"] as const) {
      const main = { ...base.main, health, cause: "GitHub denied", retry_at: "2026-10-04T01:00:00Z" }
      expect(mount({ ...base, main }).props.model.main).toEqual(main)
    }
  } finally { Date.now = original }
})

test("order attention is private to maintainers and binds its TODO number", () => {
  const base = Object.values(fixtures)[0]!.model
  const model = { ...base, attention: [{ kind: "order", text: "Order changed", todo: 42, actions: [{ tag: "order.ok", label: "OK" }] }] }
  for (const role of ["owner", "maintainer", "member"] as const) {
    const h = mount(model, role)
    expect(h.props.model.attention).toHaveLength(role === "member" ? 0 : 1)
    h.props.onAction("order.ok")
    expect(h.calls).toEqual(role === "member" ? [] : [{ tag: "order.ok", input: { n: 42 } }])
  }
})

test("a mounted Home turns stale on its local clock without another snapshot", async () => {
  GlobalRegistrator.register()
  const originalNow = Date.now
  const originalInterval = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  const ticks: Array<() => void> = []
  let now = Date.parse("2026-10-04T00:02:00Z")
  Date.now = () => now
  globalThis.setInterval = ((tick: () => void) => { ticks.push(tick); return ticks.length }) as unknown as typeof setInterval
  globalThis.clearInterval = (() => {}) as typeof clearInterval
  const host = document.createElement("div")
  const root = createRoot(host)
  const base = Object.values(fixtures)[0]!.model
  let props!: HomeViewProps
  try {
    await act(async () => root.render(<HomeContainer model={{ ...base, main: { ...base.main, health: "fresh", last_success_at: "2026-10-04T00:00:00Z" } }}
      role="owner" allowed={allowed} dispatch={() => {}} view={{ maximized: false }} onView={() => {}}
      View={value => { props = value; return null }} />))
    expect(props.model.main.health).toBe("fresh")
    expect(props.actions.map(action => action.tag)).toEqual(["todo.new"])
    now += 1000
    await act(async () => { for (const tick of ticks) tick() })
    expect(props.model.main.health).toBe("stale")
    expect(props.actions.map(action => action.tag)).toEqual(["todo.new", "github.retry"])
  } finally {
    await act(async () => root.unmount())
    Date.now = originalNow
    globalThis.setInterval = originalInterval
    globalThis.clearInterval = originalClear
    await GlobalRegistrator.unregister()
  }
})

test("only the first unmerged row can offer one Merge, even with duplicate supplied controls", () => {
  const base = Object.values(fixtures).find(fixture => fixture.model.items.length > 0)!.model
  const row = { ...base.items[0]!, state: "in_review", place: 1, merge: { state: "ready", on_github: false }, pr: { number: 123, draft: false }, actions: [{ tag: "merge", label: "Merge" }, { tag: "merge", label: "Merge" }] }
  const h = mount({ ...base, items: [row, { ...row, n: 99 }] })
  expect(h.props.model.items.map(item => item.actions.map(action => action.tag))).toEqual([["merge"], []])
  const waiting = mount({ ...base, items: [{ ...row, state: "working", actions: [] }, { ...row, n: 99 }] })
  expect(waiting.props.model.items.flatMap(item => item.actions)).toEqual([])
})

test("an install without a home provider shows unavailable and never demo rows", () => {
  const h = seeded(MAYA)
  h.controller.design.dispose()
  const controller = { ...h.controller, design: createDesignWorld({ enabled: false }) } as AppController
  const markup = renderToStaticMarkup(<ControllerTestProvider controller={controller}><HomeCard /></ControllerTestProvider>)
  expect(markup).toContain("Stack unavailable")
  expect(markup).not.toContain("acme/api")
  expect(markup).not.toContain("Stripe")
  expect(markup).not.toContain("T9")
  controller.design.dispose()
})

test("Home's machines line reads the install's capacity from GET /api/install, over a served or unavailable stack (#3658)", () => {
  const model = installFixture(); model.capacity = 2; model.parallel = undefined
  const installSnapshots = { get: () => ({ model }), subscribe: () => () => {} }
  const disabled = { ...seeded(MAYA).controller, design: createDesignWorld({ enabled: false }), installSnapshots } as unknown as AppController
  const markup = renderToStaticMarkup(<ControllerTestProvider controller={disabled}><HomeCard /></ControllerTestProvider>)
  expect(markup).toContain("Stack unavailable")
  expect(markup).toContain("0/2 machines")
  expect(markup.match(/title="Free"/g)).toHaveLength(2)
  model.capacity = 0
  expect(renderToStaticMarkup(<ControllerTestProvider controller={disabled}><HomeCard /></ControllerTestProvider>)).toContain("0/0 machines")
  disabled.design.dispose()
})

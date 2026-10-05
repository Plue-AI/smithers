import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { HomeCardSchema, type HomeViewProps } from "@smthrs/rpc/HomeCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { fixtures } from "@smthrs/rpc/fixtures/Home"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { HOME_TAGS, HomeCard, HomeContainer, homeFailureModel, homeSource } from "./HomeContainer"
import { homeFromTodos } from "../state/seams/HomeFromTodos"
import { fixtures as todoFixtures } from "@smthrs/rpc/fixtures/Todo"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import type { TodoListSnapshot } from "../state/seams/TodoSeam"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { createDesignWorld } from "../state/seams/DesignWorld"
import { BEN, MAYA } from "../state/seams/DesignWorld/world"
import { designHomeView } from "../state/seams/DesignWorld/home"
import { liveChannel } from "../runtime/LiveChannel"
import { installFixture } from "../state/seams/InstallFixtures.test-support"
import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { TodoCardSchema } from "@smthrs/rpc/TodoCard"
import { InstallModelSchema } from "../state/seams/InstallModel"
import type { IdentitySession } from "../state/AppState"
import { homeLine } from "../ShellRail"
import { useHome, type HomeAnswer } from "./HomeContainer"
import type { GitHubSyncHealth } from "../state/seams/GitHubSyncSeam"
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

const NO_INSTALL = {}
/**
 * `live` is the page's `/api/live` channel; without it the controller supplies none and Home subscribes to nothing.
 * `login` is the session's (signed out when null); the seed has no install.
 */
const seeded = (viewer: string, live = false, login: string | null = null) => {
  const submitted: unknown[] = []
  const identity: IdentitySession = { id: "identity", state: login === null ? "signed-out" : "signed-in", login, admin: false, scopesPlain: null, updatedAt: 0, revision: 0 }
  const identitySessions = createCollection(localOnlyCollectionOptions<IdentitySession, string>({ getKey: row => row.id, initialData: [identity] }))
  const controller = { design: createDesignWorld({ viewer, timers: { set: () => 0, clear: () => {} } }), ...(live ? { live: liveChannel() } : {}),
    store: { collections: { identitySessions } }, installSnapshots: { get: () => NO_INSTALL, subscribe: () => () => {} },
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

test("an install's main row reads its GitHub sync over an unavailable stack: synced N s ago, gold with Retry past 120 s", () => {
  const h = seeded(MAYA)
  h.controller.design.dispose()
  let health: GitHubSyncHealth | undefined = { state: "fresh", last_success_at: new Date(Date.now() - 40_000).toISOString() }
  const githubSyncSnapshots = { get: () => health, subscribe: () => () => {} }
  const controller = { ...h.controller, design: createDesignWorld({ enabled: false }), githubSyncSnapshots } as AppController
  const render = () => renderToStaticMarkup(<ControllerTestProvider controller={controller}><HomeCard /></ControllerTestProvider>)
  let markup = render()
  expect(markup).toContain("synced 40 s ago")
  expect(markup).not.toContain("Stack unavailable")
  expect(markup).not.toContain('data-flow="github.retry"')
  health = { state: "fresh", last_success_at: new Date(Date.now() - 6 * 60_000).toISOString() }
  markup = render()
  expect(markup).toContain("synced 6 min ago")
  expect(markup).toContain('data-health="stale"')
  expect(markup).toContain('data-flow="github.retry"')
  health = { state: "refused", last_success_at: null, cause: "not_installed" }
  markup = render()
  expect(markup).toContain('data-health="refused"')
  expect(markup).toContain("GitHub App not installed")
  // No success yet, or a host with no sync: the row is the stack's.
  for (const none of [{ state: "stale", last_success_at: null } as const, undefined]) {
    health = none
    expect(render()).toContain("Stack unavailable")
  }
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

// GET /api/todos/1 as the install serves a TODO waiting for a lane (J1 rehearsal evidence, 2026-10-05), with the queue
// the card now carries: no branch, run, PR or steps.
const installQueued: TodoCard = {
  ...todoFixtures.queued.model, n: 1, title: "First local TODO", state: "queued", place: 1, queue: { reason: "machine", position: 1 },
  branch: undefined, run: undefined, steps: [], waits: [], present: [], pr: undefined, merge: { state: "waiting", reason: "state", on_github: false }
}

test("Home from GET /api/todos: one row per unmerged TODO in served order, every state counted, a machine per awake or waking branch", () => {
  const working = { ...todoFixtures.in_review.model, n: 2, title: "Working", state: "working" as const, place: 2, pr: undefined,
    branch: { id: "b2", name: "todo-2", machine: { state: "awake" as const } } }
  const review = { ...todoFixtures.in_review.model, n: 3, place: 1, merge: { state: "ready" as const, on_github: false }, pr: { ...todoFixtures.in_review.model.pr!, draft: false } }
  const merged = { ...todoFixtures.merged.model, n: 4 }
  const home = homeFromTodos("local-owner/demo", [installQueued, working, review, merged])
  expect(HomeCardSchema.parse(home)).toEqual(home)
  expect(home.repository).toBe("local-owner/demo")
  expect(home.items.map(item => [item.n, item.state])).toEqual([[1, "queued"], [2, "working"], [3, "in_review"]])
  expect(home.counts).toEqual({ queued: 1, starting: 0, working: 1, needs_you: 0, paused: 0, failed: 0, in_review: 1, merged: 1, dropped: 0 })
  expect(home.items[0]).toMatchObject({ queue: { reason: "machine", position: 1 }, branch: { id: "", name: "" }, place: 1 })
  expect(home.items[0]!.actions).toEqual([{ tag: "todo", label: "First local TODO", args: { n: "1", door: "title" } }])
  expect(home.items[2]!.actions.map(action => [action.tag, action.label])).toEqual([["todo", review.title], ["merge", "Merge"]])
  expect(home.machines.in_use).toBe(2)
  expect(home.machines.slots.map(slot => [slot.branch, slot.awake, slot.actor.kind === "agent" && slot.actor.todo])).toEqual([["todo-2", true, 2], ["todo/12", true, 3]])
  expect(home.main).toMatchObject({ title: "main", health: "limited" })
  expect(home.main.cause).toBeUndefined()
})

test("an install's Home reads its rows from GET /api/todos: nothing until the list answers, then the rows, never the seed", () => {
  const install = installFixture(); install.capacity = 2; install.repository = { owner: "local-owner", name: "demo" }
  let snapshot: TodoListSnapshot = {}
  let subscribed = 0
  const todoList = { get: () => snapshot, subscribe: () => { subscribed++; return () => {} } }
  const controller = { ...seeded(MAYA).controller, design: createDesignWorld({ enabled: false }), todoList,
    installSnapshots: { get: () => ({ model: install }), subscribe: () => () => {} } } as unknown as AppController
  const render = () => renderToStaticMarkup(<ControllerTestProvider controller={controller}><HomeCard /></ControllerTestProvider>)
  try {
    expect(render()).toBe("")
    snapshot = { todos: [installQueued] }
    const markup = render()
    expect(markup).toContain("local-owner/demo")
    expect(markup).toContain("First local TODO")
    expect(markup).toContain("waiting for a machine #1")
    expect(markup).toContain("0/2 machines")
    expect(markup).not.toContain("Stack unavailable")
    expect(markup).not.toContain("Stripe")
    snapshot = { todos: [installQueued], error: "unreachable" }
    expect(render()).toContain("First local TODO")
    snapshot = { error: "forbidden" }
    expect(render()).toContain("Stack access refused")
    snapshot = { error: "internal" }
    expect(render()).toContain("Stack unavailable")
    // A host that serves the `home` topic or keeps the seed never reads the list.
    const seed = { ...seeded(MAYA).controller, todoList } as unknown as AppController
    expect(renderToStaticMarkup(<ControllerTestProvider controller={seed}><HomeCard /></ControllerTestProvider>)).toContain("Stripe")
    expect(subscribed).toBe(0)
    seed.design.dispose()
  } finally { controller.design.dispose() }
})

test("over the rows GET /api/todos serves, main's row is the install's GitHub sync, with Retry once it is stale", () => {
  let health: GitHubSyncHealth | undefined = { state: "fresh", last_success_at: new Date(Date.now() - 6 * 60_000).toISOString() }
  const controller = { ...seeded(MAYA).controller, design: createDesignWorld({ enabled: false }),
    todoList: { get: () => ({ todos: [installQueued] }), subscribe: () => () => {} },
    githubSyncSnapshots: { get: () => health, subscribe: () => () => {} } } as unknown as AppController
  const render = () => renderToStaticMarkup(<ControllerTestProvider controller={controller}><HomeCard /></ControllerTestProvider>)
  try {
    let markup = render()
    expect(markup).toContain("First local TODO")
    expect(markup).toContain("synced 6 min ago")
    expect(markup).toContain('data-health="stale"')
    expect(markup).toContain('data-flow="github.retry"')
    health = { state: "fresh", last_success_at: new Date(Date.now() - 12_000).toISOString() }
    markup = render()
    expect(markup).toContain("synced 12 s ago")
    expect(markup).not.toContain('data-flow="github.retry"')
    health = undefined
    expect(render()).not.toContain("synced")
  } finally { controller.design.dispose() }
})

// Verbatim GET /api/todos and GET /api/install bodies from the J1 rehearsal on main 3e5e2f63ee (walk guard evidence
// .artifacts/checks/C-J1-04/rehearsal/20261005T102611.163715000Z/http.log, 2026-10-05), read at "App agent lists TODOs":
// the owner's install of rehearsal-owner/app with T1 in review and its PR ready to merge.
const rehearsalAvatar = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cmVjdCB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHJ4PSIyNCIgZmlsbD0iI2RkZCIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iMTgiIHI9IjgiIGZpbGw9IiM4ODgiLz48cGF0aCBkPSJNOCA0NGExNiAxNiAwIDAgMSAzMiAwIiBmaWxsPSIjODg4Ii8+PC9zdmc+"
const rehearsalTodos = [{ branch: { id: "246747bc-a568-4a43-816d-85b00faf2671", machine: { state: "awake" }, name: "TODO 1 attempt 1 g1" },
  evidence: [{ attempt: 1, revision: "fd950a828594e5de5dc57368d01c5a310bb2117b", items: [
    { kind: "check", name: "build", state: "passed", took_s: 1.66 }, { kind: "check", name: "test", state: "passed", took_s: 1.734 },
    { kind: "model_access", label: "AI Gateway · Smithers credit: typesafe-ai/jev; Cerebras · Smithers credit: gpt-oss-120b" }] }],
  merge: { on_github: true, state: "ready" }, n: 1, owner: { avatar_url: rehearsalAvatar, login: "rehearsal-owner", name: "Rehearsal owner" }, place: 1,
  pr: { draft: false, head: "8c413d1e214d30116a198803fbd5d4e9d0d0b36d", included_items: [1], number: 1, url: "https://github.com/rehearsal-owner/app/pull/1" },
  present: [], prompt_revisions: [{ at: "2026-10-05T10:26:27.528829Z",
    by: { kind: "person", name: "Rehearsal owner", login: "rehearsal-owner", avatar_url: rehearsalAvatar, color_index: 0 }, text: "Add a greeting to JOURNEY.md", acceptance: [] }],
  run: { attempt: 1, id: "run-1", indicators: [] }, state: "in_review", steers: [],
  steps: [{ id: "request", label: "Plan", state: "done" }, { id: "vibe", label: "Code", state: "done" }], title: "First TODO", waits: [] }]
const rehearsalInstall = { address: { bind: "127.0.0.1:4000", listen: "mac", origins: ["http://127.0.0.1:55380"] }, capacity: 0, chatgpt: false,
  github: { app_installed: true, owner: "rehearsal-owner", signed_in: true, squash_allowed: true },
  models: [{ key: "saved", provider: "openai-chat", role: "fast" }, { key: "saved", provider: "openai-chat", role: "coding" }, { key: "saved", provider: "AI Gateway", role: "jev" }],
  repository: { name: "app", owner: "rehearsal-owner" },
  steps: [{ id: "address", state: "done" }, { id: "app_manifest", state: "done" }, { id: "sign_in", state: "done" }, { id: "repository", state: "done" },
    { id: "models", state: "done" }, { id: "source", pct: 100, state: "done" }, { id: "machine", pct: 100, state: "done" }],
  this_mac: { capacity: 0, disk_free_gb: 0, memory_gb: 0 } }

/** The rehearsal's install as `login` opens it: the seed off, GET /api/install and GET /api/todos served. */
const rehearsalHost = (login: string, todos: unknown = rehearsalTodos) => {
  const h = seeded(MAYA, false, login)
  h.controller.design.dispose()
  const install = { model: InstallModelSchema.parse(rehearsalInstall) }
  const list = { todos: TodoCardSchema.array().parse(todos) }
  const controller = { ...h.controller, design: createDesignWorld({ enabled: false }),
    installSnapshots: { get: () => install, subscribe: () => () => {} }, todoList: { get: () => list, subscribe: () => () => {} } } as unknown as AppController
  return { controller, submitted: h.submitted }
}

test("on an install the session decides the role: over the J1 rehearsal's GET /api/todos the owner sees exactly one Merge, on T1; a member sees none", async () => {
  GlobalRegistrator.register()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  try {
    for (const [login, merges] of [["rehearsal-owner", [1]], ["ben", []]] as const) {
      const h = rehearsalHost(login)
      const host = document.createElement("div"); document.body.append(host)
      const root = createRoot(host)
      try {
        await act(async () => root.render(<ControllerTestProvider controller={h.controller}><HomeCard /></ControllerTestProvider>))
        const rows = [...host.querySelectorAll(".mvp-stack-row")]
        expect(rows.map(row => row.querySelector(".mvp-ref")?.textContent)).toEqual(["T1"])
        expect(host.textContent).toContain("First TODO")
        expect(host.textContent).not.toContain("Stripe")
        expect(rows.flatMap((row, index) => [...row.querySelectorAll('button[data-flow="merge"]')].map(() => index + 1))).toEqual([...merges])
        expect(host.querySelectorAll('button[data-flow="merge"]')).toHaveLength(merges.length)
        if (merges.length > 0) {
          await click(host.querySelector('button[data-flow="merge"]'))
          expect(h.submitted).toEqual([{ name: "merge", payload: { n: 1 }, actor: "user" }])
        }
      } finally { await act(async () => root.unmount()); host.remove(); h.controller.design.dispose() }
    }
  } finally { await GlobalRegistrator.unregister() }
})

test("the seed's role goes only with the seed's rows: a signed-in session never changes the seeded viewer's Merge", () => {
  const maya = seeded(MAYA, false, "someone-else")
  expect(renderToStaticMarkup(<ControllerTestProvider controller={maya.controller}><HomeCard /></ControllerTestProvider>)).toContain('data-flow="merge"')
  maya.controller.design.dispose()
})

/** What useHome answers on `controller`'s host, rendered once. */
const probeHome = (controller: AppController): HomeAnswer | undefined => {
  const seen: Array<HomeAnswer | undefined> = []
  const Probe = () => { seen.push(useHome()); return null }
  renderToStaticMarkup(<ControllerTestProvider controller={controller}><Probe /></ControllerTestProvider>)
  expect(seen).toHaveLength(1)
  return seen[0]
}
const answered = (home: HomeAnswer | undefined): HomeAnswer => {
  expect(home).toBeDefined()
  return home!
}

test("the rail's home line on an install names the repository and counts GET /api/todos, never the seed", () => {
  const owner = rehearsalHost("rehearsal-owner")
  const home = answered(probeHome(owner.controller))
  expect(home).toMatchObject({ kind: "served", role: "owner", model: { repository: "rehearsal-owner/app" } })
  expect(homeLine(home)).toEqual({ entry_id: "home", kind: "card", title: "rehearsal-owner/app", summary: "0 need you · 0 working", tone: "quiet", glyph: { state: "queued" } })
  owner.controller.design.dispose()
  const [t1] = rehearsalTodos
  const busy = rehearsalHost("rehearsal-owner", [
    { ...t1, n: 2, state: "needs_you", place: 2, waits: [{ id: "w2", kind: "question", prompt: "Which greeting?", since: "2026-10-05T10:27:00Z", actions: [] }] },
    { ...t1, n: 3, state: "starting", place: 3, pr: undefined }, { ...t1, n: 4, state: "working", place: 4, pr: undefined }])
  const counted = answered(probeHome(busy.controller))
  expect(homeLine(counted)).toEqual({ entry_id: "home", kind: "card", title: "rehearsal-owner/app", summary: "1 need you · 2 working", tone: "attention", glyph: { state: "needs_you" } })
  expect(homeLine({ ...counted, model: { ...counted.model, counts: { ...counted.model.counts, needs_you: 0 } } }).tone).toBe("live")
  busy.controller.design.dispose()
  // Until the first list read answers there is no line; a failed read names the repository and claims no counts.
  const unread = {}, forbidden = { error: "forbidden" }
  const pending = { ...rehearsalHost("rehearsal-owner").controller, todoList: { get: () => unread, subscribe: () => () => {} } } as unknown as AppController
  expect(probeHome(pending)).toBeUndefined()
  const refused = { ...pending, todoList: { get: () => forbidden, subscribe: () => () => {} } } as unknown as AppController
  const failed = answered(probeHome(refused))
  expect(homeLine(failed)).toEqual({ entry_id: "home", kind: "card", title: "rehearsal-owner/app", tone: "quiet", glyph: { state: "queued" } })
  pending.design.dispose()
})

test("on a host with the seed the rail's home line reads the seeded stack", () => {
  const h = seeded(MAYA)
  const home = answered(probeHome(h.controller))
  expect(home.kind).toBe("seed")
  expect(homeLine(home)).toEqual({ entry_id: "home", kind: "card", title: home.model.repository, summary: "1 need you · 1 working", tone: "attention", glyph: { state: "needs_you" } })
  h.controller.design.dispose()
})

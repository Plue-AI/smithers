import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { act } from "react"
import { CardView, type CardViewProps } from "./ChatCards"
import { CardSchema } from "@smthrs/rpc/Cards"
import { createAppStore } from "./state/AppStore"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const noop = () => {}
const issue = CardSchema.parse({ id: "issue", kind: "issue", title: "Issue", status: "active", ordinal: 1, createdAt: 1, payload: { repo: "smithersai/hello-server", number: 3, title: "Greet the world", state: "open", author: "Ada", issueBody: "Body", labels: [], comments: [] } })
const props: CardViewProps = { card: issue, maximized: false, onMaximize: noop, onMinimize: noop, 
  onDecideApproval: noop, onGrantConfirm: noop, onGrantCancel: noop, onConnectGitHub: noop,
  onRunWorkflow: noop, onStopRun: noop, onRetryRun: noop, onChooseWorkflowRepo: noop,
  worldDocuments: [], onChangeWorldDocument: noop, onRunCommand: noop }
const mount = (overrides: Partial<CardViewProps> = {}, onKeyDown = noop) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = (more: Partial<CardViewProps>) => flushSync(() => root.render(<div onKeyDown={onKeyDown}><CardView {...props} {...overrides} {...more} /></div>))
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  render({})
  return { host, render }
}

test("Escape restores the same card through its minimize callback and does not escape into the guide", () => {
  let minimizations = 0
  let escaped = 0
  const { host, render } = mount({ onMinimize: () => { minimizations++; render({ maximized: false }) } }, () => { escaped++ })
  const card = host.querySelector(".smithers-card")!
  const body = card.querySelector(".smithers-card-body")
  render({ maximized: true })
  flushSync(() => card.querySelector('button[data-flow="card.minimize"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
  expect(minimizations).toBe(1)
  expect(escaped).toBe(0)
  expect(host.querySelector(".smithers-card")).toBe(card)
  expect(card.querySelector(".smithers-card-body")).toBe(body)
  expect(card.getAttribute("data-maximized")).toBe("false")
  expect(host.querySelector(".card-maximize-backdrop")).toBeNull()
})

test("focus follows a card command whose durable receipt arrives after an animation frame", async () => {
  let maximizations = 0
  let minimizations = 0
  const { host, render } = mount({ onMaximize: () => { maximizations++ }, onMinimize: () => { minimizations++ } })
  host.querySelector<HTMLButtonElement>('[data-flow="card.maximize"]')!.click()
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  expect(maximizations).toBe(1)
  render({ maximized: true })
  const restore = host.querySelector<HTMLButtonElement>('[data-flow="card.minimize"]')!
  expect(document.activeElement).toBe(restore)
  restore.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  expect(minimizations).toBe(1)
  render({ maximized: false })
  expect(document.activeElement).toBe(host.querySelector('[data-flow="card.maximize"]'))
})

test("a maximized frame with local history has one navigation pair bound to that history", () => {
  const calls: unknown[] = []
  const { host } = mount({ maximized: true, card: { ...issue, navigation: { index: 1, length: 2 } }, onRunCommand: (...args) => { calls.push(args) } })
  expect(host.querySelectorAll(".smithers-card-header")).toHaveLength(1)
  expect(host.querySelectorAll(".card-maximize-backdrop")).toHaveLength(1)
  expect(host.querySelectorAll('[data-flow="frame.back"], [data-flow="frame.forward"]')).toHaveLength(0)
  host.querySelector<HTMLButtonElement>('[data-flow="card.history.back"]')!.click()
  expect(calls).toEqual([["card.history.back", "issue"]])
})

test("an Open issue has no internal DONE details; completed runs retain their Details", () => {
  const { host, render } = mount()
  expect(host.textContent).toContain("Open")
  expect(host.querySelector(".smithers-card-details")).toBeNull()
  const run = CardSchema.parse({ id: "run", kind: "run-trace", title: "Run", status: "active", ordinal: 1, createdAt: 1,
    payload: { repo: "smithersai/hello-server", runId: "run", workflow: "issue.research", kind: "research", phase: "completed", steps: [], result: null, lastSeq: 0 } })
  render({ card: run })
  expect(host.querySelector(".smithers-card-details")?.textContent).toContain("Status")
  expect(host.querySelector(".smithers-card-details")?.textContent).toContain("Created")
})

test("mounted repository updates derive versioned reads and current tags for saved and historical cards", async () => {
  const rows = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => rows.get(key) ?? null, setItem: (key, value) => { rows.set(key, value) }, removeItem: key => { rows.delete(key) }
  } })
  const reactEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const notification = { id: "notice", scope: "github:one", repo: "org/repo", source: "smithers" as const, sourceId: "1", kind: "issue" as const,
    number: 1, title: "An issue", state: "open", updatedAt: "v1", version: "v1", tags: ["original"], processedAt: 1 }
  const observe = (version: string) => store.dispatch({ type: "repo.update.observed", actor: "system",
    context: { id: "context", scope: "github:one", data: { repo: "org/repo", checkedAt: 1, openIssues: 1, openPrs: 0, problems: [], items: [], truncated: false } },
    notifications: [{ ...notification, version, updatedAt: version, tags: version === "v1" ? ["original"] : ["original", "follow-up"] }]
  }).isPersisted.promise
  const card = CardSchema.parse({ id: "activity-live", kind: "repo-update", title: "Activity", status: "active", ordinal: 1, createdAt: 1,
    payload: { scope: "github:one", repo: "org/repo", checkedAt: 1, summary: "One update", openIssues: 1, openPrs: 0, problems: [],
      items: [{ id: "notice", version: "v1", source: "smithers", kind: "issue", number: 1, title: "An issue", state: "open", tags: ["original"], read: false }] } })
  await observe("v1")
  await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
  const saved = store.collections.cards.get(card.id)!
  const current = mount({ card: saved, projectionStore: store })
  const historical = mount({ card: structuredClone(saved), projectionStore: store, maximized: true })
  const reads = () => [current, historical].map(({ host }) => host.querySelector(".repo-update-item")?.getAttribute("data-read"))
  try {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(reads()).toEqual(["false", "false"])
    await act(async () => {
      await store.dispatch({ type: "notifications.read", actor: "user", receipts: [{ id: "notice", version: "v1" }] }).isPersisted.promise
      await store.dispatch({ type: "notification.tagged", actor: "user", id: "notice", tag: "follow-up" }).isPersisted.promise
    })
    expect(reads()).toEqual(["true", "true"])
    for (const { host } of [current, historical]) {
      expect(host.textContent).toContain("follow-up")
      expect(host.querySelector(".repo-update-unread")).toBeNull()
      expect(host.querySelector('[data-flow="notifications.read-update"]')).toBeNull()
    }
    await act(async () => { await observe("v2") })
    expect(reads()).toEqual(["true", "true"])
    expect(store.collections.cards.get(card.id)).toEqual(saved)
    expect(store.collections.repositoryNotifications.get("notice")?.readVersion).toBeUndefined()
    expect((await store.verifyState()).valid).toBe(true)
  } finally {
    while (cleanups.length) cleanups.pop()!()
    await store.dispose?.()
    if (previousActEnvironment === undefined) delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT
    else reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

test("a conversations list is headed Conversations; every other issue list is headed Issues", () => {
  const list = (kind?: "conversation" | "issue") => CardSchema.parse({ id: "issues", kind: "issue-list", title: "Issues", status: "active", ordinal: 1, createdAt: 1,
    payload: { repo: "will/flows", filter: "open", issues: [], ...(kind === undefined ? {} : { kind }) } })
  const { host, render } = mount({ card: list("conversation") })
  expect(host.querySelector(".smithers-card-title")?.textContent).toBe("Conversations")
  for (const kind of [undefined, "issue"] as const) {
    render({ card: list(kind) })
    expect(host.querySelector(".smithers-card-title")?.textContent).toBe("Issues")
  }
})

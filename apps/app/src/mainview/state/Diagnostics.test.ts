import { afterEach, describe, expect, test } from "bun:test"
import { inspect } from "node:util"
import { createAppStore as openAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { parseDiagnosticQuery, readDiagnostics } from "./Diagnostics"
import { SMITHERS_INSTRUCTIONS } from "./Instructions"
import { memoryStorage, silentAgent } from "./TestFixtures"

// Pure read/query tests below are independent of these controlled controller boundaries.
// Map storage, silent AgentPort and explicit HTTP doubles do not qualify real backend integration.
const closeStore = async (store: AppStore): Promise<void> => {
  if (store.dispose === undefined) throw new Error("Fixture store has no disposal contract")
  await store.dispose()
}
const stores = new Set<AppStore>()
const releaseRequests: Array<() => void> = []
const pendingRequests: Array<Promise<unknown>> = []
const unexpectedRequests: string[] = []
// Release held HTTP before shared controller cleanup; controllers close before
// the later hook drains the request and disposes every original/reopened store.
afterEach(() => { for (const release of releaseRequests.splice(0)) release() })
const openAppController = scopedControllers()
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Diagnostic fixture did not settle")), 3000)
    })])
  } finally { clearTimeout(timer) }
}
const createAppStore: typeof openAppStore = async (...args) => {
  const store = await openAppStore(...args)
  stores.add(store)
  return store
}
const createAppController: typeof openAppController = (store, agent, services) => {
  return openAppController(store, agent, {
    ...services,
    fetchImpl: services?.fetchImpl ?? (async input => {
      unexpectedRequests.push(String(input))
      throw new Error("Unexpected diagnostic fixture request")
    })
  })
}
afterEach(async () => {
  const errors: unknown[] = []
  try {
    const results = await bounded(Promise.allSettled(pendingRequests.splice(0)))
    for (const result of results) if (result.status === "rejected") errors.push(result.reason)
  } catch (error) { errors.push(error) }
  finally {
    for (const store of stores) {
      try { await closeStore(store) } catch (error) { errors.push(error) }
    }
    stores.clear()
  }
  const requests = unexpectedRequests.splice(0)
  if (requests.length) errors.push(new Error(`Unexpected fixture HTTP requests: ${requests.join(", ")}`))
  if (errors.length) throw new AggregateError(errors, "Diagnostic fixture cleanup failed")
})
const toast = async (store: AppStore, detail: string, key = "billing.refresh") => {
  await store.dispatch({ type: "toast.shown", actor: "system", key, title: "Refreshing balance" }).isPersisted.promise
  await store.dispatch({ type: "toast.resolved", actor: "system", key, status: "failed", detail }).isPersisted.promise
}
const read = async (controller: ReturnType<typeof createAppController>, args?: string) => {
  const result = await controller.commands.runForAgent("debug.errors", args)
  if (result.status !== "executed") throw new Error(JSON.stringify(result))
  return JSON.parse(result.value!) as ReturnType<typeof readDiagnostics>
}

describe("app diagnostics without a repository", () => {
  test("the agent discovers and reads failures signed out without admin access", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent)
    await toast(store, "Billing service unavailable")
    expect(store.collections.repositories.size).toBe(0)
    expect(controller.commands.callable().map(entry => entry.binding.descriptor.name)).toContain("debug.errors")
    expect(controller.commands.disclosed().map(command => command.name)).toContain("debug.errors")
    expect(controller.commands.find("debug.snapshot")).toBeUndefined()
    const before = store.collections.messages.size
    const result = await read(controller)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ source: "toast", status: "failed", title: "Refreshing balance", detail: "Billing service unavailable" })
    expect(store.collections.messages.size).toBe(before)
    expect(SMITHERS_INSTRUCTIONS).toContain("execute debug.errors in this turn")
    expect(SMITHERS_INSTRUCTIONS).toContain("never ask to import a repo to inspect app errors")
  })

  test("dismissed and repeated toasts remain readable after reopening the store", async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    await toast(store, "First attempt failed")
    await toast(store, "Second attempt failed")
    await store.dispatch({ type: "toast.dismissed", actor: "user", id: "toast-billing.refresh" }).isPersisted.promise
    const reopened = await createAppStore({ kind: "localStorage", storage })
    const controller = createAppController(reopened, silentAgent)
    expect(reopened.collections.toasts.size).toBe(0)
    const result = await read(controller, "--source toast")
    expect(result.items.map(row => row.detail)).toEqual(["Second attempt failed", "First attempt failed"])
    expect(result.coverage.note).toContain("newest 500 transitions")
  })

  test("the human slash door renders the errors in chat and leaves the current surface alone", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent)
    await toast(store, "Service refused the request")
    const surface = store.session().surface
    expect((await controller.commands.run("debug.errors", "refused --source toast")).status).toBe("executed")
    expect([...store.collections.messages.values()].at(-1)?.text).toContain("Service refused the request")
    expect(store.session().surface).toBe(surface)
  })

  test("filters text, source, time and limit; includes running notices only with --all", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent)
    await toast(store, "Request timed out", "first")
    await toast(store, "Request refused", "second")
    await store.dispatch({ type: "toast.shown", actor: "system", key: "active", title: "Still loading" }).isPersisted.promise
    const limited = await read(controller, "--source toast --limit 1")
    expect(limited.items).toHaveLength(1)
    expect(limited.totalMatching).toBe(2)
    expect(limited.hasMore).toBe(true)
    expect((await read(controller, "TIMED OUT --source toast")).items[0]?.detail).toBe("Request timed out")
    expect((await read(controller, "--since 2999-01-01T00:00:00Z")).items).toEqual([])
    expect((await read(controller, "Still loading")).items).toEqual([])
    expect((await read(controller, "Still loading --all")).items[0]?.status).toBe("running")
    expect((await read(controller, "--source event")).items).toEqual([])
    for (const args of ["--limit 0", "--limit 101", "--limit 1.5", "--since yesterday", "--source missing", "--unknown"]) {
      expect((await controller.commands.runForAgent("debug.errors", args)).status).toBe("failed")
    }
  })

  test("reads network and application failures without exposing request data or successful tool content", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async input => {
        if (String(input).includes("offline")) throw new Error("offline")
        return new Response("private response body", { status: String(input).includes("healthy") ? 200 : 503 })
      }
    })
    await controller.tappedFetch("https://user:private-password@app.test/failing?token=private-token#private-fragment")
    await controller.tappedFetch("/healthy")
    await controller.tappedFetch("/offline").catch(() => {})
    await store.dispatch({ type: "message.submitted", actor: "user", turnId: "turn", text: "A request" }).isPersisted.promise
    await store.dispatch({ type: "message.response.failed", actor: "system", turnId: "turn", message: "Chat request failed" }).isPersisted.promise
    await store.dispatch({ type: "toolcall.recorded", actor: "smithers", turnId: "turn", name: "files.read", arguments: "private arguments", result: "private content mentions error" }).isPersisted.promise
    await store.dispatch({ type: "toolcall.recorded", actor: "smithers", turnId: "turn", name: "files.list", arguments: "private arguments", result: "failed: Access denied" }).isPersisted.promise
    const result = await read(controller)
    expect(result.items.map(row => row.source).sort()).toEqual(["event", "network", "network", "tool"])
    expect(result.items.find(row => row.status === "503")?.title).toBe("GET https://app.test/failing")
    expect(JSON.stringify(result)).not.toContain("private")
    expect((await read(controller, "--all --source network")).items).toHaveLength(3)
  })

  test("account changes scrub old evidence and late requests cannot restore it", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const identity = (login: string | null) => store.dispatch({ type: "identity.session.loaded", actor: "system", state: login ? "signed-in" : "signed-out", login, allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    await identity("alice")
    const late = Promise.withResolvers<Response>()
    const entered = Promise.withResolvers<void>()
    releaseRequests.push(() => late.resolve(new Response("", { status: 500 })))
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async input => {
        if (!String(input).includes("late")) return new Response("", { status: 500 })
        entered.resolve()
        return late.promise
      }
    })
    await toast(store, "Alice's failure")
    await controller.tappedFetch("/alice/private")
    const pending = controller.tappedFetch("/alice/late")
    pendingRequests.push(pending)
    await bounded(entered.promise)
    await identity(null)
    await identity("bob")
    late.resolve(new Response("", { status: 500 }))
    await pending
    const result = await read(controller)
    expect(JSON.stringify(result)).not.toContain("alice")
    expect(JSON.stringify(result)).not.toContain("Alice")
    expect(result.items).toEqual([])
  })

  test("redacts quoted, multi-word and inspect-split credentials before the clip", () => {
    const query = parseDiagnosticQuery("")
    if (typeof query === "string") throw new Error(query)
    const secret = "ZqSynthetic7Secret4Value9"
    const details = [
      `connect failed: password: 'correct horse ${secret}'`,
      `connect failed: ${inspect({ privateKey: `${secret}\n`.repeat(8) })}`
    ]
    const result = readDiagnostics({ transitions: [], network: [], toolCalls: [], toasts: details.map((detail, index) => ({
      id: String(index), key: String(index), title: "failure", status: "failed" as const, detail, createdAt: index, updatedAt: index
    })) }, query)
    expect(result.items).toHaveLength(2)
    for (const item of result.items) expect(item.detail).toContain("[REDACTED")
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain("horse")
  })

  test("long results stay bounded and report omitted matches", () => {
    const query = parseDiagnosticQuery("--limit 100")
    if (typeof query === "string") throw new Error(query)
    const result = readDiagnostics({ transitions: [], network: [], toolCalls: [], toasts: Array.from({ length: 100 }, (_, index) => ({
      id: String(index), key: String(index), title: "failure", status: "failed" as const,
      detail: "x".repeat(10_000), createdAt: index, updatedAt: index
    })) }, query)
    expect(result.totalMatching).toBe(100)
    expect(result.hasMore).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThan(25_000)
    expect(result.items[0]?.detail).toContain("[truncated]")
  })

  test("records card failures while keeping arbitrary card payloads out of the read", () => {
    const result = readDiagnostics({ toasts: [], network: [], toolCalls: [], transitions: [
      { id: "transition-1", revision: 1, actor: "system", type: "card.upsert", createdAt: 1,
        payload: JSON.stringify({ card: { id: "graph", title: "Target graph", status: "error", payload: { error: "Graph load failed", content: "private file bytes" } } }) },
      { id: "transition-2", revision: 2, actor: "system", type: "card.updated", createdAt: 2,
        payload: JSON.stringify({ id: "graph", patch: { status: "error", payload: { error: "Retry failed" } } }) }
    ] }, { text: "", all: false, limit: 20 })
    expect(result.items.map(row => row.detail)).toEqual(["Retry failed", "Graph load failed"])
    expect(result.items[1]?.title).toBe("Target graph")
    expect(JSON.stringify(result)).not.toContain("private file bytes")
  })
})

test("operational failures are available through the diagnostic source filter", () => {
  const query = parseDiagnosticQuery("--source operation")
  expect(typeof query).toBe("object")
  if (typeof query === "string") throw Error(query)
  const result = readDiagnostics({ transitions: [], toasts: [], toolCalls: [], network: [], operations: [
    { seam: "run.pump", subject: "run-1", lost: "app-bug", fault: "infra", message: "disk", at: 100, count: 3 }
  ] }, query)
  expect(result.items).toEqual([{ id: "operation-100-0", source: "operation", status: "app-bug", title: "run.pump run-1", detail: "disk ×3", at: new Date(100).toISOString() }])
})

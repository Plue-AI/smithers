import { expect, test } from "bun:test"
import { writeOnlyGesture } from "../flows/CommandGesture"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { unavailableAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

test("Claude form and controller keep a held token out of history and persisted storage", async () => {
  const persisted = new Map<string, string>()
  const hold = deferred<Response>()
  const posts: string[] = []
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => persisted.get(key) ?? null, setItem: (key, value) => { persisted.set(key, value) }, removeItem: key => { persisted.delete(key) }
  } })
  const controller = createAppController(store, unavailableAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/api/user/provider-connections") && init?.method === "POST") { posts.push(String(init.body)); return hold.promise }
      return Response.json([])
    }
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
  const start = await controller.commands.runForAgent("secrets.connect")
  expect(start).toMatchObject({ status: "executed" })
  const confirmation = [...store.collections.messages.values()].find(message => message.action?.flow === "secrets.connect")!
  expect(confirmation.action?.label).toContain("Confirm:")
  expect(await controller.commands.run(confirmation.action!.flow, confirmation.action!.args)).toMatchObject({ status: "form" })
  const id = "form-secrets.connect"
  const card = store.collections.cards.get(id)
  expect(card?.kind === "flow-form" && card.payload.fields.find(field => field.name === "value")?.kind).toBe("write-only")
  const token = "sk-ant-api03-private-controller-fixture"
  expect(await controller.commands.run("form.set", `${id} value ${token}`)).toMatchObject({ status: "failed" })
  expect(await controller.commands.submit({ name: "form.submit", actor: "user", payload: { cardId: id }, gesture: writeOnlyGesture("form.submit", { value: token }) })).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => posts.length === 1)
  await store.settled?.()
  expect(JSON.stringify([...persisted])).not.toContain(token)
  expect(JSON.stringify([...store.collections.cards.values(), ...store.collections.messages.values(), ...store.collections.transitions.values()])).not.toContain(token)
  const request = store.session().codingProviderRequests?.[0]
  expect(request).toMatchObject({ owner: "alice", action: "connect", state: "requested" })
  expect(posts[0]).toContain(token)
  expect(await controller.commands.submit({ name: "form.submit", actor: "user", payload: { cardId: id }, gesture: writeOnlyGesture("form.submit", { value: token }) })).toMatchObject({ status: "failed" })
  expect(posts).toHaveLength(1)
  hold.resolve(Response.json({ id: "conn-1", provider: "claude", state: "active", label: `web-${request!.id}` }, { status: 201 }))
  await waitFor(() => store.session().codingProviderRequests?.[0]?.state === "completed")
})

test("reload reconciles a token-free connect receipt and revocation through the controller", async () => {
  const persisted = new Map<string, string>()
  const storage = { getItem: (key: string) => persisted.get(key) ?? null, setItem: (key: string, value: string) => { persisted.set(key, value) }, removeItem: (key: string) => { persisted.delete(key) } }
  const first = await createAppStore({ kind: "localStorage", storage })
  await first.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
  await first.dispatch({ type: "coding.provider.requests.changed", actor: "system", requests: [{ id: "request-1", owner: "alice", action: "connect", state: "requested" }] }).isPersisted.promise
  await first.dispose?.()
  const reopened = await createAppStore({ kind: "localStorage", storage })
  let state = "active"
  const calls: Array<{ path: string; method: string }> = []
  const controller = createAppController(reopened, unavailableAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (url, init) => {
      const path = new URL(String(url), "https://test.invalid").pathname
      const method = init?.method ?? "GET"
      if (path.startsWith("/api/user/provider-connections")) {
        calls.push({ path, method })
        if (method === "DELETE") { state = "revoked"; return new Response(null, { status: 204 }) }
        return Response.json([{ id: "conn-1", provider: "claude", state, label: "web-request-1" }])
      }
      return Response.json([])
    }
  })
  await reopened.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
  await waitFor(() => reopened.session().codingProviderRequests?.[0]?.state === "completed")
  expect(calls).toContainEqual({ path: "/api/user/provider-connections", method: "GET" })
  expect(calls.some(call => call.method === "POST")).toBe(false)
  expect(JSON.stringify([...persisted])).not.toContain("sk-ant-")
  expect(await controller.commands.run("secrets.revoke")).toMatchObject({ status: "form" })
  expect(await controller.commands.run("form.set", "form-secrets.revoke id conn-1")).toMatchObject({ status: "executed" })
  expect(await controller.commands.run("form.submit", "form-secrets.revoke")).toMatchObject({ status: "executed" })
  await waitFor(() => reopened.session().codingProviderRequests?.some(row => row.action === "revoke" && row.state === "completed") === true)
  expect(calls).toContainEqual({ path: "/api/user/provider-connections/conn-1", method: "DELETE" })
})

test("cloud session ownership changes reconnect a held coding receipt", async () => {
  const persisted = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => persisted.get(key) ?? null,
    setItem: (key, value) => { persisted.set(key, value) },
    removeItem: key => { persisted.delete(key) }
  } })
  await store.dispatch({ type: "coding.provider.requests.changed", actor: "system", requests: [{ id: "request-1", owner: "alice", action: "connect", state: "requested" }] }).isPersisted.promise
  const old = deferred<Response>()
  let reads = 0
  createAppController(store, unavailableAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: async url => {
      if (String(url).endsWith("/api/user/provider-connections")) {
        if (++reads === 1) return old.promise
        return Response.json([{ id: "conn-1", provider: "claude", state: "active", label: "web-request-1" }])
      }
      return Response.json([])
    }
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
  await waitFor(() => reads === 1)
  await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "alice", expiresAt: null, scopes: null }).isPersisted.promise
  await waitFor(() => store.session().codingProviderRequests?.[0]?.state === "completed")
  expect(reads).toBe(2)
  old.resolve(new Response(null, { status: 403 }))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(store.session().codingProviderRequests?.[0]?.state).toBe("completed")
  expect([...store.collections.messages.values()].some(message => message.text?.includes("Connection check failed"))).toBe(false)
})

test("the account pool doors: the card renders, move and Codex answer before their held requests", async () => {
  const persisted = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => persisted.get(key) ?? null, setItem: (key, value) => { persisted.set(key, value) }, removeItem: key => { persisted.delete(key) }
  } })
  const start = deferred<Response>()
  const puts: string[] = []
  const pool = [
    { id: "a", provider: "claude", label: "a", state: "active", sort_order: 0 },
    { id: "b", provider: "claude", label: "b", state: "active", sort_order: 1 }
  ]
  const controller = createAppController(store, unavailableAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (url, init) => {
      const path = new URL(String(url), "https://test.invalid").pathname
      if (path === "/api/user/provider-connections/codex/device") return start.promise
      if (path === "/api/user/provider-connections/order") { puts.push(String(init?.body)); return new Response(null, { status: 204 }) }
      if (path === "/api/user/provider-connections") return Response.json(pool)
      return Response.json([])
    }
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
  expect(await controller.commands.run("secrets.connections")).toMatchObject({ status: "executed" })
  const card = store.collections.cards.get("provider-accounts")
  expect(card?.kind === "provider-accounts" && card.payload.accounts.map(row => row.id)).toEqual(["a", "b"])
  expect(await controller.commands.run("secrets.move", "b up")).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => puts.length === 1)
  expect(JSON.parse(puts[0]!)).toEqual({ provider: "claude", ids: ["b", "a"] })
  expect(await controller.commands.run("secrets.move")).toMatchObject({ status: "form" })
  expect(await controller.commands.run("secrets.connect.codex")).toMatchObject({ status: "executed", value: "Requested" })
  expect(store.session().codingProviderRequests?.find(row => row.action === "codex")?.state).toBe("requested")
  start.resolve(new Response(null, { status: 500 }))
  await waitFor(() => store.session().codingProviderRequests?.find(row => row.action === "codex")?.state === "failed")
})

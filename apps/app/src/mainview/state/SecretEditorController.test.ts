import { expect, test } from "bun:test"
import { writeOnlyGesture } from "../flows/CommandGesture"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { unavailableAgent, waitFor } from "./TestFixtures"

/*
 * The repository secret editor (#1889) through the real command path: the
 * card's Add/Rotate/Delete doors, the write-only form, the instant
 * acknowledgment, the background PUT/DELETE against
 * /api/repos/{owner}/{repo}/agent-environment/secrets/{name}, and reload.
 */

const createAppController = scopedControllers()
const hold = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const VALUE = "opaque-secret-editor-fixture-value"
const BOOT = () => ({ apiVersion: 1 as const, host: "cloud" as const, version: "test", buildSha: "test", capabilities: ["agent" as const, "identity" as const, "cloud" as const], authFlow: "redirect" as const, sandbox: null })

type Call = { readonly method: string; readonly path: string; readonly body?: string }
type Secret = { name: string; hosts: string[]; match_headers: string[]; updated_at: string }

const storage = (persisted: Map<string, string>) => ({
  getItem: (key: string) => persisted.get(key) ?? null,
  setItem: (key: string, value: string) => { persisted.set(key, value) },
  removeItem: (key: string) => { persisted.delete(key) }
})

/** plue's agent-environment secret routes: metadata out, never a value. */
const platform = (secrets: Secret[] = [{ name: "NPM_TOKEN", hosts: ["registry.npmjs.org"], match_headers: ["authorization"], updated_at: "2026-09-01T00:00:00Z" }]) => {
  const calls: Call[] = []
  let answer: ((call: Call) => Promise<Response> | Response | undefined) | undefined
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url), "https://test.invalid").pathname
    const call: Call = { method: init?.method ?? "GET", path, ...(typeof init?.body === "string" ? { body: init.body } : {}) }
    if (!path.includes("/agent-environment")) return Response.json([])
    calls.push(call)
    const custom = await answer?.(call)
    if (custom) return custom
    const name = decodeURIComponent(path.split("/secrets/")[1] ?? "")
    if (call.method === "PUT") {
      const body = JSON.parse(call.body!) as { hosts: string[]; match_headers: string[] }
      const row = { name, hosts: body.hosts, match_headers: body.match_headers, updated_at: "2026-09-29T00:00:00Z" }
      secrets.splice(0, secrets.length, ...secrets.filter(secret => secret.name !== name), row)
      return Response.json(row, { status: 201 })
    }
    if (call.method === "DELETE") {
      secrets.splice(0, secrets.length, ...secrets.filter(secret => secret.name !== name))
      return new Response(null, { status: 204 })
    }
    return Response.json({ setup_script: "", env: [], secrets })
  }
  return { calls, secrets, fetchImpl, answer: (next: typeof answer) => { answer = next } }
}

const boot = async (persisted = new Map<string, string>(), world = platform()) => {
  const store = await createAppStore({ kind: "localStorage", storage: storage(persisted) })
  const controller = createAppController(store, unavailableAgent, { bootstrap: BOOT(), fetchImpl: world.fetchImpl })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "alice/app", org: "alice", ownerKind: "user", name: "app", head: null }] }).isPersisted.promise
  return { store, controller, world, persisted }
}

const FORM = "form-secrets.set"
const requests = (store: AppStore) => store.session().secretRequests ?? []
const rows = (store: AppStore) => {
  const card = store.collections.cards.get("secrets-alice/app")
  return card?.kind === "secrets" ? card.payload.secrets.map(secret => `${secret.name}:${secret.hosts.join(",")}`) : undefined
}
const everything = (store: AppStore, persisted: Map<string, string>) => JSON.stringify([
  [...persisted], [...store.collections.cards.values()], [...store.collections.messages.values()],
  [...store.collections.transitions.values()], [...store.collections.toasts.values()]
])
const submit = (controller: Awaited<ReturnType<typeof boot>>["controller"], value = VALUE) =>
  controller.commands.submit({ name: "form.submit", actor: "user", payload: { cardId: FORM }, gesture: writeOnlyGesture("form.submit", { value }) })

test("Add secret: the form's write-only value is acknowledged before the held PUT and never stored or read back", async () => {
  const { store, controller, world, persisted } = await boot()
  expect(await controller.commands.run("secrets.list")).toMatchObject({ status: "executed" })
  const put = hold<Response>()
  world.answer(call => call.method === "PUT" ? put.promise : undefined)
  expect(await controller.commands.run("secrets.set", JSON.stringify({ repo: "alice/app" }))).toMatchObject({ status: "form" })
  const card = store.collections.cards.get(FORM)
  expect(card?.kind === "flow-form" && card.payload.fields.find(field => field.name === "value")?.kind).toBe("write-only")
  // The value cannot be typed through the serializable form door.
  expect(await controller.commands.run("form.set", `${FORM} value ${VALUE}`)).toMatchObject({ status: "failed" })
  expect(await controller.commands.run("form.set", `${FORM} name API_TOKEN`)).toMatchObject({ status: "executed" })
  expect(await controller.commands.run("form.set", `${FORM} hosts api.example.com`)).toMatchObject({ status: "executed" })
  expect(await controller.commands.run("form.set", `${FORM} headers authorization`)).toMatchObject({ status: "executed" })
  expect(await submit(controller)).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => world.calls.some(call => call.method === "PUT"))
  expect(requests(store)).toMatchObject([{ owner: "alice", repo: "alice/app", name: "API_TOKEN", action: "set", state: "requested" }])
  // Chat stays usable while the PUT is held.
  expect(await controller.commands.run("secrets.list")).toMatchObject({ status: "executed" })
  // A second save of the same name while the first is running is refused, not queued.
  const again = await controller.commands.run("secrets.set", JSON.stringify({ name: "API_TOKEN", repo: "alice/app" }))
  expect(again).toMatchObject({ status: "form" })
  await submit(controller, "second-value")
  await waitFor(() => JSON.stringify([...store.collections.messages.values(), ...store.collections.toasts.values(), ...store.collections.cards.values()]).includes("API_TOKEN is already being changed"))
  expect(world.calls.filter(call => call.method === "PUT")).toHaveLength(1)
  const sent = world.calls.find(call => call.method === "PUT")!
  expect(sent.path).toBe("/api/repos/alice/app/agent-environment/secrets/API_TOKEN")
  expect(JSON.parse(sent.body!)).toEqual({ value: VALUE, hosts: ["api.example.com"], match_headers: ["authorization"] })
  put.resolve(Response.json({ name: "API_TOKEN", hosts: ["api.example.com"], match_headers: ["authorization"], updated_at: "2026-09-29T00:00:00Z" }, { status: 201 }))
  world.secrets.push({ name: "API_TOKEN", hosts: ["api.example.com"], match_headers: ["authorization"], updated_at: "2026-09-29T00:00:00Z" })
  await waitFor(() => requests(store)[0]?.state === "completed")
  await waitFor(() => rows(store)?.includes("API_TOKEN:api.example.com") === true)
  await store.settled?.()
  expect(everything(store, persisted)).not.toContain(VALUE)
  expect(everything(store, persisted)).not.toContain("second-value")
})

test("Rotate keeps the stored binding when the form leaves it blank", async () => {
  const { store, controller, world } = await boot()
  expect(await controller.commands.run("secrets.set", JSON.stringify({ name: "NPM_TOKEN", repo: "alice/app" }))).toMatchObject({ status: "form" })
  expect(await submit(controller)).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => requests(store)[0]?.state === "completed")
  const sent = world.calls.find(call => call.method === "PUT")!
  expect(JSON.parse(sent.body!)).toEqual({ value: VALUE, hosts: ["registry.npmjs.org"], match_headers: ["authorization"] })
  // A new setup-only secret sends an empty binding.
  expect(await controller.commands.run("secrets.set", JSON.stringify({ name: "SETUP", repo: "alice/app" }))).toMatchObject({ status: "form" })
  expect(await submit(controller)).toMatchObject({ status: "executed" })
  await waitFor(() => requests(store).some(row => row.name === "SETUP" && row.state === "completed"))
  expect(JSON.parse(world.calls.filter(call => call.method === "PUT")[1]!.body!)).toEqual({ value: VALUE, hosts: [], match_headers: [] })
})

test("refusals before any request: bad name, missing value, one-sided binding", async () => {
  const { store, controller, world } = await boot()
  const setOf = (input: Record<string, string>, value?: string) => controller.commands.submit({
    name: "secrets.set", actor: "user", payload: { repo: "alice/app", ...input },
    ...(value === undefined ? {} : { gesture: writeOnlyGesture("secrets.set", { value }) })
  })
  expect(JSON.stringify(await setOf({ name: "bad name" }, VALUE))).toContain("letters, digits")
  // No value: the form asks for it.
  expect(await setOf({ name: "OK" }, "")).toMatchObject({ status: "form", fields: ["value"] })
  expect(JSON.stringify(await setOf({ name: "OK", hosts: "api.example.com" }, VALUE))).toContain("both hosts and headers")
  expect(world.calls.filter(call => call.method !== "GET")).toHaveLength(0)
  expect(requests(store)).toHaveLength(0)
})

test("a refused save fails visibly with the platform's words and a retry succeeds", async () => {
  const { store, controller, world } = await boot()
  let refuse = true
  world.answer(call => call.method === "PUT" && refuse ? Response.json({ message: "repository admin access required" }, { status: 403 }) : undefined)
  expect(await controller.commands.run("secrets.set", JSON.stringify({ name: "API_TOKEN", repo: "alice/app" }))).toMatchObject({ status: "form" })
  expect(await submit(controller)).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => requests(store)[0]?.state === "failed")
  await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.status === "failed" && toast.detail.includes("admin access required")))
  refuse = false
  expect(await controller.commands.run("secrets.set", JSON.stringify({ name: "API_TOKEN", repo: "alice/app" }))).toMatchObject({ status: "form" })
  expect(await submit(controller)).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => requests(store).some(row => row.state === "completed"))
  expect(world.calls.filter(call => call.method === "PUT")).toHaveLength(2)
})

test("Delete answers before the held DELETE, joins nothing twice, and refreshes the card", async () => {
  const { store, controller, world } = await boot()
  expect(await controller.commands.run("secrets.list")).toMatchObject({ status: "executed" })
  expect(rows(store)).toEqual(["NPM_TOKEN:registry.npmjs.org"])
  const gone = hold<Response>()
  world.answer(call => call.method === "DELETE" ? gone.promise : undefined)
  expect(await controller.commands.run("secrets.delete", "NPM_TOKEN alice/app")).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => world.calls.some(call => call.method === "DELETE"))
  expect(JSON.stringify(await controller.commands.run("secrets.delete", "NPM_TOKEN alice/app"))).toContain("already being changed")
  expect(world.calls.filter(call => call.method === "DELETE")).toEqual([{ method: "DELETE", path: "/api/repos/alice/app/agent-environment/secrets/NPM_TOKEN" }])
  world.secrets.splice(0)
  gone.resolve(new Response(null, { status: 204 }))
  await waitFor(() => requests(store)[0]?.state === "completed")
  await waitFor(() => rows(store)?.length === 0)
  // The agent may only ask; a human confirms.
  const before = world.calls.length
  expect(await controller.commands.runForAgent("secrets.delete", "OTHER")).toMatchObject({ status: "executed" })
  expect(world.calls.length).toBe(before)
})

test("reload: an interrupted save fails without replay, an interrupted delete is sent again", async () => {
  const persisted = new Map<string, string>()
  const first = await createAppStore({ kind: "localStorage", storage: storage(persisted) })
  await first.dispatch({ type: "secret.requests.changed", actor: "system", requests: [
    { id: "s", owner: "alice", repo: "alice/app", name: "API_TOKEN", action: "set", state: "requested" },
    { id: "d", owner: "alice", repo: "alice/app", name: "NPM_TOKEN", action: "delete", state: "requested" }
  ] }).isPersisted.promise
  await first.dispose?.()
  const { store, world } = await boot(persisted)
  await waitFor(() => requests(store).every(row => row.state !== "requested"))
  expect(requests(store).map(row => `${row.id}:${row.state}`).sort()).toEqual(["d:completed", "s:failed"])
  expect(world.calls.filter(call => call.method === "PUT")).toHaveLength(0)
  expect(world.calls.filter(call => call.method === "DELETE").map(call => call.path)).toEqual(["/api/repos/alice/app/agent-environment/secrets/NPM_TOKEN"])
  await waitFor(() => [...store.collections.messages.values()].some(message => message.text?.includes("Saving API_TOKEN was interrupted") === true))
})

test("an account change drops a held save's answer instead of settling it", async () => {
  const { store, controller, world } = await boot()
  const put = hold<Response>()
  world.answer(call => call.method === "PUT" ? put.promise : undefined)
  expect(await controller.commands.run("secrets.set", JSON.stringify({ name: "API_TOKEN", repo: "alice/app" }))).toMatchObject({ status: "form" })
  expect(await submit(controller)).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => world.calls.some(call => call.method === "PUT"))
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "bob", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  put.resolve(Response.json({ name: "API_TOKEN", hosts: [], match_headers: [] }, { status: 201 }))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(requests(store).some(row => row.state === "completed")).toBe(false)
})

test("a slower, earlier card refresh never overwrites a newer one", async () => {
  const world = platform([
    { name: "NPM_TOKEN", hosts: [], match_headers: [], updated_at: "2026-09-01T00:00:00Z" },
    { name: "OTHER", hosts: [], match_headers: [], updated_at: "2026-09-01T00:00:00Z" }
  ])
  const { store, controller } = await boot(new Map(), world)
  expect(await controller.commands.run("secrets.list")).toMatchObject({ status: "executed" })
  const stale = hold<Response>()
  let reads = 0
  world.answer(call => {
    if (call.method !== "GET") return undefined
    reads += 1
    return reads === 1 ? stale.promise : undefined
  })
  expect(await controller.commands.run("secrets.delete", "NPM_TOKEN alice/app")).toMatchObject({ value: "Requested" })
  await waitFor(() => reads === 1)
  expect(await controller.commands.run("secrets.delete", "OTHER alice/app")).toMatchObject({ value: "Requested" })
  await waitFor(() => rows(store)?.length === 0)
  stale.resolve(Response.json({ setup_script: "", env: [], secrets: [{ name: "OTHER", hosts: [], match_headers: [], updated_at: "2026-09-01T00:00:00Z" }] }))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(rows(store)).toEqual([])
})

test("a held background refresh never overwrites a newer explicit list", async () => {
  const { store, controller, world } = await boot()
  expect(await controller.commands.run("secrets.list")).toMatchObject({ status: "executed" })
  const stale = hold<Response>()
  let reads = 0
  world.answer(call => {
    if (call.method !== "GET") return undefined
    reads += 1
    return reads === 1 ? stale.promise : undefined
  })
  expect(await controller.commands.run("secrets.delete", "NPM_TOKEN alice/app")).toMatchObject({ value: "Requested" })
  await waitFor(() => reads === 1)
  expect(await controller.commands.run("secrets.list")).toMatchObject({ status: "executed" })
  await waitFor(() => rows(store)?.length === 0)
  stale.resolve(Response.json({ setup_script: "", env: [], secrets: [{ name: "NPM_TOKEN", hosts: ["registry.npmjs.org"], match_headers: ["authorization"], updated_at: "2026-09-01T00:00:00Z" }] }))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(rows(store)).toEqual([])
})

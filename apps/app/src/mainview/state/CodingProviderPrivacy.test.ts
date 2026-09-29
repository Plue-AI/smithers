import { expect, test } from "bun:test"
import type { AppServices } from "./AppController"
import type { AppStore } from "./AppStore"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, settled, unavailableAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()
type Requests = NonNullable<ReturnType<AppStore["session"]>["codingProviderRequests"]>

const signIn = (store: AppStore, login: string, provider: "github" | "local" = "github") =>
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login,
    provider, allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise

const sampleRequests: Requests = [
  { id: "alice-connect-requested", owner: "alice", action: "connect", state: "requested" },
  { id: "alice-connect-completed", owner: "alice", action: "connect", state: "completed" },
  { id: "alice-connect-failed", owner: "alice", action: "connect", state: "failed" },
  { id: "alice-order-requested", owner: "alice", action: "order", provider: "claude", ids: ["private-a", "private-b"], state: "requested" },
  { id: "alice-order-completed", owner: "alice", action: "order", provider: "claude", ids: ["private-b", "private-a"], state: "completed" },
  { id: "alice-order-failed", owner: "alice", action: "order", provider: "claude", ids: ["private-a", "private-b"], state: "failed" },
  { id: "alice-revoke-requested", owner: "alice", action: "revoke", connectionId: "private-a", state: "requested" },
  { id: "alice-revoke-completed", owner: "alice", action: "revoke", connectionId: "private-b", state: "completed" },
  { id: "alice-revoke-failed", owner: "alice", action: "revoke", connectionId: "private-c", state: "failed" },
  ...(["requested", "completed", "failed"] as const).map(state => ({
    id: `alice-device-${state}`, owner: "alice", action: "codex" as const, state,
    device: { id: "11111111-1111-1111-1111-111111111111", userCode: "ALICE-CODE", verificationUri: "https://alice.example/device", interval: 5, expiresAt: "2099-01-01T00:00:00Z" }
  }))
]

const saveRequests = (store: AppStore, requests: Requests = sampleRequests) =>
  store.dispatch({ type: "coding.provider.requests.changed", actor: "system", requests }).isPersisted.promise

const assertCleared = (store: AppStore) => {
  expect(store.session().codingProviderRequests ?? []).toEqual([])
  expect(JSON.stringify(store.session())).not.toContain("private-a")
  expect(JSON.stringify(store.session())).not.toContain("ALICE-CODE")
}

const assertPrivateHistoryCleared = async (store: AppStore) => {
  expect((await store.verifyState()).valid).toBe(true)
  const history = JSON.stringify(await store.eventHistory())
  expect(history).not.toContain("private-a")
  expect(history).not.toContain("ALICE-CODE")
}

test("a completed revoke through the command registry leaves no private receipt after sign-out", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await signIn(store, "alice")
  const calls: string[] = []
  const controller = createAppController(store, unavailableAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (input, init) => {
      const path = new URL(String(input), "https://app.test").pathname
      if (path === "/api/auth/logout" && init?.method === "POST") return Response.json({ ok: true })
      if (path === "/api/user/provider-connections/private-connection" && init?.method === "DELETE") {
        calls.push("DELETE private-connection")
        return new Response(null, { status: 204 })
      }
      if (path === "/api/user/provider-connections") return Response.json([
        { id: "private-connection", provider: "claude", state: calls.length ? "revoked" : "active", label: "Alice's account" }
      ])
      return Response.json([])
    }
  })
  expect(await controller.commands.run("secrets.revoke")).toMatchObject({ status: "form" })
  expect(await controller.commands.run("form.set", "form-secrets.revoke id private-connection")).toMatchObject({ status: "executed" })
  expect(await controller.commands.run("form.submit", "form-secrets.revoke")).toMatchObject({ status: "executed" })
  await waitFor(() => store.session().codingProviderRequests?.some(row =>
    row.action === "revoke" && row.connectionId === "private-connection" && row.state === "completed") === true)
  expect(calls).toEqual(["DELETE private-connection"])
  expect(await controller.signOut()).toBeUndefined()
  assertCleared(store)
  await controller.dispose()
  await store.dispose?.()
  const reopened = await createAppStore({ kind: "localStorage", storage })
  assertCleared(reopened)
  await reopened.dispose?.()
})

test("successful controller sign-out erases every coding request state, including after reopen and Bob's sign-in", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await signIn(store, "alice")
  await saveRequests(store)
  expect(store.session().codingProviderRequests).toHaveLength(sampleRequests.length)
  const controller = createAppController(store, unavailableAgent, { fetchImpl: async () => Response.json({ ok: true }) })
  expect(await controller.signOut()).toBeUndefined()
  assertCleared(store)
  await assertPrivateHistoryCleared(store)
  expect(store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
  await controller.dispose()
  await store.dispose?.()
  const reopened = await createAppStore({ kind: "localStorage", storage })
  assertCleared(reopened)
  await assertPrivateHistoryCleared(reopened)
  await signIn(reopened, "bob")
  assertCleared(reopened)
  await reopened.dispose?.()
})

for (const replacement of ["account", "provider"] as const) {
  test(`${replacement} replacement erases all coding request states before publishing the next identity`, async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    await signIn(store, "alice")
    await saveRequests(store)
    await signIn(store, replacement === "account" ? "bob" : "alice", replacement === "provider" ? "local" : "github")
    assertCleared(store)
    await assertPrivateHistoryCleared(store)
    expect(store.collections.identitySessions.get("identity")?.login).toBe(replacement === "account" ? "bob" : "alice")
    await store.dispose?.()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    assertCleared(reopened)
    await assertPrivateHistoryCleared(reopened)
    await reopened.dispose?.()
  })
}

test("an identity outage preserves Alice's requests and recovery of the same account retains them across reopen", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await signIn(store, "alice")
  const rows = sampleRequests
  await saveRequests(store, rows)
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "unavailable", login: null,
    allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
  expect(store.session().codingProviderRequests).toEqual(rows)
  await store.dispose?.()
  const reopened = await createAppStore({ kind: "localStorage", storage })
  expect(reopened.session().codingProviderRequests).toEqual(rows)
  await signIn(reopened, "alice")
  expect(reopened.session().codingProviderRequests).toEqual(rows)
  await reopened.dispose?.()
})

for (const boundary of ["sign-out", "account replacement", "provider replacement"] as const) test(`a provider reply held through ${boundary} cannot recreate an erased request`, async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  let answer!: (value: Response) => void
  const held = new Promise<Response>(resolve => { answer = resolve })
  let reads = 0
  const services: AppServices = {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (input, init) => {
      const path = new URL(String(input), "https://app.test").pathname
      if (path === "/api/auth/logout" && init?.method === "POST") return Response.json({ ok: true })
      if (path === "/api/user/provider-connections") { reads++; return held }
      return Response.json([])
    }
  }
  await saveRequests(store, [{ id: "held-connect", owner: "alice", action: "connect", state: "requested" }])
  const controller = createAppController(store, unavailableAgent, services)
  await signIn(store, "alice")
  await waitFor(() => reads === 1)
  if (boundary === "sign-out") expect(await controller.signOut()).toBeUndefined()
  else await signIn(store, boundary === "account replacement" ? "bob" : "alice", boundary === "provider replacement" ? "local" : "github")
  assertCleared(store)
  answer(Response.json([{ id: "conn-1", provider: "claude", state: "active", label: "web-held-connect" }]))
  await settled()
  await store.settled?.()
  assertCleared(store)
  await controller.dispose()
  await store.dispose?.()
  const reopened = await createAppStore({ kind: "localStorage", storage })
  assertCleared(reopened)
  await reopened.dispose?.()
})

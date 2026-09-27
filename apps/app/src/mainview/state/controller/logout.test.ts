import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage, unavailableAgent, waitFor } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createAuthBillingController } from "./auth-billing"

const fixture = async (provider: "github" | "local" = "github", storage = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  const identity = (login: string) => store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login,
    provider, allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await identity("old-owner")
  const logout = Promise.withResolvers<Response>(), session = Promise.withResolvers<Response>()
  const paths: string[] = []
  const sessionPath = provider === "local" ? "/api/user" : "/api/auth/session"
  let settlements = 0
  const applicationIdentity = { current: async () => {
    paths.push(sessionPath)
    const response = await session.promise
    if (response.status === 401) return null
    if (!response.ok) throw new Error("Identity unavailable")
    const body = await response.json()
    return { username: body.login, admin: false, scopes: null }
  } }
  const ctx = createControllerContext(store, unavailableAgent, {
    // The owner's backend signs in with credentials; only the hosted redirect is the GitHub session (IdentityProvider.ts).
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", authFlow: provider === "local" ? "credentials" : "redirect", sandbox: null, capabilities: ["identity"] },
    ...(provider === "local" ? { applicationIdentity } : {}),
    fetchImpl: async input => {
      const path = new URL(String(input), "https://app.test").pathname
      paths.push(path)
      if (path === "/api/auth/logout") return logout.promise
      if (path === "/api/auth/session") return session.promise
      return Response.json({ scopes: [] })
    }
  })
  const auth = createAuthBillingController(ctx, store.nextOrdinal, undefined, undefined, provider === "local"
    ? { ...applicationIdentity, signInPath: "/login", settled: () => { settlements++ } } : undefined)
  return { store, identity, ctx, auth, paths, logout, session, sessionPath, settlements: () => settlements, dispose: async () => {
    await ctx.dispose(); logout.resolve(Response.json({})); session.resolve(Response.json({ state: "signed-out" })); await store.dispose?.()
  } }
}
const signedIn = (login: string) => Response.json({ state: "signed-in", login, allowlisted: true, admin: false })

for (const provider of ["github", "local"] as const) for (const boundary of ["replacement", "same-login return", "dispose"] as const) {
  for (const result of ["success", "HTTP failure", "network failure"] as const) {
    test(`${provider} logout ${result} after ${boundary} cannot directly retire the current account`, async () => {
      const t = await fixture(provider)
      try {
        const signingOut = t.auth.signOut()
        await waitFor(() => t.paths.includes("/api/auth/logout"))
        const login = boundary === "replacement" ? "new-owner" : "old-owner"
        if (boundary === "same-login return") await t.store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
        if (boundary === "dispose") await t.ctx.dispose()
        else await t.identity(login)
        await t.store.dispatch({ type: "composer.changed", actor: "user", draft: "current draft" }).isPersisted.promise
        if (result === "network failure") t.logout.reject(new Error("old request failed"))
        else t.logout.resolve(new Response(null, { status: result === "success" ? 204 : 503 }))
        if (boundary !== "dispose") {
          await waitFor(() => t.paths.includes(t.sessionPath))
          expect(t.store.collections.identitySessions.get("identity")).toMatchObject({ state: "signed-in", login })
          expect(t.store.session().draft).toBe("current draft")
          t.session.resolve(signedIn(login))
        }
        expect(await signingOut).toBeUndefined()
        expect(t.store.collections.identitySessions.get("identity")).toMatchObject({ state: "signed-in", login })
        expect(t.store.session().draft).toBe("current draft")
        if (boundary === "dispose") expect(t.paths).toEqual(["/api/auth/logout"])
        expect((await t.store.verifyState()).valid).toBe(true)
      } finally { await t.dispose() }
    })
  }
}

for (const status of [204, 503]) {
  test(`a stale logout HTTP ${status} rechecks credentials and honors a fresh signed-out answer`, async () => {
    const t = await fixture()
    try {
      const signingOut = t.auth.signOut()
      await waitFor(() => t.paths.includes("/api/auth/logout"))
      await t.identity("new-owner")
      t.logout.resolve(new Response(null, { status }))
      await waitFor(() => t.paths.includes(t.sessionPath))
      expect(t.store.collections.identitySessions.get("identity")?.login).toBe("new-owner")
      t.session.resolve(new Response(null, { status: 401 }))
      await signingOut
      expect(t.store.collections.identitySessions.get("identity")).toMatchObject({ state: "signed-out", login: null })
      expect((await t.store.verifyState()).valid).toBe(true)
    } finally { await t.dispose() }
  })
}

for (const answer of ["signed-in", "signed-out", "unavailable"] as const) {
  test(`a current failed logout reports the rechecked ${answer} session honestly`, async () => {
    const t = await fixture()
    try {
      const signingOut = t.auth.signOut()
      await waitFor(() => t.paths.includes("/api/auth/logout"))
      t.logout.resolve(new Response(null, { status: 503 }))
      await waitFor(() => t.paths.includes(t.sessionPath))
      t.session.resolve(answer === "signed-in" ? signedIn("old-owner") : new Response(null, { status: answer === "signed-out" ? 401 : 503 }))
      expect(await signingOut).toBe(answer === "signed-out" ? undefined : "Sign-out could not be confirmed.")
      expect(t.store.collections.identitySessions.get("identity")?.state).toBe(answer)
    } finally { await t.dispose() }
  })
}

test("a disposed logout controller starts no request", async () => {
  const t = await fixture()
  try {
    await t.ctx.dispose()
    await t.auth.signOut()
    expect(t.paths).toEqual([])
  } finally { await t.dispose() }
})

for (const status of [200, 503]) {
  test(`a held logout HTTP ${status} body cannot retire a replacement account when it finishes`, async () => {
    const t = await fixture(), body = Promise.withResolvers<void>()
    try {
      const signingOut = t.auth.signOut()
      await waitFor(() => t.paths.includes("/api/auth/logout"))
      let reading = false
      t.logout.resolve(new Response(new ReadableStream({ async start(controller) {
        reading = true
        await body.promise
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: "old response" })))
        controller.close()
      } }), { status }))
      await waitFor(() => reading)
      await t.identity("new-owner")
      body.resolve()
      await waitFor(() => t.paths.includes(t.sessionPath))
      expect(t.store.collections.identitySessions.get("identity")?.login).toBe("new-owner")
      t.session.resolve(signedIn("new-owner"))
      expect(await signingOut).toBeUndefined()
      expect(t.store.collections.identitySessions.get("identity")?.login).toBe("new-owner")
    } finally { body.resolve(); await t.dispose() }
  })
}

for (const boundary of ["replacement", "dispose"] as const) {
  test(`a logout reconciliation body overtaken by ${boundary} writes no obsolete identity`, async () => {
    const t = await fixture(), body = Promise.withResolvers<void>()
    try {
      const signingOut = t.auth.signOut()
      await waitFor(() => t.paths.includes("/api/auth/logout"))
      await t.auth.adoptSession({ state: "signed-in", login: "new-owner", allowlisted: true, admin: false })
      t.logout.resolve(new Response(null, { status: 204 }))
      await waitFor(() => t.paths.includes(t.sessionPath))
      let reading = false
      t.session.resolve(new Response(new ReadableStream({ async start(controller) {
        reading = true
        await body.promise
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ state: "signed-out" })))
        controller.close()
      } })))
      await waitFor(() => reading)
      if (boundary === "dispose") await t.ctx.dispose()
      else await t.auth.adoptSession({ state: "signed-in", login: "latest-owner", allowlisted: true, admin: false })
      body.resolve()
      await signingOut
      expect(t.store.collections.identitySessions.get("identity")?.login).toBe(boundary === "dispose" ? "new-owner" : "latest-owner")
    } finally { body.resolve(); await t.dispose() }
  })
}

for (const boundary of ["replacement", "dispose"] as const) {
  test(`a saved logout cleanup overtaken by ${boundary} cannot clear the selected Cloud identity`, async () => {
    const t = await fixture("local"), saved = Promise.withResolvers<void>(), dispatch = t.store.dispatch
    let held = false, changed = 0
    t.ctx.identityChanged = () => { changed++ }
    Object.assign(t.store, { dispatch: (event: Parameters<typeof dispatch>[0]) => {
      const write = dispatch(event)
      if (event.type === "identity.session.cleared") {
        held = true
        return { ...write, isPersisted: { promise: write.isPersisted.promise.then(() => saved.promise) } }
      }
      return write
    } })
    try {
      const signingOut = t.auth.signOut()
      await waitFor(() => t.paths.includes("/api/auth/logout"))
      t.logout.resolve(new Response(null, { status: 204 }))
      await waitFor(() => held)
      if (boundary === "dispose") await t.ctx.dispose()
      else await t.identity("new-owner")
      await t.store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "new-owner", expiresAt: null, scopes: null }).isPersisted.promise
      saved.resolve()
      await signingOut
      expect(t.store.collections.cloudSessions.get("cloud")?.username).toBe("new-owner")
      expect(t.settlements()).toBe(0)
      expect(changed).toBe(0)
    } finally { saved.resolve(); Object.assign(t.store, { dispatch }); await t.dispose() }
  })
}

test("a refused save of the rechecked sign-out reports incomplete local state", async () => {
  const backing = memoryStorage()
  let armed = false, refused = 0
  const storage = { ...backing, setItem: (key: string, value: string) => {
    if (armed && key.endsWith(".staged")) {
      armed = false; refused++
      throw Object.assign(new Error("Storage full"), { name: "QuotaExceededError", code: 22 })
    }
    backing.setItem(key, value)
  } }
  const t = await fixture("github", storage)
  try {
    const signingOut = t.auth.signOut()
    await waitFor(() => t.paths.includes("/api/auth/logout"))
    t.logout.resolve(new Response(null, { status: 503 }))
    await waitFor(() => t.paths.includes(t.sessionPath))
    armed = true
    t.session.resolve(new Response(null, { status: 401 }))
    expect(await signingOut).toBe("Sign-in status could not be saved. Reload to retry.")
    expect(refused).toBe(1)
  } finally { armed = false; await t.dispose() }
})

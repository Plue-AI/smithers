import { expect, test } from "bun:test"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import { memoryStorage, silentAgent, waitFor } from "../TestFixtures"
import { createAuthBillingController } from "./auth-billing"
import type { SelectedBackendIdentity } from "./auth-billing"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"

const identity = { state: "signed-in" as const, login: "will", admin: true, scopesPlain: null }
const setup = async (services: AppServices = {}) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", ...identity }).isPersisted.promise
  const ctx = createControllerContext(store, silentAgent, services)
  ctx.withToast = createFailureController(ctx).withToast
  const controller = createAuthBillingController(ctx, store.nextOrdinal)
  return {
    store,
    ctx,
    controller,
    dispose: async () => {
      await ctx.dispose()
      await store.dispose?.()
    }
  }
}
const grantId = (store: Awaited<ReturnType<typeof setup>>["store"]) => {
  const card = [...store.collections.cards.values()].find((card) => card.kind === "grant-confirm")
  if (card === undefined) throw Error("Expected a grant confirmation")
  return card.id
}

test("human confirmation persists and acknowledges before unresolved HTTP; duplicates and cancellation cannot relaunch", async () => {
  const remote = Promise.withResolvers<Response>()
  const posted: Array<{ login: string; amountUsd: number; operationKey: string }> = []
  const h = await setup({
    fetchImpl: async (_input, init) => {
      posted.push(JSON.parse(String(init?.body)))
      return remote.promise
    }
  })
  try {
    h.controller.adminGrant(25, " OCTOCAT ")
    const id = grantId(h.store)
    expect(posted).toEqual([])
    let acknowledged = false
    void h.controller.adminGrantConfirm(id).then(() => {
      acknowledged = true
    })
    await waitFor(() => acknowledged)
    expect(posted).toEqual([{ login: "octocat", amountUsd: 25, operationKey: id }])
    expect(h.store.collections.cards.get(id)).toMatchObject({ payload: { phase: "sending" } })
    await h.controller.adminGrantConfirm(id)
    expect(h.controller.adminGrantCancel(id)).toBe("That grant is already being posted — a moment.")
    expect(posted).toHaveLength(1)
    await waitFor(() => h.store.collections.toasts.get("toast-admin.grant")?.status === "running")
    expect(h.store.collections.toasts.get("toast-admin.grant")?.status).toBe("running")
    // Unrelated chat remains available while the grant HTTP response is unresolved.
    await h.store.dispatch({ type: "message.appended", actor: "user", text: "Still here" }).isPersisted.promise
    expect([...h.store.collections.messages.values()].at(-1)?.text).toBe("Still here")
    remote.resolve(Response.json({ ...posted[0], granted: true, grantId: "credit-grant:9", duplicate: false }))
    await waitFor(() => h.store.collections.cards.get(id)?.status === "acted")
    await waitFor(() => h.store.collections.toasts.get("toast-admin.grant")?.status === "ok")
    expect(h.store.collections.cards.get(id)).toMatchObject({
      payload: { phase: "granted", grantId: "credit-grant:9" }
    })
  } finally {
    remote.resolve(Response.json({}))
    await h.dispose()
  }
})

test.each([
  { body: {}, status: 200 },
  { body: { granted: true }, status: 200 },
  { body: "broken", status: 200 },
  { body: null, status: 204 },
  {
    body: {
      granted: true,
      grantId: "credit-grant:1",
      login: "other",
      amountUsd: 25,
      operationKey: "other",
      duplicate: false
    },
    status: 200
  }
])("malformed committed receipt remains retryable ($status/$body)", async ({ body, status }) => {
  const h = await setup({
    toastDebounceMs: 0,
    fetchImpl: async () =>
      status === 204 ?
        new Response(null, { status }) :
        typeof body === "string"
        ? new Response(body, { status })
        : Response.json(body, { status })
  })
  try {
    h.controller.adminGrant(25, "octocat")
    const id = grantId(h.store)
    await h.controller.adminGrantConfirm(id)
    await waitFor(() => h.store.collections.cards.get(id)?.status === "error")
    expect(h.store.collections.cards.get(id)).toMatchObject({
      payload: { phase: "failed", error: "The grant receipt didn't match." }
    })
    expect(h.store.collections.toasts.get("toast-admin.grant")?.status).toBe("failed")
  } finally {
    await h.dispose()
  }
})

test("ordinary and invalid direct grants never create a consequential confirmation", async () => {
  const h = await setup()
  try {
    expect(h.controller.adminGrant(1e-10, "octocat")).toBe("Enter a valid amount and login.")
    await h.store.dispatch({ type: "identity.session.loaded", actor: "system", ...identity, admin: false }).isPersisted
      .promise
    expect(h.controller.adminGrant(25, "octocat")).toBe("Admin access required.")
    expect(await h.controller.adminGrantConfirm("unknown")).toBe("Admin access required.")
    expect(h.store.collections.cards.size).toBe(0)
  } finally {
    await h.dispose()
  }
})

for (const fresh of ["same-admin", "ordinary", "other-account", "signed-out", "unavailable"] as const) {
  test(`durable sending grant reconnects only after fresh same-account admin verification: ${fresh}`, async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    await first.dispatch({ type: "identity.session.loaded", actor: "system", ...identity }).isPersisted.promise
    const firstCtx = createControllerContext(first, silentAgent, {
      fetchImpl: async () => new Promise<Response>(() => {})
    })
    firstCtx.withToast = createFailureController(firstCtx).withToast
    const before = createAuthBillingController(firstCtx, first.nextOrdinal)
    before.adminGrant(25, "octocat")
    const id = grantId(first)
    await before.adminGrantConfirm(id)
    // A separate unapproved card must never be automatically confirmed on reload.
    before.adminGrant(3, "unapproved")
    const unapproved = [...first.collections.cards.values()].find((card) =>
      card.id !== id && card.kind === "grant-confirm"
    )!
    await first.dispatch({ type: "composer.changed", actor: "user", draft: "reload" }).isPersisted.promise
    await firstCtx.dispose()
    await first.dispose?.()
    const store = await createAppStore({ kind: "localStorage", storage })
    const posted: unknown[] = []
    const ctx = createControllerContext(store, silentAgent, {
      toastDebounceMs: 0,
      fetchImpl: async (input, init) => {
        if (!String(input).endsWith("/api/admin/grant")) return Response.json({}, { status: 404 })
        const request = JSON.parse(String(init?.body))
        posted.push(request)
        return Response.json({ ...request, granted: true, grantId: "credit-grant:10", duplicate: true })
      }
    })
    ctx.withToast = createFailureController(ctx).withToast
    const read = Promise.withResolvers<Awaited<ReturnType<SelectedBackendIdentity["current"]>>>()
    const selected: SelectedBackendIdentity = { signInPath: "/sign-in", current: () => read.promise }
    const after = createAuthBillingController(ctx, store.nextOrdinal, selected)
    try {
      expect(store.collections.cards.get(id)).toMatchObject({ payload: { phase: "sending" } })
      const verifying = after.loadSession()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(posted).toEqual([])
      if (fresh === "unavailable") read.reject(Error("offline"))
      else {read.resolve(
          fresh === "signed-out"
            ? null
            : { username: fresh === "other-account" ? "someone" : "will", admin: fresh !== "ordinary", scopes: null }
        )}
      await verifying
      if (fresh === "same-admin") {
        await waitFor(() => store.collections.cards.get(id)?.status === "acted")
        expect(posted).toEqual([{ login: "octocat", amountUsd: 25, operationKey: id }])
        expect(store.collections.cards.get(unapproved.id)).toMatchObject({ payload: { phase: "confirm" } })
        await after.loadSession()
        expect(posted).toHaveLength(1)
      } else {
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(posted).toEqual([])
      }
    } finally {
      await ctx.dispose()
      await store.dispose?.()
    }
  })
}

test.each(["account-switch", "disposed"] as const)("approval fenced before its persisted launch: %s", async (fence) => {
  const posted: unknown[] = []
  const h = await setup({
    fetchImpl: async (_input, init) => {
      posted.push(init?.body)
      return Response.json({})
    }
  })
  try {
    h.controller.adminGrant(25, "octocat")
    const id = grantId(h.store)
    const acknowledged = h.controller.adminGrantConfirm(id)
    if (fence === "disposed") await h.ctx.dispose()
    else {await h.store.dispatch({ type: "identity.session.loaded", actor: "system", ...identity, login: "someone" })
        .isPersisted.promise}
    expect(await acknowledged).toBeUndefined()
    expect(posted).toEqual([])
  } finally {
    await h.dispose()
  }
})

test("old invalid grant data refuses before posting while a malformed receipt can retry with the original key", async () => {
  const posted: Array<{ login: string; amountUsd: number; operationKey: string }> = []
  const h = await setup({
    toastDebounceMs: 0,
    fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init?.body))
      posted.push(request)
      return Response.json(
        posted.length === 1 ? {} : { ...request, granted: true, grantId: "credit-grant:11", duplicate: true }
      )
    }
  })
  try {
    await h.store.dispatch({
      type: "card.upsert",
      actor: "user",
      card: {
        id: "grant-invalid",
        kind: "grant-confirm",
        title: "Old grant",
        status: "active",
        createdAt: 1,
        ordinal: 0,
        payload: { login: "octocat", amountUsd: 1e-10, phase: "confirm" }
      }
    }).isPersisted.promise
    expect(await h.controller.adminGrantConfirm("grant-invalid")).toBe("Enter a valid amount and login.")
    expect(posted).toEqual([])
    h.controller.adminGrant(25, "octocat")
    const id = [...h.store.collections.cards.values()].find((card) =>
      card.kind === "grant-confirm" && card.id !== "grant-invalid"
    )!.id
    await h.controller.adminGrantConfirm(id)
    await waitFor(() =>
      h.store.collections.cards.get(id)?.status === "error"
    )
    await h.controller.adminGrantConfirm(id)
    await waitFor(() => h.store.collections.cards.get(id)?.status === "acted")
    expect(posted).toEqual([{ login: "octocat", amountUsd: 25, operationKey: id }, {
      login: "octocat",
      amountUsd: 25,
      operationKey: id
    }])
  } finally {
    await h.dispose()
  }
})

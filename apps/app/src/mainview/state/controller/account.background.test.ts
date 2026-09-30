import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { createActorBindings } from "../ActorBindings"
import { memoryStorage, settle, unavailableAgent, waitFor } from "../TestFixtures"
import { createAccountController } from "./account"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"

const fixture = async (storage = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
  const reads: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  const ctx = createControllerContext(store, unavailableAgent, { toastDebounceMs: 1, fetchImpl: async () => {
    const read = Promise.withResolvers<Response>(); reads.push(read); return read.promise
  } })
  Object.assign(ctx, createFailureController(ctx))
  const actors = createActorBindings(ctx.onDispose)
  const account = actors.pair(ctx, context => createAccountController(context, { provider: "github", readsScopes: true, nextOrdinal: store.nextOrdinal, promptSignIn: () => {} }))
  const card = () => { const row = store.collections.cards.get("account"); return row?.kind === "account" ? row : undefined }
  return { storage, store, ctx, account, reads, card, agentShow: () => actors.select(account.showAccount)(), dispose: async () => {
    await ctx.dispose(); for (const read of reads) read.resolve(Response.json({ scopes: [] })); await store.dispose?.()
  } }
}

test("Account is saved and acknowledged while permissions remain unresolved; both actors share the request", async () => {
  const t = await fixture()
  try {
    let acknowledged = false
    const first = t.account.showAccount().then(value => { acknowledged = true; return value })
    await waitFor(() => t.reads.length === 1)
    await settle()
    expect(acknowledged).toBe(true)
    expect(await first).toEqual({ value: "Requested" })
    expect(t.card()?.payload).toMatchObject({ login: "owner", refresh: { state: "requested" } })
    expect(await t.agentShow()).toEqual({ value: "Requested" })
    expect(t.reads).toHaveLength(1)
    await t.store.dispatch({ type: "composer.changed", actor: "user", draft: "Still usable" }).isPersisted.promise
    await waitFor(() => t.store.collections.toasts.get("toast-account.permissions")?.status === "running")
    expect(t.store.session().draft).toBe("Still usable")
    t.reads[0]!.resolve(Response.json({ scopes: [{ scope: "issues", plain: "Read issues" }] }))
    await waitFor(() => t.card()?.payload.refresh?.state === "complete")
    await waitFor(() => t.store.collections.toasts.get("toast-account.permissions")?.status === "ok")
    expect(t.card()?.payload.scopes).toEqual([{ scope: "issues", plain: "Read issues" }])
  } finally { await t.dispose() }
})

test("reload reconnects the saved Account request once, without waiting to acknowledge it", async () => {
  const storage = memoryStorage(), first = await fixture(storage)
  let second: Awaited<ReturnType<typeof fixture>> | undefined
  try {
    await first.account.showAccount()
    await waitFor(() => first.reads.length === 1)
    await first.dispose()
    second = await fixture(storage)
    second.account.resumeAccount(); second.account.resumeAccount()
    await waitFor(() => second!.reads.length === 1)
    expect(await second.account.showAccount()).toEqual({ value: "Requested" })
    expect(second.reads).toHaveLength(1)
    second.reads[0]!.resolve(Response.json({ scopes: [] }))
    await waitFor(() => second!.card()?.payload.refresh?.state === "complete")
    expect((await second.store.verifyState()).valid).toBe(true)
  } finally { await first.dispose(); await second?.dispose() }
})

for (const failure of ["network", "http", "json", "shape", "row", "duplicate"] as const) {
  test(`${failure} permission failures survive reload and can retry without claiming completion`, async () => {
    const storage = memoryStorage(), t = await fixture(storage)
    let restored: Awaited<ReturnType<typeof fixture>> | undefined
    try {
      await t.account.showAccount()
      await waitFor(() => t.store.collections.toasts.get("toast-account.permissions")?.status === "running")
      const read = t.reads[0]!
      if (failure === "network") read.reject(new Error("private network details"))
      else read.resolve(failure === "http" ? new Response("private response", { status: 503 })
        : failure === "json" ? new Response("private invalid JSON")
        : Response.json(failure === "shape" ? {} : { scopes: failure === "row" ? [{ scope: "issues" }]
          : [{ scope: "issues", plain: "Read issues" }, { scope: "issues", plain: "Read issues" }] }))
      await waitFor(() => t.store.collections.toasts.get("toast-account.permissions")?.status === "failed")
      expect(t.card()?.payload.refresh?.state).toBe("failed")
      expect(t.card()?.payload.scopes).toEqual([])
      expect(JSON.stringify(t.card())).not.toContain("private")
      expect(t.store.collections.toasts.get("toast-account.permissions")?.action).toEqual({ flow: "account.show", label: "Retry" })
      await t.store.settled?.()
      await t.dispose()
      restored = await fixture(storage)
      restored.account.resumeAccount()
      await settle()
      expect(restored.reads).toHaveLength(0)
      expect(restored.card()?.payload.refresh?.state).toBe("failed")
      await restored.account.showAccount()
      expect(restored.reads).toHaveLength(1)
      restored.reads[0]!.resolve(Response.json({ scopes: [] }))
      await waitFor(() => restored!.card()?.payload.refresh?.state === "complete")
      await restored.store.settled?.()
      expect((await restored.store.verifyState()).valid).toBe(true)
    } finally { await t.dispose(); await restored?.dispose() }
  })
}

for (const stage of ["requested", "complete"] as const) {
  test(`Account waits for the ${stage} card receipt before advancing`, async () => {
    const t = await fixture(), saved = Promise.withResolvers<void>()
    const dispatch = t.store.dispatch
    let held = false
    Object.assign(t.store, { dispatch: (event: Parameters<typeof dispatch>[0]) => {
      const write = dispatch(event)
      if (event.type === "card.upsert" && event.card.kind === "account" && event.card.payload.refresh?.state === stage) {
        held = true
        return { ...write, isPersisted: { promise: write.isPersisted.promise.then(() => saved.promise) } }
      }
      return write
    } })
    try {
      let acknowledged = false
      const admission = t.account.showAccount().then(result => { acknowledged = true; return result })
      if (stage === "complete") {
        await admission
        await waitFor(() => t.store.collections.toasts.get("toast-account.permissions")?.status === "running")
        t.reads[0]!.resolve(Response.json({ scopes: [] }))
      }
      await waitFor(() => held)
      let duplicateAcknowledged = false
      const duplicate = t.agentShow().then(() => { duplicateAcknowledged = true })
      t.account.resumeAccount()
      await settle()
      if (stage === "requested") {
        expect(acknowledged).toBe(false)
        expect(duplicateAcknowledged).toBe(false)
        expect(t.reads).toHaveLength(0)
      } else {
        expect(t.reads).toHaveLength(1)
        expect(t.store.collections.toasts.get("toast-account.permissions")?.status).toBe("running")
      }
      saved.resolve()
      expect(await admission).toEqual({ value: "Requested" })
      await duplicate
      expect(t.reads).toHaveLength(1)
      if (stage === "complete") await waitFor(() => t.store.collections.toasts.get("toast-account.permissions")?.status === "ok")
    } finally { saved.resolve(); Object.assign(t.store, { dispatch }); await t.dispose() }
  })
}

for (const stage of ["requested", "complete"] as const) {
  test(`a refused ${stage} save cannot claim a saved Account result and remains retryable`, async () => {
    const backing = memoryStorage()
    let armed = false, refused = 0
    const storage = { ...backing, setItem: (key: string, value: string) => {
      if (armed && key.endsWith(".staged")) {
        armed = false; refused++
        throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError", code: 22 })
      }
      backing.setItem(key, value)
    } }
    const t = await fixture(storage)
    try {
      if (stage === "requested") {
        armed = true
        await expect(t.account.showAccount()).rejects.toThrow()
        expect(t.reads).toHaveLength(0)
        expect(t.card()).toBeUndefined()
      } else {
        await t.account.showAccount()
        await waitFor(() => t.store.collections.toasts.get("toast-account.permissions")?.status === "running")
        await t.store.settled?.()
        armed = true
        t.reads[0]!.resolve(Response.json({ scopes: [{ scope: "issues", plain: "Read issues" }] }))
        await waitFor(() => t.store.collections.toasts.get("toast-account.permissions")?.status === "failed")
        await settle()
        expect(t.card()?.payload.refresh?.state).toBe("requested")
        expect(t.card()?.payload.scopes).toEqual([])
      }
      expect(refused).toBe(1)
      await t.account.showAccount()
      expect(t.reads).toHaveLength(stage === "requested" ? 1 : 2)
      t.reads.at(-1)!.resolve(Response.json({ scopes: [] }))
      await waitFor(() => t.card()?.payload.refresh?.state === "complete")
      await t.store.settled?.()
      expect((await t.store.verifyState()).valid).toBe(true)
    } finally { armed = false; await t.dispose() }
  })
}

for (const ending of ["sign-out", "remove card"] as const) {
  test(`a failed response after ${ending} cannot restore the card or show a stale failure toast`, async () => {
    const t = await fixture()
    try {
      await t.account.showAccount()
      await waitFor(() => t.store.collections.toasts.get("toast-account.permissions")?.status === "running")
      await t.store.dispatch(ending === "sign-out"
        ? { type: "identity.session.cleared", actor: "user" }
        : { type: "card.removed", actor: "user", id: "account" }).isPersisted.promise
      t.reads[0]!.reject(new Error("old account failure"))
      await waitFor(() => !t.store.collections.toasts.has("toast-account.permissions"))
      expect(t.card()).toBeUndefined()
      await t.store.settled?.()
      expect((await t.store.verifyState()).valid).toBe(true)
    } finally { await t.dispose() }
  })
}

test("Account can reopen after Chat is cleared without waiting for the removed card's read", async () => {
  const t = await fixture()
  try {
    await t.account.showAccount()
    const previous = t.card()?.payload.refresh?.id
    expect(t.reads).toHaveLength(1)
    await t.store.dispatch({ type: "conversation.cleared", actor: "user", branchId: "next-conversation", notes: [] }).isPersisted.promise
    expect(t.card()).toBeUndefined()
    expect(await t.account.showAccount()).toEqual({ value: "Requested" })
    expect(t.reads).toHaveLength(2)
    expect(t.card()?.payload.refresh?.id).not.toBe(previous)
    await waitFor(() => t.store.collections.toasts.get("toast-account.permissions")?.status === "running")
    t.reads[0]!.resolve(Response.json({ scopes: [{ scope: "outdated", plain: "Old card permission" }] }))
    await settle()
    expect(t.card()?.payload.refresh?.state).toBe("requested")
    expect(t.card()?.payload.scopes).toEqual([])
    expect(t.store.collections.toasts.get("toast-account.permissions")?.status).toBe("running")
    t.reads[1]!.resolve(Response.json({ scopes: [{ scope: "current", plain: "Current permission" }] }))
    await waitFor(() => t.store.collections.toasts.get("toast-account.permissions")?.status === "ok")
    expect(t.card()?.payload.scopes).toEqual([{ scope: "current", plain: "Current permission" }])
    await t.store.settled?.()
    expect((await t.store.verifyState()).valid).toBe(true)
  } finally { await t.dispose() }
})

test("clearing Chat during admission does not acknowledge or launch a request for the removed card", async () => {
  const t = await fixture(), saved = Promise.withResolvers<void>(), dispatch = t.store.dispatch
  let held = false
  Object.assign(t.store, { dispatch: (event: Parameters<typeof dispatch>[0]) => {
    const write = dispatch(event)
    if (event.type === "card.upsert" && event.card.kind === "account") {
      held = true
      return { ...write, isPersisted: { promise: write.isPersisted.promise.then(() => saved.promise) } }
    }
    return write
  } })
  try {
    const reading = t.account.showAccount()
    await waitFor(() => held)
    await t.store.dispatch({ type: "conversation.cleared", actor: "user", branchId: "next-conversation", notes: [] }).isPersisted.promise
    saved.resolve()
    expect(await reading).toEqual({ value: "Account request is no longer current." })
    expect(t.reads).toHaveLength(0)
    expect(t.card()).toBeUndefined()
  } finally { saved.resolve(); Object.assign(t.store, { dispatch }); await t.dispose() }
})

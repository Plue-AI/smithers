import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { createActorBindings } from "../ActorBindings"
import { memoryStorage, settle, unavailableAgent, waitFor } from "../TestFixtures"
import { createAccountController } from "./account"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"

const fixture = async (provider: "github" | "local" = "github", storage = memoryStorage(), readsScopes = true) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  const identity = (login: string) => store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login,
    provider, allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await identity("old-owner")
  const reads: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  const ctx = createControllerContext(store, unavailableAgent, { fetchImpl: async () => {
    const read = Promise.withResolvers<Response>()
    reads.push(read)
    return read.promise
  } })
  Object.assign(ctx, createFailureController(ctx))
  const actors = createActorBindings(ctx.onDispose)
  const account = actors.pair(ctx, context => createAccountController(context, { provider, readsScopes, nextOrdinal: store.nextOrdinal, promptSignIn: () => {} }))
  return { store, ctx, account, agentShow: () => actors.select(account.showAccount)(), reads, identity, dispose: async () => {
    for (const read of reads) read.resolve(Response.json({ scopes: [] }))
    await ctx.dispose(); await store.dispose?.()
  } }
}
const scopes = (scope = "private-old") => Response.json({ scopes: [{ scope, plain: scope }] })

for (const boundary of ["response", "body"] as const) {
  for (const change of ["replacement", "sign-out", "same-login return", "provider switch", "ended account", "dispose"] as const) {
    test(`${change} while Account awaits its ${boundary} cannot restore private data`, async () => {
      const t = await fixture()
      const body = Promise.withResolvers<void>()
      try {
        const reading = t.account.showAccount()
        await waitFor(() => t.reads.length === 1)
        if (boundary === "body") {
          const response = new Response(new ReadableStream({ async start(controller) {
            await body.promise
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ scopes: [{ scope: "private-old", plain: "private-old" }] })))
            controller.close()
          } }))
          t.reads[0]!.resolve(response)
          await settle()
        }
        if (change === "replacement") await t.identity("new-owner")
        if (change === "sign-out" || change === "same-login return") {
          await t.store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
          if (change === "same-login return") await t.identity("old-owner")
        }
        if (change === "provider switch") await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "old-owner", provider: "local", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
        if (change === "ended account") t.ctx.endAccount()
        if (change === "dispose") await t.ctx.dispose()
        t.reads[0]!.resolve(scopes())
        body.resolve()
        const result = await reading
        await settle()
        await t.store.settled?.()
        if (change !== "dispose" && change !== "ended account") expect(t.store.collections.cards.has("account")).toBe(false)
        expect(JSON.stringify(t.store.collections.cards.get("account") ?? null)).not.toContain("private-old")
        expect(JSON.stringify(result)).not.toContain("old-owner")
        expect(JSON.stringify(result)).not.toContain("private-old")
      } finally { body.resolve(); await t.dispose() }
    })
  }
}

test("a same-owner re-probe keeps the pending Account read valid", async () => {
  const t = await fixture()
  try {
    const reading = t.account.showAccount()
    await waitFor(() => t.reads.length === 1)
    await t.identity("old-owner")
    t.reads[0]!.resolve(scopes())
    expect(await reading).toEqual({ value: "Requested" })
    await waitFor(() => JSON.stringify(t.store.collections.cards.get("account")).includes("private-old"))
    expect(t.store.collections.cards.get("account")?.payload).toMatchObject({ login: "old-owner", scopes: [{ scope: "private-old", plain: "private-old" }] })
  } finally { await t.dispose() }
})

test("a previous session's Account read cannot overwrite a new session's permission answer", async () => {
  const t = await fixture()
  try {
    await t.account.showAccount()
    await waitFor(() => t.reads.length === 1)
    await t.store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    await t.identity("old-owner")
    await t.account.showAccount()
    await waitFor(() => t.reads.length === 2)
    t.reads[1]!.resolve(scopes("current"))
    await waitFor(() => JSON.stringify(t.store.collections.cards.get("account")).includes("current"))
    t.reads[0]!.resolve(scopes("outdated"))
    await settle()
    await t.store.settled?.()
    expect(t.store.collections.cards.get("account")?.payload).toMatchObject({ scopes: [{ scope: "current", plain: "current" }] })
  } finally { await t.dispose() }
})

for (const first of ["user", "smithers"] as const) {
  test(`a ${first} Account request shares its admission and remote read with the other actor`, async () => {
    const t = await fixture()
    try {
      const old = first === "user" ? t.account.showAccount() : t.agentShow()
      const recent = first === "user" ? t.agentShow() : t.account.showAccount()
      expect(await old).toEqual({ value: "Requested" })
      expect(await recent).toEqual({ value: "Requested" })
      expect(t.reads).toHaveLength(1)
      t.reads[0]!.resolve(scopes("current"))
      await waitFor(() => JSON.stringify(t.store.collections.cards.get("account")).includes("current"))
      await t.store.settled?.()
      expect(t.store.collections.cards.get("account")?.payload).toMatchObject({ scopes: [{ scope: "current", plain: "current" }] })
      const writes = [...t.store.collections.transitions.values()].filter(event => event.type === "card.upsert")
      expect(writes.map(event => event.actor)).toEqual([first, "system"])
    } finally { await t.dispose() }
  })
}

for (const change of [false, true]) {
  test(`Account waits for its card save${change ? " and suppresses a result after account replacement" : " before reporting success"}`, async () => {
    const t = await fixture("local")
    const saved = Promise.withResolvers<void>()
    const dispatch = t.store.dispatch
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
      let finished = false
      const reading = t.account.showAccount().then(result => { finished = true; return result })
      await waitFor(() => held)
      await settle()
      expect(finished).toBe(false)
      if (change) await t.identity("new-owner")
      saved.resolve()
      const result = await reading
      if (change) {
        expect(JSON.stringify(result)).not.toContain("old-owner")
        expect(t.store.collections.cards.has("account")).toBe(false)
      } else expect(result).toMatchObject({ value: expect.stringContaining("old-owner") })
    } finally { saved.resolve(); Object.assign(t.store, { dispatch }); await t.dispose() }
  })
}

test("a real refused Account save fails without a success claim and can retry", async () => {
  const backing = memoryStorage()
  let armed = false
  let refused = 0
  const storage = { ...backing, setItem: (key: string, value: string) => {
    if (armed && key.endsWith(".staged")) {
      armed = false; refused += 1
      throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError", code: 22 })
    }
    backing.setItem(key, value)
  } }
  const t = await fixture("local", storage)
  try {
    armed = true
    await expect(t.account.showAccount()).rejects.toThrow()
    expect(refused).toBe(1)
    expect(t.store.collections.cards.has("account")).toBe(false)
    expect(await t.account.showAccount()).toMatchObject({ value: expect.stringContaining("old-owner") })
  } finally { await t.dispose() }
})

test("a disposed Account controller starts no read or write", async () => {
  const t = await fixture("local")
  try {
    await t.ctx.dispose()
    await t.account.showAccount()
    await t.store.settled?.()
    expect(t.reads).toHaveLength(0)
    expect(t.store.collections.cards.has("account")).toBe(false)
  } finally { await t.dispose() }
})

test("a selected backend identity shows the GitHub account without the identity worker's scopes read", async () => {
  const t = await fixture("github", memoryStorage(), false)
  try {
    expect(await t.account.showAccount()).toEqual({ value: "account: @old-owner; access allowed; 0 box(es) listed" })
    await settle()
    expect(t.reads).toHaveLength(0)
    const card = t.store.collections.cards.get("account")
    expect(card?.kind === "account" ? card.payload : undefined).toMatchObject({ login: "old-owner", provider: "github", scopes: [] })
    expect(card?.kind === "account" ? card.payload.refresh : "missing").toBeUndefined()
  } finally { await t.dispose() }
})

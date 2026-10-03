import { expect, test } from "bun:test"
import { ADMIN_HEALTH_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { createAppStore } from "../AppStore"
import { memoryStorage, silentAgent } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createPresentationController } from "./presentation"

const health = { status: "ok", database: { status: "ok" } }
const fixture = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: true, provider: "github", scopesPlain: null }).isPersisted.promise
  const ctx = createControllerContext(store, silentAgent, {})
  return { store, ctx, presentation: createPresentationController(ctx) }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
const retire = async (t: Fixture, boundary: "logout" | "dispose") => {
  if (boundary === "dispose") await t.ctx.dispose()
  else await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, provider: "github", scopesPlain: null }).isPersisted.promise
}
const snapshot = (t: Fixture) => ({ messages: [...t.store.collections.messages.values()], cards: [...t.store.collections.cards.values()], toasts: [...t.store.collections.toasts.values()] })

// A held dependency deliberately ignores cancellation, so the method's own
// account/lifetime fence must reject the observation even if the transport returns.
for (const boundary of ["logout", "dispose"] as const) {
  for (const outcome of ["success", "http-error", "network-error", "malformed"] as const) {
    test(`a ${outcome} health response after ${boundary} publishes no result`, async () => {
      const t = await fixture()
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<Response>()
      t.ctx.boundedFetch = async url => { expect(url).toEndWith(ADMIN_HEALTH_PATH); entered.resolve(); return release.promise }
      const read = t.presentation.debugSeams()
      try {
        await entered.promise
        await retire(t, boundary)
        const before = snapshot(t)
        if (outcome === "network-error") release.reject(new Error("Late private transport details"))
        else release.resolve(outcome === "success" ? Response.json(health) : outcome === "http-error" ? Response.json({ message: "Late private error" }, { status: 403 }) : Response.json({ private: "Unknown health shape" }))
        expect(await read).toBeUndefined()
        await t.store.settled?.()
        expect(snapshot(t)).toEqual(before)
      } finally { release.resolve(Response.json(health)); await read; await t.ctx.dispose(); await t.store.dispose?.() }
    })
  }
  for (const outcome of ["success", "http-error"] as const) {
    test(`a held ${outcome} body after ${boundary} cannot escape the health fence`, async () => {
      const t = await fixture()
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
      const response = Response.json(health, { status: outcome === "success" ? 200 : 403 })
      if (outcome === "success") response.json = async () => { entered.resolve(); await release.promise; return health }
      else t.ctx.errorMessageOf = async () => { entered.resolve(); await release.promise; return "Late private error" }
      t.ctx.boundedFetch = async () => response
      const read = t.presentation.debugSeams()
      try {
        await entered.promise
        await retire(t, boundary)
        const before = snapshot(t)
        release.resolve()
        expect(await read).toBeUndefined()
        await t.store.settled?.()
        expect(snapshot(t)).toEqual(before)
      } finally { release.resolve(); await read; await t.ctx.dispose(); await t.store.dispose?.() }
    })
  }
}

test("a current health read still renders once without a health card or toast", async () => {
  const t = await fixture()
  t.ctx.boundedFetch = async () => Response.json(health)
  try {
    expect(await t.presentation.debugSeams()).toEqual({ value: JSON.stringify(health) })
    await t.store.settled?.()
    expect([...t.store.collections.messages.values()].map(message => message.text)).toEqual([`Seam health\n\n\`\`\`json\n${JSON.stringify(health)}\n\`\`\``])
    expect(t.store.collections.cards.size).toBe(0)
    expect(t.store.collections.toasts.size).toBe(0)
  } finally { await t.ctx.dispose(); await t.store.dispose?.() }
})

for (const outcome of ["http-error", "network-error", "malformed"] as const) {
  test(`a current ${outcome} health read retains its refusal`, async () => {
    const t = await fixture()
    t.ctx.errorMessageOf = async () => "Health access denied"
    t.ctx.boundedFetch = async () => {
      if (outcome === "network-error") throw new Error("Private transport detail")
      return outcome === "http-error" ? Response.json({}, { status: 403 }) : Response.json({ invalid: true })
    }
    try {
      expect(await t.presentation.debugSeams()).toBe(outcome === "http-error" ? "Health access denied" : outcome === "network-error" ? "The health read didn't answer — the admin route is unreachable." : "The health read answered in a shape I didn't understand.")
      expect(t.store.collections.messages.size).toBe(0)
      expect(t.store.collections.cards.size).toBe(0)
      expect(t.store.collections.toasts.size).toBe(0)
    } finally { await t.ctx.dispose(); await t.store.dispose?.() }
  })
}

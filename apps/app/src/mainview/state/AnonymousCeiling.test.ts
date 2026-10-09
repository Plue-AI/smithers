import { CardSchema } from "@smthrs/rpc/Cards"
import { expect, test } from "bun:test"

import { createAppStore } from "./AppStore"
import { memoryStorage } from "./TestFixtures"

/*
 * The anonymous turn ceiling card is deferred with Smithers Cloud (mvp.md §8,
 * T-CUT-03): its browser producer left with the browser turn driver
 * (90ef5aaccb), but the kind stays live, so a transcript that already holds
 * one still decodes and signing in still answers it.
 */
const PER_ADDRESS =
  "That is 20 turns today without signing in, which is as far as exploring goes. Sign in with GitHub to keep going, or come back in about 6 hours. Nothing was charged."

test("sign-in answers a persisted anonymous ceiling card", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
  const card = CardSchema.parse({ id: "anonymous-ceiling-turn-1", kind: "anonymous-ceiling", title: "Exploring is paused", status: "active",
    createdAt: 1, ordinal: 1, payload: { message: PER_ADDRESS, retryAt: "2026-09-08T00:00:00.000Z" } })
  await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
  await store.dispose?.()
  const reopened = await createAppStore({ kind: "localStorage", storage })
  try {
    expect(reopened.collections.cards.get(card.id)).toMatchObject({ kind: "anonymous-ceiling", status: "active", payload: card.payload })
    await reopened.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in",
      login: "codeplanesmithers", admin: false, scopesPlain: null }).isPersisted.promise
    expect(reopened.collections.cards.get(card.id)).toMatchObject({ id: card.id, payload: card.payload,
      ordinal: card.ordinal, createdAt: card.createdAt, status: "acted" })
    expect((await reopened.verifyState()).valid).toBe(true)
  } finally { await reopened.dispose?.() }
})

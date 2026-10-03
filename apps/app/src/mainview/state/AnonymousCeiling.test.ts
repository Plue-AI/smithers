import type { StartAgentTurnResult } from "@smthrs/rpc/NativeAgent"
import { describe,expect,test } from "bun:test"

import type { AgentPort } from "../runtime/AgentPort"
import type { AppStore } from "./AppStore"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage,settled } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * The anonymous turn ceiling (apps/server turnLimit.ts; factory mock 22). A
 * signed-out visitor whose turn the Worker refused with 429 turn_rate_limited
 * gets the refusal as its own card carrying the server's sentence and reset
 * time, with no generic failure bubble, and the composer settles to idle. The
 * branch is the refusal's code plus the session, never the sentence: both
 * server wordings take the card, a signed-in login's ceiling keeps the failure
 * line, a session the app has not confirmed signed out (identity still
 * loading, or the seam unavailable) keeps the failure line, and every other
 * failure keeps today's message.
 */


const PER_ADDRESS =
  "That is 20 turns today without signing in, which is as far as exploring goes. Sign in with GitHub to keep going, or come back in about 6 hours. Nothing was charged."
const FOR_EVERYONE =
  "Exploring without signing in has reached its daily limit for everyone, not just you. Sign in with GitHub to keep going, or come back in about 3 hours. Nothing was charged."
const LOGIN_CEILING =
  "That is more than 1000 model calls in an hour, which no conversation reaches by hand. Chat resumes on its own in about 12 minutes. Nothing was charged and your balance is untouched."

/** An agent whose every leg answers the given start result: the Worker refused or failed before streaming. */
const refusingAgent = (result: StartAgentTurnResult): AgentPort => ({
  available: true,
  startTurn: async () => result,
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

type IdentityFixture = "signed-out" | "signed-in" | "unavailable" | "never-loaded"

const storeWith = async (state: IdentityFixture): Promise<AppStore> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  // Boot leaves the identity row at "unknown" until the seam answers; never dispatching models a turn typed before it did.
  if (state === "never-loaded") return store
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state,
    login: state === "signed-in" ? "will" : null,
    admin: false,
    scopesPlain: null
  })
  return store
}

const sendRefused = async (state: IdentityFixture, result: StartAgentTurnResult, _tutorial = false) => {
  const store = await storeWith(state)
  const controller = createAppController(store, refusingAgent(result), {
    fetchImpl: async () => new Response("{}", { status: 200 })
  })
  controller.send("what does the kernel do with a denied capability?")
  await settled()
  await settled()
  const ceilingCards = [...store.collections.cards.values()].filter((card) => card.kind === "anonymous-ceiling")
  const failedMessages = [...store.collections.messages.values()].filter((message) => message.status === "failed")
  return { store, ceilingCards, failedMessages }
}

describe("a signed-out turn refused by the anonymous ceiling", () => {
  test("the per-address refusal renders the card with the server's sentence and reset time, no failure bubble", async () => {
    const { store, ceilingCards, failedMessages } = await sendRefused("signed-out", {
      status: "error",
      message: `Smithers web agent failed (HTTP 429): ${PER_ADDRESS}`,
      refusal: { code: "turn_rate_limited", message: PER_ADDRESS, retryAt: "2026-09-08T00:00:00.000Z" }
    })
    expect(ceilingCards.length).toBe(1)
    const card = ceilingCards[0]
    if (card?.kind !== "anonymous-ceiling") throw new Error("expected the ceiling card")
    expect(card.payload).toEqual({ message: PER_ADDRESS, retryAt: "2026-09-08T00:00:00.000Z" })
    expect(failedMessages).toEqual([])
    expect(store.session().phase).toBe("idle")
    // The card follows the question it answers.
    const question = [...store.collections.messages.values()].find((message) => message.role === "user")
    expect(card.ordinal).toBeGreaterThan(question?.ordinal ?? Number.POSITIVE_INFINITY)
  })

  test("the deployment-wide refusal renders the same card, with a null reset when the body named none", async () => {
    const { ceilingCards, failedMessages } = await sendRefused("signed-out", {
      status: "error",
      message: `Smithers web agent failed (HTTP 429): ${FOR_EVERYONE}`,
      refusal: { code: "turn_rate_limited", message: FOR_EVERYONE, retryAt: null }
    })
    expect(ceilingCards.map((card) => card.kind === "anonymous-ceiling" ? card.payload : undefined)).toEqual([
      { message: FOR_EVERYONE, retryAt: null }
    ])
    expect(failedMessages).toEqual([])
  })
})

describe("every other refused turn keeps today's failure line", () => {
  test("a signed-in login's own ceiling is a failure line, never the sign-in card", async () => {
    const { ceilingCards, failedMessages, store } = await sendRefused("signed-in", {
      status: "error",
      message: `Smithers web agent failed (HTTP 429): ${LOGIN_CEILING}`,
      refusal: { code: "turn_rate_limited", message: LOGIN_CEILING, retryAt: "2026-09-07T13:00:00.000Z" }
    })
    expect(ceilingCards).toEqual([])
    expect(failedMessages.map((message) => message.text)).toEqual([
      `I couldn't complete that turn. Smithers web agent failed (HTTP 429): ${LOGIN_CEILING}`
    ])
    expect(store.session().phase).toBe("idle")
  })

  test("a ceiling refusal before the identity seam answered keeps the failure line: the session may be signed in", async () => {
    const { ceilingCards, failedMessages, store } = await sendRefused("never-loaded", {
      status: "error",
      message: `Smithers web agent failed (HTTP 429): ${LOGIN_CEILING}`,
      refusal: { code: "turn_rate_limited", message: LOGIN_CEILING, retryAt: "2026-09-07T13:00:00.000Z" }
    })
    expect(store.collections.identitySessions.get("identity")?.state).toBe("unknown")
    expect(ceilingCards).toEqual([])
    expect(failedMessages.map((message) => message.text)).toEqual([
      `I couldn't complete that turn. Smithers web agent failed (HTTP 429): ${LOGIN_CEILING}`
    ])
    expect(store.session().phase).toBe("idle")
  })

  test("a ceiling refusal while the identity seam is unavailable keeps the failure line, never the sign-in card", async () => {
    const { ceilingCards, failedMessages, store } = await sendRefused("unavailable", {
      status: "error",
      message: `Smithers web agent failed (HTTP 429): ${PER_ADDRESS}`,
      refusal: { code: "turn_rate_limited", message: PER_ADDRESS, retryAt: "2026-09-08T00:00:00.000Z" }
    })
    expect(store.collections.identitySessions.get("identity")?.state).toBe("unavailable")
    expect(ceilingCards).toEqual([])
    expect(failedMessages.map((message) => message.text)).toEqual([
      `I couldn't complete that turn. Smithers web agent failed (HTTP 429): ${PER_ADDRESS}`
    ])
    expect(store.session().phase).toBe("idle")
  })

  test("a non-429 failure while signed out keeps the failure line", async () => {
    const { ceilingCards, failedMessages, store } = await sendRefused("signed-out", {
      status: "error",
      message: "Smithers Cloud is unreachable right now. Try again in a moment. (HTTP 503)"
    })
    expect(ceilingCards).toEqual([])
    expect(failedMessages.map((message) => message.text)).toEqual([
      "I couldn't complete that turn. Smithers Cloud is unreachable right now. Try again in a moment. (HTTP 503)"
    ])
    expect(store.session().phase).toBe("idle")
  })
})

test("sign-in answers the anonymous ceiling's persisted sign-in card", async () => {
  const { store, ceilingCards } = await sendRefused("signed-out", {
    status: "error", message: PER_ADDRESS,
    refusal: { code: "turn_rate_limited", message: PER_ADDRESS, retryAt: null }
  })
  const before = ceilingCards[0]!
  expect(before.status).toBe("active")
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in",
    login: "codeplanesmithers", admin: false, scopesPlain: null }).isPersisted.promise
  expect(store.collections.cards.get(before.id)).toMatchObject({ id: before.id, payload: before.payload,
    ordinal: before.ordinal, createdAt: before.createdAt, status: "acted" })
})

describe("a signed-in turn refused for lack of model credit", () => {
  test("states the typed failure with no plans card and no Upgrade door (M-09: billing is deferred)", async () => {
    const { store, ceilingCards, failedMessages } = await sendRefused("signed-in", {
      status: "error",
      message: "That turn wasn't run because the account has no balance left. (HTTP 402)",
      refusal: { code: "out_of_credit", message: "Out of credit.", retryAt: null }
    })
    await settled()
    expect(ceilingCards).toEqual([])
    expect(failedMessages.map((message) => message.text)).toEqual([
      "I couldn't complete that turn. That turn wasn't run because the account has no balance left. (HTTP 402)"
    ])
    expect([...store.collections.cards.values()].filter((card) => ["balance", "billing-plans", "grant-confirm"].includes(card.kind))).toEqual([])
    expect(store.session().phase).toBe("idle")
  })
})

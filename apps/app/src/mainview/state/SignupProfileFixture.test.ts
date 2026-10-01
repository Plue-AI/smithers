import { expect, test } from "bun:test"
import { executeAgentToolCall } from "../flows/agentTools"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { SIGNUP_PROFILE_PATH, type SignupProfile } from "./Signup"
import { memoryStorage, signupProfileFetch, silentAgent, waitFor } from "./TestFixtures"

const createController = scopedControllers()
const savedProfile = (): SignupProfile => ({
  name: "Ada Park",
  account: "ada",
  stage: "poll",
  question: 2,
  answers: { role: "Engineering", models: ["Claude"] }
})

test("the signup fixture serves only exact selected-host GETs and gives each caller a fresh body", async () => {
  const unexpected = async () => {
    throw new Error("Unexpected request")
  }
  const source = savedProfile(), fixture = signupProfileFetch(unexpected, source)
  source.answers.models = ["Changed outside fixture"]
  for (
    const input of [
      SIGNUP_PROFILE_PATH,
      new URL(`https://app.test${SIGNUP_PROFILE_PATH}`),
      new Request(`https://app.test${SIGNUP_PROFILE_PATH}`)
    ]
  ) {
    const response = await fixture.fetchImpl(input)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(await response.json()).toEqual({ profile: savedProfile() })
  }
  expect(fixture.reads).toEqual([SIGNUP_PROFILE_PATH, SIGNUP_PROFILE_PATH, SIGNUP_PROFILE_PATH])
  expect(await (await signupProfileFetch(unexpected).fetchImpl(SIGNUP_PROFILE_PATH)).json()).toEqual({ profile: null })
  expect(() => signupProfileFetch(unexpected, { ...savedProfile(), name: "" })).toThrow()
})

test("unrelated origins, paths, queries and methods reach the original refusing transport unchanged", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = []
  const fixture = signupProfileFetch(async (input, init) => {
    calls.push({ input, ...(init === undefined ? {} : { init }) })
    throw new Error("Unexpected request")
  })
  const requests = [
    { input: `${SIGNUP_PROFILE_PATH}?extra=1` },
    { input: `${SIGNUP_PROFILE_PATH}#fragment` },
    { input: `${SIGNUP_PROFILE_PATH}/more` },
    { input: `https://other.test${SIGNUP_PROFILE_PATH}` },
    { input: "/api/auth/scopes" },
    { input: SIGNUP_PROFILE_PATH, init: { method: "PUT" } },
    { input: SIGNUP_PROFILE_PATH, init: { method: "POST" } },
    { input: new Request(`https://app.test${SIGNUP_PROFILE_PATH}`, { method: "DELETE" }) }
  ]
  for (const request of requests) {
    await expect(fixture.fetchImpl(request.input, request.init)).rejects.toThrow("Unexpected request")
  }
  expect(calls).toEqual(requests)
  expect(fixture.reads).toEqual([])
})

test("a held profile read stays background work while discovery and Chat remain usable, then persists server recovery", async () => {
  const storage = memoryStorage(), store = await createAppStore({ kind: "localStorage", storage })
  const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const starts: string[] = []
  const fixture = signupProfileFetch(async () => {
    throw new Error("Unexpected request")
  }, savedProfile())
  const controller = createController(store, {
    ...silentAgent,
    startTurn: async (request) => {
      starts.push(request.runId)
      return { status: "error", message: "Unexpected model turn" }
    }
  }, {
    fetchImpl: async (input, init) => {
      entered.resolve()
      await held.promise
      return fixture.fetchImpl(input, init)
    }
  })
  try {
    await store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "ada",
      admin: false,
      scopesPlain: null
    }).isPersisted.promise
    await entered.promise
    expect(fixture.reads).toEqual([])
    expect(store.session().signup?.stage).toBe("account")
    controller.changeDraft("Chat remains usable")
    const discovery = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: "{\"action\":\"list\",\"namespace\":\"repo\"}"
    })
    expect(JSON.parse(discovery).commands.length).toBeGreaterThan(0)
    expect(store.session().draft).toBe("Chat remains usable")
    expect(fixture.reads).toEqual([])
    expect(starts).toEqual([])
    held.resolve()
    await waitFor(() => store.session().signup?.stage === "poll")
    await store.settled?.()
    expect(store.session().signup).toMatchObject(savedProfile())
    expect(fixture.reads).toEqual([SIGNUP_PROFILE_PATH])
    expect(starts).toEqual([])
    await controller.dispose()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    try {
      expect(reopened.session().signup).toMatchObject(savedProfile())
      expect((await reopened.verifyState()).valid).toBe(true)
    } finally {
      await reopened.dispose?.()
    }
  } finally {
    held.resolve()
    await controller.dispose()
    await store.dispose?.()
  }
})

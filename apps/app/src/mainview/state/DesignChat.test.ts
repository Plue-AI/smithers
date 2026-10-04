/*
 * The app agent in the mounted design (MOCK SEAM, state/seams/DesignWorld/chat.ts):
 * a plain prompt it can read runs the person's flows and answers in the
 * conversation without a model turn; drop asks first with an A✓ card only
 * the asker sees; merge opens the person's own Review & merge; anything
 * else takes the real turn.
 */
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { describe, expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, silentAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()
const cloud: AppBootstrap = { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity"], authFlow: "redirect", sandbox: null }

const setup = async (available = true) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
  const requests: StartAgentTurnRequest[] = []
  const controller = createAppController(store, { ...silentAgent, available, startTurn: async request => { requests.push(request); return { status: "started" } } },
    /* A configured host with no TODO provider (/api/todos is a 404): the seed answers TODO flows. */
    { bootstrap: cloud, fetchImpl: async input => new URL(String(input), "https://cloud.test").pathname.startsWith("/api/todos") ? Response.json({}, { status: 404 }) : Response.json({}) })
  const messages = () => [...store.collections.messages.values()].sort((a, b) => a.ordinal - b.ordinal)
  const answered = async () => {
    await waitFor(() => store.session().phase === "idle" && messages().some(message => message.role === "smithers"))
    return messages().at(-1)!
  }
  return { store, controller, requests, messages, answered, design: controller.design }
}

describe("the app agent answers plain prompts from the seeded world", () => {
  test("a theme request changes this person's screen and says so; no model turn starts", async () => {
    const { store, controller, requests, messages, answered } = await setup()
    controller.send("switch to dark mode")
    const reply = await answered()
    expect(messages().map(message => [message.role, message.text])).toEqual([["user", "switch to dark mode"], ["smithers", "Changed Maya's theme to dark."]])
    expect(reply.context).toBeUndefined()
    expect(store.session().theme).toBe("dark")
    expect(store.session().draft).toBe("")
    expect(requests).toHaveLength(0)
  })

  test("a question answers in one line with its Context line, and opens the lines it rests on", async () => {
    const { store, controller, answered } = await setup()
    controller.send("why is the checkout test flaky?")
    const reply = await answered()
    expect(reply.text).toBe("It checks the status before the payment intent settles.")
    expect(reply.context?.map(item => item.kind)).toEqual(["file", "page", "run"])
    expect(store.collections.cards.get("design:file:b-checkout:src/checkout/checkout.test.ts")?.kind).toBe("file")
  })

  test("stop runs at once with the person's authority, attributed to them via Smithers; the reply is its receipt", async () => {
    const { controller, answered, design } = await setup()
    expect(design.world().todos.find(each => each.id === "t-checkout")?.state).toBe("working")
    controller.send("stop the checkout TODO")
    expect((await answered()).text).toBe("Stopped T10.")
    expect(design.world().todos.find(each => each.id === "t-checkout")?.state).toBe("paused")
    const stopped = design.world().branches.find(each => each.id === "b-checkout")?.activity.at(-1)
    expect(stopped).toMatchObject({ text: "Stopped T10", asked: "maya~smithers" })
  })

  test("the person's own press stays attributed to the bare member", async () => {
    const { controller, design } = await setup()
    expect((await controller.commands.submit({ name: "todo.stop", payload: { n: 10 }, actor: "user" })).status).toBe("executed")
    expect(design.world().branches.find(each => each.id === "b-checkout")?.activity.at(-1)).toMatchObject({ text: "Stopped T10", asked: "maya" })
  })

  test("a step that throws settles the turn with a visible failure and Chat keeps working", async () => {
    const { store, controller, messages } = await setup()
    const submit = controller.commands.submit
    ;(controller.commands as { submit: typeof submit }).submit = async () => { throw new Error("boom") }
    controller.send("stop the checkout TODO")
    await waitFor(() => store.session().phase === "idle" && messages().some(message => message.role === "smithers"))
    expect(messages().at(-1)).toMatchObject({ role: "smithers", status: "failed", text: "I couldn't complete that turn. Try again." })
    ;(controller.commands as { submit: typeof submit }).submit = submit
    controller.send("stop the checkout TODO")
    await waitFor(() => store.session().phase === "idle" && messages().filter(message => message.role === "smithers").length === 2)
    expect(messages().at(-1)?.text).toBe("Stopped T10.")
  })

  test("drop asks first: a private A✓ card, nothing dropped until the press; Cancel settles it once", async () => {
    const { store, controller, design, messages } = await setup()
    controller.send("drop T11")
    await waitFor(() => store.session().phase === "idle" && design.world().acts.length === 1)
    const act = design.world().acts[0]!
    expect(act).toMatchObject({ by: "maya", verb: "Drop", state: "asked", tag: "todo.drop", args: { n: 11 }, todo: "t-log" })
    expect(design.world().todos.find(each => each.id === "t-log")?.state).toBe("queued")
    const card = store.collections.cards.get(`design:confirm:act:${act.id}`)
    expect(card).toMatchObject({ kind: "confirm", title: "Drop T11 log-retries?", payload: { id: `act:${act.id}` }, audience_member_id: "design:maya" })
    // The agent asked; it did not answer in prose.
    expect(messages().filter(message => message.role === "smithers")).toEqual([])
    const line = JSON.stringify({ confirmation: act.id, revision: act.id })
    expect((await controller.commands.run("confirm.cancel", line)).status).toBe("executed")
    expect(design.world().acts[0]?.state).toBe("cancelled")
    expect((await controller.commands.run("confirm.cancel", line)).status).toBe("failed")
  })

  test("the press is the act's own flow, run as the person", async () => {
    const { controller, design } = await setup()
    controller.send("drop T11")
    await waitFor(() => design.world().acts.length === 1)
    const outcome = await controller.commands.submit({ name: "todo.drop", payload: { n: 11 }, actor: "user" })
    expect(outcome.status).toBe("executed")
    expect(design.world().todos.find(each => each.id === "t-log")?.state).toBe("dropped")
  })

  test("merge opens the person's own Review & merge and merges nothing", async () => {
    const { store, controller, design } = await setup()
    controller.send("merge #88")
    await waitFor(() => store.session().phase === "idle" && store.collections.cards.has("design:confirm:merge:t-stripe"))
    expect(store.collections.cards.get("design:confirm:merge:t-stripe")).toMatchObject({ kind: "confirm", payload: { id: "merge:t-stripe" } })
    expect(design.world().todos.find(each => each.id === "t-stripe")?.state).toBe("in-review")
    expect((await controller.commands.run("confirm.cancel", JSON.stringify({ confirmation: "merge:t-stripe", revision: "x" }))).status).toBe("executed")
    expect(store.collections.cards.has("design:confirm:merge:t-stripe")).toBe(false)
  })

  test("a prompt the agent has no reading for takes the real turn", async () => {
    const { controller, requests } = await setup()
    controller.send("tell me a joke")
    await waitFor(() => requests.length === 1)
    expect(requests[0]?.messages.length).toBeGreaterThan(0)
  })

  test("with no agent provider, an unscripted prompt answers from the seed instead of failing", async () => {
    const { controller, answered } = await setup(false)
    controller.send("Why is T9 waiting?")
    const reply = await answered()
    expect(reply.text).toMatch(/^T9 /)
    expect(reply.context).toEqual([{ kind: "todo", label: "T9 Retry failed webhooks with backoff", ref: "t-retry" }])
  })
})

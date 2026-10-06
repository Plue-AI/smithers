import { expect, test } from "bun:test"
import type { AgentPort } from "../../runtime/AgentPort"
import { scopedControllers } from "../../state/ControllerTestScope"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, signupProfileFetch } from "../../state/TestFixtures"

const createAppController = scopedControllers()
const unavailable: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
const answer = { id: "answer-9", context: [{ kind: "run", label: "Run 9", ref: "run-9", reason: "Evidence" }] }
const boot = async (enabled: boolean) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const presented: unknown[] = []
  const profile = signupProfileFetch(async input => {
    const url = String(input)
    return url.endsWith("/api/conversations/main") ? Response.json({ entries: [answer] }) : Response.json({}, { status: 404 })
  })
  const controller = createAppController(store, unavailable, { fetchImpl: profile.fetchImpl,
    contextLine: () => { throw new Error("No projection is installed") },
    ...(enabled ? { contextProvider: { available: () => true, present: async (value: unknown, branch: string, actor: "user" | "smithers") => { presented.push([value, branch, actor]) } } } : {}) })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  return { controller, presented }
}
test("Inspect's slash, structured button and agent doors read the same stored list", async () => {
  const h = await boot(true)
  expect(await h.controller.runCommandForResult("context.inspect", "main answer-9")).toMatchObject({ status: "executed", value: JSON.stringify(answer) })
  expect(await h.controller.commands.submit({ name: "context.inspect", payload: { branch: "main", answer: "answer-9" }, actor: "user" })).toMatchObject({ status: "executed" })
  expect(await h.controller.commands.runForAgent("context.inspect", 'main answer-9')).toMatchObject({ status: "executed", value: JSON.stringify(answer) })
  expect(h.presented).toEqual([[answer, "main", "user"], [answer, "main", "user"], [answer, "main", "smithers"]])
})
test("without providers Inspect refuses through the command path", async () => {
  const h = await boot(false)
  expect(h.controller.contextAvailable()).toBe(false)
  expect(h.controller.contextLine("answer-9")).toBeUndefined()
  expect(await h.controller.runCommandForResult("context.inspect", "main answer-9")).toMatchObject({ status: "failed", error: "Context is unavailable" })
  expect(h.presented).toEqual([])
})

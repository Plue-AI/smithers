import { MessageSchema, ToastSchema } from "../../state/AppState"
import { expect, test } from "bun:test"
import type { AgentPort } from "../../runtime/AgentPort"
import { scopedControllers } from "../../state/ControllerTestScope"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, signupProfileFetch } from "../../state/TestFixtures"

const createAppController = scopedControllers()
const unavailable: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
const answer = { id: "answer-9", context: [{ kind: "run", label: "Run 9", ref: "run-9", reason: "Evidence" }] }
const boot = async (enabled: boolean | "install") => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const presented: unknown[] = []
  const profile = signupProfileFetch(async input => {
    const url = String(input)
    return url.endsWith("/api/conversations/main") ? Response.json({ entries: [enabled === "install" ? { ...answer, runId: "run-9" } : answer] }) : Response.json({}, { status: 404 })
  })
  const controller = createAppController(store, unavailable, { fetchImpl: profile.fetchImpl,
    contextLine: () => { throw new Error("No projection is installed") },
    ...(enabled === "install" ? { bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"] as const, authFlow: "redirect" as const, sandbox: null } } : {}),
    ...(enabled === true ? { contextProvider: { available: () => true, present: async (value: unknown, branch: string, actor: "user" | "smithers") => { presented.push([value, branch, actor]) } } } : {}) })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  return { controller, presented }
}
test("Inspect's slash, structured button and agent doors read the same stored list", async () => {
  const h = await boot(true)
  expect(await h.controller.runCommandForResult("run.inspect", JSON.stringify({ branch: "main", answer: "answer-9" }))).toMatchObject({ status: "executed", value: JSON.stringify(answer) })
  expect(await h.controller.commands.submit({ name: "run.inspect", payload: { branch: "main", answer: "answer-9" }, actor: "user" })).toMatchObject({ status: "executed" })
  expect(await h.controller.commands.runForAgent("run.inspect", JSON.stringify({ branch: "main", answer: "answer-9" }))).toMatchObject({ status: "executed", value: JSON.stringify(answer) })
  expect(h.presented).toEqual([[answer, "main", "user"], [answer, "main", "user"], [answer, "main", "smithers"]])
})
test("without providers Inspect refuses through the command path", async () => {
  const h = await boot(false)
  expect(h.controller.contextAvailable()).toBe(false)
  expect(h.controller.contextLine("answer-9")).toBeUndefined()
  expect(await h.controller.runCommandForResult("run.inspect", JSON.stringify({ branch: "main", answer: "answer-9" }))).toMatchObject({ status: "failed", error: "Context is unavailable" })
  expect(h.presented).toEqual([])
})


test("retired inspection actions preserve their answer scope without executing the old tag", async () => {
  const h = await boot(true)
  expect((await h.controller.commands.run("context.inspect", "main answer-9")).status).toBe("unknown-command")
  const saved = MessageSchema.shape.action.parse({ flow: "context.inspect", args: "main answer-9", label: "Inspect" })!
  expect(saved).toEqual({ flow: "run.inspect", args: JSON.stringify({ branch: "main", answer: "answer-9" }), label: "Inspect" })
  expect(ToastSchema.shape.action.parse({ flow: "context.inspect", args: "main answer-9", label: "Inspect" })).toEqual(saved)
  expect((await h.controller.commands.run(saved.flow, saved.args)).status).toBe("executed")
  expect(h.presented).toEqual([[answer, "main", "user"]])
  expect(JSON.parse(MessageSchema.shape.action.parse({ flow: "context.inspect", args: '{"id":"another-run"}', label: "Inspect" })!.args!)).toEqual({})
})


test("the install composes stored answer inspection into its existing private Run card", async () => {
  const h = await boot("install")
  expect(h.controller.contextAvailable()).toBe(true)
  expect(await h.controller.commands.submit({ name: "run.inspect", payload: { branch: "main", answer: "answer-9" }, actor: "user" })).toMatchObject({ status: "executed" })
  expect(h.controller.store.collections.cards.get("run:run-9")?.kind).toBe("run")
  expect(await h.controller.commands.submit({ name: "run.inspect", payload: { id: "another-run", branch: "main", answer: "answer-9" }, actor: "user" })).toMatchObject({ status: "failed" })
  expect(h.controller.store.collections.cards.has("run:another-run")).toBe(false)
})

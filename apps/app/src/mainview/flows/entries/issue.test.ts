import { expect, test } from "bun:test"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, signupProfileFetch } from "../../state/TestFixtures"
import { modelInvocable } from "../registry"
import { flowArgs } from "../FlowArgs"

test("Make TODO uses one handler for slash, button, agent and recorded cards", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: string[] = []
  const controller = createAppController(store, {
    available: false, startTurn: async () => ({ status: "error", message: "unavailable" }),
    cancelTurn: async () => {}, subscribe: () => () => {}
  }, { fetchImpl: signupProfileFetch(async input => {
    requests.push(String(input))
    throw Error("Make TODO must not read or launch from the browser")
  }).fetchImpl })
  try {
    const make = controller.commands.find("todo.from-issue")!
    expect(modelInvocable(make)).toBe(true)
    expect(make.metadata.confirm).toBe("make a TODO from the issue")
    expect(make.metadata.workflow).toBeUndefined()
    expect(controller.commands.find("issue.implement")!.metadata.hidden).toBe(true)
    expect(flowArgs("todo.from-issue", { number: 7, repo: "owner/repo" })).toBe("7 owner/repo")
    for (const name of ["todo.from-issue", "issue.implement"]) {
      // No GitHub issue card is open, so there is nothing to draft from.
      expect(await controller.runCommandForResult(name, "7 owner/repo")).toEqual({ status: "failed", error: "Open GitHub issue #7 before making a TODO." })
      await controller.commands.submit({ name, payload: { number: 7, repo: "owner/repo" }, actor: "user" })
    }
    expect(await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "todo.from-issue", args: "7 owner/repo" }) })).toContain("asked the user to confirm")
    expect(requests).toEqual([])
    expect([...store.collections.cards.values()].some(card => card.kind === "run-trace" || card.kind === "change")).toBe(false)
  } finally { await controller.dispose() }
})

test("Make TODO on a GitHub issue card opens its author's Draft and files nothing", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  const writes: string[] = []
  const controller = createAppController(store, {
    available: false, startTurn: async () => ({ status: "error", message: "unavailable" }),
    cancelTurn: async () => {}, subscribe: () => () => {}
  }, { fetchImpl: signupProfileFetch(async (input, init) => {
    if ((init?.method ?? "GET") !== "GET") writes.push(String(input))
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
  }).fetchImpl })
  try {
    const issue = { repo: "owner/repo", number: 7, title: "Webhooks fail on 502", state: "open" as const, author: "ben", issueBody: "Webhooks fail on 502",
      source: "github" as const, htmlUrl: "https://github.com/owner/repo/issues/7", labels: [],
      comments: [{ author: "alice", commentBody: "retry at most 5 times", createdAt: null }] }
    await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "issue-github-owner/repo-7", kind: "issue", title: issue.title, status: "active", createdAt: 1, ordinal: 1, payload: issue } }).isPersisted.promise
    expect(await controller.runCommandForResult("todo.from-issue", "7 owner/repo")).toEqual({ status: "executed", value: "Drafted" })
    const draft = [...store.collections.cards.values()].find(card => card.kind === "draft")
    expect(draft?.kind === "draft" && draft.audience_member_id).toBe("ben")
    expect(draft?.kind === "draft" && draft.payload).toMatchObject({ title: "Webhooks fail on 502", prompt: "Webhooks fail on 502\n\n@alice:\n> retry at most 5 times",
      issue: { number: 7, url: "https://github.com/owner/repo/issues/7", fixes: true }, private: true })
    expect(writes).toEqual([])
  } finally { await controller.dispose() }
})

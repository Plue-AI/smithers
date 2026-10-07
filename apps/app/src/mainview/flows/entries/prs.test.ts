import { expect, test } from "bun:test"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, signupProfileFetch } from "../../state/TestFixtures"
import { modelInvocable } from "../registry"

test("review is a confirmable command and both review doors refuse browser execution", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: string[] = []
  const controller = createAppController(store, {
    available: false, startTurn: async () => ({ status: "error", message: "unavailable" }),
    cancelTurn: async () => {}, subscribe: () => () => {}
  }, { fetchImpl: signupProfileFetch(async input => {
    requests.push(String(input))
    throw Error("Review must not request browser execution")
  }).fetchImpl })
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", admin: false, scopesPlain: null }).isPersisted.promise
    const review = controller.commands.find("review")!
    expect(modelInvocable(review)).toBe(true)
    expect(review.metadata.confirm).toBe("review the pull request")
    expect(review.metadata.workflow).toBe("review")
    expect(controller.commands.find("prs.land")).toBeUndefined()
    expect(controller.commands.find("prs.triage")!.metadata.hidden).toBe(true)
    for (const name of ["review", "prs.triage"]) {
      expect(await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name, args: "50 owner/repo" }) })).toBe(name === "review" ? "failed: this command runs on the conversation host" : "failed: /prs.triage is user-only — it is a control the human clicks, already visible on their screen")
    }
    expect(await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "review", args: "50 owner/repo" }) })).toBe("failed: this command runs on the conversation host")
    expect(requests).toEqual([])
    expect([...store.collections.cards.values()].some(card => card.kind === "run-trace" || card.kind === "change")).toBe(false)
  } finally { await controller.dispose() }
})

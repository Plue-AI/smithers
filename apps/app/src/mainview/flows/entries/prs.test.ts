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
    const review = controller.commands.find("review")!
    expect(modelInvocable(review)).toBe(true)
    expect(review.metadata.confirm).toBe("review the pull request")
    expect(review.metadata.workflow).toBeUndefined()
    expect(controller.commands.find("prs.triage")!.metadata.hidden).toBe(true)
    for (const name of ["review", "prs.triage"]) {
      const result = await controller.runCommandForResult(name, "50 owner/repo")
      expect(result).toEqual({ status: "failed", error: "Review is unavailable on this host." })
      await controller.commands.submit({ name, payload: { number: 51, repo: "owner/repo" }, actor: "user" })
    }
    expect(await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "review", args: "50 owner/repo" }) })).toContain("asked the user to confirm")
    expect(requests).toEqual([])
    expect([...store.collections.cards.values()].some(card => card.kind === "run-trace" || card.kind === "change")).toBe(false)
  } finally { await controller.dispose() }
})

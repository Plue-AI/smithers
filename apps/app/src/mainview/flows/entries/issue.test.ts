import { expect, test } from "bun:test"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, signupProfileFetch } from "../../state/TestFixtures"
import { modelInvocable } from "../registry"
import { flowArgs } from "../FlowArgs"

test("Make TODO uses one dark handler for slash, button, agent and recorded cards", async () => {
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
      expect(await controller.runCommandForResult(name, "7 owner/repo")).toEqual({ status: "failed", error: "Make TODO is unavailable until install admission is configured." })
      await controller.commands.submit({ name, payload: { number: 7, repo: "owner/repo" }, actor: "user" })
    }
    expect(await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "todo.from-issue", args: "7 owner/repo" }) })).toContain("asked the user to confirm")
    expect(requests).toEqual([])
    expect([...store.collections.cards.values()].some(card => card.kind === "run-trace" || card.kind === "change")).toBe(false)
  } finally { await controller.dispose() }
})

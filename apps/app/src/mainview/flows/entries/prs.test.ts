import { expect, test } from "bun:test"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, signupProfileFetch, waitFor } from "../../state/TestFixtures"
import { modelInvocable } from "../registry"
import { MessageSchema, ToastSchema } from "../../state/AppState"

test("review is the only confirmable review command and refuses browser execution", async () => {
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
    expect(review.metadata).toMatchObject({ agent: "confirm", cli: ["review"], actors: ["person", "app_agent", "external_agent"] })
    expect(controller.commands.find("prs.land")).toBeUndefined()
    expect(controller.commands.find("prs.triage")).toBeUndefined()
    expect((await controller.commands.run("prs.triage", "50 owner/repo")).status).toBe("unknown-command")
    const recorded = { flow: "prs.triage", args: "50 owner/repo", label: "Review" }
    const saved = MessageSchema.shape.action.parse(recorded)!
    expect(saved).toEqual({ ...recorded, flow: "review" })
    expect(ToastSchema.shape.action.parse(recorded)).toEqual(saved)
    const answered = { ...recorded, answer: "Requested", answeredAt: 1 }
    expect(MessageSchema.shape.answeredAction.parse(answered)?.flow).toBe("review")
    expect(ToastSchema.shape.answeredAction.parse(answered)?.flow).toBe("review")
    expect(await controller.commands.run(saved.flow, saved.args)).toEqual({ status: "failed", error: "Sign in" })
    for (const name of ["review"]) {
      const result = await controller.runCommandForResult(name, "50 owner/repo")
      // #3612 (42a4fa17b0): sign-in precedes host admission (spec §5.2.1).
      expect(result).toEqual({ status: "failed", error: "Sign in" })
      await controller.commands.submit({ name, payload: { number: 51, repo: "owner/repo" }, actor: "user" })
    }
    expect(await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "review", args: "50 owner/repo" }) })).toBe("failed: this command runs on the conversation host")
    expect(requests).toEqual([])
    expect(store.session().reviewRequests ?? []).toEqual([])
    expect([...store.collections.cards.values()].some(card => card.kind === "run-trace" || card.kind === "change")).toBe(false)
  } finally { await controller.dispose() }
})

for (const name of ["review"]) {
  test(`${name} requests only host admission and never falls back to browser execution`, async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const requests: string[] = []
    let browserStarts = 0
    const controller = createAppController(store, {
      available: false, startTurn: async () => { browserStarts++; return { status: "error", message: "unavailable" } },
      cancelTurn: async () => {}, subscribe: () => () => {}
    }, { fetchImpl: signupProfileFetch(async input => {
      requests.push(new URL(String(input), "https://app.test").pathname)
      return Response.json({ error: { class: "infra", code: "review_delivery_unavailable", message: "Review unavailable" } }, { status: 503 })
    }).fetchImpl })
    try {
      store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null })
      // T-FLW-13 Scope and spec §12.3: missing host integration refuses; no working-copy fallback.
      expect(await controller.runCommandForResult(name, "50 owner/repo")).toEqual({ status: "executed", value: "Requested" })
      await waitFor(() => store.session().reviewRequests?.[0]?.state === "failed")
      expect(requests).toEqual(["/api/reviews"])
      expect(browserStarts).toBe(0)
      expect([...store.collections.cards.values()].some(card => card.kind === "run-trace" || card.kind === "change")).toBe(false)
    } finally { await controller.dispose() }
  })
}

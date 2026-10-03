import { expect, test } from "bun:test"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage } from "../../state/TestFixtures"

test("confirm.cancel refuses stale and answered revisions and persists cancellation", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const controller = createAppController(store, { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} })
  try {
    controller.requestFlowConfirmation("todo.drop", "T12", "drop this TODO")
    const pending = [...store.collections.messages.values()].find(message => message.action?.flow === "todo.drop")!
    const revision = pending.action!.revision!
    const before = store.session().revision
    expect(await controller.cancelConfirmation(pending.id, "stale")).toMatchObject({ refusal: { code: "native_confirm_stale", status: 409 } })
    expect(store.collections.messages.get(pending.id)?.action).toEqual(pending.action)
    expect(store.session().revision).toBe(before)
    expect(await controller.commands.run("confirm.cancel", JSON.stringify({ confirmation: pending.id, revision: "stale" }))).toMatchObject({ status: "failed" })
    expect(store.collections.messages.get(pending.id)?.action).toEqual(pending.action)
    expect(await controller.commands.run("confirm.cancel", JSON.stringify({ confirmation: pending.id, revision }))).toMatchObject({ status: "executed" })
    expect(store.collections.messages.get(pending.id)?.action).toBeUndefined()
    expect(store.collections.messages.get(pending.id)?.answeredAction).toMatchObject({ revision, answer: "Cancelled" })
    expect(await controller.cancelConfirmation(pending.id, revision)).toMatchObject({ refusal: { code: "native_confirm_stale" } })
    expect(await controller.commands.run("confirm.cancel", JSON.stringify({ confirmation: pending.id, revision }))).toMatchObject({ status: "failed" })
    expect(await controller.cancelConfirmation("missing", revision)).toMatchObject({ refusal: { code: "native_confirm_stale" } })
    await store.dispatch({ type: "message.appended", actor: "system", text: "Old confirmation", action: { flow: "todo.drop", label: "Confirm" } }).isPersisted.promise
    const legacy = [...store.collections.messages.values()].find(message => message.text === "Old confirmation")!
    expect(await controller.cancelConfirmation(legacy.id, revision)).toMatchObject({ refusal: { code: "native_confirm_stale" } })
    expect(store.collections.messages.get(legacy.id)?.action).toEqual(legacy.action)
    const restored = await createAppStore({ kind: "localStorage", storage })
    expect(restored.collections.messages.get(pending.id)?.answeredAction?.answer).toBe("Cancelled")
    expect(restored.collections.messages.get(pending.id)?.action).toBeUndefined()
  } finally { controller.dispose() }
})

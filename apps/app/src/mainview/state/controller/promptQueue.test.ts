import { expect, test } from "bun:test"
import { scopedControllers } from "../ControllerTestScope"
import { createAppStore } from "../AppStore"
import { memoryStorage, silentAgent, settle, waitFor } from "../TestFixtures"

const createAppController = scopedControllers()

// Host FIFO, edit/remove/restore and own-turn Stop live in the mounted
// SharedConversationApp suite. The old browser steer/resume runner is gone.
// Retain the failure boundary when no shared admission provider is composed.
for (const state of ["signed-in", "signed-out"] as const) {
  test(`a ${state} queued prompt cannot launch the retired browser executor`, async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let starts = 0
    const controller = createAppController(store, { ...silentAgent, startTurn: async () => { starts++; return { status: "started" } } }, { toastDebounceMs: 0 })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state, login: state === "signed-in" ? "ben" : null, admin: false, scopesPlain: null }).isPersisted.promise
    controller.changeDraft("queued work")
    controller.enqueuePrompt("queued work")
    await waitFor(() => (store.session().queuedPrompts?.length ?? 0) === 1)
    await settle()
    expect(starts).toBe(0)
    expect(store.session().queuedPrompts?.[0]?.text).toBe("queued work")
    expect(controller.commands.find("chat.queue.resume")).toBeUndefined()
  })
}

import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

test("Review PRs opens the chosen signup repository after onboarding with several repos loaded", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, {
    fetchImpl: async () => Response.json({ message: "Not found" }, { status: 404 })
  })
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "roninjin10", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
      { id: "roninjin10/smithers", org: "roninjin10", ownerKind: "user", name: "smithers", head: null },
      { id: "roninjin10/plue", org: "roninjin10", ownerKind: "user", name: "plue", head: null },
      { id: "roninjin10/hello-world", org: "roninjin10", ownerKind: "user", name: "hello-world", head: null }
    ] }).isPersisted.promise
    controller.signupChange({ stage: "ready", repo: "roninjin10/smithers" })
    await controller.signupFinish()

    const outcome = await controller.commands.run("review.setup")
    expect(outcome.status).toBe("executed")
    const setup = [...store.collections.cards.values()].find(card => card.kind === "repository-setup" && card.payload.job === "review")
    expect(setup?.kind).toBe("repository-setup")
    if (setup?.kind === "repository-setup") expect(setup.payload.repo).toBe("roninjin10/smithers")
  } finally {
    await controller.dispose()
    await store.dispose?.()
  }
})

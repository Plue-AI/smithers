import { describe, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { resolveTargetRepo } from "../RepoContext"
import { SIGNUP_QUESTIONS } from "../Signup"
import { backend, memoryStorage, silentAgent } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createSignupController } from "./signup"

const boot = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return { store, controller: createSignupController(createControllerContext(store, silentAgent, backend({}))) }
}

describe("the signup controller", () => {
  test("the account step needs a name and a valid account, then opens the poll", async () => {
    const { store, controller } = await boot()
    controller.signupChange({ stage: "account" })
    expect(controller.signupAccount()).toBe("Type your full name.")
    controller.signupSet("name", "Ada Park")
    controller.signupSet("account", "a")
    expect(controller.signupAccount()).toBe("An account name is 2–39 lowercase letters, digits or hyphens.")
    controller.signupSet("account", "Ada Park")
    expect(controller.signupAccount()).toBeUndefined()
    expect(store.session().signup).toMatchObject({ stage: "poll", name: "Ada Park", account: "adapark", question: 0 })
    await store.dispose?.()
  })

  test("answers advance one question at a time, multi-select toggles, every question may be skipped, and the last answer readies the workspace", async () => {
    const { store, controller } = await boot()
    controller.signupChange({ stage: "poll", question: 0 })
    expect(SIGNUP_QUESTIONS.filter(question => question.required)).toEqual([])
    expect(controller.signupNext()).toBeUndefined()
    expect(store.session().signup?.question).toBe(1)
    controller.signupBack()
    expect(controller.signupAnswer("Huge")).toContain("Choose one of")
    controller.signupAnswer("2–10")
    expect(store.session().signup?.question).toBe(1)
    controller.signupBack()
    expect(store.session().signup?.question).toBe(0)
    controller.signupAnswer("2–10")
    controller.signupAnswer("Engineering")
    controller.signupNext() // heard: optional
    controller.signupAnswer("Yes")
    expect(SIGNUP_QUESTIONS[store.session().signup!.question]?.id).toBe("models")
    controller.signupAnswer("Claude")
    controller.signupAnswer("Codex")
    controller.signupAnswer("Claude")
    expect(store.session().signup?.answers.models).toEqual(["Codex"])
    controller.signupNext()
    controller.signupRepo("new")
    controller.signupSet("more", "  ship it ")
    controller.signupNext()
    expect(store.session().signup).toMatchObject({ stage: "ready", repo: "new", answers: { size: "2–10", role: "Engineering", know: "Yes", models: ["Codex"], repo: "new", more: "ship it" } })
    await controller.signupFinish()
    expect(store.session().signup?.stage).toBe("done")
    await store.dispose?.()
  })

  test("the chosen repository becomes the target of first-run repository doors", async () => {
    const { store, controller } = await boot()
    const repositories = ["roninjin10/smithers", "roninjin10/plue", "roninjin10/hello-world"].map(id => ({
      id, org: "roninjin10", ownerKind: "user" as const, name: id.split("/")[1]!, head: null
    }))
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories }).isPersisted.promise
    controller.signupChange({ stage: "ready", repo: "roninjin10/smithers" })
    expect(resolveTargetRepo(store, undefined)).toEqual({ error: expect.stringContaining("Several repositories") })

    await controller.signupFinish()
    expect(store.session().activeRepoKey).toBe("roninjin10/smithers")
    expect(resolveTargetRepo(store, undefined)).toEqual({ repo: "roninjin10/smithers" })
    expect(store.session().signup?.stage).toBe("done")
    await store.dispose?.()
  })

  test("finishing signup preserves an explicit target", async () => {
    const { store, controller } = await boot()
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
      { id: "roninjin10/smithers", org: "roninjin10", ownerKind: "user", name: "smithers", head: null },
      { id: "roninjin10/plue", org: "roninjin10", ownerKind: "user", name: "plue", head: null }
    ] }).isPersisted.promise
    await store.dispatch({ type: "repo.selected", actor: "user", id: "roninjin10/plue" }).isPersisted.promise
    controller.signupChange({ stage: "ready", repo: "roninjin10/smithers" })
    await controller.signupFinish()
    expect(store.session().activeRepoKey).toBe("roninjin10/plue")

    expect(store.session().signup?.repo).toBeUndefined()
    await store.dispose?.()
  })

  test("new or unavailable signup repositories do not become targets", async () => {
    for (const repo of ["new", "roninjin10/absent"]) {
      const { store, controller } = await boot()
      await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
        { id: "roninjin10/smithers", org: "roninjin10", ownerKind: "user", name: "smithers", head: null }
      ] }).isPersisted.promise
      controller.signupChange({ stage: "ready", repo })
      await controller.signupFinish()
      expect(store.session().activeRepoKey).toBeNull()
      expect(store.session().signup?.repo).toBe(repo === "new" ? undefined : repo)
      await store.dispose?.()
    }
  })

  test("a completed signup from an older session restores its chosen repo after inventory loads", async () => {
    const { store, controller } = await boot()
    controller.signupChange({ stage: "done", repo: "roninjin10/smithers" })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "roninjin10", admin: false, scopesPlain: null }).isPersisted.promise
    const rows = ["roninjin10/smithers", "roninjin10/plue"].map(id => ({
      id, org: "roninjin10", ownerKind: "user" as const, name: id.split("/")[1]!, head: null
    }))
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: rows }).isPersisted.promise
    expect(store.session().activeRepoKey).toBe("roninjin10/smithers")
    expect(store.session().signup?.repo).toBeUndefined()
    expect(resolveTargetRepo(store, undefined)).toEqual({ repo: "roninjin10/smithers" })
    await store.dispatch({ type: "repository.entry.changed", actor: "system", entry: {
      requestId: "later-navigation", repo: "roninjin10/plue", phase: "pending"
    } }).isPersisted.promise
    await store.dispatch({ type: "repository.entry.changed", actor: "system", entry: null }).isPersisted.promise
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: rows }).isPersisted.promise
    expect(store.session().activeRepoKey).toBeNull()
    await store.dispose?.()
  })

  test("legacy signup recovery waits for sign-in and preserves a later selection", async () => {
    const { store, controller } = await boot()
    controller.signupChange({ stage: "done", repo: "roninjin10/smithers" })
    const rows = ["roninjin10/smithers", "roninjin10/plue"].map(id => ({
      id, org: "roninjin10", ownerKind: "user" as const, name: id.split("/")[1]!, head: null
    }))
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: rows }).isPersisted.promise
    expect(store.session().activeRepoKey).toBeNull()
    expect(store.session().signup?.repo).toBe("roninjin10/smithers")
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "roninjin10", admin: false, scopesPlain: null }).isPersisted.promise
    expect(store.session().activeRepoKey).toBe("roninjin10/smithers")
    await store.dispatch({ type: "repo.selected", actor: "user", id: "roninjin10/plue" }).isPersisted.promise
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: rows }).isPersisted.promise
    expect(store.session().activeRepoKey).toBe("roninjin10/plue")
    expect(store.session().signup?.repo).toBeUndefined()
    await store.dispose?.()
  })

  test("an early empty inventory does not consume a legacy signup choice before its repo arrives", async () => {
    const { store, controller } = await boot()
    controller.signupChange({ stage: "done", repo: "roninjin10/smithers" })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "roninjin10", admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [] }).isPersisted.promise
    expect(store.session().activeRepoKey).toBeNull()
    expect(store.session().signup?.repo).toBe("roninjin10/smithers")
    await store.dispatch({ type: "repository.upserted", actor: "system", repository: {
      id: "roninjin10/smithers", org: "roninjin10", ownerKind: "user", name: "smithers", head: null
    } }).isPersisted.promise
    expect(store.session().activeRepoKey).toBe("roninjin10/smithers")
    expect(store.session().signup?.repo).toBeUndefined()
    await store.dispose?.()
  })
})

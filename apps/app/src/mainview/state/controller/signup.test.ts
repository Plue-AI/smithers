import { describe, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { resolveTargetRepo } from "../RepoContext"
import { openSignupQuestion } from "../Signup"
import { json, memoryStorage, silentAgent, waitFor } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createSignupController } from "./signup"

/** The backend's signup profile route: one saved document, and a switch that makes the store fail. */
const profileServer = (saved: unknown = null) => {
  const server = { saved, down: false, writes: [] as unknown[], reads: 0 }
  const unavailable = () => json(503, { code: "profile_unavailable", fault: "infra", message: "service unavailable" })
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "https://app.test")
    if (url.pathname !== "/api/user/settings/signup") return json(404, { status: "error" })
    if (init?.method === "PUT") {
      if (server.down) return unavailable()
      server.saved = JSON.parse(String(init.body))
      server.writes.push(server.saved)
      return json(200, { profile: server.saved, updated_at: "2026-09-30T00:00:00Z" })
    }
    server.reads += 1
    return server.down ? unavailable() : json(200, { profile: server.saved })
  }
  return { server, fetchImpl }
}

const boot = async (saved: unknown = null) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const { server, fetchImpl } = profileServer(saved)
  return { store, server, controller: createSignupController(createControllerContext(store, silentAgent, { fetchImpl })) }
}

const signIn = (store: Awaited<ReturnType<typeof createAppStore>>, login: string) =>
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, admin: false, scopesPlain: null }).isPersisted.promise

describe("the signup controller", () => {
  test("the account step needs a name and a valid account, then opens the poll", async () => {
    const { store, controller } = await boot()
    controller.signupChange({ stage: "account" })
    expect(await controller.signupAccount()).toBe("Type your full name.")
    controller.signupSet("name", "Ada Park")
    controller.signupSet("account", "a")
    expect(await controller.signupAccount()).toBe("An account name is 2–39 lowercase letters, digits or hyphens.")
    controller.signupSet("account", "Ada Park")
    expect(await controller.signupAccount()).toBeUndefined()
    expect(store.session().signup).toMatchObject({ stage: "poll", name: "Ada Park", account: "adapark", question: 0 })
    await store.dispose?.()
  })

  test("the account step opens the poll only after the server saves the claim; profile_unavailable keeps the typed input for a retry", async () => {
    const { store, server, controller } = await boot()
    controller.signupChange({ stage: "account" })
    controller.signupSet("name", "Ada Park")
    controller.signupSet("account", "adapark")
    server.down = true
    const refused = await controller.signupAccount()
    expect(refused).toStartWith("profile_unavailable — ")
    expect(store.session().signup).toMatchObject({ stage: "account", draft: { name: "Ada Park", account: "adapark" } })
    expect(store.session().signup?.name).toBeUndefined()
    expect(server.writes).toEqual([])

    server.down = false
    expect(await controller.signupAccount()).toBeUndefined()
    expect(server.writes).toEqual([{ name: "Ada Park", account: "adapark", stage: "poll", question: 0, answers: {} }])
    expect(store.session().signup).toMatchObject({ stage: "poll", name: "Ada Park", account: "adapark", question: 0 })
    await store.dispose?.()
  })

  test("a repository choice readies the workspace only after the server saves it; a refused save leaves the question open", async () => {
    const { store, server, controller } = await boot()
    controller.signupChange({ stage: "poll", name: "Ada Park", account: "adapark", question: 0 })
    server.down = true
    expect(await controller.signupRepo("adapark/hello")).toStartWith("profile_unavailable — ")
    expect(store.session().signup).toMatchObject({ stage: "poll", question: 0, answers: {} })
    expect(store.session().signup?.repo).toBeUndefined()

    server.down = false
    // Acts run one at a time: Skip reads the row the choice left, where no question is open.
    const [chosen, skipped] = await Promise.all([controller.signupRepo(" adapark/hello "), controller.signupNext()])
    expect([chosen, skipped]).toEqual([undefined, "No question is open."])
    expect(server.writes).toEqual([
      { name: "Ada Park", account: "adapark", stage: "ready", question: 0, answers: { repo: "adapark/hello" }, repo: "adapark/hello" }
    ])
    expect(store.session().signup).toMatchObject({ stage: "ready", repo: "adapark/hello", answers: { repo: "adapark/hello" } })
    await store.dispose?.()
  })

  test("signing in from a fresh browser restores a profile saved mid-way through the seven-question poll onto the repository question", async () => {
    const saved = { name: "Ada Park", account: "adapark", stage: "poll", question: 4, answers: { size: "2–10", role: "Engineering", know: "Yes" } }
    const { store, server, controller } = await boot(saved)
    expect(store.session().signup).toBeUndefined()
    await signIn(store, "ada-gh")
    await waitFor(() => store.session().signup?.stage === "poll")
    expect(store.session().signup).toMatchObject(saved)
    expect(store.session().signup?.draft).toEqual({})
    expect(openSignupQuestion(store.session().signup!).id).toBe("repo")
    expect(await controller.signupNext()).toBeUndefined()
    expect(store.session().signup?.stage).toBe("ready")
    expect(server.saved).toEqual({ ...saved, stage: "ready" })
    await store.dispose?.()
  })

  test("a claim made where the restore could not read keeps the saved answers", async () => {
    const saved = { name: "Ada Park", account: "adapark", stage: "poll", question: 2, answers: { size: "2–10", role: "Engineering" } }
    const { store, server, controller } = await boot(saved)
    server.down = true
    await signIn(store, "ada-gh")
    await waitFor(() => server.reads === 1)
    expect(store.session().signup).toMatchObject({ stage: "account", account: "ada-gh" })
    controller.signupSet("name", "Ada P")
    expect(await controller.signupAccount()).toStartWith("profile_unavailable — ")
    expect(store.session().signup?.stage).toBe("account")

    server.down = false
    expect(await controller.signupAccount()).toBeUndefined()
    expect(server.saved).toEqual({ ...saved, name: "Ada P", account: "ada-gh" })
    expect(store.session().signup).toMatchObject({ stage: "poll", question: 2, name: "Ada P", account: "ada-gh", answers: saved.answers })
    await store.dispose?.()
  })

  test("a person with no saved profile keeps the prefilled account step", async () => {
    const { store, server } = await boot()
    await signIn(store, "ada-gh")
    await waitFor(() => server.reads === 1)
    expect(store.session().signup).toMatchObject({ stage: "account", account: "ada-gh", draft: { account: "ada-gh" } })
    await store.dispose?.()
  })

  test("Skip or a repository choice readies the workspace from the one question; neither acts before the poll", async () => {
    const { store, controller } = await boot()
    controller.signupChange({ stage: "account", draft: { name: "Ada Park" } })
    expect(await controller.signupNext()).toBe("No question is open.")
    expect(await controller.signupRepo("roninjin10/smithers")).toBe("No question is open.")
    expect(store.session().signup).toMatchObject({ stage: "account", answers: {} })
    expect(store.session().signup?.repo).toBeUndefined()

    controller.signupChange({ stage: "poll" })
    expect(await controller.signupNext()).toBeUndefined()
    expect(store.session().signup).toMatchObject({ stage: "ready", answers: {} })
    expect(store.session().signup?.repo).toBeUndefined()

    // A row left at a later index by the seven-question poll still answers.
    controller.signupChange({ stage: "poll", question: 6 })
    expect(await controller.signupRepo("  roninjin10/smithers ")).toBeUndefined()
    expect(store.session().signup).toMatchObject({ stage: "ready", repo: "roninjin10/smithers", answers: { repo: "roninjin10/smithers" } })
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

  // `new` is the retired new-repo answer a row saved before 2026-10-01 may still hold; it reads as skipped.
  test("a legacy new answer or an unavailable signup repository does not become a target", async () => {
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

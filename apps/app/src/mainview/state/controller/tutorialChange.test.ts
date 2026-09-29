import { expect, test } from "bun:test"
import { CODING_PLAN } from "../../cards/fixtures/CodingPlan"
import { createAppStore } from "../AppStore"
import { StorageWriteFailedError } from "../StorageRecoveryContract"
import { presentAppFailure } from "./AppFailure"
import { formRenderedText } from "./forms"
import { scopedControllers } from "../ControllerTestScope"
import { json, loadBox, memoryStorage, silentAgent, waitFor } from "../TestFixtures"

/*
 * A plan card is scoped to the repository and the account OWNER that asked
 * for it. Window focus, a sibling tab and any 401 re-read the session; a
 * re-read naming the same owner is not an account change and must neither
 * discard a plan being drafted nor refuse to start a saved one.
 */
const createAppController = scopedControllers()
const repo = "owner/tutorial"
const plan = { ...CODING_PLAN, changes: [CODING_PLAN.changes[0]!] }

type Store = Awaited<ReturnType<typeof createAppStore>>
const fixture = async (box = true, wrap: (store: Store) => Store = store => store) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "owner", ownerKind: "user", name: "tutorial", head: null }] }).isPersisted.promise
  if (box) await loadBox(store, repo)
  let planned: () => Promise<Response> = async () => json(200, plan)
  let preflight: () => Promise<Response> = async () => json(503, { message: "The change service is unavailable." })
  let login = "owner"
  const posts: string[] = []
  const controller = createAppController(wrap(store), silentAgent, {
    fetchImpl: async (input) => {
      const path = new URL(String(input), "https://app.test").pathname
      if (path.endsWith("/api/user")) return json(200, { id: 1, username: login, is_admin: false })
      if (path.startsWith("/api/tutorial/change/")) {
        posts.push(path)
        // The start is proven admitted by reaching preflight; what follows is not under test.
        return path.endsWith("/plan") ? planned() : preflight()
      }
      return new Promise<Response>(() => {})
    }
  })
  const plans = () => [...store.collections.cards.values()].filter(card => card.kind === "run-trace" && card.payload.kind === "change-plan")
  return { store, controller, posts, plans,
    planned: (answer: () => Promise<Response>) => { planned = answer },
    preflight: (answer: () => Promise<Response>) => { preflight = answer },
    signIn: (next: string) => { login = next } }
}

test("a same-owner re-read while the plan is drafted still writes the plan card", async () => {
  const t = await fixture()
  let release!: (response: Response) => void
  t.planned(() => new Promise<Response>(resolve => { release = resolve }))
  const suggesting = t.controller.suggestTutorialChange(repo)
  await waitFor(() => t.posts.includes("/api/tutorial/change/plan"))
  await t.controller.loadSession()
  release(json(200, plan))
  expect(await suggesting).toEqual({ value: expect.stringContaining("Review the suggested feature") })
  expect(t.plans()).toHaveLength(1)
})

test("a saved plan still starts after same-owner re-reads", async () => {
  const t = await fixture()
  await t.controller.suggestTutorialChange(repo)
  const [card] = t.plans()
  await t.controller.loadSession()
  await t.controller.loadSession()
  expect(await t.controller.startTutorialChange(card!.id)).not.toBe("The repository or account changed; request a new plan.")
  expect(t.posts).toContain("/api/tutorial/change/preflight")
  const saved = t.store.collections.cards.get(card!.id)
  expect(saved?.kind === "run-trace" && saved.payload.input?.tutorialScope).toEqual({ repoKey: null, accountLogin: "owner" })
})

test("with no box, Start refuses on the plan card, keeps its door, and runs again once a box is open", async () => {
  const t = await fixture(false)
  await t.controller.suggestTutorialChange(repo)
  const [card] = t.plans()
  const refusal = `Open a box of ${repo} first: /box.open ${repo}`
  expect(await t.controller.startTutorialChange(card!.id)).toBe(refusal)
  expect(t.posts).not.toContain("/api/tutorial/change/preflight")
  const saved = t.store.collections.cards.get(card!.id)
  expect(saved?.status).toBe("active")
  expect(saved?.kind === "run-trace" && saved.payload.error).toBe(refusal)
  await loadBox(t.store, repo)
  await t.controller.startTutorialChange(card!.id)
  expect(t.posts).toContain("/api/tutorial/change/preflight")
})

test("a plan saved by another owner is refused after the account changes", async () => {
  const t = await fixture()
  await t.controller.suggestTutorialChange(repo)
  const [card] = t.plans()
  t.signIn("someone-else")
  await t.controller.loadSession()
  // The owner change erased the plan; a copy that survived elsewhere comes back.
  await t.store.dispatch({ type: "card.upsert", actor: "system", card: card! }).isPersisted.promise
  expect(await t.controller.startTutorialChange(card!.id)).toBe("The repository or account changed; request a new plan.")
  expect(t.posts).not.toContain("/api/tutorial/change/preflight")
})

const RAW = "TypeError: fetch failed at undici/lib/fetch.js:42"

test("an untagged planning failure answers the planning sentence, never its raw message", async () => {
  const t = await fixture()
  t.planned(async () => { throw new Error(RAW) })
  const answer = await t.controller.suggestTutorialChange(repo)
  expect(answer).toBe("The change could not be planned. Not your fault.")
  expect(t.plans()).toHaveLength(0)
})

test("a storage failure while saving the plan answers its registry sentence", async () => {
  const t = await fixture(true, store => new Proxy(store, { get: (target, key, receiver) => key === "dispatch"
    ? (transition: Parameters<typeof store.dispatch>[0]) => {
      if (transition.type === "card.upsert" && transition.card.kind === "run-trace") throw new StorageWriteFailedError()
      return target.dispatch(transition)
    } : Reflect.get(target, key, receiver) }))
  expect(await t.controller.suggestTutorialChange(repo)).toBe(presentAppFailure(new StorageWriteFailedError(), () => {}).sentence)
})

test("an untagged start failure puts the start sentence on the plan card, and a service refusal keeps its words", async () => {
  const t = await fixture()
  await t.controller.suggestTutorialChange(repo)
  const [card] = t.plans()
  t.preflight(async () => { throw new Error(RAW) })
  expect(await t.controller.startTutorialChange(card!.id)).toBe("The change could not be started. Not your fault.")
  const saved = t.store.collections.cards.get(card!.id)
  expect(saved?.kind === "run-trace" && saved.payload.error).toBe("The change could not be started. Not your fault.")
  t.preflight(async () => json(503, { message: "The change service is unavailable." }))
  expect(await t.controller.startTutorialChange(card!.id)).toBe("The change service is unavailable.")
})

test("with several boxes, Start renders the box pick before the plan is consumed, and Submit starts it once on the pick (#2475)", async () => {
  const t = await fixture(false)
  const boxA = "0b0c0d0e-0000-4000-8000-00000000000a", boxB = "0b0c0d0e-0000-4000-8000-00000000000b"
  await loadBox(t.store, repo, boxA)
  await loadBox(t.store, repo, boxB)
  await t.controller.suggestTutorialChange(repo)
  const [card] = t.plans()
  expect(await t.controller.commands.run("agent.change.start", card!.id)).toEqual({ status: "executed", value: formRenderedText(["workspaceId"]) })
  expect(t.store.collections.cards.get("form-box.select")).toMatchObject({ payload: { given: { repo, flow: "agent.change.start", args: card!.id } } })
  expect(t.store.collections.cards.get(card!.id)?.status).toBe("active")
  expect(t.posts).not.toContain("/api/tutorial/change/preflight")

  // The agent keeps the refusal on the card; the plan keeps its door.
  const agent = await t.controller.commands.runForAgent("agent.change.start", card!.id)
  expect(JSON.stringify(agent)).not.toContain("form-box.select")
  expect(t.posts).not.toContain("/api/tutorial/change/preflight")

  await t.controller.commands.run("form.set", `form-box.select workspaceId ${boxB}`)
  t.preflight(() => new Promise<Response>(() => {}))
  void t.controller.commands.run("form.submit", "form-box.select")
  await waitFor(() => t.posts.includes("/api/tutorial/change/preflight"))
  expect(t.store.session().activeRepoKey).toBe(`${repo}#workspace:${boxB}`)
  expect(t.store.collections.cards.get(card!.id)?.status).toBe("acted")
  expect((await t.controller.commands.run("form.submit", "form-box.select")).status).toBe("failed")
  expect(t.posts.filter(path => path.endsWith("/preflight"))).toHaveLength(1)
})

test("a plan made on another repository is not started by picking a box", async () => {
  const t = await fixture(false)
  await t.controller.suggestTutorialChange(repo)
  const [card] = t.plans()
  await t.store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
    { id: repo, org: "owner", ownerKind: "user", name: "tutorial", head: null },
    { id: "owner/other", org: "owner", ownerKind: "user", name: "other", head: null }] }).isPersisted.promise
  await loadBox(t.store, "owner/other")
  await t.store.dispatch({ type: "repo.selected", actor: "user", id: "owner/other#workspace:" + [...t.store.collections.cloudWorkspaces.keys()][0] }).isPersisted.promise
  expect(await t.controller.startTutorialChange(card!.id)).toBe("The repository or account changed; request a new plan.")
})

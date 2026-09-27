import { expect, test } from "bun:test"
import { CODING_PLAN } from "../../cards/fixtures/CodingPlan"
import { createAppStore } from "../AppStore"
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

const fixture = async (box = true) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "owner", ownerKind: "user", name: "tutorial", head: null }] }).isPersisted.promise
  if (box) await loadBox(store, repo)
  let planned: () => Promise<Response> = async () => json(200, plan)
  let login = "owner"
  const posts: string[] = []
  const controller = createAppController(store, silentAgent, {
    fetchImpl: async (input) => {
      const path = new URL(String(input), "https://app.test").pathname
      if (path.endsWith("/api/auth/session")) return json(200, { login, allowlisted: true, admin: false })
      if (path.startsWith("/api/tutorial/change/")) {
        posts.push(path)
        // The start is proven admitted by reaching preflight; what follows is not under test.
        return path.endsWith("/plan") ? planned() : json(503, { message: "The change service is unavailable." })
      }
      return new Promise<Response>(() => {})
    }
  })
  const plans = () => [...store.collections.cards.values()].filter(card => card.kind === "run-trace" && card.payload.kind === "change-plan")
  return { store, controller, posts, plans,
    planned: (answer: () => Promise<Response>) => { planned = answer },
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

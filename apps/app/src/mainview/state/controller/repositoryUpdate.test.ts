import { expect,test } from "bun:test"
import { CardSchema } from "../AppState"
import { createAppStore } from "../AppStore"
import { projectRepositoryUpdate } from "../CardProjection"
import { readRepositoryDetail } from "../RepositoryReadReceipts"
import { memoryStorage, repositoryHttpFixture } from "../TestFixtures"
const REPO = "owner/repo"
import { createIssuesSeam } from "../seams/IssuesSeam"
import { createLandingsSeam } from "../seams/LandingsSeam"
import type { SeamContext } from "../seams/SeamContext"
import { createRepositoryUpdate } from "./repositoryUpdate"
async function setup(storage = memoryStorage(), http: SeamContext["http"] = repositoryHttpFixture()) {
  const store = await createAppStore({ kind: "localStorage", storage })
  const ctx: SeamContext = { store, dispatch: store.dispatch, actor: () => "user", nextOrdinal: () => 1, baseUrl: "", http }
  return { store, ctx, actions: createRepositoryUpdate(ctx), storage }
}
test("repository update receipts survive reload; refresh preserves unread items and read is version-specific", async () => {
  const { store, actions, storage } = await setup()
  expect(await actions.showRepoOverview(REPO)).toEqual({ value: expect.stringContaining("2 issue updates, 1 PR update") })
  const first = [...store.collections.cards.values()].find(card => card.kind === "repo-update")!
  if (first.kind !== "repo-update") throw Error("missing update")
  expect(first.payload.items).toHaveLength(3)
  const restored = await setup(storage)
  expect(await restored.actions.showRepoOverview(REPO)).toEqual({ value: expect.stringContaining("No new issue or PR updates") })
  let card = restored.store.collections.cards.get(first.id)!
  if (card.kind !== "repo-update") throw Error("missing update")
  expect(card.payload.items).toHaveLength(3)
  await restored.actions.tagNotification(card.payload.items[0]!.id, "follow-up")
  expect(restored.store.collections.repositoryNotifications.get(card.payload.items[0]!.id)?.tags).toContain("follow-up")
  await restored.actions.markUpdateRead(card.id)
  await restored.actions.showRepoOverview(REPO)
  card = restored.store.collections.cards.get(first.id)!
  expect(card.kind === "repo-update" && card.payload.items).toEqual([])
  const row = [...restored.store.collections.repositoryNotifications.values()][0]!
  await restored.store.dispatch({ type: "notifications.read", actor: "user", receipts: [{ id: row.id, version: "stale-version" }] }).isPersisted.promise
  expect(restored.store.collections.repositoryNotifications.get(row.id)?.readVersion).not.toBe("stale-version")
})
test("failed sources are a partial update, never an empty successful check", async () => {
  const { store, actions } = await setup(memoryStorage(), async () => Response.json({ message: "Unavailable" }, { status: 503 }))
  const result = await actions.showRepoOverview("org/repo")
  expect(result).toEqual({ value: expect.stringContaining("could not be checked") })
  const card = [...store.collections.cards.values()].find(card => card.kind === "repo-update")!
  expect(card.kind === "repo-update" && card.payload.openIssues).toBeNull()
  expect(store.collections.repositoryNotifications.size).toBe(0)
})


test("background reads persist observations without announcing or displaying them", async () => {
  const { store, actions, storage } = await setup()
  const result = await actions.updateRepo(REPO)
  expect(typeof result).toBe("object")
  const data = JSON.parse((result as { value: string }).value)
  expect(data).toMatchObject({ repo: REPO, openIssues: 2, openPrs: 1, problems: [] })
  expect(data.items.some((item: { number: number; kind: string }) => item.kind === "issue" && item.number === 3)).toBe(true)
  expect(store.collections.cards.size).toBe(0)
  expect(store.collections.messages.size).toBe(0)
  expect([...store.collections.repositoryNotifications.values()].every(row => row.announcedVersion === undefined)).toBe(true)
  const restored = await setup(storage)
  expect([...restored.store.collections.repositoryContexts.values()][0]?.data).toEqual(data)
  await restored.actions.showRepoOverview(REPO)
  const overview = [...restored.store.collections.cards.values()][0]
  expect(overview?.kind === "repo-update" && overview.payload.items).toHaveLength(3)
  await restored.actions.updateRepo(REPO)
  expect([...restored.store.collections.cards.values()]).toEqual([overview])
})

test("startup's repository read discards its pending result once its controller closes", async () => {
  const { store, ctx } = await setup()
  let disposed = false
  const actions = createRepositoryUpdate(ctx, () => disposed)
  const before = store.session().revision
  const pending = actions.updateRepo(REPO)
  disposed = true
  await store.dispose?.()
  expect(await pending).toBe("The controller is closed.")
  expect(store.session().revision).toBe(before)
  expect(store.collections.repositoryContexts.size).toBe(0)
  expect(store.collections.repositoryNotifications.size).toBe(0)
  expect(await actions.updateRepo(REPO)).toBe("The controller is closed.")
})


test("successful issue and PR navigation marks their exact versions read, including Back and reload", async () => {
  const { store, ctx, actions, storage } = await setup()
  await actions.showRepoOverview(REPO)
  const overview = [...store.collections.cards.values()][0]!
  await createIssuesSeam(ctx).viewIssue(3, REPO)
  const issue = [...store.collections.repositoryNotifications.values()].find(row => row.kind === "issue" && row.number === 3)!
  expect(issue.readVersion).toBe(issue.version)
  await store.dispatch({ type: "card.history.moved", actor: "user", id: overview.id, delta: -1 }).isPersisted.promise
  const saved = store.collections.cards.get(overview.id)
  const returned = saved?.kind === "repo-update" ? projectRepositoryUpdate(saved, [...store.collections.repositoryNotifications.values()], [...store.collections.notificationReceipts.values()]) : saved
  expect(returned?.kind === "repo-update" && returned.payload.items.find(item => item.number === 3)?.read).toBe(true)
  expect(returned?.kind === "repo-update" && returned.payload.items.find(item => item.number === 2)?.read).toBe(false)
  await createLandingsSeam(ctx).viewLanding(4, REPO)
  const pr = [...store.collections.repositoryNotifications.values()].find(row => row.kind === "pr" && row.number === 4)!
  expect(pr.readVersion).toBe(pr.version)
  const restored = await setup(storage)
  await restored.store.dispatch({ type: "card.history.moved", actor: "user", id: overview.id, delta: -1 }).isPersisted.promise
  const restoredCard = restored.store.collections.cards.get(overview.id)
  const persisted = restoredCard?.kind === "repo-update" ? projectRepositoryUpdate(restoredCard, [...restored.store.collections.repositoryNotifications.values()], [...restored.store.collections.notificationReceipts.values()]) : restoredCard
  expect(persisted?.kind === "repo-update" && persisted.payload.items.find(item => item.number === 4)?.read).toBe(true)
})

const issueResponse = (updatedAt: string) => ({ number: 3, title: "Hello bug", state: "open", updated_at: updatedAt, body: "details", user: { login: "tester" } })

test("failed detail reads do not consume a matching repository notification", async () => {
  const { store, ctx, actions } = await setup(memoryStorage(), async url => {
    if (url.includes("/issues?state=open")) return Response.json([issueResponse("2026-09-13T00:00:00Z")])
    if (url.endsWith("/issues/3")) return Response.json({ message: "Unavailable" }, { status: 503 })
    return Response.json([])
  })
  await actions.showRepoOverview("org/repo")
  const overview = [...store.collections.cards.values()].find(card => card.kind === "repo-update")!
  const line = "Loading issue #3 in org/repo failed (503). Something on Smithers' side failed. Not your fault, and nothing your request could have changed."
  const error = await createIssuesSeam(ctx).viewIssue(3, "org/repo")
  expect(error).toBe(line)
  expect(error).not.toContain("Unavailable")
  const row = [...store.collections.repositoryNotifications.values()][0]!
  expect(row.readVersion).toBeUndefined()
  expect([...store.collections.notificationReceipts.values()]).toEqual([])
  // The attempted view owns its honest error location; Back retains the unread overview.
  expect(store.collections.cards.get(overview.id)).toMatchObject({ kind: "status", status: "error", loading: false, body: line })
  const history = store.collections.cardHistories.get(overview.id)!
  expect(history.entries.find(card => card.kind === "repo-update")).toMatchObject(CardSchema.parse(overview))
  await store.dispatch({ type: "card.history.moved", actor: "user", id: overview.id, delta: -1 }).isPersisted.promise
  const restored = store.collections.cards.get(overview.id)!
  expect(restored.kind === "repo-update" && projectRepositoryUpdate(restored, [...store.collections.repositoryNotifications.values()], [...store.collections.notificationReceipts.values()]).payload.items[0]?.read).toBe(false)
})

test("a new notification version arriving during a slow detail read remains unread", async () => {
  let updatedAt = "2026-09-13T00:00:00Z"
  let finish: (value: Response) => void = () => {}
  const response = new Promise<Response>(resolve => { finish = resolve })
  const { store, ctx, actions } = await setup(memoryStorage(), async url => {
    if (url.includes("/issues?state=open")) return Response.json([issueResponse(updatedAt)])
    if (url.endsWith("/issues/3")) return response
    return Response.json([])
  })
  await actions.showRepoOverview("org/repo")
  const detail = createIssuesSeam(ctx).viewIssue(3, "org/repo")
  updatedAt = "2026-09-13T01:00:00Z"
  await actions.showRepoOverview("org/repo")
  finish(Response.json(issueResponse("2026-09-13T00:00:00Z")))
  await detail
  const row = [...store.collections.repositoryNotifications.values()][0]!
  expect(row.updatedAt).toBe(updatedAt)
  expect(row.readVersion).not.toBe(row.version)
  const overview = [...store.collections.cardHistories.values()][0]!.entries.find(card => card.kind === "repo-update")
  expect(overview?.kind === "repo-update" && overview.payload.items[0]?.read).toBe(false)
})

test("read receipts stay isolated by repository, account, and source", async () => {
  const { ctx, store, actions } = await setup(memoryStorage(), async url =>
    Response.json(url.includes("/issues?state=open") || url.includes("github-repos/") ? [issueResponse("2026-09-13T00:00:00Z")] : []))
  await actions.showRepoOverview("org/repo")
  await actions.showRepoOverview("else/repo")
  await readRepositoryDetail(ctx, "org/repo", "issue", 3, async () => ({ value: "Loaded Smithers detail" }))
  const rows = [...store.collections.repositoryNotifications.values()]
  expect(rows.filter(row => row.readVersion === row.version).map(row => [row.repo, row.source])).toEqual([["org/repo", "smithers"]])
  await readRepositoryDetail(ctx, "else/repo", "issue", 3, async () => {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "another-user", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    return { value: "Loaded before account change" }
  })
  expect([...store.collections.repositoryNotifications.values()].filter(row => row.repo === "else/repo").every(row => row.readVersion === undefined)).toBe(true)
})

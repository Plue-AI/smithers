import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { createAppController } from "../AppController"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import { memoryStorage, settle, signupProfileFetch, silentAgent, waitFor } from "../TestFixtures"
import { installFixture } from "./InstallFixtures.test-support"

/*
 * An install's issues (J2 1 and 2, T-STK-09): /issues, /issue #n and the
 * issues flows read the install's own routes, GET /api/issues and
 * /api/issues/{n}, which serve the repository's GitHub issues through the
 * install's App. They never read Smithers Cloud's tracker or a person's
 * GitHub source. The cards are the GitHub issue cards, and Make TODO on the
 * card drafts from what the install read and commits it with its digest.
 */
const REPO = "local-owner/demo"
const githubIssue = (number: number, title: string, body: string, login: string) => ({
  number, title, body, state: "open", html_url: `https://github.com/${REPO}/issues/${number}`, user: { login },
  labels: [{ name: "bug", color: "d73a4a" }], assignees: [], comments: 1, created_at: "2026-10-05T09:00:00Z", updated_at: "2026-10-05T10:00:00Z"
})

/** An install's app signed in as alice; the owner's app loads the repository, a member's loads none (GET /api/user/repos is empty). */
const installApp = async ({ loaded = true } = {}) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
  if (loaded) await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: REPO, org: "local-owner", ownerKind: "user", name: "demo", head: null }] }).isPersisted.promise
  const install = { ...installFixture(), repository: { owner: "local-owner", name: "demo" }, repositories: [REPO] }
  const calls: string[] = []
  const posts: Array<{ path: string; body: unknown }> = []
  const answer = (path: string, search: string): Response => {
    if (path === "/api/issues") return Response.json(new URLSearchParams(search).get("state") === "closed" ? []
      : [githubIssue(2, "Say goodbye", "JOURNEY.md should end with a farewell.", "ben"), githubIssue(1, "Retry webhooks", "They drop on 502.", "ben")])
    if (path === "/api/issues/2") return Response.json({ issue: githubIssue(2, "Say goodbye", "JOURNEY.md should end with a farewell.", "ben"),
      comments: [{ id: 5, body: "Keep it short.", user: { login: "carol" }, created_at: "2026-10-05T11:00:00Z" }] })
    if (path === "/api/issues/9") return Response.json({ code: "not_found", class: "user", message: "Issue #9 was not found" }, { status: 404 })
    if (path === "/api/todos") return Response.json({ state: "accepted", n: 4, rev: 1 }, { status: 202 })
    if (path === "/api/install" && !loaded) return Response.json(install)
    return new Response("", { status: 404 })
  }
  const controller = createAppController(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", authFlow: "redirect", sandbox: null, capabilities: ["identity", "install"] },
    fetchImpl: signupProfileFetch(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), "https://app.test")
      const method = init?.method ?? "GET"
      calls.push(`${method} ${url.pathname}${url.search}`)
      if (method === "POST") posts.push({ path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : null })
      return answer(url.pathname, url.search)
    }).fetchImpl
  })
  return { store, controller, calls, posts }
}

const cardOf = <K extends Card["kind"]>(cards: Iterable<Card>, id: string, kind: K): Extract<Card, { kind: K }> => {
  const card = [...cards].find(row => row.id === id)
  if (card?.kind !== kind) throw new Error(`Expected ${kind} card ${id}, got ${card?.kind ?? "nothing"}`)
  return card as Extract<Card, { kind: K }>
}

test("/issues and /issue #n read the install's GitHub issues, with comments, from its own routes", async () => {
  const { store, controller, calls } = await installApp()
  try {
    expect(await controller.runCommandForResult("issues", "")).toMatchObject({ status: "executed" })
    const list = cardOf(store.collections.cards.values(), `issues-${REPO}`, "issue-list")
    expect(list.payload.issues.map(row => [row.number, row.title, row.source, row.author])).toEqual([[2, "Say goodbye", "github", "ben"], [1, "Retry webhooks", "github", "ben"]])
    expect(list.payload.github).toBeUndefined()

    expect(await controller.runCommandForResult("issue", "#2")).toMatchObject({ status: "executed" })
    // The detail opens in the list's place, with the list in its history.
    const detail = cardOf(store.collections.cards.values(), `issues-${REPO}`, "issue")
    expect(detail.payload).toMatchObject({ repo: REPO, number: 2, source: "github", title: "Say goodbye", issueBody: "JOURNEY.md should end with a farewell.",
      author: "ben", state: "open", labels: ["bug"], htmlUrl: `https://github.com/${REPO}/issues/2`,
      comments: [{ author: "carol", commentBody: "Keep it short.", createdAt: "2026-10-05T11:00:00Z" }] })

    // The list row's door and an unqualified issues.view open the same GitHub card.
    expect(await controller.runCommandForResult("issues.view", `2 ${REPO}`)).toMatchObject({ status: "executed" })
    expect(await controller.runCommandForResult("issues.list", `closed ${REPO}`)).toMatchObject({ status: "executed" })
    expect(cardOf(store.collections.cards.values(), `issues-${REPO}`, "issue-list").payload.issues).toEqual([])
    expect(await controller.runCommandForResult("issue", "#9")).toEqual({ status: "failed", error: "Issue #9 was not found" })

    const reads = calls.filter(call => call.includes("issues"))
    expect(reads).toEqual(["GET /api/issues?state=open", "GET /api/issues/2", "GET /api/issues/2", "GET /api/issues?state=closed", "GET /api/issues/9"])
    expect(calls.some(call => call.includes("/api/repos/") && call.includes("issues") || call.includes("/github-repos/"))).toBe(false)
  } finally { await controller.dispose() }
})

test("Make TODO on an install's issue card drafts the issue and its discussion and commits it with its digest", async () => {
  const { store, controller, posts } = await installApp()
  try {
    expect(await controller.runCommandForResult("issue", "#2")).toMatchObject({ status: "executed" })
    expect(cardOf(store.collections.cards.values(), `issue-github-${REPO}-2`, "issue").payload.comments).toHaveLength(1)
    // The card's Make TODO button runs todo.from-issue with the card's number and repository.
    expect(await controller.runCommandForResult("todo.from-issue", `2 ${REPO}`)).toEqual({ status: "executed", value: "Drafted" })
    const draft = [...store.collections.cards.values()].find(card => card.kind === "draft")
    if (draft?.kind !== "draft") throw new Error("no Draft")
    expect(draft.audience_member_id).toBe("alice")
    expect(draft.payload).toMatchObject({ title: "Say goodbye", prompt: "JOURNEY.md should end with a farewell.\n\n@carol:\n> Keep it short.",
      issue: { number: 2, url: `https://github.com/${REPO}/issues/2`, fixes: true } })
    expect(await controller.runCommandForResult("todo.new", JSON.stringify({ cardId: draft.id }))).toEqual({ status: "executed", value: "Requested" })
    await waitFor(() => posts.some(post => post.path === "/api/todos"))
    const digest = createHash("sha256").update("Say goodbye\0JOURNEY.md should end with a farewell.").digest("hex")
    expect(posts.find(post => post.path === "/api/todos")?.body).toMatchObject({ title: "Say goodbye", issue: 2, fixes: true, issue_digest: digest, place: { mode: "append" } })
  } finally { await controller.dispose() }
})

test("a member's app, which loads no repository, lists and opens the install repository's issues", async () => {
  const { store, controller, calls } = await installApp({ loaded: false })
  try {
    await waitFor(() => calls.includes("GET /api/install"))
    expect([...store.collections.repositories.values()]).toEqual([])
    await settle()
    expect(await controller.runCommandForResult("issues", "")).toMatchObject({ status: "executed" })
    expect(cardOf(store.collections.cards.values(), `issues-${REPO}`, "issue-list").payload.issues.map(row => row.number)).toEqual([2, 1])
    expect(await controller.runCommandForResult("issue", "#2")).toMatchObject({ status: "executed" })
    expect(cardOf(store.collections.cards.values(), `issues-${REPO}`, "issue").payload).toMatchObject({ repo: REPO, number: 2, source: "github" })
    expect(calls.filter(call => call.includes("issues"))).toEqual(["GET /api/issues?state=open", "GET /api/issues/2"])
  } finally { await controller.dispose() }
})

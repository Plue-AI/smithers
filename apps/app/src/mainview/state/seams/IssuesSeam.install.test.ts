import { expect, test } from "bun:test"
import { LiveChannel, type LiveSocket } from "../../runtime/LiveChannel"
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
const installApp = async ({ loaded = true, allowed = true, channel = undefined as LiveChannel | undefined, outsider = false } = {}) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
  if (loaded) await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: REPO, org: "local-owner", ownerKind: "user", name: "demo", head: null }] }).isPersisted.promise
  const install = { ...installFixture(), repository: { owner: "local-owner", name: "demo" }, repositories: [REPO] }
  let readFailure = false
  let digest = "a".repeat(64)
  const calls: string[] = []
  const posts: Array<{ path: string; body: unknown }> = []
  const listeners = new Map<string, Set<() => void>>()
  const answer = (path: string, search: string): Response => {
    if (path === "/api/issues") return Response.json(new URLSearchParams(search).get("state") === "closed" ? []
      : [githubIssue(2, "Say goodbye", "JOURNEY.md should end with a farewell.", "ben"), githubIssue(1, "Retry webhooks", "They drop on 502.", "ben")])
    if (path === "/api/issues/2" && readFailure) return new Response("", {status:503})
    if (path === "/api/issues/2") return Response.json({ issue_digest: digest, make_todo_allowed: allowed, issue: githubIssue(2, "Say goodbye", "JOURNEY.md should end with a farewell.", outsider ? "carol" : "ben"),
      comments: [{ id: 5, body: "Keep it short.", user: { login: "carol" }, created_at: "2026-10-05T11:00:00Z" }] })
    if (path === "/api/issues/9") return Response.json({ code: "not_found", class: "user", message: "Issue #9 was not found" }, { status: 404 })
    if (path === "/api/todos") return Response.json({ state: "accepted", n: 4, rev: 1 }, { status: 202 })
    if (path === "/api/install" && !loaded) return Response.json(install)
    return new Response("", { status: 404 })
  }
  const controller = createAppController(store, silentAgent, {
    live: channel ?? { subscribe: (topic, receive) => { const rows = listeners.get(topic) ?? new Set<() => void>(); rows.add(receive); listeners.set(topic, rows); return () => { rows.delete(receive) } }, getSnapshot: () => undefined },
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", authFlow: "redirect", sandbox: null, capabilities: ["identity", "install"] },
    fetchImpl: signupProfileFetch(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), "https://app.test")
      const method = init?.method ?? "GET"
      calls.push(`${method} ${url.pathname}${url.search}`)
      if (method === "POST") posts.push({ path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : null })
      return answer(url.pathname, url.search)
    }).fetchImpl
  })
  return { store, controller, calls, posts, setAllowed: (value: boolean) => { allowed = value }, setReadFailure: (value: boolean) => { readFailure = value }, setDigest: (value: string) => { digest = value } }
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
    const digest = "a".repeat(64)
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


test("an install refuses a Member draft from outsider text before writing any Draft", async () => {
  const { store, controller, posts } = await installApp({ allowed: false })
  try {
    await controller.runCommandForResult("issue", "#2")
    expect(await controller.runCommandForResult("todo.from-issue", `2 ${REPO}`)).toEqual({ status: "failed", error: "Only a maintainer can make a TODO from this issue." })
    const agent = await controller.commands.runAsAgent("todo.from-issue", `2 ${REPO}`).then(outcome => JSON.stringify(outcome))
    expect(agent).toContain("Only a maintainer")
    expect([...store.collections.cards.values()].filter(card => card.kind === "confirm")).toHaveLength(0)
    expect([...store.collections.cards.values()].filter(card => card.kind === "draft")).toHaveLength(0)
    expect(posts.filter(post => post.path === "/api/todos")).toHaveLength(0)
  } finally { await controller.dispose() }
})

test("a server demotion after reading refuses confirmation and Draft without any live event", async () => {
 const {store,controller,setAllowed,posts} = await installApp()
 try {
  expect(await controller.runCommandForResult("issue", "#2")).toMatchObject({status:"executed"})
  const issue = cardOf(store.collections.cards.values(), `issue-github-${REPO}-2`, "issue")
  expect(issue.payload.makeTodoAllowed).toBe(true)
  setAllowed(false)
  const agent = await controller.commands.runAsAgent("todo.from-issue", `2 ${REPO}`).then(outcome => JSON.stringify(outcome))
  expect(agent).not.toContain("asked the user to confirm")
  expect(agent).toContain("Only a maintainer")
  expect(await controller.runCommandForResult("todo.from-issue", `2 ${REPO}`)).toMatchObject({status:"failed"})
  expect([...store.collections.cards.values()].some(card => card.kind === "draft" || card.kind === "confirm")).toBe(false)
  expect(posts).toEqual([])
  // Restoring server permission permits drafting again.
  setAllowed(true)
  expect(await controller.runCommandForResult("issue", "#2")).toMatchObject({status:"executed"})
  expect(await controller.runCommandForResult("todo.from-issue", `2 ${REPO}`)).toMatchObject({status:"executed",value:"Drafted"})
 } finally {await controller.dispose()}
})

for (const loss of ["disconnect", "gap", "other-topic gap"] as const) test(`live ${loss} invalidates an outsider issue when the maintainer is demoted offline`, async () => {
  const socket: LiveSocket = { readyState: 1, onopen: null, onclose: null, onmessage: null, send() {}, close() {} }
  const channel = new LiveChannel({ socket: () => socket, schedule: () => 1, cancel() {} })
  const { store, controller, posts, setAllowed } = await installApp({ channel, outsider: true })
  try {
    const releaseOther = channel.subscribe("home", () => {})
    socket.onopen?.()
    // Deliver the members cursor before the authorized read.
    socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: 1, cursor: 1, data: [] }) })
    await controller.runCommandForResult("issue", "#2")
    expect(cardOf(store.collections.cards.values(), `issue-github-${REPO}-2`, "issue").payload.makeTodoAllowed).toBe(true)
    if (loss === "disconnect") socket.onclose?.()
    else socket.onmessage?.({ data: JSON.stringify({ t: "gap", id: loss === "gap" ? 1 : 2 }) })
    setAllowed(false) // Demotion elsewhere cannot deliver a roster notification.
    const agent = await controller.commands.runAsAgent("todo.from-issue", `2 ${REPO}`).then(outcome => JSON.stringify(outcome))
    expect(agent).not.toContain("asked the user to confirm")
    expect(await controller.runCommandForResult("todo.from-issue", `2 ${REPO}`)).toMatchObject({ status: "failed" })
    expect([...store.collections.cards.values()].some(card => card.kind === "draft" || card.kind === "confirm")).toBe(false)
    expect(posts).toEqual([])
    // A live snapshot alone does not reauthorize the retained issue.
    socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: 1, cursor: 2, data: [] }) })
    expect(await controller.runCommandForResult("todo.from-issue", `2 ${REPO}`)).toMatchObject({ status: "failed" })
    releaseOther()
    await controller.runCommandForResult("issue", "#2")
    expect(await controller.runCommandForResult("todo.from-issue", `2 ${REPO}`)).toMatchObject({ status: "failed" })
    setAllowed(true)
    await controller.runCommandForResult("issue", "#2")
    expect(await controller.runCommandForResult("todo.from-issue", `2 ${REPO}`)).toMatchObject({ status: "executed", value: "Drafted" })
  } finally { await controller.dispose(); channel.dispose() }
})

for (const command of ["todo.from-issue", "issue.implement"]) test(`${command} refuses a failed preflight read and uses the current digest on recovery`, async () => {
  const {store,controller,posts,setReadFailure,setDigest} = await installApp()
  try {
    await controller.runCommandForResult("issue", "#2")
    setReadFailure(true)
    const agent = await controller.commands.runAsAgent(command, `2 ${REPO}`).then(outcome => JSON.stringify(outcome))
    expect(agent).not.toContain("asked the user to confirm")
    expect(await controller.runCommandForResult(command, `2 ${REPO}`)).toMatchObject({status:"failed"})
    expect([...store.collections.cards.values()].some(card => card.kind === "draft" || card.kind === "confirm")).toBe(false)
    setReadFailure(false)
    setDigest("b".repeat(64))
    expect(await controller.runCommandForResult(command, `2 ${REPO}`)).toMatchObject({status:"executed",value:"Drafted"})
    const draft = [...store.collections.cards.values()].find(card => card.kind === "draft")
    if (!draft) throw Error("no Draft")
    await controller.runCommandForResult("todo.new", JSON.stringify({cardId:draft.id}))
    await waitFor(() => posts.some(post => post.path === "/api/todos"))
    expect(posts.find(post => post.path === "/api/todos")?.body).toMatchObject({issue_digest:"b".repeat(64)})
  } finally {await controller.dispose()}
})

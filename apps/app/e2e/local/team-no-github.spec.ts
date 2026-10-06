import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { README } from "./demo-repository"

// J1 step 8, then J2 and J4 as Ben (Maintainer) and Alice (Member), on the install setup-no-github.spec.ts set up.
// Every request the install answers 401 or 403 is recorded by person; a member's path must have none beyond the
// refusals their role calls for (a Member's merge and Add).
const output = "test-results/local-no-github"
const app = "http://localhost:4000"
type Who = "owner" | "ben" | "alice"
type Seen = { who: Who; method: string; path: string; status: number; code?: string }
let run: { setupURL: string; fakeURL: string; home: string; modelOrigin: string; modelKey: string }
// A failed test restarts the worker, so the record is a file every worker appends to, and a person signs in again.
const record = `${output}/team-requests.jsonl`
const note = (row: Seen | { aborted: string }) => appendFileSync(record, JSON.stringify(row) + "\n", { mode: 0o600 })
const recorded = () => existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []
const people = new Map<Who, { context: BrowserContext; page: Page }>()
/** A Member may not merge or manage people; the install refuses those by role, and the card offers neither. */
const byRole = (s: Seen) => s.who === "alice" && s.status === 403 && s.code === "permission" &&
  (/^\/api\/todos\/\d+\/merge$/.test(s.path) || s.path.startsWith("/api/members"))

const fake = async (path: string, body: unknown) => {
  const response = await fetch(`${run.fakeURL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  expect(response.status, path).toBeLessThan(300)
  return response.status === 204 ? undefined : response.json()
}
/** Opens the install's address in a fresh browser and signs in with GitHub as who. */
const signIn = async (browser: Browser, who: Who) => {
  const context = await browser.newContext()
  await context.route(/^https?:\/\//, async route => {
    const origin = new URL(route.request().url()).origin
    if (["http://localhost:4000", "http://127.0.0.1:4000", run.fakeURL, run.modelOrigin].includes(origin)) return route.continue()
    // People's avatars are images on github.com, never GitHub API calls.
    if (/^https:\/\/github\.com\/[a-z\d-]+\.png$/i.test(route.request().url())) return route.fulfill({ status: 404 })
    note({ aborted: `${who} ${route.request().method()} ${origin}${new URL(route.request().url()).pathname}` })
    await route.abort()
  })
  const page = await context.newPage()
  page.on("response", async response => {
    const url = new URL(response.url())
    if (url.origin !== app || !url.pathname.startsWith("/api/")) return
    const row: Seen = { who, method: response.request().method(), path: url.pathname, status: response.status() }
    if (row.status === 401 || row.status === 403) try { row.code = (await response.json()).code } catch { row.code = "unreadable" }
    note(row)
  })
  page.on("websocket", socket => {
    const path = new URL(socket.url()).pathname
    note({ who, method: "WS", path, status: 101 })
    // The handshake's status is in the error; a 404 (no live channel served) answers the owner alike.
    socket.on("socketerror", error => note({ who, method: "WS", path, status: Number(/response code: (\d+)/.exec(error)?.[1] ?? 0), code: error }))
  })
  await page.goto(`${app}/api/auth/github`)
  await page.getByRole("link", { name: who === "owner" ? "Authorize" : `Authorize as ${who}`, exact: true }).click()
  await page.waitForURL(url => url.origin === app && !url.pathname.startsWith("/api/"))
  await expect(page.getByTestId("composer-input")).toBeAttached({ timeout: 15_000 })
  people.set(who, { context, page })
  return page
}
/** who's page, signed in again when an earlier failure restarted the worker. */
const person = async (browser: Browser, who: Who) => people.get(who)?.page ?? signIn(browser, who)
const say = async (page: Page, text: string) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill(text)
  await input.press("Enter")
}
const members = (page: Page) => page.getByRole("region", { name: "Members", exact: true }).last()
const todos = async (page: Page) => {
  const response = await page.request.get(`${app}/api/todos`)
  expect(response.status()).toBe(200)
  return (await response.json()) as { n: number; state: string; title: string }[] | { todos: { n: number; state: string; title: string }[] }
}
const list = (body: Awaited<ReturnType<typeof todos>>) => Array.isArray(body) ? body : body.todos
const commitTodo = async (page: Page, title: string) => {
  await say(page, "/todo.new")
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await draft.getByLabel("Title", { exact: true }).fill(title)
  await draft.getByLabel("Prompt", { exact: true }).fill(`${title} in JOURNEY.md`)
  await draft.getByRole("combobox", { name: "Place", exact: true }).selectOption({ label: "Append" })
  await draft.getByRole("button", { name: "Commit", exact: true }).click()
  await expect.poll(async () => list(await todos(page)).some(todo => todo.title === title), { timeout: 10_000 }).toBe(true)
}

test.beforeAll(async () => {
  run = JSON.parse(readFileSync(`${output}/run.json`, "utf8"))
  // GitHub: Ben maintains the repository, Alice writes to it, Carol only reads it.
  await fake("/_fake/collaborators", { id: 201, login: "ben", permission: "maintain" })
  await fake("/_fake/collaborators", { id: 202, login: "alice", permission: "write" })
  await fake("/_fake/collaborators", { id: 203, login: "carol", permission: "read" })
})
test.afterAll(async () => { for (const { context } of people.values()) await context.close() })

test("J1 8 owner adds Ben and Alice on the Members card", async ({ browser }) => {
  const page = await signIn(browser, "owner")
  await say(page, "/members")
  const card = members(page)
  for (const login of ["ben", "alice"]) {
    await card.getByLabel("GitHub username", { exact: true }).fill(login)
    await card.getByRole("button", { name: "Add", exact: true }).click()
    await expect(card.locator(`li[data-login="${login}"]`)).toBeVisible()
  }
  await expect(card.locator('li[data-login="ben"]')).toContainText("Maintainer")
  await expect(card.locator('li[data-login="alice"]')).toContainText("Member")
  // Carol reads the repository on GitHub only: no row, and the card links to the repository's access settings.
  await card.getByLabel("GitHub username", { exact: true }).fill("carol")
  await card.getByRole("button", { name: "Add", exact: true }).click()
  await expect(card.getByRole("link", { name: /needs access on GitHub/ })).toHaveAttribute("href", "https://github.com/local-owner/demo/settings/access")
  await expect(card.locator('li[data-login="carol"]')).toHaveCount(0)
})
for (const who of ["ben", "alice"] as const) test(`J1 8 ${who} opens the install's address and signs in`, async ({ browser }) => {
  const page = await signIn(browser, who)
  // Boot reads settle: the install, repositories, stack, sync and live channel.
  await page.waitForTimeout(4000)
  await say(page, "/members")
  const card = members(page)
  await expect(card.locator('li[data-login="ben"]')).toContainText("Maintainer")
  await expect(card.locator('li[data-login="alice"]')).toContainText("Member")
  await expect(card.getByRole("button", { name: "Add", exact: true })).toHaveCount(who === "ben" ? 1 : 0)
})
for (const who of ["ben", "alice"] as const) test(`J4 1 ${who} opens the stack`, async ({ browser }) => {
  const page = await person(browser, who)
  await say(page, "/stack")
  await expect.poll(async () => list(await todos(page)).length, { timeout: 10_000 }).toBeGreaterThan(0)
  await page.waitForTimeout(2000)
})
for (const who of ["ben", "alice"] as const) test(`J2 ${who} asks the app agent about the code`, async ({ browser }) => {
  const page = await person(browser, who)
  await say(page, "What is in README.md? Show the file.")
  const file = page.locator('[data-kind="file"]').last()
  await expect(file).toContainText("README.md", { timeout: 20_000 })
  await expect(file).toContainText(README.trim().split("\n").at(-1)!)
})
// J2 1-3 in the browser: Ben opens an issue on GitHub and Carol comments on it. Each person lists the install's issues
// and opens the issue card; Alice presses Make TODO on the card, commits the Draft and watches the TODO start.
const issueTitle = "Greet in JOURNEY.md"
let issueNumber = 0
/** The walk's issue, opened once per worker (a failed test restarts the worker). */
const walkIssue = async () => {
  if (issueNumber === 0) {
    issueNumber = (await fake("/_fake/issues", { repo: "local-owner/demo", login: "ben", title: issueTitle, body: "Add a greeting line to JOURNEY.md." })).number
    await fake("/_fake/comments", { repo: "local-owner/demo", number: issueNumber, login: "carol", body: "Keep it to one line." })
  }
  return issueNumber
}
/** Opens the issue card with /issue #n and answers it once it shows the issue and its comment. */
const issueCard = async (page: Page, number: number) => {
  await say(page, `/issue #${number}`)
  const card = page.locator(`[data-kind="issue"]:has(article[data-issue="${number}"])`).last()
  await expect(card).toContainText("Add a greeting line to JOURNEY.md.", { timeout: 15_000 })
  await expect(card).toContainText("Keep it to one line.")
  return card
}
for (const who of ["owner", "ben", "alice"] as const) test(`J2 1 ${who} lists the install's issues and opens the issue card`, async ({ browser }) => {
  const number = await walkIssue()
  const page = await person(browser, who)
  await say(page, "/issues")
  await expect(page.locator(`[data-kind="issue-list"] li[data-issue="${number}"]`).last()).toContainText(issueTitle, { timeout: 15_000 })
  const card = await issueCard(page, number)
  await expect(card.getByRole("button", { name: "Make TODO", exact: true })).toBeVisible()
})
test("J2 2-3 Alice privately drafts, edits and commits once, then watches the TODO start", async ({ browser }) => {
  const page = await person(browser, "alice")
  const card = await issueCard(page, await walkIssue())
  const owner = await person(browser, "owner")
  const before = list(await todos(page))
  const ownerDrafts = await owner.getByRole("region", { name: "Draft", exact: true }).count()
  const writes = async () => {
    const response = await fetch(`${run.fakeURL}/_fake/writes`)
    expect(response.status).toBe(200)
    return await response.json() as { method: string; path: string; status: number }[]
  }
  const issueWrites = (rows: Awaited<ReturnType<typeof writes>>) => rows.filter(row =>
    row.path.startsWith(`/repos/local-owner/demo/issues/${issueNumber}/`) && row.method !== "GET")
  const beforeWrites = issueWrites(await writes())
  await card.getByRole("button", { name: "Make TODO", exact: true }).click()
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await expect(draft.getByLabel("Title", { exact: true })).toHaveValue(issueTitle, { timeout: 20_000 })
  await expect(draft.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Add a greeting line to JOURNEY.md.\n\n@carol:\n> Keep it to one line.", { timeout: 10_000 })
  await expect(owner.getByRole("region", { name: "Draft", exact: true })).toHaveCount(ownerDrafts)
  expect(list(await todos(page))).toEqual(before)
  expect(issueWrites(await writes())).toEqual(beforeWrites)
  const edited = "Add a greeting line to JOURNEY.md.\n\n@carol:\n> Keep it to one line.\nLog the greeting."
  await draft.getByRole("textbox", { name: "Prompt", exact: true }).fill(edited)
  // ui-components.md: the fixes toggle reads "Closes #i when merged".
  await draft.getByRole("checkbox", { name: `Closes #${issueNumber} when merged`, exact: true }).check()
  await draft.getByRole("combobox", { name: "Place", exact: true }).selectOption({ label: "Append" })
  const submitted = page.waitForRequest(r => r.method() === "POST" && new URL(r.url()).pathname === "/api/todos")
  const committedResponse = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/todos")
  await draft.getByRole("button", { name: "Commit", exact: true }).click()
  const request = await submitted
  // docs/api/openapi.yaml: POST /api/todos answers 202 Accepted.
  expect((await committedResponse).status()).toBe(202)
  const data = request.postDataJSON()
  const headers = await request.allHeaders()
  expect(data.issue_digest).toEqual(expect.any(String))
  expect(headers["idempotency-key"]).toEqual(expect.any(String))
  let made: { n: number; state: string; title: string } | undefined
  await expect.poll(async () => (made = list(await todos(page)).find(todo => todo.title === issueTitle))?.n ?? 0, { timeout: 15_000 }).toBeGreaterThan(0)
  // It is the issue's TODO: committed with the issue it fixes.
  const committed = await (await page.request.get(`${app}/api/todos/${made!.n}`)).json() as { issue?: { number: number; fixes: boolean } }
  expect(committed.issue).toMatchObject({ number: issueNumber, fixes: true })
  const detail = await (await page.request.get(`${app}/api/todos/${made!.n}`)).json()
  expect(detail.prompt_revisions).toHaveLength(1)
  expect(detail.prompt_revisions[0]).toMatchObject({ reason: "from-issue", text: edited, issue_digest: data.issue_digest, by: { kind: "person", login: "alice" } })
  const assertOne = async () => {
    expect(list(await todos(page)).filter(todo => todo.title === issueTitle)).toHaveLength(1)
    const response = await fetch(`${run.fakeURL}/_fake/issue?repo=local-owner/demo&number=${issueNumber}`)
    expect(response.status).toBe(200)
    // githubfake IssueView has no JSON tags: Labels and Comments; each comment is {body, via_app}.
    const remote = await response.json() as { Labels: string[]; Comments: { body: string; via_app: boolean }[] }
    expect(remote.Labels.filter(label => label === "todo")).toHaveLength(1)
    // The App's notice reads "Committed as Tn ↗"; with an install address it is the Markdown link
    // "Committed as [Tn ↗](url)". C-J2-01 says it links the TODO, but no TODO URL exists yet (the product
    // links the repository page); that target is an open spec question with 8a, so only the text is asserted.
    // What GitHub renders: Markdown links as their text, without HTML comments (the App's dedup marker).
    const visible = (body: string) => body.replace(/<!--[\s\S]*?-->/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim()
    const comments = remote.Comments.filter(comment => visible(comment.body) === `Committed as T${made!.n} ↗`)
    expect(comments, JSON.stringify(remote.Comments)).toHaveLength(1)
    expect(comments[0].via_app).toBe(true)
    for (const suffix of ["labels", "comments"]) expect(issueWrites(await writes()).filter(row =>
      row.path.endsWith(`/${suffix}`) && row.status >= 200 && row.status < 300)).toHaveLength(1)
    const current = await (await page.request.get(`${app}/api/todos/${made!.n}`)).json()
    expect(current.prompt_revisions).toEqual(detail.prompt_revisions)
  }
  await expect.poll(async () => issueWrites(await writes()).filter(row => row.path.endsWith("/comments") && row.status < 300).length).toBe(1)
  await assertOne()
  const duplicate = await page.request.post(request.url(), { headers, data })
  // An idempotent replay answers the original 202; assertOne proves it created nothing.
  expect(duplicate.status()).toBe(202)
  await assertOne()
  const invalid = await page.request.post(request.url(), {
    headers: { ...headers, "idempotency-key": crypto.randomUUID() }, data: { ...data, issue_digest: "0".repeat(64) }
  })
  expect(invalid.ok()).toBe(false)
  await assertOne()
  await say(page, `/todo T${made!.n}`)
  await expect(page.getByRole("article", { name: `TODO T${made!.n}`, exact: true }).last()).toBeVisible()
  // The TODO starts: it leaves queued for a branch machine. Each state the walk sees is recorded.
  const seen: string[] = []
  await expect.poll(async () => {
    const response = await page.request.get(`${app}/api/todos/${made!.n}`)
    const state = response.ok() ? (await response.json() as { state: string }).state : `status ${response.status()}`
    if (seen.at(-1) !== state) seen.push(state)
    return state
  }, { timeout: 180_000, intervals: [2_000] }).toMatch(/^(starting|working|needs_you|in_review|merging|merged)$/)
  appendFileSync(`${output}/j2-todo-states.txt`, `T${made!.n} issue #${issueNumber}: ${seen.join(" -> ")}\n`)
})
test("C-J2-04 owner opens the completed canary's attempt evidence", async ({ browser }) => {
  test.fixme(true, "Written before implementation: C-J2-04 step 2; the TODO evidence projection (mythical_todo_read.go currentTodoEvidence) emits no diff, usage, model_access or github_check item; lands with T-STK-10")
  const page = await person(browser, "owner")
  await say(page, "/todo T1")
  const card = page.getByRole("article", { name: "TODO T1", exact: true }).last()
  const response = await page.request.get(`${app}/api/todos/1`)
  expect(response.status()).toBe(200)
  const todo = await response.json()
  const attempt = todo.evidence.find((entry: { attempt: number }) => entry.attempt === 1)
  expect(attempt).toBeTruthy()
  expect(attempt.revision).toMatch(/^[a-f0-9]{40}$/)
  const evidence = card.getByRole("region", { name: "Attempt 1 evidence", exact: true })
  await expect(evidence).toBeVisible()
  const diff = attempt.items.find((item: { kind: string }) => item.kind === "diff")
  expect(diff.files).toBeGreaterThan(0)
  expect(diff.added).toBeGreaterThan(0)
  expect(diff.removed).toBeGreaterThanOrEqual(0)
  const checks = attempt.items.filter((item: { kind: string }) => item.kind === "check")
  expect(checks.length).toBeGreaterThanOrEqual(2)
  for (const check of checks) {
    expect(check.state).toBe("passed")
    expect(check.took_s).toBeGreaterThanOrEqual(0)
    await expect(evidence).toContainText(check.name)
  }
  const review = attempt.items.find((item: { kind: string }) => item.kind === "review")
  expect(review.summary).toBe("approve")
  await expect(evidence).toContainText("approve")
  await expect(evidence).not.toContainText("not measured yet")
  appendFileSync(`${output}/j2-evidence.jsonl`, JSON.stringify({ todo: 1, attempt }) + "\n")
})
for (const who of ["ben", "alice"] as const) test(`J2 ${who} writes and commits a TODO`, async ({ browser }) => {
  const page = await person(browser, who)
  await commitTodo(page, `TODO from ${who}`)
  const mine = list(await todos(page)).find(todo => todo.title === `TODO from ${who}`)!
  await say(page, `/todo T${mine.n}`)
  await expect(page.getByRole("article", { name: `TODO T${mine.n}`, exact: true }).last()).toBeVisible()
})
test("J4 2 Ben steers a TODO and opens Review & merge", async ({ browser }) => {
  const page = await person(browser, "ben")
  const mine = list(await todos(page)).find(todo => todo.title === "TODO from ben")!
  await say(page, `/todo.steer T${mine.n} keep the greeting short`)
  await page.waitForTimeout(2000)
  await say(page, "/merge T1")
  await page.waitForTimeout(2000)
})
test("members see no refusal on their paths", async () => {
  const rows = recorded()
  expect(rows.filter(row => "aborted" in row)).toEqual([])
  expect(rows.filter(row => "who" in row && row.who !== "owner" && (row.status === 401 || row.status === 403) && !byRole(row))).toEqual([])
})

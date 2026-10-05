import { test, expect, type Browser, type Page } from "@playwright/test"
import { appendFileSync, readFileSync } from "node:fs"

// J1 7 and J7 on the install setup-no-github.spec.ts walked to Merged and team-no-github.spec.ts staffed: Open branch
// on a TODO card opens the branch the install serves (its commits, changed files and checks), for the owner and for a
// Member, and every member lists every branch. Runs after both (file order), against the same bundle and data.
const output = "test-results/local-no-github"
const app = "http://localhost:4000"
type Who = "owner" | "alice"
let run: { fakeURL: string; modelOrigin: string }
const refusals: string[] = []

const signIn = async (browser: Browser, who: Who) => {
  const context = await browser.newContext()
  await context.route(/^https?:\/\//, async route => {
    const origin = new URL(route.request().url()).origin
    if (["http://localhost:4000", "http://127.0.0.1:4000", run.fakeURL, run.modelOrigin].includes(origin)) return route.continue()
    if (/^https:\/\/github\.com\/[a-z\d-]+\.png$/i.test(route.request().url())) return route.fulfill({ status: 404 })
    await route.abort()
  })
  const page = await context.newPage()
  page.on("response", response => {
    const url = new URL(response.url())
    if (url.origin === app && url.pathname.startsWith("/api/branches") && response.status() >= 400) refusals.push(`${who} ${response.status()} ${url.pathname}`)
  })
  await page.goto(`${app}/api/auth/github`)
  await page.getByRole("link", { name: who === "owner" ? "Authorize" : `Authorize as ${who}`, exact: true }).click()
  await page.waitForURL(url => url.origin === app && !url.pathname.startsWith("/api/"))
  await expect(page.getByTestId("composer-input")).toBeAttached({ timeout: 15_000 })
  return page
}
const say = async (page: Page, text: string) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill(text)
  await input.press("Enter")
}
type Served = { branch?: { name: string }; state: string; evidence: { items: { kind: string; name?: string; state?: string }[] }[] }
type Diff = { files: { path: string; change: string }[]; commits?: { sha: string; subject: string }[] }
const get = async <T>(page: Page, path: string) => {
  const response = await page.request.get(`${app}${path}`)
  expect(response.status(), path).toBe(200)
  return await response.json() as T
}

/** Presses Open branch on T1's card and checks the Branch card against what the install serves. */
const openT1Branch = async (page: Page) => {
  const t1 = await get<Served>(page, "/api/todos/1")
  expect(t1.branch?.name).toMatch(/^smithers\//)
  const name = t1.branch!.name
  await say(page, "/todo T1")
  const todo = page.getByRole("article", { name: "TODO T1", exact: true }).last()
  await expect(todo).toBeVisible({ timeout: 10_000 })
  const diffRead = page.waitForResponse(response => new URL(response.url()).pathname === `/api/branches/${encodeURIComponent(name)}/diff`)
  await todo.getByRole("button", { name: "Open branch", exact: true }).click()
  expect((await diffRead).status()).toBe(200)
  const diff = await get<Diff>(page, `/api/branches/${encodeURIComponent(name)}/diff`)
  expect(diff.files.length).toBeGreaterThan(0)
  expect(diff.commits?.length ?? 0).toBeGreaterThan(0)
  const branch = page.locator("section.branch-view").filter({ has: page.getByRole("heading", { name, exact: true }) }).last()
  await expect(branch).toBeVisible({ timeout: 10_000 })
  await expect(branch).toContainText("T1")
  // Activity: each commit's subject and short sha, then the TODO's checks as the evidence holds them.
  for (const commit of diff.commits!.slice(-3)) {
    await expect(branch.locator('li[data-kind="change"]').filter({ hasText: commit.subject })).toContainText(commit.sha.slice(0, 7))
  }
  const checks = (t1.evidence.at(-1)?.items ?? []).filter(item => item.kind === "check")
  for (const check of checks) await expect(branch.locator('li[data-kind="step"]').filter({ hasText: `${check.name} ${check.state}` })).toHaveCount(1)
  // Files: every path the change touched, with its change.
  const files = branch.getByRole("tab", { name: /^Files/ })
  await expect(files).toHaveText(`Files${diff.files.length}`)
  await files.click()
  for (const file of diff.files) await expect(branch.locator("li").filter({ hasText: file.path })).toContainText(file.change)
  await expect(branch.getByRole("button", { name: "Copy SSH line" })).toHaveCount(0)
  appendFileSync(`${output}/open-branch.txt`, `${name}: ${diff.commits!.map(commit => commit.subject).join(" | ")}; files ${diff.files.map(file => `${file.change} ${file.path}`).join(", ")}; checks ${checks.map(check => `${check.name} ${check.state}`).join(", ")}\n`)
  return name
}

test.beforeAll(async () => { run = JSON.parse(readFileSync(`${output}/run.json`, "utf8")) })

test("J1 7 the owner presses Open branch on T1 and sees its commits, files and checks", async ({ browser }) => {
  test.setTimeout(60_000)
  const page = await signIn(browser, "owner")
  await openT1Branch(page)
  await page.context().close()
})

test("J1 7 a Member presses Open branch on T1 and lists every branch", async ({ browser }) => {
  test.setTimeout(60_000)
  const page = await signIn(browser, "alice")
  const name = await openT1Branch(page)
  // T1 merged: its card still opens its branch, and the list holds only open TODOs' branches.
  const branches = await get<{ name: string; kind: string; item?: { n: number } }[]>(page, "/api/branches")
  expect(branches.map(branch => branch.name)).not.toContain(name)
  const todos = await get<Served[] | { todos: Served[] }>(page, "/api/todos")
  const open = (Array.isArray(todos) ? todos : todos.todos).filter(todo => todo.branch && !["merged", "dropped"].includes(todo.state))
  expect(branches.filter(branch => branch.kind === "item").map(branch => branch.name).sort()).toEqual(open.map(todo => todo.branch!.name).sort())
  await page.context().close()
})

test("Open branch on a branch the install does not serve says why and opens nothing", async ({ browser }) => {
  const page = await signIn(browser, "alice")
  await say(page, "/branch smithers/no-such-branch")
  await expect(page.getByText("branch not found").first()).toBeVisible({ timeout: 10_000 })
  await expect(page.locator("section.branch-view").filter({ hasText: "smithers/no-such-branch" })).toHaveCount(0)
  await page.context().close()
})

test("members read branches with no refusal but the missing one", () => {
  expect(refusals).toEqual(["alice 404 /api/branches/smithers%2Fno-such-branch"])
})

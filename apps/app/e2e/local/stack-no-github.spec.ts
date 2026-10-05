import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { githubRoute } from "./github-route"

const networks = new WeakMap<Page, { aborted: string[] }>()
const app = "http://localhost:4000"
const run = () => JSON.parse(readFileSync("test-results/local-no-github/run.json", "utf8")) as {
  fakeURL: string; modelOrigin: string; repo: string
}
type Todo = { n: number; title: string; state: string; place: number;
  pr: { number: number; head: string; included_items: number[] }; approval_cleared?: boolean }
const say = async (page: Page, text: string) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill(text)
  await input.press("Enter")
}
const card = (page: Page, n: number) => page.getByRole("article", { name: `TODO T${n}`, exact: true }).last()
const todo = async (page: Page, n: number): Promise<Todo> => {
  const response = await page.request.get(`${app}/api/todos/${n}`)
  expect(response.status()).toBe(200)
  return response.json()
}
const todos = async (page: Page): Promise<Todo[]> => {
  const response = await page.request.get(`${app}/api/todos`)
  expect(response.status()).toBe(200)
  const body = await response.json()
  return Array.isArray(body) ? body : body.todos
}
const show = async (page: Page, n: number) => {
  await say(page, `/todo T${n}`)
  await expect(card(page, n)).toBeVisible()
  return card(page, n)
}
// Match the rehearsal's eight-minute coding allowance; this is a new real-machine walk.
const state = async (page: Page, n: number, expected: string) => {
  await expect.poll(async () => (await todo(page, n)).state, { timeout: 8 * 60_000, intervals: [1000] }).toBe(expected)
  await show(page, n)
  await expect(card(page, n).locator("header .mvp-state")).toHaveAttribute("data-state", expected)
}
const create = async (page: Page, title: string, prompt: string, before?: number) => {
  await say(page, "/todo.new")
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await draft.getByLabel("Title", { exact: true }).fill(title)
  await draft.getByLabel("Prompt", { exact: true }).fill(prompt)
  await draft.getByRole("combobox", { name: "Place", exact: true }).selectOption(before ? { value: JSON.stringify({ mode: "before", n: before }) } : { label: "Append" })
  await draft.getByRole("button", { name: "Commit", exact: true }).click()
  let made: Todo | undefined
  await expect.poll(async () => (made = (await todos(page)).find(item => item.title === title))?.n, { timeout: 10_000 }).toBeGreaterThan(0)
  await show(page, made!.n)
  return made!.n
}
const drop = async (page: Page, n: number) => {
  await show(page, n)
  await card(page, n).getByRole("button", { name: "Drop", exact: true }).click()
  await page.locator('[data-kind="confirm"]').last().locator("button[data-primary]").click()
  await state(page, n, "dropped")
}
const merge = async (page: Page, n: number) => {
  const head = (await todo(page, n)).pr.head
  await say(page, `/merge T${n}`)
  const review = page.getByRole("region", { name: `Merge T${n} into main?`, exact: true }).last()
  await expect(review.getByRole("button", { name: "Merge", exact: true })).toBeEnabled()
  const requested = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === `/api/todos/${n}/merge`)
  await review.getByRole("button", { name: "Merge", exact: true }).click()
  expect((await requested).postDataJSON()).toEqual({ reviewed_head_sha: head })
}
/** A state-changing request as the signed-in person: session requests need Origin, X-CSRF-Token (middleware/csrf.go) and an Idempotency-Key. */
const post = async (page: Page, url: string, options: { data?: unknown } = {}) => {
  const csrf = (await page.context().cookies(app)).find(cookie => cookie.name === "__csrf")?.value
  // State-changing routes also require an Idempotency-Key (refused 400 idempotency_key_required without one).
  return page.request.post(url, { ...options, headers: { Origin: app, "Idempotency-Key": crypto.randomUUID(), ...(csrf ? { "X-CSRF-Token": csrf } : {}) } })
}
const pull = async (page: Page, n: number) => {
  const response = await page.request.get(`${run().fakeURL}/_fake/pull?repo=${run().repo}&number=${(await todo(page, n)).pr.number}`)
  expect(response.status()).toBe(200)
  return response.json()
}
const writes = async (page: Page): Promise<{ method: string; path: string; status: number }[]> => {
  const response = await page.request.get(`${run().fakeURL}/_fake/writes`)
  expect(response.status()).toBe(200)
  return response.json()
}
const firstActive = async (page: Page) => (await todos(page)).find(item => !["merged", "dropped"].includes(item.state))?.n
const home = (page: Page) => page.locator('[data-keyboard-pane="Stack"]').last()
const row = (page: Page, n: number) => home(page).locator("li.mvp-stack-row").filter({ has: page.locator(".mvp-ref", { hasText: new RegExp(`^T${n}$`) }) })

// Playwright lists setup, stack, team alphabetically: use the already installed owner.
// Ben is not added until the later team walk; no dependency on its private helpers.
test.beforeEach(async ({ page, context }) => {
  const traffic = await githubRoute(context, run().fakeURL)
  await context.route(/^https?:\/\//, async route => {
    const origin = new URL(route.request().url()).origin
    if ([app, "http://127.0.0.1:4000", run().fakeURL, run().modelOrigin].includes(origin)) return route.continue()
    if (/^https:\/\/github\.com\/[a-z\d-]+\.png$/i.test(route.request().url())) return route.fulfill({ status: 404 })
    return route.fallback()
  })
  await page.goto(`${app}/api/auth/github`)
  await page.getByRole("link", { name: "Authorize", exact: true }).click()
  await page.waitForURL(url => url.origin === app && !url.pathname.startsWith("/api/"))
  await expect(page.getByTestId("composer-input")).toBeAttached({ timeout: 15_000 })
  // Attach provider network refusals to the same browser receipt.
  networks.set(page, traffic)
})
test.afterEach(async ({ page }, info) => {
  expect(networks.get(page)?.aborted).toEqual([])
  await info.attach("stack-screen", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await info.attach("github-writes", { body: JSON.stringify(await writes(page)), contentType: "application/json" })
})

test("J4b failed predecessor refuses merge; Drop lets the next TODO merge; review Drop closes its PR", async ({ page }) => {
  test.setTimeout(30 * 60_000)
  const tail = await firstActive(page)
  const failed = await create(page, "Stack walk fails", "[FAIL] [FILE w47-fail.md] Add a greeting to w47-fail.md", tail)
  const next = await create(page, "Stack walk next", "[PR] [FILE w47-next.md] Add a greeting to w47-next.md", tail)
  await state(page, next, "in_review")
  await expect(card(page, next)).toContainText(`Merges after T${failed}`)
  await say(page, "/stack")
  await expect(row(page, next)).toContainText(`Merges after T${failed}`)
  await expect(row(page, next).getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  const before = (await writes(page)).filter(write => write.path.endsWith("/merge")).length
  // The person-visible HTTP door must enforce the same order as the card.
  const refused = await post(page, `${app}/api/todos/${next}/merge`, { data: { reviewed_head_sha: (await todo(page, next)).pr.head } })
  expect(refused.status(), await refused.text()).toBe(409)
  expect(await refused.text()).toContain(`Merges after T${failed}`)
  expect((await writes(page)).filter(write => write.path.endsWith("/merge"))).toHaveLength(before)
  await state(page, failed, "failed")
  test.fixme(true, "Written before implementation: C-J7-02 step 6; spec.md §10.7.2 requires confirmation, but person Drop dispatches immediately via TodoSeam.ts:498 and Commands.ts:727 only confirms agent invocations; lands with T-STK-05")
  await drop(page, failed)
  await say(page, "/stack")
  await expect(row(page, failed)).toHaveCount(0)
  await expect(row(page, next).getByRole("button", { name: "Merge", exact: true })).toBeEnabled()
  await merge(page, next)
  await state(page, next, "merged")
  expect((await pull(page, next)).pull).toMatchObject({ merged: true, state: "closed" })
  const dropped = await create(page, "Stack walk review drop", "[PR] [FILE w47-drop.md] Add a greeting to w47-drop.md", tail)
  await state(page, dropped, "in_review")
  await drop(page, dropped)
  await expect.poll(async () => (await pull(page, dropped)).pull.state).toBe("closed")
  const receipt = await pull(page, dropped)
  expect(receipt.pull.merged).toBe(false)
  expect(receipt.comments).toEqual(expect.arrayContaining([expect.objectContaining({ body: "Dropped in Smithers by @local-owner" })]))
  await say(page, "/stack")
  await expect(row(page, dropped)).toHaveCount(0)
})

test("J7 Before placement; GitHub refusal is visible; main merge rebases the next PR onto the prefix", async ({ page }) => {
  test.setTimeout(30 * 60_000)
  const tail = await firstActive(page)
  const first = await create(page, "Stack walk prefix", "[PR] [FILE w47-prefix.md] Add a greeting to w47-prefix.md", tail)
  const last = await create(page, "Stack walk last", "[PR] [FILE w47-last.md] Add a greeting to w47-last.md", tail)
  const inserted = await create(page, "Stack walk insert", "[PR] [FILE w47-insert.md] Add a greeting to w47-insert.md", last)
  await say(page, "/stack")
  await expect(home(page).locator("li.mvp-stack-row .mvp-ref")).toHaveText([
    `T${first}`, `T${inserted}`, `T${last}`, ...(await todos(page)).filter(item => ![first, inserted, last].includes(item.n) && !["merged", "dropped"].includes(item.state)).map(item => `T${item.n}`)
  ])
  for (const n of [first, inserted, last]) await state(page, n, "in_review")
  // C-J7-01 step 6: the inserted TODO stacks on the prefix, so its PR names the earlier item it includes.
  await expect.poll(async () => (await todo(page, inserted)).pr.included_items, { timeout: 8 * 60_000, intervals: [1000] }).toContain(first)
  expect((await pull(page, inserted)).pull.body).toContain(`Includes [T${first}]`)
  expect((await todo(page, inserted)).pr.included_items).toContain(first)
  await say(page, "/stack")
  test.fixme(true, "Written before implementation: C-J4-03 pass step 9 (line 29); HomeContainer.tsx:65 requires place === 1 and hides Merge on the first active ready TODO when retained terminal rows leave its place at 2; lands with T-APP-01")
  await expect(row(page, first).getByRole("button", { name: "Merge", exact: true })).toBeEnabled()
  for (const n of [inserted, last]) {
    await expect(row(page, n)).toContainText(`Merges after T${first}`)
    await expect(row(page, n).getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  }
  const sentence = "At least 1 approving review is required by reviewers with write access."
  const refusal = await page.request.post(`${run().fakeURL}/_fake/merge-refusal`, { data: { repo: run().repo, number: (await todo(page, first)).pr.number, status: 405, message: sentence } })
  expect(refusal.status()).toBe(204)
  await merge(page, first)
  await show(page, first)
  await expect(card(page, first)).toContainText(sentence, { timeout: 60_000 })
  expect((await todo(page, first)).state).toBe("in_review")
  const oldHead = (await todo(page, inserted)).pr.head
  await merge(page, first)
  await state(page, first, "merged")
  const main = (await pull(page, first)).pull.merge_commit_sha
  expect(main).toMatch(/^[a-f0-9]{40}$/)
  await expect.poll(async () => (await todo(page, inserted)).pr.head, { timeout: 8 * 60_000, intervals: [1000] }).not.toBe(oldHead)
  await state(page, inserted, "in_review")
  // Read actual provider Git ancestry, not an expected value computed by the implementation.
  await expect.poll(async () => (await pull(page, inserted)).parent, { timeout: 8 * 60_000, intervals: [1000] }).toBe(main)
  await say(page, "/stack")
  await expect(row(page, first)).toHaveCount(0)
  await expect(row(page, inserted).getByRole("button", { name: "Merge", exact: true })).toBeEnabled()
  await expect(row(page, last)).toContainText(`Merges after T${inserted}`)
  const mergeCalls = (await writes(page)).filter(write => write.path.endsWith("/merge")).length
  const stale = await post(page, `${app}/api/todos/${inserted}/merge`, { data: { reviewed_head_sha: oldHead } })
  expect(stale.status()).toBe(409)
  expect((await writes(page)).filter(write => write.path.endsWith("/merge"))).toHaveLength(mergeCalls)
  await merge(page, inserted)
  await state(page, inserted, "merged")
  await drop(page, last)
})

import { expect, test } from "./browserTest"
import type { MythicalItem, MythicalStack } from "@smthrs/rpc/Mythical"
import { installCloudFixture } from "./cloudFixture"
import { fillComposer } from "./composer"

/*
 * Filing a TODO for the coding factory from the History card (#2782),
 * keyboard only, against a fake Smithers Cloud: New TODO opens the form, File
 * is acknowledged while the filing is still unanswered, Chat stays usable,
 * one notice follows the TODO through its lanes and checks, and it settles
 * only when the pull request opens. A reload reconnects it without filing it
 * again, and a refused filing is retried from the card.
 */

const REPO = "smithersai/smithers"
const BASE = `/api/repos/${REPO}/mythical`
const item = (id: string, state: MythicalItem["state"], extra: Partial<MythicalItem> = {}): MythicalItem => ({
  id, state, attempt: 1, runs: {}, dependsOn: [], updatedAt: new Date().toISOString(),
  issue: { number: Number(id.slice(1)), title: "Add the footer link", url: `https://github.com/${REPO}/issues/${id.slice(1)}` },
  ...extra
})
const snapshot = (generation: number, items: MythicalItem[]): MythicalStack => ({
  repository: REPO, state: "active", generation, mainBehind: false,
  changes: [{ changeId: "kbootstrapchange", commitId: "c1", title: "Initial import", kind: "bootstrap", state: "landed" }],
  items, lanes: [{ index: 0, state: items.some(row => row.lane === 0) ? "busy" : "idle" }, { index: 1, state: "idle" }],
  limits: { maxParallel: 2 }
})

test("a TODO filed from the History card is followed through the factory to its pull request", async ({ page }) => {
  await installCloudFixture(page)
  let current = snapshot(1, [])
  const filings: string[] = []
  let answer: (() => void) | undefined
  let refuse = true
  await page.route(url => url.pathname === BASE, route => route.fulfill({ json: current }))
  await page.route(url => url.pathname === `${BASE}/events`, route => route.fulfill({
    status: 200, headers: { "content-type": "text/event-stream" },
    body: `event: mythical\ndata: {"generation":${current.generation},"kind":"item"}\n\n`
  }))
  await page.route(url => url.pathname === `${BASE}/todos`, async route => {
    filings.push(route.request().postData() ?? "")
    if (refuse) {
      await route.fulfill({ status: 403, json: { message: "only a maintainer the factory's policy names files a TODO" } })
      return
    }
    // The filing stays unanswered until the test lets it through.
    await new Promise<void>(resolve => { answer = resolve })
    current = snapshot(2, [item("i12", "queued")])
    await route.fulfill({ status: 201, json: item("i12", "queued") })
  })

  await page.goto("/")
  await expect(page.getByTestId("first-run-actions")).toBeVisible()
  await fillComposer(page, `/history.show ${REPO}`)
  await page.getByTestId("composer-send").click()
  const card = page.locator('[data-kind="stack"]')
  await expect(card.getByTestId("stack-counts")).toContainText("1 change")
  if (await page.getByTestId("composer-input").isVisible()) await page.getByTestId("composer-input").press("Escape")

  // Keyboard only: the door, the form, File.
  const fileTodo = async () => {
    await card.getByTestId("stack-todo").focus()
    await page.keyboard.press("Enter")
    const form = page.locator('form.flow-form[data-flow-name="history.todo"]').last()
    await expect(form.getByTestId("flow-form-submit")).toHaveText("File")
    await form.getByTestId("flow-form-title").focus()
    await page.keyboard.type("Add the footer link")
    await expect(form.getByTestId("flow-form-submit")).toBeEnabled()
    await form.getByTestId("flow-form-submit").focus()
    await page.keyboard.press("Enter")
  }

  // A refused filing stays on the card; its Retry files the same TODO.
  await fileTodo()
  const failure = card.locator('[data-testid="stack-failure"][data-act="todo"]')
  await expect(failure).toContainText("Smithers could not file this TODO.")
  expect(filings.map(body => JSON.parse(body) as { title: string; request: string })).toEqual([{ title: "Add the footer link", request: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-z]+$/) }])
  refuse = false
  await failure.getByRole("button", { name: "Retry" }).focus()
  await page.keyboard.press("Enter")
  await expect.poll(() => filings.length).toBe(2)
  await expect(failure).toHaveCount(0)

  // Acknowledged while the filing is unanswered; one notice runs; Chat stays usable.
  const notice = page.locator(".toast-stack .toast", { hasText: "Add the footer link" })
  await expect(notice).toHaveAttribute("data-toast-status", "running")
  await fillComposer(page, `/history.view metrics ${REPO}`)
  await page.getByTestId("composer-send").click()
  await expect(card.getByRole("button", { name: "Metrics" })).toHaveAttribute("aria-pressed", "true")
  expect(answer).toBeDefined()
  answer?.()

  // The factory picks it up: the same notice follows its lane and checks.
  await expect(notice).toContainText("queued", { timeout: 15_000 })
  current = snapshot(3, [item("i12", "running", { lane: 0 })])
  await expect(notice).toContainText("implementing", { timeout: 15_000 })
  await expect(page.locator(".toast-stack .toast", { hasText: "#12 Add the footer link" })).toHaveCount(0)

  // A reload reconnects the running TODO without filing it again.
  await page.reload()
  await expect(notice).toHaveAttribute("data-toast-status", "running", { timeout: 15_000 })
  current = snapshot(4, [item("i12", "verifying", { lane: 0, checks: { state: "pending", failed: [] } })])
  await expect(notice).toContainText("checking", { timeout: 15_000 })
  current = snapshot(5, [item("i12", "proposed", {
    checks: { state: "passed", failed: [] }, pullRequest: { number: 71, url: "https://github.com/pr/71", state: "open" }
  })])
  await expect(page.locator('.toast-stack .toast[data-toast-status="running"]', { hasText: "Add the footer link" })).toHaveCount(0, { timeout: 15_000 })
  await card.getByRole("button", { name: "Issues" }).click()
  await expect(card.getByTestId("stack-item-i12")).toContainText("PR #71")
  expect(filings).toHaveLength(2)
})

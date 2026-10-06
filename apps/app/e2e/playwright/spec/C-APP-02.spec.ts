import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

// Browser proof of the production dispatcher, TODO seam, card and View.
// Planner delivery and multiplayer attribution are qualified on the install.
test("C-APP-02: Queued Edit saves prompt and acceptance once and survives reload", async ({ page }) => {
  await owner(page)
  const model = structuredClone(fixtures.queued.model)
  model.n = 2
  model.prompt_revisions = [{ ...model.prompt_revisions[0]!, text: "PROMPT-A", acceptance: [] }]
  const writes: { key: string; body: { prompt: string; acceptance: string[] } }[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/2", async route => {
    const request = route.request()
    if (request.method() === "PATCH") {
      const body = request.postDataJSON() as { prompt: string; acceptance: string[] }
      const key = request.headers()["idempotency-key"]!
      writes.push({ key, body })
      if (model.prompt_revisions.length === 1) model.prompt_revisions.push({ ...model.prompt_revisions[0]!, text: body.prompt, acceptance: body.acceptance })
      await route.fulfill({ status: 202, json: { state: "accepted", n: 2, rev: 2 } })
    } else await route.fulfill({ json: model })
  })
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "/todo T2")
  const card = page.getByRole("article", { name: "TODO T2" }).last()
  await card.getByText("Edit", { exact: true }).press("Enter")
  await expect(card.getByLabel("Prompt", { exact: true })).toHaveValue("PROMPT-A")
  await card.getByLabel("Prompt", { exact: true }).fill("PROMPT-B")
  await card.getByLabel("Acceptance", { exact: true }).fill("The greeting is visible")
  await card.getByRole("button", { name: "Save", exact: true }).press("Enter")
  await page.keyboard.press("Enter")
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]!.body).toEqual({ prompt: "PROMPT-B", acceptance: ["The greeting is visible"] })
  expect(writes[0]!.key).toBeTruthy()
  await expect(card.locator(".todo-prompt")).toHaveText("PROMPT-B")
  await expect(card.getByText("+1", { exact: true })).toBeVisible()
  await page.reload()
  await say(page, "/todo T2")
  await expect(page.getByRole("article", { name: "TODO T2" }).last().locator(".todo-prompt")).toHaveText("PROMPT-B")
})

test("a person's Drop sends no control before confirmation", async ({ page }) => {
  await owner(page)
  const model = structuredClone(fixtures.queued.model)
  model.n = 2
  const writes: unknown[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/2", async route => {
    if (route.request().method() === "POST") {
      writes.push(route.request().postDataJSON())
      model.state = "dropped"
      await route.fulfill({ status: 202, json: { state: "accepted", n: 2 } })
    } else await route.fulfill({ json: model })
  })
  await page.goto("/")
  await say(page, "/todo T2")
  const card = page.getByRole("article", { name: "TODO T2" }).last()
  await card.getByRole("button", { name: "Drop", exact: true }).press("Enter")
  await expect(page.getByTestId("transcript").getByText("Drop T2?", { exact: true })).toBeVisible()
  expect(writes).toEqual([])
  await page.getByRole("button", { name: "Confirm: drop this TODO", exact: true }).last().press("Enter")
  await expect.poll(() => writes.length).toBe(1)
  expect(writes).toEqual([{ op: "drop" }])
  await expect(card).toContainText("Dropped")
})

// The install provider, rather than DesignWorld, supplies queue and step facts.
test("TODO state shows the working step and the daily admission limit", async ({ page }) => {
  await owner(page)
  const working = structuredClone(fixtures.working.model)
  working.n = 1
  const queued = structuredClone(fixtures.queued.model)
  queued.n = 2
  queued.queue = { reason: "daily_limit", position: 2 }
  const paused = structuredClone(fixtures.paused_by_budget.model)
  paused.n = 3
  paused.pause!.owner = { login: "maya", name: "Maya", avatar_url: "https://example.com/maya.png" }
  await page.route("**/api/todos", route => route.fulfill({ json: [working, queued, paused] }))
  await page.route("**/api/todos/1", route => route.fulfill({ json: working }))
  await page.route("**/api/todos/2", route => route.fulfill({ json: queued }))
  await page.route("**/api/todos/3", route => route.fulfill({ json: paused }))
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "/todo T1")
  await expect(page.getByRole("article", { name: "TODO T1" }).last().locator("header .state")).toHaveText("Working · Implement")
  await say(page, "/todo T2")
  const card = page.getByRole("article", { name: "TODO T2" }).last()
  await expect(card).toContainText("Daily limit reached · starts tomorrow · #2")
  await expect(card.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
  await say(page, "/todo T3")
  const budget = page.getByRole("article", { name: "TODO T3" }).last()
  await expect(budget).toContainText("Paused · daily token budget · Maya")
  await expect(budget).not.toContainText(paused.pause!.resume_at!)
})

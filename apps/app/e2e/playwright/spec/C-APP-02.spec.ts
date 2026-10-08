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

// The install's foreign-head decision uses the displayed wait/head, with
// authority rechecked by the composed route. Other waits remain independent.
for (const role of ["owner", "member"] as const) {
  test(`outside push Discard is ${role === "owner" ? "bound and durable" : "hidden from members"}`, async ({ page }) => {
    const { installCloudFixture } = await import("../cloudFixture")
    const { installFixture } = await import("../../../src/mainview/state/seams/InstallFixtures.test-support")
    await installCloudFixture(page, { capabilities: ["identity", "install"] })
    await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
    await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
    await page.route("**/api/members", route => route.fulfill({ json: {
      members: [{ login: "canary-owner", name: "Will", avatar_url: "https://example.com/owner.png", color_index: 0,
        role, needs_access: false, suspended: false, actions: [] }],
      access_url: "https://github.com/smithers-mvp-canary/node/settings/access"
    } }))
    const model = structuredClone(fixtures.foreign_push.model)
    model.n = 2; model.title = "Outside push"
    model.branch!.name = "smithers/retry-webhooks"
    model.waits.push(structuredClone(fixtures.needs_you.model.waits[0]!))
    const foreign = model.waits[0]!, originalEvidence = structuredClone(model.evidence)
    const writes: { key: string; body: unknown }[] = []
    let accept!: () => void
    const admitted = new Promise<void>(resolve => { accept = resolve })
    await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
    await page.route("**/api/todos/2", route => route.fulfill({ json: model }))
    await page.route(url => url.pathname.startsWith("/api/branches/"), async route => {
      expect(decodeURIComponent(new URL(route.request().url()).pathname)).toBe("/api/branches/smithers/retry-webhooks")
      writes.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"]! })
      await admitted
      await route.fulfill({ status: 202, json: { state: "accepted", n: 2 } })
    })
    await page.goto("/")
    await say(page, "/todo T2")
    const card = page.getByRole("article", { name: "TODO T2" }).last()
    await expect(card.getByRole("button", { name: "Bring in", exact: true })).toBeVisible()
    const discard = card.getByRole("button", { name: "Discard", exact: true })
    if (role === "member") {
      await expect(discard).toHaveCount(0)
      expect(writes).toEqual([])
      return
    }
    await discard.press("Enter")
    const confirm = page.getByRole("button", { name: "Confirm: discard this outside push", exact: true }).last()
    await expect(confirm).toBeVisible()
    expect(writes).toEqual([])
    await confirm.press("Enter")
    await expect.poll(() => writes.length).toBe(1)
    expect(writes[0]!.body).toEqual({ op: "discard-foreign", id: foreign.id, revision: foreign.sha })
    expect(writes[0]!.key).toBeTruthy()
    const notice = page.locator('.notice[data-tone="live"]').filter({ hasText: "Outside push" })
    await expect(notice).toBeVisible()
    await say(page, "/todo T2")
    await expect(page.getByTestId("composer-input")).toBeEditable()
    accept()
    await expect(notice).toBeVisible()
    model.waits = model.waits.filter(wait => wait.id !== foreign.id)
    await expect(discard).toHaveCount(0)
    await expect(notice).toHaveCount(0)
    await expect(card.getByRole("button", { name: "Answer", exact: true })).toBeVisible()
    expect(model.evidence).toEqual(originalEvidence)
    expect(writes).toHaveLength(1)
  })
}

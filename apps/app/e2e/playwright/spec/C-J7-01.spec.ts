import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { TodoCard } from "@smthrs/rpc/TodoCard"

// App boundary: real dispatcher, Draft, TODO and Home seams against served
// projections. Guest execution, steer delivery and ancestry need reference-host receipts.
test("C-J7-01: insert precedes T3 and amend retains T2", async ({ page }) => {
  test.setTimeout(120_000)
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/members", route => route.fulfill({ json: {
    members: [{ login: "canary-owner", name: "Will", avatar_url: "https://example.com/owner.png", color_index: 0,
      role: "owner", needs_access: false, suspended: false, actions: [] }],
    access_url: "https://github.com/smithers-mvp-canary/node/settings/access"
  } }))
  const models: TodoCard[] = [fixtures.in_review.model, fixtures.working.model, fixtures.queued.model]
    .map((model, index) => ({ ...structuredClone(model), n: index + 1, place: index + 1, title: `J7 TODO ${index + 1}` }))
  models[1]!.prompt_revisions = [{ ...models[1]!.prompt_revisions[0]!, acceptance: ["Keep the check"] }]
  const originalBranch = structuredClone(models[1]!.branch), originalRun = structuredClone(models[1]!.run)
  const writes: { method: string; body: Record<string, unknown>; key: string }[] = []
  await page.route("**/api/todos", async route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: [...models].sort((a, b) => a.place! - b.place!) })
    const body = route.request().postDataJSON() as Record<string, unknown>
    writes.push({ method: "POST", body, key: route.request().headers()["idempotency-key"]! })
    expect(body).toMatchObject({ title: "Add jitter", prompt: "Add a jitter helper", place: { mode: "before", n: 3 } })
    models[2]!.place = 4
    models.push({ ...structuredClone(fixtures.queued.model), n: 4, place: 3, title: "Add jitter",
      prompt_revisions: [{ ...fixtures.queued.model.prompt_revisions[0]!, text: "Add a jitter helper", acceptance: [] }] })
    await route.fulfill({ status: 202, json: { state: "accepted", n: 4, rev: 1 } })
  })
  await page.route(url => /^\/api\/todos\/[1-4]$/.test(url.pathname), async route => {
    const model = models.find(model => model.n === Number(new URL(route.request().url()).pathname.split("/").pop()))!
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { prompt: string }
      writes.push({ method: "PATCH", body, key: route.request().headers()["idempotency-key"]! })
      model.prompt_revisions.push({ ...model.prompt_revisions[0]!, text: body.prompt })
      return route.fulfill({ status: 202, json: { state: "accepted", n: 2, rev: 2 } })
    }
    return route.fulfill({ json: model })
  })
  await page.goto("/")
  await say(page, "/todo.new")
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await draft.getByLabel("Title", { exact: true }).fill("Add jitter")
  await draft.getByLabel("Prompt", { exact: true }).fill("Add a jitter helper")
  await draft.getByRole("combobox", { name: "Place", exact: true }).selectOption(JSON.stringify({ mode: "before", n: 3 }))
  expect(writes).toHaveLength(0)
  await draft.getByRole("button", { name: "Commit", exact: true }).press("Enter")
  await expect.poll(() => writes.length).toBe(1)
  await say(page, "/stack")
  const stack = page.getByRole("list", { name: "Stack", exact: true }).last()
  await expect(stack).toContainText(/J7 TODO 1[\s\S]*J7 TODO 2[\s\S]*Add jitter[\s\S]*J7 TODO 3/)
  await say(page, "/todo T2")
  await expect(page.getByRole("article", { name: "TODO T2" }).last()).toContainText("Working", { timeout: 30_000 })
  await say(page, "/todo.amend T2 Also log each retry.")
  await expect.poll(() => writes.length, { timeout: 30_000 }).toBe(2)
  expect(writes[1]).toMatchObject({ method: "PATCH", body: { prompt: "Also log each retry." } })
  await say(page, "/todo T2")
  const card = page.getByRole("article", { name: "TODO T2" }).last()
  await expect(card.getByText("+1", { exact: true })).toBeVisible()
  await expect(card.locator("header .state")).toContainText("Working")
  expect(models[1]!.prompt_revisions.map(revision => revision.text)).toEqual([fixtures.working.model.prompt_revisions[0]!.text, "Also log each retry."])
  expect(models[1]!.branch).toEqual(originalBranch)
  expect(models[1]!.run).toEqual(originalRun)
  expect(models).toHaveLength(4)
  expect(writes.every(write => write.key.length > 0)).toBe(true)
  expect(new Set(writes.map(write => write.key)).size).toBe(2)
  await expect(page.getByRole("region", { name: "Notifications" }).getByText("Amended", { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.reload()
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible({ timeout: 60_000 })
  await say(page, "/stack")
  await expect(page.getByRole("list", { name: "Stack", exact: true }).last()).toContainText(/J7 TODO 1[\s\S]*J7 TODO 2[\s\S]*Add jitter[\s\S]*J7 TODO 3/)
  expect(writes).toHaveLength(2)
})

// Amend's real seam is independent of the placement and candidate-ancestry
// scenario above, whose remaining reference-host providers are still required.
test("C-J7-01: Amend uses PATCH and adds one revision to the same TODO", async ({ page }) => {
  await owner(page)
  let model = { ...fixtures.working.model, prompt_revisions: fixtures.working.model.prompt_revisions.slice(0, 1) }
  const requests: { method: string; body: unknown }[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/12", async route => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON()
      requests.push({ method: "PATCH", body })
      model = { ...model, prompt_revisions: [...model.prompt_revisions, {
        text: body.prompt, acceptance: [], by: model.prompt_revisions[0]!.by, at: "2026-10-06T00:00:00Z"
      }] }
      await route.fulfill({ status: 202, json: { state: "accepted", n: 12, rev: 2, attempt: 1 } })
    } else await route.fulfill({ json: model })
  })
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "/todo T12")
  await expect(page.getByText("Attempt 1", { exact: true }).last()).toBeVisible()
  await say(page, "/todo.amend T12 Also log each retry.")
  await expect.poll(() => requests).toEqual([{ method: "PATCH", body: { prompt: "Also log each retry." } }])
  await say(page, "/todo T12")
  await expect(page.getByText("+1", { exact: true }).last()).toBeVisible()
  expect(model.n).toBe(12)
  expect(model.run?.id).toBe("run-41")
  expect(model.branch?.id).toBe("todo-12")
})

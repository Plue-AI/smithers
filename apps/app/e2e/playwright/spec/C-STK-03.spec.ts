import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { issueTodoInstall } from "./issue-todo-fixture"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

// Real installed app seam and card against a controlled HTTP provider. Durable
// execution and PostgreSQL admission have separate tests; this is not a microVM receipt.
for (const initialState of ["working", "in_review"] as const) test(`C-STK-03: Stop and Resume retain the ${initialState} run across reload and wait for execution`, async ({ page }) => {
  test.setTimeout(120_000)
  await issueTodoInstall(page)
  const model = structuredClone(fixtures.working.model)
  model.n = 1
  model.state = initialState
  model.run!.executing = true
  const originalRun = structuredClone(model.run)
  const originalSteps = structuredClone(model.steps)
  const originalEvidence = structuredClone(model.evidence)
  const writes: { body: unknown; key: string }[] = []
  let admit!: () => void
  const admission = new Promise<void>(resolve => { admit = resolve })
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/1", async route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: model })
    const body = route.request().postDataJSON()
    writes.push({ body, key: route.request().headers()["idempotency-key"]! })
    if (body.op === "stop") await admission
    return route.fulfill({ status: 202, json: { state: "accepted", n: 1, attempt: model.run!.attempt } })
  })
  await page.goto("/")
  await say(page, "/todo T1")
  const card = () => page.getByRole("article", { name: "TODO T1" }).last()
  const notice = page.locator('.notice[data-tone="live"]').filter({ hasText: model.title })
  await card().getByRole("button", { name: "Stop", exact: true }).press("Enter")
  await expect.poll(() => writes.length).toBe(1)
  await expect(notice).toBeVisible()
  await say(page, "/todo.stop T1")
  await say(page, "/todo T1")
  expect(writes).toHaveLength(1)
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await expect(card().locator("header .state")).toContainText(initialState === "working" ? "Working" : "In review")
  admit()
  await expect(notice).toBeVisible()
  model.state = "paused"
  model.pause = { reason: "person", since: "2026-10-07T00:00:00Z" }
  await expect(card().locator("header .state")).toContainText("Paused")
  await expect(notice).toHaveCount(0)
  await page.reload()
  await say(page, "/todo T1")
  await card().getByRole("button", { name: "Resume", exact: true }).press("Enter")
  await expect.poll(() => writes.length).toBe(2)
  await expect(notice).toBeVisible()
  model.state = "queued"
  await expect(card().locator("header .state")).toContainText("Queued")
  await expect(notice).toBeVisible()
  model.state = "starting"
  await expect(card().locator("header .state")).toContainText("Starting")
  await expect(notice).toBeVisible()
  model.state = "working"
  model.pause = undefined
  await expect(card().locator("header .state")).toContainText("Working")
  await expect(notice).toHaveCount(0)
  expect(model.run).toEqual(originalRun)
  expect(model.steps).toEqual(originalSteps)
  expect(model.evidence).toEqual(originalEvidence)
  // Reload can reconnect an unacknowledged request using its original key.
  // Each logical control has one key and every replay retains its body.
  const controls = [...new Map(writes.map(write => [write.key, write.body])).values()]
  expect(controls).toEqual([{ op: "stop" }, { op: "resume" }])
  for (const write of writes) expect(write.body).toEqual(writes.find(first => first.key === write.key)!.body)
  expect(new Set(writes.map(write => write.key)).size).toBe(2)
  expect(writes.every(write => write.key.length > 0)).toBe(true)
})

import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

// Production app dispatcher and seam; composed PostgreSQL HTTP proof lives in
// todo_interrupted_integration_test.go. Guest execution requires the mini.
test("current-flow Retry submits the steer once and retains earlier evidence", async ({ page }) => {
  await owner(page)
  const model: TodoCard = structuredClone(fixtures.failed.model)
  model.n = 2
  const earlier = structuredClone(model.evidence)
  const writes: { key: string; body: unknown }[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/2", async route => {
    if (route.request().method() === "POST") {
      writes.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() })
      model.state = "queued"
      delete model.failure
      await route.fulfill({ status: 202, json: { state: "accepted", attempt: 2 } })
    } else await route.fulfill({ json: model })
  })
  await page.goto("/")
  await say(page, "/todo T2")
  const card = page.getByRole("article", { name: "TODO T2" }).last()
  const button = card.getByRole("button", { name: "Retry with the current flow", exact: true })
  await expect(button).toBeVisible()
  // Each Retry door owns its optional steer.
  await card.getByLabel("Steer", { exact: true }).last().fill("use the new helper")
  await button.press("Enter")
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]!.body).toEqual({ op: "retry-current-flow", steer: "use the new helper" })
  expect(writes[0]!.key).toBeTruthy()
  expect(model.evidence).toEqual(earlier)
})

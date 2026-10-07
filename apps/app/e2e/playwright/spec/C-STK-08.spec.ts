import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { issueTodoInstall } from "./issue-todo-fixture"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

// Installed app seam/card with a controlled HTTP projection. PostgreSQL wait
// ordering and actual GitHub/microVM observations have separate receipts.
test("C-STK-08: Resume retains independent questions and an external merge wins", async ({ page }) => {
  await issueTodoInstall(page)
  const model = structuredClone(fixtures.needs_you.model)
  model.n = 1
  model.pause = { reason: "person", since: "2026-10-07T00:00:00Z" }
  const originalWaits = structuredClone(model.waits)
  const writes: unknown[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/1", route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: model })
    writes.push(route.request().postDataJSON())
    model.control_failure = undefined
    return route.fulfill({ status: 202, json: { state: "accepted", n: 1, attempt: model.run!.attempt } })
  })
  await page.goto("/")
  await say(page, "/todo T1")
  const card = () => page.getByRole("article", { name: "TODO T1" }).last()
  const notice = page.locator('.notice[data-tone="live"]').filter({ hasText: model.title })
  await expect(card().locator("header .state")).toContainText("Needs you")
  await expect(card().getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await card().getByRole("button", { name: "Resume", exact: true }).press("Enter")
  await expect.poll(() => writes.length).toBe(1)
  await expect(notice).toBeVisible()
  model.control_failure = { op: "resume", message: "Resume failed" }
  await expect(notice).toHaveCount(0)
  await expect(page.getByText("Resume failed", { exact: true })).toBeVisible()
  await expect(card().getByRole("button", { name: "Answer", exact: true })).toBeVisible()
  await card().getByRole("button", { name: "Resume", exact: true }).press("Enter")
  await expect.poll(() => writes.length).toBe(2)
  await expect(notice).toBeVisible()
  model.pause = undefined
  await expect(notice).toHaveCount(0)
  await expect(card().locator("header .state")).toContainText("Needs you")
  await expect(card().getByRole("button", { name: "Answer", exact: true })).toBeVisible()
  expect(model.waits).toEqual(originalWaits)
  expect(writes).toEqual([{ op: "resume" }, { op: "resume" }])
  // A later authoritative terminal projection supersedes all prior waits.
  model.state = "merged"
  model.waits = []
  model.merge = { state: "done", on_github: true }
  await expect(card().locator("header .state")).toContainText("Merged")
  await expect(card().getByRole("button", { name: "Answer", exact: true })).toHaveCount(0)
  await page.reload()
  await say(page, "/todo T1")
  await expect(card().locator("header .state")).toContainText("Merged")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

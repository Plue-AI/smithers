import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { recoveryFixture } from "./github-recovery-fixture"

// Mounted install provider, not a microVM crash qualification receipt.
test("C-DUR-02: interrupted work waits for explicit pinned Retry", async ({ page }) => {
  const model: TodoCard = { ...structuredClone(fixtures.failed.model), n: 1 }
  model.failure = { step: "runtime", class: "interrupted", message: "Interrupted", retryable: true }
  model.flow_version = { flow_name: "todo", source_commit: "a".repeat(40), digest: "b".repeat(64) }
  model.run = { id: "run-1", attempt: 1, indicators: [] }
  const fixture = await recoveryFixture(page, model)
  await fixture.open()
  await expect(fixture.card()).toContainText("Interrupted")
  await fixture.reload()
  await expect(fixture.card()).toContainText("Interrupted")
  expect(fixture.writes).toEqual([])
  await fixture.card().getByRole("button", { name: "Retry", exact: true }).press("Enter")
  await expect.poll(() => fixture.writes.length).toBe(1)
  expect(fixture.writes[0]!.body).toEqual({ op: "retry" })
  expect(fixture.writes[0]!.key).toBeTruthy()
  model.state = "working"
  model.failure = undefined
  model.run = { id: "run-2", attempt: 2, indicators: [] }
  await fixture.publish()
  await expect(fixture.card()).toContainText("Working")
  await expect(fixture.card()).toContainText("required-ci")
  await fixture.reload()
  await expect(fixture.card()).toContainText("Working")
  await expect(fixture.card()).toContainText("required-ci")
  expect(fixture.writes).toHaveLength(1)
})

// Mounted projection only: the recorded interrupted attempt survives reload.
test("C-DUR-02: Recorded machine interruption remains visible after reload", async ({ page }) => {
  await page.goto("/")
  await say(page, "/run run-retry-1")
  await expect(page.getByText("Interrupted", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Edited 1 file", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByText("Interrupted", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Edited 1 file", { exact: true })).toHaveCount(1)
  await expect(page.locator("[data-kind=run]").last()).toBeVisible()
  await expect(page.locator("[data-kind=run]").last().getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
})

// The installed Run card uses the same todo.retry flow as the TODO card.
test("C-DUR-02: live Run Retry dispatches the pinned TODO command", async ({ page }) => {
  const model: TodoCard = { ...structuredClone(fixtures.failed.model), n: 1 }
  model.failure = { step: "runtime", class: "interrupted", message: "Interrupted", retryable: true }
  const run = {
    id: "native-interrupted", flow: "todo", version: "b".repeat(64), title: "Interrupted checks", todo: 1, state: "interrupted" as const,
    attempts: [{ n: 1, run_id: "native-interrupted", state: "interrupted" as const, graph: [], steps: [], phases: [] }],
    waits: [], tokens: 1200, time_s: 2, cost_usd: 0.12, engine: [], journal: []
  }
  const fixture = await recoveryFixture(page, model, run)
  await fixture.open()
  await say(page, "/run.inspect native-interrupted")
  const card = page.getByRole("region", { name: "Run Interrupted checks", exact: true })
  await expect(card).toContainText("Interrupted")
  await expect(card.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
  expect(fixture.writes).toEqual([])
  await card.getByRole("button", { name: "Retry", exact: true }).press("Enter")
  await expect.poll(() => fixture.writes.length).toBe(1)
  expect(fixture.writes[0]!.body).toEqual({ op: "retry" })
  expect(fixture.writes[0]!.key).toBeTruthy()
})

import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"

import { issueTodoInstall } from "./issue-todo-fixture"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { TodoCard } from "@smthrs/rpc/TodoCard"

// UI projection of .specs/engineering/checks/C-STK-01.md.
// App flow/card proof with HTTP contracts. Full transition and real-guest receipts remain separate.
test("C-STK-01: stop and resume preserve the TODO and a question refuses Stop", async ({ page }) => {
  await issueTodoInstall(page)
  const todos: TodoCard[] = [
    { ...structuredClone(fixtures.working.model), n: 2 },
    { ...structuredClone(fixtures.needs_you.model), n: 3 },
    { ...structuredClone(fixtures.failed.model), n: 4 },
    { ...structuredClone(fixtures.merged.model), n: 5 }
  ]
  const originalSteps = structuredClone(todos[0]!.steps)
  const originalRun = structuredClone(todos[0]!.run)
  const earlier = structuredClone(todos[2]!.evidence)
  const writes: { n: number; body: Record<string, unknown>; key: string }[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: todos }))
  await page.route(url => /^\/api\/todos\/\d+$/.test(url.pathname), route => {
    const n = Number(new URL(route.request().url()).pathname.split("/").pop())
    const model = todos.find(todo => todo.n === n)!
    if (route.request().method() !== "POST") return route.fulfill({ json: model })
    const body = route.request().postDataJSON()
    writes.push({ n, body, key: route.request().headers()["idempotency-key"]! })
    if (body.op === "stop") { model.state = "paused"; model.pause = { reason: "person", since: "2026-10-08T00:00:00Z" } }
    if (body.op === "resume") { model.state = "queued"; delete model.pause }
    if (body.op === "retry") {
      model.state = "queued"; delete model.failure
      model.steers.push({ text: body.steer, by: { ...model.owner, kind: "person", color_index: 0 }, at: "2026-10-08T00:00:00Z" })
    }
    return route.fulfill({ status: 202, json: { state: "accepted", n, attempt: body.op === "retry" ? 2 : 1 } })
  })
  await page.goto("/")
  const card = () => page.getByRole("article", { name: /^TODO T/ }).last()
  await say(page, "/todo T2")
  await expect(card().locator("header .state")).toContainText("Working")
  await card().getByRole("button", { name: "Stop", exact: true }).last().press("Enter")
  await expect(card().locator("header .state")).toContainText("Paused")
  await page.reload()
  await say(page, "/todo T2")
  await card().getByRole("button", { name: "Resume", exact: true }).last().press("Enter")
  await expect(card().locator("header .state")).toContainText("Queued")
  todos[0]!.state = "working"
  await expect(card().locator("header .state")).toContainText("Working")
  await expect(card().getByRole("list", { name: "Flow steps" })).toContainText("Plan")
  expect(todos[0]!.steps).toEqual(originalSteps)
  expect(todos[0]!.run).toEqual(originalRun)
  await say(page, "/todo T3")
  await expect(card().locator("header .state")).toContainText("Needs you")
  await expect(card().getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await expect(card().getByRole("button", { name: "Answer", exact: true }).last()).toBeVisible()
  await say(page, "/todo T4")
  await expect(card().locator("header .state")).toContainText("Failed")
  await card().getByLabel("Steer", { exact: true }).first().fill("Use the existing retry helper")
  await card().getByRole("button", { name: "Retry", exact: true }).last().press("Enter")
  await expect(card().locator("header .state")).toContainText("Queued")
  await expect(card().getByText("Use the existing retry helper", { exact: true }).last()).toBeVisible()
  await say(page, "/todo T5")
  await expect(card().locator("header .state")).toContainText("Merged")
  expect(todos[2]!.evidence).toEqual(earlier)
  expect(writes.map(write => ({ n: write.n, body: write.body }))).toEqual([
    { n: 2, body: { op: "stop" } }, { n: 2, body: { op: "resume" } },
    { n: 4, body: { op: "retry", steer: "Use the existing retry helper" } }
  ])
  expect(writes.every(write => Boolean(write.key))).toBe(true)
  for (const name of ["Stop", "Resume", "Retry", "Drop"]) {
    await expect(card().getByRole("button", { name, exact: true })).toHaveCount(0)
  }
})

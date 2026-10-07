import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { say, sourceReady } from "./j1-fixtures"
import type { InstallModel } from "../../../src/mainview/state/seams/InstallModel"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

// Mounted install providers exercise the production seam, dispatcher and cards.
// Real detection/layer builds have composed-router and microVM receipts;
// this browser projection does not replace reference-host C-J1-06 qualification.
for (const [repository, checks] of [
  ["node", ["pnpm test", "pnpm lint"]],
  ["go", ["go test ./..."]]
] as const) {
  test(`C-J1-06: ${repository} source precedes machine readiness and checks reach the TODO card`, async ({ page }) => {
    const fullName = `smithers-mvp-canary/${repository}`
    await installCloudFixture(page, { capabilities: ["identity", "install"], repos: [{
      owner: "smithers-mvp-canary", name: repository, full_name: fullName, default_bookmark: "main", owner_type: "User"
    }] })
    await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
    let model: InstallModel = { ...installFixture(), repository: { owner: "smithers-mvp-canary", name: repository }, repositories: [fullName] }
    model = { ...model, steps: model.steps.map(step => step.id === "machine" ? { ...step, state: "running", pct: 20 } : step) }
    await page.route("**/api/install", route => route.fulfill({ json: model }))
    let publish: (() => void) | undefined
    let cursor = 0
    await page.routeWebSocket("**/api/live", socket => {
      socket.onMessage(raw => {
        const frame = JSON.parse(String(raw))
        if (frame.t === "sub" && frame.topic === "install") {
          publish = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: ++cursor, data: model }))
          publish()
        }
      })
    })
    const todo = { ...fixtures.in_review.model, n: 1, title: "Add sum", pr: {
      ...fixtures.in_review.model.pr!, url: `https://github.com/${fullName}/pull/1`
    }, evidence: [{ attempt: 1, revision: "4bc79ae", items: checks.map(name => ({ kind: "check" as const, name, state: "passed" as const, took_s: 1 })) }] }
    await page.route("**/api/todos", route => route.fulfill({ json: [todo] }))
    await page.route("**/api/todos/1", route => route.fulfill({ json: todo }))
    await page.goto("/setup")
    await sourceReady(page)
    await expect(page.getByTestId("composer-input")).toBeEditable()
    await page.reload()
    await sourceReady(page)
    await expect.poll(() => !!publish).toBe(true)
    model = { ...model, steps: model.steps.map(step => step.id === "machine" ? { ...step, state: "failed", error: { class: "user", code: "layer_failed", message: "Dependency install failed" } } : step) }
    publish!()
    const setup = page.getByRole("region", { name: "Set up Smithers" })
    await expect(setup.getByRole("alert")).toHaveText("user")
    await setup.getByText("Details", { exact: true }).click()
    await expect(setup.getByRole("region", { name: "Failure details" })).toContainText("Dependency install failed")
    await sourceReady(page)
    model = { ...model, steps: model.steps.map(step => step.id === "machine" ? { id: step.id, state: "done", pct: 100 } : step) }
    publish!()
    await expect(page.getByText("Machine ready", { exact: true })).toBeVisible()
    await expect(page.getByText("Source ready", { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByText("Machine ready", { exact: true })).toBeVisible()
    await expect(page.getByText("Source ready", { exact: true })).toBeVisible()
    await say(page, "/todo T1")
    const card = page.locator('.smithers-card[data-kind="todo"]').last()
    await expect(card).toContainText("In review")
    for (const check of checks) await expect(card).toContainText(check)
    await expect(card.getByRole("link", { name: /on GitHub/ }).first()).toHaveAttribute("href", todo.pr.url)
    await expect(page.getByText(/commit.*\.smithers\/|target index/i)).toHaveCount(0)
  })
}

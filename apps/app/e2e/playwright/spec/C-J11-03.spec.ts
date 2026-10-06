import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { say } from "./j1-fixtures"

// Browser proof of the production command/card/seam wiring. PostgreSQL and
// credential refusals are exercised by model_routes_owner_test.go.
test("C-J11-03: the owner switches the reviewer model immediately", async ({ page }) => {
 await installCloudFixture(page, { capabilities: ["agent", "identity", "install"] })
 await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
 let model = "model-a"
 const snapshot = () => ({ native: false, canAssign: true, agents: [
  { id: "planner", label: "Planner agent", purpose: "", model: { id: "model-a", label: "model-a", provider: "openai-responses" }, builtin: true, available: false, account: "", reason: "", source: "owner", instructions: "flows/todo/flow.ts" },
  { id: "implementer", label: "Implementer agent", purpose: "", model: { id: "model-a", label: "model-a", provider: "openai-responses" }, builtin: true, available: false, account: "", reason: "", source: "owner", instructions: "flows/todo/flow.ts" },
  { id: "reviewer", label: "Reviewer agent", purpose: "", model: { id: model, label: model, provider: "openai-responses" }, binding: { protocol: "openai-responses", modelId: model, credential: "OPENAI_API_KEY" }, builtin: true, available: false, account: "", reason: "", source: "owner", instructions: "flows/todo/flow.ts" },
  { id: "app", label: "App agent", purpose: "", runs: [{ id: "turn-before-switch", model: "model-old" }, { id: "turn-after-switch", model: "model-f" }], model: { id: "model-f", label: "model-f", provider: "openai-chat" }, builtin: true, available: false, account: "", reason: "", source: "owner", instructions: ".smithers/instructions/app.md" }
 ] })
 await page.route("**/api/agents", route => route.fulfill({ json: snapshot() }))
 const writes: unknown[] = []
 await page.route("**/api/agents/reviewer/model", async route => {
  const body = route.request().postDataJSON(); writes.push(body); model = body.model.modelId
  await route.fulfill({ json: snapshot() })
 })
 await page.route("**/api/model/test", route => route.fulfill({ json: { ok: true, latencyMs: 2, sample: "ok" } }))
 await page.goto("/smithers-mvp-canary/node")
 await say(page, "/agents")
 for (const name of ["Planner agent", "Implementer agent", "Reviewer agent", "App agent"])
  await expect(page.getByText(name, { exact: true }).last()).toBeVisible()
 await expect(page.getByTestId("agent-recent-runs-app")).toContainText("turn-before-switch · model-old")
 await expect(page.getByTestId("agent-recent-runs-app")).toContainText("turn-after-switch · model-f")
 await page.getByTestId("agent-model-reviewer").press("Enter")
 await page.getByLabel("Model", { exact: true }).last().fill("model-b")
 await expect(page.getByRole("button", { name: "Save", exact: true }).last()).toBeEnabled()
 await page.getByRole("button", { name: "Save", exact: true }).last().press("Enter")
 await expect(page.locator('[data-agent="reviewer"]')).toContainText("model-b")
 expect(writes).toEqual([{ model: { protocol: "openai-responses", modelId: "model-b", credential: "OPENAI_API_KEY" } }])
 await page.reload()
 await say(page, "/agents")
 await expect(page.locator('[data-agent="reviewer"]')).toContainText("model-b")
 await expect(page.locator('[data-agent="app"] [data-flow="files.read"]')).toBeVisible()
 await say(page, "/agent reviewer")
 await expect(page.locator("[data-agent]")).toHaveCount(1)
 await expect(page.locator('[data-agent="reviewer"]')).toBeVisible()
 await say(page, '/model.save {"name":"review-c","protocol":"openai-responses","modelId":"model-c","credential":"OPENAI_API_KEY"}')
 const record = page.locator('[data-model-id="review-c"]')
 await expect(record).toContainText("model-c")
 await record.getByRole("button", { name: "Test", exact: true }).press("Enter")
 await expect(record).toContainText("2 ms")
 await say(page, "/model.assign reviewer review-c")
 await expect(page.locator('[data-agent="reviewer"]')).toContainText("model-c")
 await record.getByRole("button", { name: "Edit", exact: true }).press("Enter")
 await expect(page.getByRole("button", { name: "Save", exact: true }).last()).toBeVisible()
 await record.getByRole("button", { name: "Remove", exact: true }).press("Enter")
 await expect(record).toHaveCount(0)
 await say(page, "/help")
 await expect(page.getByText("model.compose", { exact: true })).toHaveCount(0)
 await expect(page.getByText("model.ask", { exact: true })).toHaveCount(0)
})

test("C-J11-03: merged instructions and already running TODO calls use the next binding", async () => {
 test.fixme(true, "Requires verified Active-main instruction data and trusted per-call factory role binding in the coding host")
})

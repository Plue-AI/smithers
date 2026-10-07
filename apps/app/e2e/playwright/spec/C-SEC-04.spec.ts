import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// UI projection of .specs/engineering/checks/C-SEC-04.md; not a qualification receipt.
// Requires fresh install setup tokens, simultaneous OAuth callbacks, restart rotation and GitHub access verification.
// mvp.md J1.1, J1.2; T-ACC-01, T-INS-06 and T-INS-08.
test("C-SEC-04: pre-claim Setup keeps TODO and Members controls closed", async ({ page }) => {
  // HTTP projection only: the composed PostgreSQL tests qualify setup
  // credential validity, claim concurrency and owner permission separately.
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route("**/api/user", route => route.fulfill({ status: 401,
    json: { class: "permission", code: "unauthenticated", message: "Sign in again" } }))
  const model = installFixture()
  model.github = { signed_in: false, app_installed: false }
  model.repository = undefined
  model.steps = model.steps.map(step => ({ ...step, state: step.id === "address" ? "done" : "pending" }))
  await page.route("**/api/install", route => route.fulfill({ json: model }))
  const writes: string[] = []
  for (const path of ["/api/todos", "/api/members"]) await page.route(`**${path}`, route => {
    if (route.request().method() !== "GET") writes.push(path)
    return route.fulfill({ status: 403, json: { class: "permission", code: "permission", message: "Permission denied" } })
  })
  await page.goto("/setup")
  await expect(page.getByRole("region", { name: "Set up Smithers" })).toBeVisible()
  await say(page, "/todo.new")
  await expect(page.getByRole("button", { name: "Commit", exact: true })).toHaveCount(0)
  await say(page, "/members")
  await expect(page.getByLabel("GitHub username", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("region", { name: "Set up Smithers" })).toBeVisible()
  // Reload keeps the setup projection and refuses work again.
  await say(page, "/todo.new")
  await expect(page.getByRole("button", { name: "Commit", exact: true })).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Set up Smithers" })).toBeVisible()
  expect(writes).toEqual([])
})

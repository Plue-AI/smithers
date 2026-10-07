import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// UI projection; real quota admission, UTC reset, storage and key confinement
// are exercised independently by TestFastGateway*Postgres against the composed router.
test("C-FM-02: daily gateway quota leaves Chat usable without billing", async ({ page }) => {
  await owner(page)
  const model = installFixture()
  model.fast_model = {
    signed_in: true, source: "coding model", cause: "capacity",
    remaining: 0, reset_at: "2026-10-08T00:00:00Z"
  }
  await page.route("**/api/install", route => route.fulfill({ json: model }))
  await page.goto("/")
  await say(page, "/settings")
  const access = page.getByTestId("fast-model-access").last()
  const refusal = "Fast model: daily Smithers quota used; using coding model until 00:00 UTC"
  await expect(access.getByRole("status")).toHaveText(refusal)
  await expect(access.getByText("0 tokens left · 00:00 UTC", { exact: true })).toBeVisible()
  await expect(page.getByText(/billing|credit card/i)).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await say(page, "What needs me?")
  await expect(page.getByText("Needs you", { exact: true }).first()).toBeVisible()

  await page.reload()
  await say(page, "/settings")
  await expect(access.getByRole("status")).toHaveText(refusal)
  await expect(page.getByTestId("composer-input")).toBeEditable()

  // Project the host's refreshed status after the gateway's UTC boundary.
  model.fast_model = {
    signed_in: true, source: "Smithers", remaining: 100_000,
    reset_at: "2026-10-09T00:00:00Z"
  }
  await say(page, "/settings")
  await expect(access.getByText("100000 tokens left · 00:00 UTC", { exact: true })).toBeVisible()
  await expect(access.getByRole("status")).toHaveCount(0)
  await expect(access.getByText("Smithers", { exact: true })).toBeVisible()
  await say(page, "What needs me?")
  await expect(page.getByText("Needs you", { exact: true }).first()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

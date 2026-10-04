import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-INS-05.md; not a qualification receipt.
// Written before implementation: mvp.md J1.1, §6.1 Install on a Mac; lands with T-INS-01, T-INS-02
test("C-INS-05: Relocated bundle exposes persistent setup and machine readiness", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1.1, §6.1 Install on a Mac; lands with T-INS-01, T-INS-02")
  // Folded check: build layout, hashes, PG18, offline boot and missing-library
  // refusal are T-INS-01/T-INS-02 integration checks, never browser claims.
  // Seed setup after a relocated-bundle start and after its stop/start.
  await page.goto("/setup")
  const card = page.getByRole("region", { name: "Set up Smithers" })
  await expect(card).toBeVisible()
  await expect(card.getByText("Source ready", { exact: true })).toBeVisible()
  await expect(card.getByText("Machine ready", { exact: true })).toBeVisible()
  await page.reload()
  await expect(card.getByText("Source ready", { exact: true })).toBeVisible()
  await expect(card.getByText("Machine ready", { exact: true })).toBeVisible()
  await say(page, "where do we retry webhooks?")
  await expect(page.getByText("src/webhooks/retry.ts", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("textbox").last()).toBeEditable()
})

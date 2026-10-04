import { expect, test } from "../browserTest"

// UI projection of .specs/engineering/checks/C-INS-06.md; not a qualification receipt.
// Written before implementation: mvp.md J1.1, §6.1 Install on a Mac, §11 stage 1; lands with T-INS-08
test("C-INS-06: Service restart retains the setup session and completed steps", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1.1, §6.1 Install on a Mac, §11 stage 1; lands with T-INS-08")
  // Seed service recovery with GitHub App complete and model access pending.
  // launchd, process UID, reboot, readiness timing and handoff secrecy are host evidence.
  await page.goto("/setup")
  const card = page.getByRole("region", { name: "Set up Smithers" })
  await expect(card).toBeVisible()
  await expect(card.getByText("GitHub App", { exact: true })).toBeVisible()
  await expect(card.getByRole("button", { name: "Create GitHub App", exact: true })).toHaveCount(0)
  await expect(card.getByText("Model access", { exact: true })).toBeVisible()
  await page.reload()
  await expect(card).toBeVisible()
  await expect(card.getByRole("button", { name: "Create GitHub App", exact: true })).toHaveCount(0)
  await expect(card.getByText("Model access", { exact: true })).toBeVisible()
  await expect(card.getByText("Source ready", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("textbox").last()).toBeEditable()
})

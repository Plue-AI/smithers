import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-GH-01.md.
// Requires scenario-specific seeded events; backend and reference-host receipts remain separate.
// Written before implementation: mvp.md J1.2, §6.3; lands with T-GH-01
test("C-GH-01: localhost App setup claims the owner before selecting a repository", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1.2, §6.3; lands with T-GH-01")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Required seed: token-backed fresh localhost setup, manifest callback,
  // owner callback and installation callback. Real GitHub/security receipts are separate.
  await say(page, "/setup")
  const card = page.getByRole("region", { name: "Set up Smithers" })
  await card.getByRole("button", { name: "This Mac only", exact: true }).press("Enter")
  await card.getByRole("button", { name: "Create the GitHub App", exact: true }).press("Enter")
  await expect(card).toContainText("App created")
  await expect(card.getByRole("button", { name: "acme/api", exact: true })).toBeDisabled()
  await card.getByRole("button", { name: "Sign in with GitHub", exact: true }).press("Enter")
  await expect(card).toContainText("Owner")
  await card.getByRole("button", { name: "acme/api", exact: true }).press("Enter")
  await expect(card).toContainText("App installed")
  await expect(card).not.toContainText("PRIVATE KEY")
  await page.reload()
  await say(page, "/setup")
  await expect(page.getByRole("region", { name: "Set up Smithers" })).toContainText("App installed")
  await expect(page.getByRole("button", { name: "Create the GitHub App", exact: true })).toHaveCount(0)
})

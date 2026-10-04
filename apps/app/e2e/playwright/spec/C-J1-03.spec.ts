import { expect, test } from "../browserTest"
import { owner, say, sourceReady } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J1-03.md.
// Real host, GitHub, installation and timing receipts remain in the reference-host check.
// Seed requirements: canary Node/Go repositories, owner, held image build,
// mirrored src/mail/expiry.ts, and the access outcomes named below.
// Written before implementation: mvp.md J1; lands with T-APP-15
test("C-J1-03: Source-ready questions show mirrored files while the image builds", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1; lands with T-APP-15")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  await sourceReady(page)
  await say(page, "where do we send the expiry email?")
  const file = page.getByText("src/mail/expiry.ts", { exact: true }).first()
  await expect(file).toBeVisible()
  await file.press("Enter")
  await expect(page.getByText(/function sendExpiryEmail/)).toBeVisible()
  await page.getByRole("button", { name: "Maximize card", exact: true }).last().press("Enter")
  await page.getByText("sendExpiryEmail", { exact: true }).first().hover()
  await page.getByText("sendExpiryEmail", { exact: true }).first().click({ modifiers: ["ControlOrMeta"] })
  await expect(page.getByRole("alert")).toHaveCount(0)
  await sourceReady(page)
  await expect(page.getByText("Starting", { exact: true })).toHaveCount(0)
})

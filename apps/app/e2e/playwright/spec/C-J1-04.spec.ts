import { expect, test } from "../browserTest"
import { firstTodo, owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J1-04.md.
// Real host, GitHub, installation and timing receipts remain in the reference-host check.
// Seed requirements: canary Node/Go repositories, owner, held image build,
// mirrored src/mail/expiry.ts, and the access outcomes named below.
// Written before implementation: mvp.md J1; lands with T-APP-02
test("C-J1-04: First TODO is reviewed and merged through the app", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1; lands with T-APP-02")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "where do we send the expiry email?")
  await expect(page.getByText("src/mail/expiry.ts", { exact: true }).first()).toBeVisible()
  await firstTodo(page, "Add a sum(a, b) export with a test")
  await expect(page.getByText("Checks", { exact: true }).first()).toBeVisible()
  await expect(page.getByRole("link", { name: /on GitHub/ }).first()).toBeVisible()
  await page.getByRole("button", { name: "Merge", exact: true }).first().press("Enter")
  await expect(page.getByText(/Merge T\d+ into main\?/)).toBeVisible()
  await page.getByRole("button", { name: "Merge", exact: true }).last().press("Enter")
  await expect(page.getByText(/Merged into main/)).toBeVisible()
  await page.reload()
  await expect(page.getByText(/Merged into main/)).toBeVisible()
})

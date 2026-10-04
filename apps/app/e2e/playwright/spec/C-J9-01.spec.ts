import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J9-01.md; not a qualification receipt.
// Written before implementation: mvp.md J9, §6.5, §6.11, Appendix A; lands with T-APP-02
test("C-J9-01: Repository answers become one committed TODO and an authored wiki page", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J9, §6.5, §6.11, Appendix A; lands with T-APP-02")
  await owner(page)
  await page.goto("/")
  await say(page, "where do we retry webhooks?")
  await expect(page.getByText("src/webhooks/retry.ts", { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/redeliver/).last()).toBeVisible()
  await expect(page.getByText("Webhooks", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "Make TODO", exact: true }).last().press("Enter")
  await expect(page.getByLabel("Prompt", { exact: true }).last()).toHaveValue(/retry.ts/)
  await page.getByLabel("Title", { exact: true }).last().fill("Document webhook retries")
  const commit = page.getByRole("button", { name: "Commit", exact: true }).last()
  await commit.press("Enter")
  await page.keyboard.press("Enter")
  await expect(page.getByText("Committed Document webhook retries", { exact: true })).toHaveCount(1)
  await page.getByRole("button", { name: "Save to wiki", exact: true }).last().press("Enter")
  await expect(page.getByText("Smithers for Ben", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("textbox").last()).toHaveValue(/retry.ts/)
  await say(page, "what calls redeliver?")
  await say(page, "make that a TODO")
  await expect(page.getByLabel("Title", { exact: true }).last()).toBeEditable()
  await say(page, "/wiki.save")
  await expect(page.getByRole("textbox").last()).toHaveValue(/redeliver/)
  // Alice's private-draft exclusion and exact SQL revisions need the real two-member fixture.
})

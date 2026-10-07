import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MCH-12.md; not a qualification receipt.
// Written before implementation: mvp.md §6.7, M-42; spec.md §8.8.1a, §8.8.1b; lands with T-MCH-16
test("C-MCH-12: declared secret file path persists without exposing its value", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.7, M-42; spec.md §8.8.1a, §8.8.1b; lands with T-MCH-16")
  // Seed a maintainer and a fresh branch machine. File ownership, modes,
  // symlink refusal and real relay substitution require broker/relay receipts.
  // The Path input and its design binding have not landed yet.
  await owner(page)
  await page.goto("/")
  await say(page, "/secrets")
  await page.getByLabel("Name", { exact: true }).fill("ANTHROPIC_API_KEY")
  await page.getByLabel("Value", { exact: true }).fill("cycle33-secret-value")
  await page.getByLabel("Hosts", { exact: true }).fill("api.anthropic.com")
  await page.getByLabel("Path", { exact: true }).fill("~/.config/anthropic/key")
  await page.getByRole("button", { name: "Add", exact: true }).press("Enter")
  await expect(page.getByText("~/.config/anthropic/key", { exact: true })).toBeVisible()
  await expect(page.getByText("cycle33-secret-value", { exact: true })).toHaveCount(0)
  await page.reload()
  await say(page, "/secrets")
  await expect(page.getByText("~/.config/anthropic/key", { exact: true })).toBeVisible()
  await say(page, "/todo.new")
  await page.getByLabel("Title", { exact: true }).fill("Use the provider key")
  await page.getByLabel("Prompt", { exact: true }).fill("Run the coding tool on a fresh machine using the install secret.")
  await page.getByRole("button", { name: "Commit", exact: true }).press("Enter")
  await expect(page.getByText("In review", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0)
  await say(page, "/secrets")
  await page.getByRole("button", { name: "Remove", exact: true }).last().press("Enter")
  await expect(page.getByText("~/.config/anthropic/key", { exact: true })).toHaveCount(0)
})

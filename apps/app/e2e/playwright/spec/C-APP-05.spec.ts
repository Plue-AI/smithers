import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-APP-05.md.
// Written before implementation: mvp.md §3 Conversation, §6.4, M-08; lands with T-APP-16
test("C-APP-05: a host turn finishes after its author closes the tab", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §3 Conversation, §6.4, M-08; lands with T-APP-16")
  // Seed a held host turn: this prompt stops T2, then asks privately to drop it.
  // Release it after the author closes the tab. Seed three Earlier archives.
  // Execution placement and retired write-route 404s require T-APP-16 integration receipts.
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "Stop T2, then drop T2")
  await expect(page.getByText("Stop T2, then drop T2", { exact: true }).last()).toBeVisible()
  const context = page.context()
  await page.close()
  const returned = await context.newPage()
  await owner(returned)
  await returned.goto("/smithers-mvp-canary/node")
  await expect(returned.getByText("Stop T2, then drop T2", { exact: true })).toHaveCount(1)
  await expect(returned.getByText("Paused", { exact: true }).last()).toBeVisible()
  await expect(returned.getByText("Drop T2?", { exact: true }).last()).toBeVisible()
  await expect(returned.getByText("Dropped", { exact: true })).toHaveCount(0)
  await returned.getByRole("button", { name: "Cancel", exact: true }).last().press("Enter")
  await returned.getByRole("button", { name: "Earlier", exact: true }).press("Enter")
  await expect(returned.getByRole("button", { name: /Legacy conversation/ })).toHaveCount(3)
  await returned.getByRole("button", { name: /Legacy conversation/ }).first().press("Enter")
  await expect(returned.getByText("Read-only", { exact: true }).last()).toBeVisible()
  await expect(returned.getByText("Archived greeting", { exact: true }).last()).toBeVisible()
  await expect(returned.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
})

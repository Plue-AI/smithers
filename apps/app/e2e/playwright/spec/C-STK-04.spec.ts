import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-STK-04.md.
// Requires seeded DesignWorld; backend race, tree and reference-host receipts remain separate.
// Written before implementation: mvp.md §4.2, J10; lands with T-GH-03
test("C-STK-04: an outside out-of-order merge retains the included change note", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §4.2, J10; lands with T-GH-03")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Seed GitHub delivery: T3 merged before T2, including both changes.
  // The delivery occurs after the first stack render; no browser mutation of state.
  await say(page, "/stack")
  await expect(page.getByText("T3 merged before T2; T2's change is in T3's commit", { exact: true }).last()).toBeVisible()
  const stack = page.getByRole("list", { name: "Stack", exact: true })
  for (const n of [2, 3]) {
    await expect(stack.getByRole("listitem").filter({ hasText: new RegExp(`\\bT${n}\\b`) })).toContainText("Merged")
  }
  await say(page, "/todo T2")
  const card = () => page.locator(".smithers-card").last()
  await expect(card()).toContainText("Merged")
  await expect(card()).toContainText("in T3's commit")
  await expect(card().getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await page.reload()
  await say(page, "/todo T2")
  await expect(card()).toContainText("in T3's commit")
  await say(page, "/todo T3")
  await expect(card()).toContainText("Merged")
})

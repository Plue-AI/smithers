import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-STK-02.md.
// Requires seeded DesignWorld; backend race, tree and reference-host receipts remain separate.
// Written before implementation: mvp.md §4.2, §6.6, M-06, M-13; lands with T-STK-03
test("C-STK-02: admission follows stack order and capacity", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §4.2, §6.6, M-06, M-13; lands with T-STK-03")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Seed capacity 3, parallel 2, T1/T2 Working and T3–T5 Queued.
  // Seeded scheduler releases T1 only after T6 is committed Before T3.
  await say(page, "/stack")
  const stack = page.getByRole("list", { name: "Stack", exact: true })
  const row = (n: number) => stack.getByRole("listitem").filter({ hasText: new RegExp(`\\bT${n}\\b`) })
  await expect(row(1)).toContainText("Working")
  await expect(row(2)).toContainText("Working")
  for (const [n, position] of [[3, 1], [4, 2], [5, 3]]) {
    await expect(row(n!)).toContainText(`waiting for a machine #${position}`)
  }
  await say(page, "/todo.new")
  await page.getByLabel("Title", { exact: true }).fill("Earlier queued work")
  await page.getByLabel("Prompt", { exact: true }).fill("Run before the waiting third item")
  await page.getByRole("button", { name: "Append", exact: true }).press("Enter")
  await page.getByRole("button", { name: /Before T3/ }).press("Enter")
  await page.getByRole("button", { name: "Commit", exact: true }).last().press("Enter")
  await say(page, "/stack")
  await expect(row(6)).toContainText("Working")
  await expect(row(3)).toContainText("waiting for a machine #1")
  await say(page, "/settings")
  for (let i = 0; i < 6; i++) await page.getByRole("button", { name: "More TODOs at once", exact: true }).press("Enter")
  await page.reload()
  await say(page, "/settings")
  await expect(page.getByRole("group", { name: "TODOs at once", exact: true }).getByText("8", { exact: true })).toBeVisible()
  await say(page, "/stack")
  await expect(row(3)).toContainText("Working")
  await expect(row(4)).toContainText("Queued")
  await expect(row(5)).toContainText("Queued")
})

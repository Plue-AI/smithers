import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-PERF-04.md; not a qualification receipt.
// SSH writes, file digests and second-Mac timing cannot be qualified by the seeded world.
// Written before implementation: mvp.md §6.8, §9; lands with T-COL-04, T-APP-11, T-REL-01
test("C-PERF-04: Outside writes refresh the File card without reload", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.8, §9; lands with T-COL-04, T-APP-11, T-REL-01")
  await owner(page)
  await page.goto("/")
  // Future live fixture supplies 200 spaced SSH writes by C over one persistent connection.
  await say(page, "/branch retry-webhooks")
  await say(page, "/file src/a.ts")
  const content = page.getByRole("group", { name: "src/a.ts", exact: true }).last()
  for (let i = 1; i <= 200; i++) await expect(content).toContainText(`// m${i}\n`)
  await say(page, "/branch retry-webhooks")
  await page.getByRole("tab", { name: /^Activity/ }).last().press("Enter")
  await expect(page.getByText("C via SSH changed 1 file", { exact: true })).toHaveCount(200)
})

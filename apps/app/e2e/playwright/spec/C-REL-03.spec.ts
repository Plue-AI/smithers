import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-REL-03.md; not a qualification receipt.
// Requires release N/N+1, host upgrade and restore fault fixtures and independently computed data digests; seeded reload is insufficient.
// Written before implementation: mvp.md §12.6, M-26; lands with T-INS-07
test("C-REL-03: Upgrade and restore retain branch working files", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §12.6, M-26; lands with T-INS-07")
  await owner(page)
  await page.goto("/")
  // External reference-host automation performs the upgrade while a TODO
  // works, then restores the deliberately failed migration on a backup copy.
  // The app remains the only browser interaction boundary.
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const terminal = page.getByRole("region", { name: / output$/ }).last()
  await terminal.click()
  await page.keyboard.type("printf cycle22-preserved > cycle22-uncommitted.txt")
  await page.keyboard.press("Enter")
  await expect(terminal).toContainText("cycle22-uncommitted.txt")
  // Host harness completes upgrade before this reload, and restore before
  // the second reload. D1/D2/D3 equality remains its independent obligation.
  for (const phase of ["upgrade", "restore"]) {
    await test.step(phase, async () => {
      await page.reload()
      await say(page, "/branch retry-webhooks")
      await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
      const output = page.getByRole("region", { name: / output$/ }).last()
      await output.click()
      await page.keyboard.type("cat cycle22-uncommitted.txt")
      await page.keyboard.press("Enter")
      await expect(output).toContainText("cycle22-preserved")
    })
  }
})

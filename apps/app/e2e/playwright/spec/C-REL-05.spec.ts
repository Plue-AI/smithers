import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-REL-05.md; not a qualification receipt.
// Requires 24 hours of independently authenticated tool calls and real sleep/wake; the seeded terminal does not execute commands.
// Written before implementation: mvp.md §6.8, J6.1; lands with T-REL-02
test("C-REL-05: Each machines own tool logins survive a wake in the soak", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.8, J6.1; lands with T-REL-02")
  await owner(page)
  await page.goto("/")
  // Reference-host scheduler repeats this UI probe every ten minutes for
  // 24 hours, sleeping upgrade-stripe every four hours. Independent machine
  // logins are preconditions; no token bytes are put in test artifacts.
  for (const branch of ["retry-webhooks", "upgrade-stripe"]) {
    await say(page, `/branch ${branch}`)
    await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
    const terminal = page.getByRole("region", { name: / output$/ }).last()
    await terminal.click()
    await page.keyboard.type('claude -p "ok" && codex exec "ok" && gh api user >/dev/null && printf cycle22-auth-ok')
    await page.keyboard.press("Enter")
    await expect(terminal).toContainText("cycle22-auth-ok")
    await expect(terminal).not.toContainText(/authentication error|Please log in|not logged in/)
    await page.getByRole("button", { name: "Close", exact: true }).last().press("Enter")
  }
})

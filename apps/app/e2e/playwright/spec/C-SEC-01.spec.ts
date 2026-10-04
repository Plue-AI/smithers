import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-SEC-01.md; not a qualification receipt.
// Requires production guests, host model proxy and root/capture/relay scans; terminal output alone is not isolation evidence.
// Written before implementation: mvp.md M-18, M-29, M-30, §6.15 Secrets, §9 Isolation; lands with T-MCH-12, T-FLW-01
test("C-SEC-01: Branch terminals receive only all-branches secrets", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md M-18, M-29, M-30, §6.15 Secrets, §9 Isolation; lands with T-MCH-12, T-FLW-01")
  await owner(page)
  await page.goto("/")
  // Live fixture provisions P/K/M/A sentinels through the production owner
  // settings. Scan artifacts contain hashes only; never print secret bytes.
  await say(page, "/secrets")
  await expect(page.getByLabel("Value", { exact: true }).last()).toHaveAttribute("type", "password")
  for (const branch of ["retry-webhooks", "ben/retry-try-2"]) {
    await say(page, `/branch ${branch}`)
    await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
    const output = page.getByRole("region", { name: / output$/ }).last()
    await output.click()
    // The fixture scanner searches sentinels, including process environments,
    // without emitting their values. It checks the positive control as well.
    await page.keyboard.type("node /tmp/secret-scan.mjs --hashes-only")
    await page.keyboard.press("Enter")
    await expect(output).toContainText("provider=0 app=0 main=0 all=present")
    await page.getByRole("button", { name: "Close", exact: true }).last().press("Enter")
  }
  // Main-background M/A visibility and run-proxy credential kind are verified
  // independently by C-SEC-01's integration runner, never inferred from UI.
})

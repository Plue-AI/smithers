import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-COL-04.md; not a qualification receipt.
// Written before implementation: mvp.md M-18, M-29, §9 Isolation, §6.8; lands with T-COL-03, T-TRM-07, T-MCH-11, T-COL-03a
test("C-COL-04: Branch terminal cannot read another member home or escalate", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md M-18, M-29, §9 Isolation, §6.8; lands with T-COL-03, T-TRM-07, T-MCH-11, T-COL-03a")
  await owner(page)
  await page.goto("/")
  // Seed: Ben's terminal on the real confined machine with Alice's private
  // token and an outside sentinel. Path races, FIFO/socket refusal, forged
  // identities, HMAC and process privilege assertions remain integration tests.
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const terminal = page.getByRole("textbox", { name: "Terminal input", exact: true }).last()
  for (const line of ["cat /home/alice/.codex/auth.json", "cat /run/smithers/20002/token", "sudo cat /etc/smithers-sentinel"]) {
    await terminal.fill(line)
    await terminal.press("Enter")
  }
  await expect(page.getByText(/Permission denied/).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Add to machine image", exact: true }).last()).toBeVisible()
  await expect(page.getByText("alice-private-token-sentinel", { exact: false })).toHaveCount(0)
  await expect(page.getByText("outside-root-sentinel", { exact: false })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("alice-private-token-sentinel", { exact: false })).toHaveCount(0)
})

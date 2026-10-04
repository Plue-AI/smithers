import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MCH-06.md; not a qualification receipt.
// Written before implementation: mvp.md §6.8, §9, J6.5, M-18, M-29; lands with T-MCH-11
test("C-MCH-06: Terminal cannot elevate or read another member home", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.8, §9, J6.5, M-18, M-29; lands with T-MCH-11")
  await owner(page)
  await page.goto("/")
  // Seed Ben's product terminal as uid 20001, Alice as uid 20002.
  // Root helper, agent-user probes, capabilities and SSH rejection remain reference-host checks.
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const input = page.getByRole("textbox", { name: "Terminal input", exact: true }).last()
  await input.fill("id -u; stat -c '%a' /home/ben; command -v sudo su")
  await input.press("Enter")
  const output = page.getByRole("region", { name: "Terminal output", exact: true }).last()
  await expect(output).toContainText("20001")
  await expect(output).toContainText("700")
  await expect(output).not.toContainText("/bin/sudo")
  await expect(output).not.toContainText("/bin/su")
  await input.fill("cat /home/alice/.config/gh/hosts.yml")
  await input.press("Enter")
  await expect(output).toContainText("Permission denied")
  await input.fill("printf 'shared work' > /workspace/shared.txt")
  await input.press("Enter")
  await say(page, "/file shared.txt")
  await expect(page.getByRole("region", { name: "File content", exact: true }).last()).toContainText("shared work")
})

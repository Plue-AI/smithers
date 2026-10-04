import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-AGT-02.md; not a qualification receipt.
// Written before implementation: mvp.md M-38, M-34, J6; lands with T-AGT-02, T-AGT-03
test("C-AGT-02: Live external conversations stay attributed and read-only", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md M-38, M-34, J6; lands with T-AGT-02, T-AGT-03")
  await owner(page)
  await page.goto("/")
  // Seed: registered Ben-owned Claude Code and Codex sessions, normalized
  // complete records, reconnect replay and an unsupported source version.
  // Broker isolation, real-agent latency and revocation remain integration evidence.
  await say(page, "/branch retry-webhooks")
  for (const name of ["Claude Code for Ben", "Codex for Ben"]) {
    await expect(page.getByText(name, { exact: true }).last()).toBeVisible()
  }
  const imported = page.getByRole("article").filter({ hasText: "Run the webhook tests" }).last()
  await expect(imported).toContainText("Ben")
  for (const name of ["Edit", "Resend", "Answer", "Approve", "Retry", "Stop", "Steer"]) {
    await expect(imported.getByRole("button", { name, exact: true })).toHaveCount(0)
  }
  await expect(page.getByText("pnpm test webhooks", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Tests failed", { exact: true }).last()).toBeVisible()
  await page.context().setOffline(true)
  await page.context().setOffline(false)
  await page.reload()
  await say(page, "/branch retry-webhooks")
  await expect(page.getByText("Run the webhook tests", { exact: true })).toHaveCount(1)
  await expect(page.getByText("Unsupported transcript version", { exact: true })).toBeVisible()
})

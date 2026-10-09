import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { withGitHubInstall } from "./github-install-fixture"

// Production cleaner, host objects, GitHub reopen and reconstruction; native
// capture inputs use the process fixture. Real microVM/security receipts remain
// required on the reference host.
test("C-MCH-05: dropped cleanup preserves captured files through reopen and reload", { tag: "@install" }, async ({ page }) => {
  test.setTimeout(300_000)
  await withGitHubInstall(page, "TestCleanupReopenComposedInstall", "SMITHERS_GH03_REHEARSAL", async fixture => {
    for (const phase of ["dropped", "cleaned", "in_review"] as const) {
      const host = await fixture.phase(phase)
      await fixture.open(host)
      await say(page, `/todo T${host.number}`)
      const card = page.getByRole("article", { name: `TODO T${host.number}`, exact: true }).last()
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect(card).toContainText(phase === "dropped" || phase === "cleaned" ? "Dropped" : "In review")
      if (phase === "cleaned" || phase === "in_review") {
        await say(page, `/branch T${host.number}`)
        await expect(page.getByRole("tab", { name: /^Files/ }).last()).toBeVisible({ timeout: 30_000 })
        await say(page, "/file tracked.txt")
        await expect(page.getByRole("textbox", { name: "tracked.txt", exact: true }).last()).toContainText("tracked final bytes")
        await say(page, "/file untracked.txt")
        await expect(page.getByRole("textbox", { name: "untracked.txt", exact: true }).last()).toContainText("untracked final bytes")
      }
      await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
      await fixture.acknowledge(phase)
    }
  })
})

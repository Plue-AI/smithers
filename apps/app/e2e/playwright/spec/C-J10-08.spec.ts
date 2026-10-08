import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { withGitHubInstall } from "./github-install-fixture"

// Real composed install, PostgreSQL, native repository and production pulls
// worker. Guest qualification and seven-day boundaries have separate receipts.
test("C-J10-08: GitHub close and reopen survive the mounted card and reload", async ({ page }) => {
  test.setTimeout(300_000)
  await withGitHubInstall(page, "TestTODOGitHubCloseReopenComposedInstall/day_6", "SMITHERS_GH03_REHEARSAL", async fixture => {
    for (const phase of ["dropped", "in_review", "merged"] as const) {
      const host = await fixture.phase(phase)
      await fixture.open(host)
      await say(page, `/todo T${host.number}`)
      const card = page.getByRole("article", { name: `TODO T${host.number}`, exact: true }).last()
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect(card).toContainText({ dropped: "Dropped", in_review: "In review", merged: "Merged" }[phase])
      await expect(card).not.toContainText("Attempt 2")
      if (phase === "dropped") await expect(card).toContainText("closed on GitHub by @alice")
      if (phase === "dropped" || phase === "merged") await expect(card.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
      await fixture.acknowledge(phase)
    }
  })
})

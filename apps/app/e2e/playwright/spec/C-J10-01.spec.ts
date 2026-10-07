import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { withGitHubInstall } from "./github-install-fixture"

// Real production publication, PostgreSQL and native accepted-prefix diff.
// Packaged guest candidate/propose dispatch remains reference-host evidence.
test("C-J10-01: published TODOs retain drafts and show only their own diff", async ({ page }) => {
  test.setTimeout(300_000)
  await withGitHubInstall(page, "TestTODOGitHubOrderAndShapeComposedInstall", "SMITHERS_GH03_ORDER_REHEARSAL", async fixture => {
    const host = await fixture.phase("shape")
    await fixture.open(host)
    await say(page, `/todo T${host.number}`)
    const card = page.getByRole("article", { name: "TODO T2", exact: true }).last()
    await expect(card).toContainText("Second")
    await expect(card).toContainText("Includes T1")
    await expect(card.getByRole("link", { name: "#2 on GitHub", exact: true })).toHaveAttribute("href", "https://github.com/rehearsal-owner/app/pull/2")
    await say(page, "/diff smithers/second")
    await expect(page.getByText("SECOND.txt", { exact: true }).last()).toBeVisible()
    await expect(page.getByText("FIRST.txt", { exact: true })).toHaveCount(0)
    await fixture.acknowledge("shape")
  }, "shape")
})

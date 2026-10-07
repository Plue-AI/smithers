import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { withGitHubInstall } from "./github-install-fixture"

// Installed cards read production polling and keyed completion effects.
// Accepted trees are fixture input; guest qualification remains separate.
test("C-J10-05: GitHub merges update TODOs and only close fixed issues", async ({ page }) => {
  test.setTimeout(300_000)
  await withGitHubInstall(page, "TestTODOGitHubOrderAndShapeComposedInstall", "SMITHERS_GH03_ORDER_REHEARSAL", async fixture => {
    const host = await fixture.phase("issue_merge")
    await fixture.open(host)
    for (const number of [host.number - 1, host.number]) {
      await say(page, `/todo T${number}`)
      const card = page.getByRole("article", { name: `TODO T${number}`, exact: true }).last()
      await expect(card).toContainText("Merged")
      await expect(card.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
    }
    await say(page, `/issue ${host.fixingIssue}`)
    await expect(page.locator('.smithers-card[data-kind="issue"]').last()).toContainText("Closed")
    await say(page, `/issue ${host.referenceIssue}`)
    await expect(page.locator('.smithers-card[data-kind="issue"]').last()).toContainText("Open")
    await page.reload()
    await say(page, `/todo T${host.number - 1}`)
    await expect(page.getByRole("article", { name: `TODO T${host.number - 1}`, exact: true }).last()).toContainText("Merged")
    await fixture.acknowledge("issue_merge")
  }, "issue_merge")
})

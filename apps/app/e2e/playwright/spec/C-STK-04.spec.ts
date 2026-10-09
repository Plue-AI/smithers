import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { withGitHubInstall } from "./github-install-fixture"

// Production publication and fetched containment feed the real Home and TODO
// cards. The Go boundary independently proves the fence and revision-bound OK.
test("C-STK-04: an outside out-of-order merge retains the note and owner OK", { tag: "@install" }, async ({ page }) => {
  test.setTimeout(300_000)
  await withGitHubInstall(page, "TestTODOGitHubOrderAndShapeComposedInstall", "SMITHERS_GH03_ORDER_REHEARSAL", async fixture => {
    const host = await fixture.phase("order")
    await fixture.open(host)
    const note = "T2 merged before T1; T1's change is in T2's commit"
    await expect(page.getByText(note, { exact: true })).toBeVisible({ timeout: 30_000 })
    await say(page, "/todo T1")
    const first = page.getByRole("article", { name: "TODO T1", exact: true }).last()
    await expect(first).toContainText("Merged")
    await expect(first).toContainText("in T2's commit")
    await expect(first.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
    await page.reload()
    await say(page, "/todo T1")
    await expect(first).toContainText("in T2's commit")
    await say(page, "/todo T2")
    await expect(page.getByRole("article", { name: "TODO T2", exact: true }).last()).toContainText("Merged")
    await page.getByRole("button", { name: "OK", exact: true }).press("Enter")
    await expect(page.getByText(note, { exact: true })).toHaveCount(0)
    await fixture.acknowledge("order")
  }, "order")
})

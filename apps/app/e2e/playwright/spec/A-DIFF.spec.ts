import { withGitHubInstall } from "./github-install-fixture"
import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Seeded UI projection; live provider qualification remains above.
test("A-DIFF: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/diff T8")
  await expect(page.getByRole("region", { name: "package.json changes", exact: true }).last()).toContainText("17.2.0")
  await expect(page.getByRole("region", { name: "src/webhooks/verify.ts changes", exact: true }).last()).toContainText("TOLERANCE")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})


// Accepted trees are fixture inputs; the composed reader and browser are real.
test("A-DIFF: shows only the branch change", { tag: "@install" }, async ({ page }) => {
  test.setTimeout(300_000)
  await withGitHubInstall(page, "TestTODOGitHubOrderAndShapeComposedInstall", "SMITHERS_GH03_ORDER_REHEARSAL", async fixture => {
    const host = await fixture.phase("shape")
    await fixture.open(host)
    await say(page, "/diff smithers/second")
    const card = page.getByTestId("card-diff-branch-smithers/second")
    await expect(card).toContainText("SECOND.txt")
    await expect(card).toContainText("second")
    await expect(card).not.toContainText("FIRST.txt")
    await expect(page.getByTestId("composer-input")).toBeEditable()
    await page.reload()
    await expect(card).toContainText("SECOND.txt")
    await expect(card).not.toContainText("FIRST.txt")
    await fixture.acknowledge("shape")
  }, "shape")
})

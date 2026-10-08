import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { withGitHubInstall } from "./github-install-fixture"

// Packaged candidate/propose, hostile host Git, PostgreSQL and served diff.
// Linux namespaces exercise the path; Mac microVM qualification remains separate.
test("C-J10-01: published TODOs retain drafts and show only their own diff", async ({ page }) => {
  test.setTimeout(600_000)
  await withGitHubInstall(page, "TestMythicalPRShapeHostileProductionDispatch", "SMITHERS_GH03_REHEARSAL", async fixture => {
    const host = await fixture.phase("shape")
    await fixture.open(host)
    await say(page, `/todo T${host.number}`)
    const card = page.getByRole("article", { name: "TODO T2", exact: true }).last()
    await expect(card).toContainText("Safe transfer")
    await expect(card).toContainText("Includes T1")
    await expect(card.getByRole("link", { name: "#2 on GitHub", exact: true })).toHaveAttribute("href", "https://github.com/rehearsal-owner/app/pull/2")
    await say(page, "/diff smithers/safe-transfer")
    await expect(page.getByText("safe.md", { exact: true }).last()).toBeVisible()
    await expect(page.getByText("earlier.md", { exact: true })).toHaveCount(0)
    await fixture.acknowledge("shape")
  }, "shape")
})

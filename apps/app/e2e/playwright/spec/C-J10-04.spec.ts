import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { withGitHubInstall } from "./github-install-fixture"

// Real presence holds the original PR for multiple worker passes. The backend
// checks publication, verification and equivalent-review retention.
// Physical guest freeze timing and writer attribution require the mini.
test("C-J10-04: a person presses Rebase now on the installed Branch card", async ({ page }) => {
  test.setTimeout(600_000)
  await withGitHubInstall(page, "TestRebaseNowExplicitRehearsal", "SMITHERS_REBASE_REHEARSAL", async fixture => {
    const pending = await fixture.phase("pending")
    await fixture.open(pending)
    await say(page, `/branch T${pending.number}`)
    const branch = () => page.locator('[data-kind="branch"]').last()
    const admitted = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname.startsWith("/api/branches/"))
    await branch().getByRole("button", { name: "Rebase now", exact: true }).press("Enter")
    expect((await admitted).status()).toBe(202)
    await expect(page.getByTestId("composer-input")).toBeEditable()
    await fixture.acknowledge("pending")
    const rebased = await fixture.phase("rebased")
    await fixture.open(rebased)
    await say(page, `/branch T${rebased.number}`)
    await expect(branch().getByRole("button", { name: "Rebase now", exact: true })).toHaveCount(0)
    await say(page, `/todo T${rebased.number}`)
    await expect(page.getByRole("article", { name: `TODO T${rebased.number}`, exact: true }).last().locator("header .state")).toContainText("In review")
    await expect(page.getByTestId("composer-input")).toBeEditable()
    await fixture.acknowledge("rebased")
  }, "", 480_000)
})

import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { withGitHubInstall } from "./github-install-fixture"

test("Scratch Rebase now follows its TODO source through the installed Branch card", { tag: "@install" }, async ({ page }) => {
  test.setTimeout(600_000)
  await withGitHubInstall(page, "TestScratchRebaseFromTodoRehearsal", "SMITHERS_SCRATCH_REBASE_REHEARSAL", async fixture => {
    const pending = await fixture.phase("scratch_pending") as Awaited<ReturnType<typeof fixture.phase>> & { scratchName: string }
    await fixture.open(pending)
    await say(page, `/branch ${pending.scratchName}`)
    const branch = () => page.locator('[data-kind="branch"]').last()
    await expect(branch()).toContainText(pending.scratchName)
    const admitted = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/branches/${encodeURIComponent(pending.scratchName)}`)
    await branch().getByRole("button", { name: "Rebase now", exact: true }).press("Enter")
    const response = await admitted
    expect(response.status()).toBe(202)
    expect(response.request().postDataJSON()).toEqual({ rebase: true })
    expect(await response.json()).not.toHaveProperty("n")
    await expect(page.getByTestId("composer-input")).toBeEditable()
    await fixture.acknowledge("scratch_pending")
    const rebased = await fixture.phase("scratch_rebased")
    await fixture.open(rebased)
    await say(page, `/branch ${pending.scratchName}`)
    await expect(branch().getByRole("button", { name: "Rebase now", exact: true })).toHaveCount(0)
    const file = await page.request.get(`${rebased.origin}/api/branches/${encodeURIComponent(pending.scratchName)}/files/scratch.md`)
    expect(file.status()).toBe(200)
    expect((await file.json()).content).toEqual({ kind: "text", text: "keep the whole Scratch delta\n" })
    await expect(page.getByTestId("composer-input")).toBeEditable()
    await fixture.acknowledge("scratch_rebased")
  }, "", 480_000)
})

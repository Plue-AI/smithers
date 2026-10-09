import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { withGitHubInstall } from "./github-install-fixture"

// Real install and retained native conflict after backend/daemon restart.
// The backend fixture checks the same attempt, zero repair launches and a
// fresh review. Physical guest isolation still requires the mini.
test("C-J7-03: unresolved Done refuses and a clean human edit resumes the retained attempt", { tag: "@install" }, async ({ page }) => {
  test.setTimeout(600_000)
  await withGitHubInstall(page, "TestRebaseZeroConflictAttemptsRehearsal", "SMITHERS_REBASE_REHEARSAL", async fixture => {
    const conflict = await fixture.phase("conflict") as Awaited<ReturnType<typeof fixture.phase>> & { branchId: string }
    await fixture.open(conflict)
    await say(page, `/todo T${conflict.number}`)
    const card = () => page.getByRole("article", { name: `TODO T${conflict.number}`, exact: true }).last()
    await expect(card().locator("header .state")).toContainText("Needs you")
    await expect(card().getByText("JOURNEY.md", { exact: true })).toBeVisible()
    const done = () => card().getByRole("button", { name: "Done", exact: true })
    const answer = () => page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/todos/${conflict.number}/answer`)
    let response = answer()
    await done().press("Enter")
    expect((await response).status()).toBe(409)
    await expect(done()).toBeVisible()
    const path = `${conflict.origin}/api/repos/rehearsal-owner/app/workspaces/${conflict.branchId}/files/content?path=JOURNEY.md`
    const file = await page.request.get(path)
    expect(file.status()).toBe(200)
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === "__csrf")!.value
    const written = await page.request.put(path, { headers: { "X-CSRF-Token": csrf, Origin: conflict.origin }, data: {
      base_digest: (await file.json()).digest, content: "Greeting from new main\nHello from Smithers!\n"
    } })
    expect(written.status()).toBe(200)
    response = answer()
    await done().press("Enter")
    expect((await response).status()).toBe(202)
    await expect(page.getByTestId("composer-input")).toBeEditable()
    await fixture.acknowledge("conflict")
    const reviewed = await fixture.phase("reviewed")
    await fixture.open(reviewed)
    await say(page, `/todo T${reviewed.number}`)
    await expect(card().locator("header .state")).toContainText("In review")
    await fixture.acknowledge("reviewed")
  }, "", 480_000)
})

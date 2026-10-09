import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { withGitHubInstall } from "./github-install-fixture"

// Production install, PostgreSQL, packaged coding host and GitHub fake.
// This mounted-card proof supplements the reference-host terminal/SSH journey
// in e2e/real/fork-add-to-stack.spec.ts; it does not qualify guest isolation.
test.use({ trace: "on", video: "on" })

test("C-J7-02: mounted live Drop preserves an adopted fork across reload", { tag: "@install" }, async ({ page }) => {
  test.setTimeout(600_000)
  await withGitHubInstall(page, "TestForkAddLiveDropComposedInstall", "SMITHERS_TODO_DROP_REHEARSAL", async fixture => {
    const forked = await fixture.phase("forked") as Awaited<ReturnType<typeof fixture.phase>> & { scratchName: string }
    await fixture.open(forked)
    await say(page, `/todo T${forked.number}`)
    const source = () => page.getByRole("article", { name: `TODO T${forked.number}`, exact: true }).last()
    await expect(source().locator("header .state")).toContainText("Working")
    await say(page, `/branch ${forked.scratchName}`)
    const branch = page.locator('[data-kind="branch"]').last()
    await expect(branch).toContainText(forked.scratchName)
    await expect(branch.getByRole("button", { name: "Add to stack", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Replace T2", exact: true })).toHaveCount(0)
    await fixture.acknowledge("forked")

    const adopted = await fixture.phase("adopted") as typeof forked & { childNumber: number }
    await say(page, "/stack")
    const stack = () => page.getByRole("list", { name: "Stack", exact: true }).last()
    await expect(stack()).toContainText(/Prefix[\s\S]*Source[\s\S]*Keep the source fork[\s\S]*Later/)
    await say(page, `/todo.drop T${adopted.number}`)
    const confirm = page.getByRole("button", { name: "Confirm: drop this TODO", exact: true }).last()
    await expect(confirm).toBeVisible()
    // Asking for Drop leaves the source and stack intact until the press.
    const before = await page.request.get(`${adopted.origin}/api/todos/${adopted.number}`)
    expect(before.status()).toBe(200)
    expect((await before.json()).state).toBe("working")
    await expect(page.getByTestId("composer-input")).toBeEditable()
    const request = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/todos/${adopted.number}`)
    await confirm.press("Enter")
    const response = await request
    expect(response.status()).toBe(202)
    expect(response.request().postDataJSON()).toEqual({ op: "drop" })
    await fixture.acknowledge("adopted")

    const dropped = await fixture.phase("dropped") as typeof adopted & { branchName: string }
    await fixture.open(dropped)
    await say(page, `/todo T${dropped.number}`)
    await expect(source().locator("header .state")).toContainText("Dropped")
    await say(page, "/stack")
    await expect(stack()).toContainText(/Prefix[\s\S]*Keep the source fork[\s\S]*Later/)
    await expect(stack()).not.toContainText("Source")
    await say(page, `/todo T${dropped.childNumber}`)
    await expect(page.getByRole("article", { name: `TODO T${dropped.childNumber}`, exact: true }).last().locator("header .state")).toContainText("Working")
    const file = await page.request.get(`${dropped.origin}/api/branches/${encodeURIComponent(dropped.branchName)}/files/fork-edit.md`)
    expect(file.status()).toBe(200)
    expect((await file.json()).content).toEqual({ kind: "text", text: "fixed fork edit\n" })
    await expect(page.getByTestId("composer-input")).toBeEditable()
    await fixture.acknowledge("dropped")
  }, "", 480_000)
})

import { expect, test, type Page } from "./browserTest"

const command = async (page: Page, line: string) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await expect(input).toBeVisible()
  await input.fill(line)
  await input.press("Enter")
  await expect(input).toBeHidden()
}

test("an unresolved or failed repository URL never reads the previous repository by default", async ({ page }) => {
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
    capabilities: ["agent", "identity", "cloud", "cloud.terminal"], authFlow: "native-handoff", sandbox: null,
  } }))
  await page.route("**/api/auth/session", route => route.fulfill({ json: { status: "signed-out" } }))
  let release!: () => void
  let gate: Promise<void> | undefined
  await page.route("**/api/public/repos", async route => {
    await gate
    await route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } })
  })
  await page.route("**/api/repos/smithersai/smithers", route => route.fulfill({ json: { default_bookmark: "main" } }))
  let reads = 0
  await page.route(/\/api\/repos\/smithersai\/smithers\/contents(?:\/[^?]*)?(?:\?.*)?$/, route => {
    reads++
    return route.fulfill({ json: [{ path: "README.md", name: "README.md", type: "file", size: 11 }] })
  })
  await page.goto("/smithersai/smithers/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await command(page, "/files.list / smithersai/smithers")
  await expect(page.locator('[data-kind="file-list"]').last()).toContainText("README.md")

  gate = new Promise<void>(resolve => { release = resolve })
  await page.goto("/missing-owner/missing-repository/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  reads = 0
  await command(page, "/files.list /")
  await page.waitForTimeout(400)
  expect(reads).toBe(0)
  // Explicit targets still use the same public read seam while entry resolution waits.
  await command(page, "/files.list / smithersai/smithers")
  await expect.poll(() => reads).toBe(1)
  await command(page, "/files.list /smithersai/smithers/docs")
  await expect.poll(() => reads).toBe(2)
  release()
  gate = undefined
  await page.waitForResponse(response => response.url().endsWith("/api/public/repos"))
  await command(page, "/files.list /")
  await page.waitForTimeout(400)
  expect(reads).toBe(2)

  await page.reload()
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await command(page, "/files.list /")
  await page.waitForTimeout(400)
  expect(reads).toBe(2)
})

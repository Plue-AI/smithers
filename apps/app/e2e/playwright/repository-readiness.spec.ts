import { expect, test, type Page } from "./browserTest"
import { identityRoute } from "./identity"

const command = async (page: Page, line: string) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill(line)
  await input.press("Enter")
  await expect(input).toBeHidden()
}

test("a cold catalog request survives reload and keeps progress through its bound read", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
    capabilities: ["identity", "cloud"], authFlow: "native-handoff", sandbox: null
  } }))
  await page.route("**/api/user", identityRoute(null))
  await page.route("**/api/recommend", route => route.fulfill({ json: { suggestions: [] } }))
  let releaseCatalog!: () => void
  const catalog = new Promise<void>(resolve => { releaseCatalog = resolve })
  await page.route("**/api/public/repos", async route => {
    await catalog
    await route.fulfill({ json: { repos: [{ name: "alpha/one" }] } }).catch(() => {})
  })
  await page.route("**/api/repos/alpha/one", route => route.fulfill({ json: { default_bookmark: "main" } }))
  let releaseRead!: () => void
  const read = new Promise<void>(resolve => { releaseRead = resolve })
  let reads = 0
  await page.route("**/api/repos/alpha/one/contents/README.md", async route => {
    reads++
    await read
    await route.fulfill({ json: { path: "README.md", type: "file", content: "# Bound alpha file", encoding: "utf-8" } })
  })
  await page.goto("/alpha/one/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await command(page, "/files.read /alpha/one/README.md")
  await command(page, "/files.read /alpha/one/README.md")
  const waiting = page.locator('[data-toast-status="running"]').filter({ hasText: "Loading repository" })
  await expect(waiting).toBeVisible()
  expect(reads).toBe(0)
  await expect(page.getByText("Sign in with GitHub to continue.", { exact: true })).toHaveCount(0)
  await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill("Chat stays usable")
  await expect(page.getByTestId("composer-input")).toHaveValue("Chat stays usable")
  await page.reload()
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await expect(waiting).toBeVisible()
  expect(reads).toBe(0)
  releaseCatalog()
  await expect.poll(() => reads).toBe(1)
  await expect(waiting).toBeVisible()
  releaseRead()
  await expect(page.locator('[data-kind="file"]').last()).toContainText("Bound alpha file")
  await expect(page.locator('[data-toast-status="ok"]').filter({ hasText: "Ready" })).toBeVisible()
  expect(reads).toBe(1)
  expect(errors).toEqual([])
})

test("a command retries an unavailable catalog in background and reconnects across reload", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
    capabilities: ["identity", "cloud"], authFlow: "native-handoff", sandbox: null
  } }))
  await page.route("**/api/user", identityRoute(null))
  await page.route("**/api/recommend", route => route.fulfill({ json: { suggestions: [] } }))
  let catalogs = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route("**/api/public/repos", async route => {
    catalogs++
    if (catalogs === 1) return route.fulfill({ status: 503, json: {} })
    await gate
    await route.fulfill({ json: { repos: [{ name: "alpha/one" }] } }).catch(() => {})
  })
  await page.route("**/api/repos/alpha/one", route => route.fulfill({ json: { default_bookmark: "main" } }))
  let reads = 0
  await page.route("**/api/repos/alpha/one/contents/README.md", route => {
    reads++
    return route.fulfill({ json: { path: "README.md", type: "file", content: "# Retried alpha", encoding: "utf-8" } })
  })
  await page.goto("/alpha/one/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await expect.poll(() => catalogs).toBe(1)
  await expect(page.getByText("The public repository catalog answered HTTP 503.", { exact: false }).first()).toBeVisible()
  await command(page, "/files.read README.md alpha/one")
  await command(page, "/files.read README.md alpha/one")
  await expect.poll(() => catalogs).toBe(2)
  await expect(page.getByText("Sign in with GitHub to continue.", { exact: true })).toHaveCount(0)
  const waiting = page.locator('[data-toast-status="running"]').filter({ hasText: "Loading repository" })
  await expect(waiting).toBeVisible()
  expect(reads).toBe(0)
  await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill("Chat remains usable while retrying")
  await expect(page.getByTestId("composer-input")).toHaveValue("Chat remains usable while retrying")
  await page.reload()
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await expect.poll(() => catalogs).toBe(3)
  await expect(waiting).toBeVisible()
  release()
  await expect(page.locator('[data-kind="file"]').last()).toContainText("Retried alpha")
  await expect(page.locator('[data-toast-status="ok"]').filter({ hasText: "Ready" })).toBeVisible()
  expect(reads).toBe(1)
  expect(errors).toEqual([])
})

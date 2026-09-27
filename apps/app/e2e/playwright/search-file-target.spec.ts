import { expect, test, type Page } from "./browserTest"
import { identityRoute } from "./identity"

const command = async (page: Page, line: string) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill(line)
  await input.press("Enter")
  await expect(input).toBeHidden()
}

// Explicit HTTP fixtures exercise registry, persisted cards and keyboard dispatch.
test("a deduplicated file search keeps its repository after selection and reload", async ({ page }) => {
  const reads: string[] = []
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "native-handoff", sandbox: null
  } }))
  await page.route("**/api/user", identityRoute(null))
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "alpha/one" }, { name: "beta/two" }] } }))
  await page.route(/\/api\/repos\/(alpha\/one|beta\/two)$/, route => route.fulfill({ json: { default_bookmark: "main" } }))
  await page.route(/\/api\/repos\/(alpha\/one|beta\/two)\/contents(?:\/[^?]*)?(?:\?.*)?$/, route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/contents")) return route.fulfill({ json: [{ name: "README.md", path: "README.md", type: "file", size: 12 }] })
    if (path.endsWith("/contents/README.md")) {
      reads.push(path)
      return route.fulfill({ json: { type: "file", path: "README.md", content: path.includes("alpha/one") ? "# Alpha content" : "# Beta content", encoding: "utf-8" } })
    }
    return route.fulfill({ status: 404, json: { message: "Path not found" } })
  })
  await page.goto("/alpha/one/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await command(page, "/files.list / alpha/one")
  await expect(page.locator('[data-kind="file-list"]')).toContainText("README.md")
  await command(page, "/search.files README")
  const result = page.locator('[data-kind="search-results"]')
  await expect(result.locator(".search-results-item")).toHaveCount(1)
  await expect(result.locator(".search-results-actions button")).toHaveCount(1)
  const open = result.getByRole("button", { name: "Read a file from a repository", exact: true })
  await command(page, "/repo.select beta/two")
  await open.focus()
  await open.press("Enter")
  await expect(page.getByTestId("card-file-alpha/one-README.md")).toContainText("Alpha content")
  expect(reads).toEqual(["/api/repos/alpha/one/contents/README.md"])
  await page.reload()
  await expect(open).toBeVisible()
  await command(page, "/repo.select beta/two")
  await open.focus()
  await open.press("Enter")
  await expect.poll(() => reads.length).toBe(2)
  expect(reads.every(path => path.includes("/alpha/one/"))).toBe(true)
})

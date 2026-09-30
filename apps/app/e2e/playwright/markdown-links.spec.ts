import { expect, test, type Page } from "./browserTest"
import { identityRoute } from "./identity"

const command = async (page: Page, line: string) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill(line)
  await input.press("Enter")
  await expect(input).toBeHidden()
}

const README = [
  "# Alpha",
  "",
  "[License](LICENSE) · [Docs](docs/) · [Home](https://example.com/) · [Bad](javascript:alert(1))"
].join("\n")

// #3132: a README read from alpha/one while the page sits on beta/two opens its own LICENSE, in a card, without leaving the app.
test("a markdown card's relative link opens its own repository's file instead of the app's 404", async ({ page }) => {
  const reads: string[] = []
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "native-handoff", sandbox: null
  } }))
  await page.route("**/api/user", identityRoute(null))
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "alpha/one" }, { name: "beta/two" }] } }))
  await page.route(/\/api\/repos\/(alpha\/one|beta\/two)$/, route => route.fulfill({ json: { default_bookmark: "main" } }))
  await page.route(/\/api\/repos\/(alpha\/one|beta\/two)\/contents(?:\/[^?]*)?(?:\?.*)?$/, route => {
    const path = new URL(route.request().url()).pathname
    reads.push(path)
    if (path.endsWith("/contents/README.md")) return route.fulfill({ json: { type: "file", path: "README.md", content: README, encoding: "utf-8" } })
    if (path.endsWith("/contents/LICENSE")) return route.fulfill({ json: { type: "file", path: "LICENSE", content: "MIT License", encoding: "utf-8" } })
    if (path.endsWith("/contents/docs")) return route.fulfill({ json: [{ name: "guide.md", path: "docs/guide.md", type: "file", size: 3 }] })
    return route.fulfill({ status: 404, json: { message: "Path not found" } })
  })
  await page.goto("/beta/two/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await command(page, "/files.read README.md alpha/one")
  const readme = page.getByTestId("card-file-alpha/one-README.md")
  const editor = readme.locator('[data-testid="markdown-editor"][data-mode="wysiwyg"]')
  await expect(editor.getByRole("link", { name: "License" })).toBeVisible()
  const route = page.url()

  await editor.getByRole("link", { name: "License" }).click()
  await expect(page.getByTestId("card-file-alpha/one-LICENSE")).toContainText("MIT License")
  expect(page.url()).toBe(route)

  await editor.getByRole("link", { name: "Docs" }).click()
  await expect(page.locator('[data-kind="file-list"]')).toContainText("guide.md")
  await editor.getByRole("link", { name: "Bad" }).click()
  expect(page.url()).toBe(route)
  await expect(page.getByText("Page not found")).toHaveCount(0)
  expect(reads).toContain("/api/repos/alpha/one/contents/LICENSE")
  expect(reads.filter(path => /\/beta\/two\/contents\/(LICENSE|docs)/.test(path))).toEqual([])
  await expect(editor.getByRole("link", { name: "Home" })).toHaveAttribute("href", "https://example.com/")
})

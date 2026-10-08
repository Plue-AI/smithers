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

const markdownFixture = async (page: Page, documentPath: string, markdown: string) => {
  const reads: string[] = []
  const files: Record<string, string> = {
    [documentPath]: markdown,
    LICENSE: "MIT License",
    "docs/LICENSE": "License in docs",
    "docs/guide/next.md": "# Next\n\n## Usage\n\nNext document."
  }
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "native-handoff", sandbox: null
  } }))
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", identityRoute(null))
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "alpha/one" }, { name: "beta/two" }] } }))
  await page.route(/\/api\/repos\/(alpha\/one|beta\/two)$/, route => route.fulfill({ json: { default_bookmark: "main" } }))
  await page.route(/\/api\/repos\/(alpha\/one|beta\/two)\/contents(?:\/[^?]*)?(?:\?.*)?$/, route => {
    const path = new URL(route.request().url()).pathname
    reads.push(path)
    const filePath = path.split("/contents/")[1]
    if (filePath !== undefined && files[filePath] !== undefined) return route.fulfill({ json: { type: "file", path: filePath, content: files[filePath], encoding: "utf-8" } })
    if (path.endsWith("/contents/docs")) return route.fulfill({ json: [{ name: "guide.md", path: "docs/guide.md", type: "file", size: 3 }] })
    return route.fulfill({ status: 404, json: { message: "Path not found" } })
  })
  return reads
}

// §6.8 keeps File as the read-only source editor; rendered citations belong to Wiki.
test("Markdown source retains its own repository and never activates a source link", async ({ page }) => {
  const reads = await markdownFixture(page, "README.md", README)
  await page.goto("/beta/two/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  const location = page.url()
  await command(page, "/file README.md alpha/one")
  const card = page.getByTestId("card-file-alpha/one-README.md")
  await expect(card.locator(".cm-content")).toContainText("[License](LICENSE)")
  await expect(card.locator(".cm-content")).toContainText("[Bad](javascript:alert(1))")
  await expect(card.locator(".code-file-view")).toHaveAttribute("data-mode", "read_only")
  await expect(card.locator('[data-testid="markdown-editor"]')).toHaveCount(0)
  await expect(card.locator(".cm-content a")).toHaveCount(0)
  expect(reads.filter(read => !read.endsWith("/.smithers/factory.json"))).toEqual(["/api/repos/alpha/one/contents/README.md"])
  expect(page.url()).toBe(location)
  expect(page.context().pages()).toHaveLength(1)
})

test("nested Markdown source keeps parent links and fragments literal at its repository path", async ({ page }) => {
  const path = "docs/guide/start.md"
  const markdown = "# Guide\n\n[Parent](../LICENSE) · [Next](next.md#usage) · [Escape](../../../LICENSE)"
  const reads = await markdownFixture(page, path, markdown)
  await page.goto("/beta/two/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  const location = page.url()
  await command(page, `/file ${path} alpha/one`)
  const card = page.getByTestId(`card-file-alpha/one-${path}`)
  await expect(card.locator(".cm-content")).toContainText(markdown.replaceAll("\n", ""))
  await expect(card.locator(".cm-content a")).toHaveCount(0)
  expect(reads.filter(read => !read.endsWith("/.smithers/factory.json"))).toEqual([`/api/repos/alpha/one/contents/${path}`])
  expect(reads.filter(read => read.includes("#") || read.includes("%23") || read.includes("/beta/two/") && !read.endsWith("/.smithers/factory.json"))).toEqual([])
  expect(page.url()).toBe(location)
  await expect(page.getByText("Page not found", { exact: true })).toHaveCount(0)
})

test("a Markdown source line opens in the real editor without sending fragment bytes to its read", async ({ page }) => {
  const lines = ["# Alpha", "", "[Section](#section)", ...Array.from({ length: 100 }, (_, index) => `Paragraph ${index + 1}.`), "## Section", "[Missing](#missing) · [Malformed](#%zz)"]
  const section = lines.indexOf("## Section") + 1
  const reads = await markdownFixture(page, "README.md", lines.join("\n"))
  await page.goto("/beta/two/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  const location = page.url()
  await command(page, `/file ${JSON.stringify({ path: "README.md", repo: "alpha/one", line: section })}`)
  const card = page.getByTestId("card-file-alpha/one-README.md")
  await expect(card.locator(".cm-line", { hasText: "## Section" })).toBeInViewport()
  await expect(card.locator(".cm-content")).toContainText("[Malformed](#%zz)")
  await expect(card.locator(".cm-content a")).toHaveCount(0)
  expect(reads.filter(read => !read.endsWith("/.smithers/factory.json"))).toEqual(["/api/repos/alpha/one/contents/README.md"])
  expect(page.url()).toBe(location)
  await expect(page.getByText("Page not found", { exact: true })).toHaveCount(0)
})

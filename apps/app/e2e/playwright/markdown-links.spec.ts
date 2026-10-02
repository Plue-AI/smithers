import { controlTabKey, expect, test, type Locator, type Page } from "./browserTest"
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
  await page.route("**/api/user", identityRoute(null))
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

const activateLinkWithKeyboard = async (page: Page, link: Locator) => {
  await expect(link).toBeVisible()
  for (let step = 0; step < 80; step += 1) {
    await page.keyboard.press(controlTabKey(page))
    if (await link.evaluate(node => document.activeElement === node)) break
  }
  await expect(link).toBeFocused()
  await page.keyboard.press("Enter")
}

// #3132: a README read from alpha/one while the page sits on beta/two opens its own LICENSE, in a card, without leaving the app.
test("a markdown card's relative link opens its own repository's file instead of the app's 404", async ({ page }) => {
  const reads = await markdownFixture(page, "README.md", README)
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

test("keyboard activation resolves nested and parent links from the retained document and bounds file fragments", async ({ page }) => {
  const path = "docs/guide/README.md"
  const markdown = "# Guide\n\n[Parent](../LICENSE) · [Next](./next.md#usage) · [Same](README.md#guide) · [Escape](../../../LICENSE)"
  const reads = await markdownFixture(page, path, markdown)
  await page.goto("/beta/two/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await command(page, `/files.read ${path} alpha/one`)
  const editor = page.getByTestId(`card-file-alpha/one-${path}`).locator('[data-testid="markdown-editor"][data-mode="wysiwyg"]')
  const location = page.url()

  await activateLinkWithKeyboard(page, editor.getByRole("link", { name: "Parent", exact: true }))
  await expect(page.getByTestId("card-file-alpha/one-docs/LICENSE")).toContainText("License in docs")
  await activateLinkWithKeyboard(page, editor.getByRole("link", { name: "Next", exact: true }))
  await expect(page.getByTestId("card-file-alpha/one-docs/guide/next.md")).toContainText("Next document.")
  await activateLinkWithKeyboard(page, editor.getByRole("link", { name: "Same", exact: true }))
  await expect(editor).toContainText("Guide")
  expect(page.url()).toBe(location)
  expect(reads).toContain("/api/repos/alpha/one/contents/docs/LICENSE")
  expect(reads).toContain("/api/repos/alpha/one/contents/docs/guide/next.md")
  expect(reads.filter(read => read.includes("#") || read.includes("%23") || read.includes("/beta/two/contents/docs/"))).toEqual([])

  const documentReads = () => reads.filter(read => read.startsWith("/api/repos/alpha/one/contents"))
  const before = documentReads().length
  await activateLinkWithKeyboard(page, editor.getByRole("link", { name: "Escape", exact: true }))
  expect(documentReads()).toHaveLength(before)
  expect(page.url()).toBe(location)
  await expect(page.getByText("Page not found")).toHaveCount(0)
})

test("same-document fragments scroll the real editor while unknown and malformed anchors stay bounded", async ({ page }) => {
  const markdown = [
    "# Alpha", "", "[Section](#section)", "",
    ...Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1}.\n`),
    "## Section", "", "[Missing](#missing) · [Malformed](#%zz)"
  ].join("\n")
  const reads = await markdownFixture(page, "README.md", markdown)
  await page.goto("/beta/two/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await command(page, "/files.read README.md alpha/one")
  const editor = page.getByTestId("card-file-alpha/one-README.md").locator('[data-testid="markdown-editor"][data-mode="wysiwyg"]')
  const heading = editor.getByRole("heading", { name: "Section", exact: true })
  await expect(editor.getByRole("link", { name: "Section", exact: true })).toBeVisible()
  await expect(heading).not.toBeInViewport()
  const location = page.url()
  const documentReads = () => reads.filter(read => read.startsWith("/api/repos/alpha/one/contents"))
  const before = documentReads().length
  await editor.getByRole("link", { name: "Section", exact: true }).click()
  await expect(heading).toBeInViewport()
  for (const name of ["Missing", "Malformed"]) {
    const link = editor.getByRole("link", { name, exact: true })
    await expect(link).toBeInViewport()
    const y = (await heading.boundingBox())!.y
    await link.click()
    expect((await heading.boundingBox())!.y).toBeCloseTo(y, 0)
    expect(documentReads()).toHaveLength(before)
    expect(page.url()).toBe(location)
  }
  await expect(page.getByText("Page not found")).toHaveCount(0)
})

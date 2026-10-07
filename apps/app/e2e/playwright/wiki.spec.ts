import { expect, test } from "./browserTest"
import type { Page } from "./browserTest"
import * as Y from "yjs"
import { installCloudFixture } from "./cloudFixture"
import { fillComposer } from "./composer"

const repo = "smithersai/smithers"
const pageId = 42
const documentId = `wiki:${repo}:${pageId}`
const cardId = `wiki-open-${documentId}`
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) })
const send = async (page: Page, text: string) => {
  await fillComposer(page, text)
  await page.getByTestId("composer-send").click()
}

const wikiFixture = async (page: Page) => {
  const doc = new Y.Doc()
  doc.getText("markdown").insert(
    0,
    "# Architecture\n\n## Runtime\n\nOne runtime for Bun and Node.\n\n## Wiki\n\nShared Markdown."
  )
  const revision = 1
  const posts: Array<{ update_id: string; update: string; page_id: number }> = []
  const bootstrap = () => ({
    page: {
      id: pageId,
      slug: "architecture",
      title: "Architecture",
      body: doc.getText("markdown").toString(),
      revision,
      author: { id: 1, login: "will" },
      created_at: "2026-09-08T00:00:00Z",
      updated_at: "2026-09-08T00:00:00Z"
    },
    state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
    state_vector: Buffer.from(Y.encodeStateVector(doc)).toString("base64")
  })
  await installCloudFixture(page)
  await page.route(`**/api/repos/${repo}/wiki?*`, (route) => {
    const { body: _body, ...index } = bootstrap().page
    return route.fulfill(json([index]))
  })
  // The Wiki pane reads its space's navigation index since 8efb1a0e6a.
  await page.route(`**/api/repos/${repo}/wiki/navigation/index?*`, (route) => {
    const { body: _body, ...row } = bootstrap().page
    return route.fulfill(json({ pages: [{ ...row, metadata: {} }], folders: [], tags: [] }))
  })
  await page.route(
    `**/api/repos/${repo}/wiki/architecture/document?*`,
    (route) => route.fulfill(json(bootstrap()))
  )
  page.on("request", request => {
    if (/\/wiki\/architecture\/(updates|stream)(?:\?|$)/.test(request.url())) posts.push({ update_id: "retired", update: "", page_id: pageId })
  })
  return { doc, posts, bootstrap }
}

test("Wiki reads stay embedded and editing refuses until live admission exists", async ({ page }) => {
  const { doc, posts, bootstrap } = await wikiFixture(page)
  await page.goto("/")
  await send(page, `/wiki.cloud ${repo}`)
  const index = page.getByTestId(`card-wiki-index-${repo}-public`)
  await expect(index).toBeVisible()
  await page.getByTestId("composer-input").press("Escape")
  await index.getByRole("button", { name: "Open page", exact: true }).click()
  const card = page.getByTestId(`card-${cardId}`)
  await expect(card).toBeVisible()
  await card.getByRole("button", { name: "Outline", exact: true }).click()
  await expect(card.getByRole("list", { name: "Page outline" })).toContainText("Runtime")
  await card.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(card.locator('.ProseMirror[contenteditable="true"]')).toHaveCount(0)
  await expect(card.locator('.ProseMirror')).toContainText("Shared Markdown.")
  expect(posts).toEqual([])
  await page.reload()
  await expect(card).toBeVisible()
  await expect(card.getByRole("button", { name: "Edit", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(card.locator('.ProseMirror[contenteditable="true"]')).toHaveCount(0)
  await card.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(card.locator('.ProseMirror')).toContainText("Shared Markdown.")
  expect(posts).toEqual([])
  expect(bootstrap().page.body).toBe("# Architecture\n\n## Runtime\n\nOne runtime for Bun and Node.\n\n## Wiki\n\nShared Markdown.")
  const component = await card.locator(".world-card-workspace").elementHandle()
  await card.getByRole("button", { name: /maximize/i }).click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  expect(await card.locator(".world-card-workspace").evaluate((node, original) => node === original, component)).toBe(true)
  await card.getByRole("button", { name: "Restore", exact: true }).click()
  await expect(card).toHaveAttribute("data-maximized", "false")
  doc.destroy()
})

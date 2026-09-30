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
  let revision = 1
  const posts: Array<{ update_id: string; update: string; page_id: number }> = []
  const accepted = new Map<string, number>()
  let beforeAcknowledge: (() => Promise<void>) | undefined
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
  await page.route(`**/api/repos/${repo}/wiki/architecture/stream?*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: ": connected\n\n"
    }))
  await page.route(`**/api/repos/${repo}/wiki/architecture/updates?*`, async (route) => {
    const input = route.request().postDataJSON() as typeof posts[number]
    posts.push(input)
    if (!accepted.has(input.update_id)) {
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(input.update, "base64")))
      accepted.set(input.update_id, ++revision)
    }
    const held = beforeAcknowledge
    beforeAcknowledge = undefined
    await held?.()
    return route.fulfill(
      json({ document: bootstrap(), update_id: input.update_id, accepted_revision: accepted.get(input.update_id) })
    )
  })
  return {
    doc, posts, bootstrap,
    holdNextAcknowledgement: () => {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      beforeAcknowledge = () => gate
      return release
    },
    insertPeer: (text: string) => {
      const markdown = doc.getText("markdown")
      markdown.insert(0, text)
      markdown.insert(markdown.length, "\n\nPeer ending.")
      revision++
    }
  }
}

test("collaborative Wiki stays embedded, edits through the flow, and restores the same view after reload", async ({ page }, testInfo) => {
  const { doc, posts, bootstrap } = await wikiFixture(page)
  await page.goto("/")
  await send(page, `/wiki.cloud ${repo}`)
  const index = page.getByTestId(`card-wiki-index-${repo}-public`)
  await expect(index).toBeVisible()
  await page.getByTestId("composer-input").press("Escape")
  await index.getByRole("button", { name: "Open page", exact: true }).click()
  const card = page.getByTestId(`card-${cardId}`)
  // A cloud page opens in its reading view; Outline and Edit are its other views (e9b13a036c).
  await expect(card.getByRole("button", { name: "Document", exact: true })).toHaveAttribute("aria-pressed", "true")
  await card.getByRole("button", { name: "Outline", exact: true }).click()
  await expect(card.getByRole("list", { name: "Page outline" })).toContainText("Runtime")
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await expect(card.locator(".world-card-sidebar")).not.toContainText("wiki:")
  await page.screenshot({ path: testInfo.outputPath("smithers-wiki-outline.png"), fullPage: true })
  await testInfo.attach("smithers-wiki-outline.png", { path: testInfo.outputPath("smithers-wiki-outline.png"), contentType: "image/png" })
  await card.getByRole("button", { name: "Edit", exact: true }).click()
  const editor = card.locator(".ProseMirror[contenteditable=\"true\"]")
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.press("Enter")
  await page.keyboard.type("Collaboration works.")
  await expect.poll(() => bootstrap().page.body).toContain("Collaboration works.")
  await expect(card).toContainText("No pending edits")
  expect(posts.every((post) => post.page_id === pageId)).toBe(true)

  await page.reload()
  await expect(card).toBeVisible()
  await expect(card.getByRole("button", { name: "Edit", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(card).toContainText("This is a saved copy")
  await expect(card.locator(".ProseMirror")).toContainText("Collaboration works.")
  await card.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(card.locator(".ProseMirror[contenteditable=\"true\"]")).toBeVisible()
  const component = await card.locator(".world-card-workspace").elementHandle()
  await card.getByRole("button", { name: /maximize/i }).click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  expect(await card.locator(".world-card-workspace").evaluate((node, original) => node === original, component)).toBe(
    true
  )
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await card.getByRole("button", { name: "Restore", exact: true }).click()
  await expect(card).toHaveAttribute("data-maximized", "false")
  doc.destroy()
})

for (const target of ["caret", "selection", "chat"] as const) {
  test(`a peer Wiki revision preserves the human's ${target} between keystrokes`, async ({ page }) => {
    const fixture = await wikiFixture(page)
    await page.goto("/")
    await send(page, `/wiki.cloud ${repo}`)
    const index = page.getByTestId(`card-wiki-index-${repo}-public`)
    await expect(index).toBeVisible()
    await page.getByTestId("composer-input").press("Escape")
    await index.getByRole("button", { name: "Open page", exact: true }).click()
    const card = page.getByTestId(`card-${cardId}`)
    await card.getByRole("button", { name: "Edit", exact: true }).click()
    const editor = card.locator('.ProseMirror[contenteditable="true"]')
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.press("ControlOrMeta+End")
    const release = fixture.holdNextAcknowledgement()
    try {
      await page.keyboard.press("Enter")
      await page.keyboard.type("Colla")
      await expect.poll(() => fixture.posts.length).toBe(1)
      await expect(editor).toContainText("Colla")
      await expect(editor).toBeFocused()
      if (target === "selection") {
        await page.keyboard.press("Shift+ArrowLeft")
        await page.keyboard.press("Shift+ArrowLeft")
        await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("la")
      } else if (target === "chat") {
        // The editor's spotlight consumes an outside click to release it.
        // Use the app's native Chat shortcut to move directly to its input.
        await page.keyboard.press("ControlOrMeta+k")
        await expect(page.getByTestId("composer-input")).toBeFocused()
        await page.keyboard.type("Keep writing here")
      }
      fixture.insertPeer("Peer note.\n\n")
      release()
      await expect(editor).toContainText("Peer note.")
      if (target === "chat") {
        await expect(page.getByTestId("composer-input")).toBeFocused()
        await page.keyboard.type(" too")
        await expect(page.getByTestId("composer-input")).toHaveValue("Keep writing here too")
      } else {
        await expect(editor).toBeFocused()
        if (target === "selection") {
          await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("la")
          await page.keyboard.type("laboration works.")
        } else {
          await page.keyboard.type("boration works.")
        }
        await expect.poll(() => fixture.bootstrap().page.body).toContain("Collaboration works.")
      }
      await expect(card).toContainText("No pending edits")
      expect(fixture.bootstrap().page.body).toContain("Peer note.")
      expect(fixture.bootstrap().page.body).toContain("Peer ending.")
      await page.reload()
      await expect(card.locator(".ProseMirror")).toContainText("Peer note.")
      await expect(card.locator(".ProseMirror")).toContainText(target === "chat" ? "Colla" : "Collaboration works.")
    } finally {
      release()
      fixture.doc.destroy()
    }
  })
}

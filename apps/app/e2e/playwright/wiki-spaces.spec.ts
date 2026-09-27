import { expect, test, type Page } from "./browserTest"
import * as Y from "yjs"
import { installCloudFixture } from "./cloudFixture"

/*
 * The wiki spaces (#1922) in the Wiki pane, against a fake Smithers Cloud
 * that answers the contract's routes by space: the public/private switch
 * and same-path isolation, the tree with folders and tags, the page with
 * its server backlinks, editing through the existing collaborative save, a
 * page's history card with per-revision downloads, an attachment shown from
 * its scoped content route, a rename refused at a stale revision (visible),
 * and a new page acknowledged at once with the toast following the write.
 * With SMITHERS_WIKI_CAPTURE set, the pane is captured in both spaces.
 */

const repo = "smithersai/smithers"
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) })
const author = { id: 1, login: "will" }
const at = "2026-09-26T00:00:00Z"
type Space = "public" | "private"

/** A slash command from the app home: Control+K opens the composer (D-18), the line runs, Escape closes it. */
const slash = async (page: Page, line: string) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await expect(input).toBeVisible()
  await input.fill(line)
  await page.getByTestId("composer-send").click()
  await expect(page.getByTestId("composer-input")).toHaveValue("")
  await page.getByTestId("composer-input").press("Escape")
}

const wikiFixture = async (page: Page) => {
  const bodies: Record<Space, Record<string, string>> = {
    public: { home: "# Home\n\nSee [[Guides/Start#Install|start]].\n\n![[assets/logo.png]]\n\nLater: [[Nowhere]].", start: `# Start\n\nBack to [[Home]].\n${"\nA paragraph.\n".repeat(40)}\n## Install\n\nRun the installer.` },
    private: { home: "# Home\n\nPrivate notes. Read [[Plans/Roadmap|the roadmap]].\n\n![[assets/diagram.png]]", roadmap: "# Roadmap\n\nBack to [[Home]]." }
  }
  const pages: Record<Space, Array<Record<string, unknown>>> = {
    public: [
      { id: 1, slug: "home", title: "Home", path: "Home.md", revision: 3, visibility: "public", content_digest: "a".repeat(64), author, created_at: at, updated_at: at,
        metadata: { frontmatter: null, aliases: [], tags: ["guide"], headings: ["Home"], links: [{ target: "Guides/Start", heading: "Install", alias: "start", embed: false, page_id: 2 }, { target: "assets/logo.png", embed: true, page_id: 3 }, { target: "Nowhere", embed: false }] },
        backlinks: [{ page_id: 2, path: "Guides/Start.md", embed: false }] },
      { id: 2, slug: "start", title: "Start", path: "Guides/Start.md", revision: 1, visibility: "public", content_digest: "b".repeat(64), author, created_at: at, updated_at: at,
        metadata: { frontmatter: null, aliases: [], tags: ["guide"], headings: ["Start", "Install"], links: [{ target: "Home", embed: false, page_id: 1 }] }, backlinks: [{ page_id: 1, path: "Home.md", embed: false }] },
      { id: 3, slug: "logo", title: "logo.png", path: "assets/logo.png", revision: 1, visibility: "public", content_digest: "c".repeat(64), author, created_at: at, updated_at: at,
        attachment: { digest: "c".repeat(64), media_type: "image/png", size: 68 }, metadata: { frontmatter: null, aliases: [], tags: [], headings: [], links: [] }, backlinks: [{ page_id: 1, path: "Home.md", embed: true }] }
    ],
    private: [
      { id: 9, slug: "home", title: "Home", path: "Home.md", revision: 1, visibility: "private", content_digest: "d".repeat(64), author, created_at: at, updated_at: at,
        metadata: { frontmatter: null, aliases: [], tags: ["secret"], headings: ["Home"], links: [{ target: "Plans/Roadmap", alias: "the roadmap", embed: false, page_id: 10 }, { target: "assets/diagram.png", embed: true, page_id: 11 }] },
        backlinks: [{ page_id: 10, path: "Plans/Roadmap.md", embed: false }] },
      { id: 10, slug: "roadmap", title: "Roadmap", path: "Plans/Roadmap.md", revision: 1, visibility: "private", content_digest: "e".repeat(64), author, created_at: at, updated_at: at,
        metadata: { frontmatter: null, aliases: [], tags: ["secret"], headings: ["Roadmap"], links: [{ target: "Home", embed: false, page_id: 9 }] }, backlinks: [{ page_id: 9, path: "Home.md", embed: false }] },
      { id: 11, slug: "diagram", title: "diagram.png", path: "assets/diagram.png", revision: 1, visibility: "private", content_digest: "f".repeat(64), author, created_at: at, updated_at: at,
        attachment: { digest: "f".repeat(64), media_type: "image/png", size: 68 }, metadata: { frontmatter: null, aliases: [], tags: [], headings: [], links: [] }, backlinks: [{ page_id: 9, path: "Home.md", embed: true }] }
    ]
  }
  const docs = new Map<string, Y.Doc>()
  const docOf = (space: Space, slug: string) => {
    const key = `${space}/${slug}`
    let doc = docs.get(key)
    if (doc === undefined) { doc = new Y.Doc(); doc.getText("markdown").insert(0, bodies[space][slug] ?? ""); docs.set(key, doc) }
    return doc
  }
  const requests: Array<{ method: string; url: string }> = []
  // A 480x180 checker: an embed the capture can see.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAeAAAAC0CAIAAADD3miXAAAFHklEQVR42u3UwQkAIBADwavL2mzYx7Ug1uAvBwOpYFhSfe647dXjxpkzZ86/K9CC5syZs4MWNGfOnDk7aEFz5szZQYMWNGfOnB20oDlz5uygQQuaM2fODlrQnDlz5uygBc2ZM2cHDVrQnDlzdtCC5syZs4MGLWjOnDk7aEFz5syZs4MWNGfOnB00aEFz5szZQQuaM2fODhq0oDlz5uygBc2ZM2cHDVrQnDlzdtCC5syZM2cHLWjOnDk7aNCC5syZs4MWNGfOnB00aEFz5szZQQuaM2fOnB20oDlz5uygQQuaM2fODlrQnDlzdtCgBc2ZM2cHLWjOnDk7aNCC5syZs4MWNGfOnDk7aEFz5szZQYMWNGfOnB20oDlz5uygQQuaM2fODlrQnDlz5uygBc2ZM2cHDVrQnDlzdtCC5syZs4MGLWjOnDk7aEFz5szZQYMWNGfOnB20oDlz5szZQQuaM2fODhq0oDlz5uygBc2ZM2cHDVrQnDlzdtCC5syZM2cHLWjOnDk7aNCC5syZs4MWNGfOnB00aEFz5szZQQuaM2fOnB20oDlz5uygQXPmzJmzgxY0Z86cHTRoQXPmzNlBC5ozZ84OGrSgOXPmHHPQ4hAHZ86cM+egBc2ZM2cHLWjOnDlzdtCC5syZs4MGLWjOnDk7aEFz5szZQYMWNGfOnB20oDlz5szZQQuaM2fODhq0oDlz5uygBc2ZM2cHDVrQnDlzdtCC5syZM2cHLWjOnDk7aNCC5syZs4MWNGfOnB00aEFz5szZQQuaM2fODhq0oDlz5uygBc2ZM2fODlrQnDlzdtCgBc2ZM2cHLWjOnDk7aNCC5syZs4MWNGfOnDk7aEFz5szZQYMWNGfOnB20oDlz5uygQQuaM2fODlrQnDlzdtCgBc2ZM2cHLWjOnDlzdtCC5syZs4MGLWjOnDk7aEFz5szZQYMWNGfOnB20oDlz5szZQQuaM2fODhq0oDlz5uygBc2ZM2cHDVrQnDlzdtCC5syZs4MGLWjOnDk7aEFz5syZs4MWNGfOnB00aEFz5szZQQuaM2fODhq0oDlz5uygBc2ZM2fODlrQnDlzdtCgBc2ZM2cHLWjOnDk7aNCC5syZs4MWNGfOnDk7aEFz5szZQYMWNGfOnB20oDlz5uygQQuaM2fODlrQnDlzdtCgBc2ZM+ecgxaHODhz5pw5By1ozpw5O2hBc+bMmbODFjRnzpwdNGhBc+bM2UELmjNnzg4atKA5c+bsoAXNmTNnzg5a0Jw5c3bQoAXNmTNnBy1ozpw5O2jQgubMmbODFjRnzpw5O2hBc+bM2UGDFjRnzpwdtKA5c+bsoEELmjNnzg5a0Jw5c3bQoAXNmTNnBy1ozpw5c3bQgubMmbODBi1ozpw5O2hBc+bM2UGDFjRnzpwdtKA5c+bM2UELmjNnzg4atKA5c+bsoAXNmTNnBw1a0Jw5c3bQgubMmbODBi1ozpw5O2hBc+bMmbODFjRnzpwdNGhBc+bM2UELmjNnzg4atKA5c+bsoAXNmTNnzg5a0Jw5c3bQoAXNmTNnBy1ozpw5O2jQgubMmbODFjRnzpwdNGhBc+bM2UELmjNnzpwdtKA5c+bsoEELmjNnzg5a0Jw5c3bQoAXNmTNnBy1ozpw5c3bQgubMmbODBi1ozpw5O2hBc+bM2UGDFjRnzpwdtKA5c+bM2UELmjNnzg4atKA5c+bsoAXNmTNnBw1a0Jw5c3bQgubMmbODBi1ozpw5x+wB0G2dYOK+sO0AAAAASUVORK5CYII=", "base64")
  let renameHold: (() => Promise<void>) | undefined
  await installCloudFixture(page)
  // The app home (D-18): the repository's homepage blocks, so the chat behind the pane is the grid.
  await page.route((url) => url.pathname === `/api/repos/${repo}/home`, (route) => route.fulfill({ json: { kind: "blocks", blocks: [
    { type: "prompt", title: "What should we work on?", placeholder: "Ask Smithers…" },
    { type: "app", flow: "issue.implement", title: "Fix an issue", picture: "issue" },
    { type: "app", flow: "prs.triage", title: "Review a PR", picture: "review" },
    { type: "app", flow: "wiki.ask", title: "Ask the codebase", picture: "wiki" },
    { type: "app", flow: "triggers.register", title: "Run it every night", picture: "schedule" }
  ] } }))
  const wikiRoute = async (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
    const request = route.request()
    const url = new URL(request.url())
    const space = (url.searchParams.get("visibility") ?? "missing") as Space | "missing"
    requests.push({ method: request.method(), url: url.pathname + url.search })
    if (space === "missing") return route.fulfill(json({ message: "visibility is required" }, 400))
    const path = url.pathname
    if (path.endsWith("/navigation/index")) {
      return route.fulfill(json({ pages: pages[space].map((row) => ({ ...row, body: "" })),
        folders: [...new Set(pages[space].flatMap((row) => String(row.path).includes("/") ? [String(row.path).split("/")[0]] : []))],
        tags: [...new Set(pages[space].flatMap((row) => (row.metadata as { tags: string[] }).tags))] }))
    }
    if (/\/history\/1$/.test(path)) return route.fulfill(json([
      { page_id: 1, revision: 3, path: "Home.md", title: "Home", content_digest: "a".repeat(64), deleted: false, author, updated_at: "2026-09-26T03:00:00Z" },
      { page_id: 1, revision: 2, path: "Old/Home.md", title: "Home", content_digest: "e".repeat(64), deleted: false, author: { id: 2, login: "ada" }, updated_at: "2026-09-26T02:00:00Z" },
      { page_id: 1, revision: 1, path: "Old/Home.md", title: "Home", content_digest: "f".repeat(64), deleted: false, author, updated_at: "2026-09-26T01:00:00Z" }
    ]))
    if (/\/history\/(3|11)\/1\/content$/.test(path)) return route.fulfill({ status: 200, contentType: "image/png", body: png })
    if (/\/history\/\d+\/\d+\/content$/.test(path)) return route.fulfill({ status: 200, contentType: "text/markdown", body: "# Old" })
    const slugMatch = /\/wiki\/([^/]+)(?:\/(document|updates|stream))?$/.exec(path)
    if (request.method() === "PATCH" && slugMatch !== null) {
      await renameHold?.()
      const body = request.postDataJSON() as { path?: string; expected_revision?: number }
      const row = pages[space].find((candidate) => candidate.slug === slugMatch[1])
      if (row === undefined) return route.fulfill(json({ message: "not found" }, 404))
      if (body.expected_revision !== row.revision) return route.fulfill(json({ message: `revision ${body.expected_revision} is not current` }, 409))
      row.path = body.path ?? row.path
      row.revision = Number(row.revision) + 1
      return route.fulfill(json(row))
    }
    if (request.method() === "POST" && path.endsWith("/wiki")) {
      // Slow enough for the notice to show (the 300 ms toast law), fast enough to settle in a test.
      await new Promise((resolve) => setTimeout(resolve, 500))
      const body = request.postDataJSON() as { title: string; body: string }
      const row = { id: 20, slug: "notes", title: body.title, path: "Notes.md", revision: 1, visibility: space, content_digest: "1".repeat(64), author, created_at: at, updated_at: at, metadata: { frontmatter: null, aliases: [], tags: [], headings: [body.title], links: [] }, backlinks: [] }
      pages[space].push(row)
      bodies[space]["notes"] = body.body
      return route.fulfill(json(row))
    }
    if (request.method() === "PUT" && path.includes("/attachments/")) {
      const row = { id: 30, slug: "home-diagram-png", title: "diagram.png", path: url.searchParams.get("path"), revision: 1, visibility: space, content_digest: "9".repeat(64), author, created_at: at, updated_at: at, attachment: { digest: "9".repeat(64), media_type: request.headers()["content-type"], size: request.postDataBuffer()?.length ?? 0 }, metadata: { frontmatter: null, aliases: [], tags: [], headings: [], links: [] }, backlinks: [] }
      pages[space].push(row)
      return route.fulfill(json(row))
    }
    if (slugMatch !== null && slugMatch[2] === "document") {
      const row = pages[space].find((candidate) => candidate.slug === slugMatch[1])
      if (row === undefined) return route.fulfill(json({ message: "not found" }, 404))
      const doc = docOf(space, slugMatch[1]!)
      return route.fulfill(json({ page: { ...row, body: doc.getText("markdown").toString() }, state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"), state_vector: Buffer.from(Y.encodeStateVector(doc)).toString("base64") }))
    }
    // A live revision stream stays open; a stream that ended would say "Reconnecting". The request rests until the page closes.
    if (slugMatch !== null && slugMatch[2] === "stream") return new Promise<void>(() => {})
    if (slugMatch !== null && slugMatch[2] === "updates") {
      const input = request.postDataJSON() as { update_id: string; update: string; page_id: number }
      const row = pages[space].find((candidate) => candidate.id === input.page_id)!
      const doc = docOf(space, String(row.slug))
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(input.update, "base64")))
      row.revision = Number(row.revision) + 1
      return route.fulfill(json({ document: { page: { ...row, body: doc.getText("markdown").toString() }, state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"), state_vector: Buffer.from(Y.encodeStateVector(doc)).toString("base64") }, update_id: input.update_id, accepted_revision: row.revision }))
    }
    if (path.endsWith("/wiki")) {
      return route.fulfill(json(pages[space].map(({ metadata: _m, backlinks: _b, ...row }) => row)))
    }
    return route.fulfill(json({ message: `unexpected ${path}` }, 500))
  }
  await page.route(`**/api/repos/${repo}/wiki/**`, wikiRoute)
  await page.route(`**/api/repos/${repo}/wiki?*`, wikiRoute)
  return { pages, bodies, requests, docOf, holdRename: () => { let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve }); renameHold = () => gate; return release } }
}

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

test("the Wiki pane: spaces, tree, page, backlinks, edit, history, attachment, rename conflict, new page", async ({ page }) => {
  const fixture = await wikiFixture(page)
  await page.goto("/")
  // The app home (D-18) is up before the chord: the grid, no chat controls strip.
  await expect(page.getByTestId("app-tile")).toHaveCount(4)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0)
  // The wiki belongs to the selected repository (the fixture loads one; the selection names it).
  await slash(page, `/repo.select ${repo}`)
  await slash(page, "/wiki.pane")
  const pane = page.locator(".world-surface")
  await expect(pane).toBeVisible()
  await expect(pane.getByTestId("wiki-space-public")).toHaveAttribute("aria-pressed", "true")
  // The public tree: its folders and pages, its tags.
  const tree = pane.getByTestId("wiki-tree")
  await expect(tree.locator('[data-slot="file-tree-dir-toggle"]')).toHaveText(["Guides", "assets"])
  await expect(tree.getByRole("button", { name: "#guide" })).toBeVisible()
  // Opening a page runs wiki.cloud.open in the shown space; the page shows its path, revision and server backlinks.
  await tree.getByRole("button", { name: "Home", exact: true }).click()
  await expect(pane.getByTestId("wiki-page-path")).toHaveText("Home.md")
  await expect(pane.getByTestId("wiki-page-revision")).toHaveText("r3")
  const rail = pane.getByTestId("wiki-rail")
  await expect(rail).toContainText("Guides/Start.md")
  expect(fixture.requests.some((request) => request.url === `/api/repos/${repo}/wiki/home/document?visibility=public`)).toBe(true)
  // The page reads rendered: the wikilink with its alias, the embedded image from its scoped route, the unresolved target marked, no raw markup, no chat card behind it.
  const view = pane.getByTestId("wiki-page")
  await expect(view.getByRole("link", { name: "start", exact: true })).toHaveAttribute("href", "#note/Guides%2FStart.md?h=Install")
  await expect(view.getByTestId("wiki-embed").locator("img")).toHaveAttribute("src", `/api/repos/${repo}/wiki/history/3/1/content?visibility=public`)
  await expect(view.locator('a[href^="#unresolved/"]')).toHaveText("Nowhere")
  await expect(view).not.toContainText("[[")
  await expect(pane.locator(".world-document-notice")).toHaveCount(0)
  await expect(page.locator('[data-testid^="card-wiki-open-"]')).toHaveCount(0)
  if (process.env.SMITHERS_WIKI_CAPTURE) {
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: `${process.env.SMITHERS_WIKI_CAPTURE}-public.png` })
  }
  // A wikilink opens its page and carries the heading; the page's own backlinks follow.
  await view.getByRole("link", { name: "start", exact: true }).click()
  await expect(pane.getByTestId("wiki-page-path")).toHaveText("Guides/Start.md")
  await expect(rail).toContainText("Home.md")
  await expect(view.locator(".sui-md-heading", { hasText: "Install" })).toBeInViewport()
  // The private space: the same path is another page, with its own tree and tags.
  await pane.getByTestId("wiki-space-private").click()
  await expect(pane.getByTestId("wiki-space-private")).toHaveAttribute("aria-pressed", "true")
  await expect(tree).toHaveAttribute("data-space", "private")
  await expect(tree.getByRole("button", { name: "#secret" })).toBeVisible()
  await expect(tree.locator('[data-slot="file-tree-dir-toggle"]')).toHaveText(["Plans", "assets"])
  await tree.getByRole("button", { name: "Home", exact: true }).click()
  await expect(pane.getByTestId("wiki-page-revision")).toHaveText("r1")
  await expect(pane.getByTestId("wiki-page")).toContainText("Private notes.")
  expect(fixture.requests.some((request) => request.url === `/api/repos/${repo}/wiki/home/document?visibility=private`)).toBe(true)
  await expect(pane.getByTestId("wiki-page").getByRole("link", { name: "the roadmap", exact: true })).toBeVisible()
  await expect(pane.getByTestId("wiki-page").getByTestId("wiki-embed").locator("img")).toBeVisible()
  await expect(rail).toContainText("Plans/Roadmap.md")
  if (process.env.SMITHERS_WIKI_CAPTURE) {
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: `${process.env.SMITHERS_WIKI_CAPTURE}-private.png` })
  }
  // Back to the public space: the tree is public again, and Start is where the edit goes.
  await pane.getByTestId("wiki-space-public").click()
  await expect(tree).toHaveAttribute("data-space", "public")
  await tree.getByRole("button", { name: "Start", exact: true }).click()
  await expect(pane.getByTestId("wiki-page-path")).toHaveText("Guides/Start.md")
  // Editing: Edit shows the editor; the existing collaborative save carries the space.
  await pane.getByTestId("wiki-page-edit").click()
  const editor = pane.locator('.ProseMirror[contenteditable="true"]')
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.press("Enter")
  await page.keyboard.type("Edited here.")
  await expect.poll(() => fixture.docOf("public", "start").getText("markdown").toString()).toContain("Edited here.")
  expect(fixture.requests.some((request) => request.url === `/api/repos/${repo}/wiki/start/updates?visibility=public`)).toBe(true)
  await pane.getByTestId("wiki-page-edit").click()
  await expect(pane.getByTestId("wiki-page")).toContainText("Edited here.")
  // The tag narrows the tree; the search does too.
  await tree.getByRole("button", { name: "#guide" }).click()
  await expect(tree.locator('[data-slot="file-tree-file"]')).toHaveCount(2)
  await tree.getByRole("button", { name: "#guide" }).click()
  await tree.getByRole("searchbox", { name: "Search pages" }).fill("logo")
  await expect(tree.locator('[data-slot="file-tree-file"]')).toHaveCount(1)
  // The attachment: shown from its scoped content route.
  await tree.getByRole("button", { name: "logo.png", exact: true }).click()
  await expect(pane.getByTestId("wiki-attachment").locator("img")).toHaveAttribute("src", `/api/repos/${repo}/wiki/history/3/1/content?visibility=public`)
  await tree.getByRole("searchbox", { name: "Search pages" }).fill("")
  // History: the card in the chat, one download per revision, renames included.
  await tree.getByRole("button", { name: "Home", exact: true }).click()
  await pane.getByTestId("wiki-page-history").click()
  const history = page.getByTestId("wiki-history")
  await expect(history).toBeVisible()
  await expect(history.getByTestId("wiki-revision-2")).toContainText("Old/Home.md")
  await expect(history.getByTestId("wiki-revision-3").getByRole("link", { name: "r3" })).toHaveAttribute("href", `/api/repos/${repo}/wiki/history/1/3/content?visibility=public`)
  // Rename at a stale revision: refused, visible, nothing overwritten.
  fixture.pages.public[0]!.revision = 7
  await pane.getByTestId("wiki-page-rename").click()
  const rename = page.locator('form.flow-form[data-flow-name="wiki.cloud.rename"]')
  await expect(rename.locator("label")).toHaveCount(1)
  await rename.getByTestId("flow-form-path").fill("Guides/Home.md")
  await rename.getByTestId("flow-form-submit").click()
  await expect(page.locator('[data-toast-status="failed"]').filter({ hasText: "changed since you opened it" })).toBeVisible()
  expect(fixture.pages.public[0]!.path).toBe("Home.md")
  // The refusal stays until dismissed; every notice leaves before the switch is pressed (the stack sits over the pane's header).
  for (let attempt = 0; attempt < 3 && await page.locator('[data-toast-status="failed"]').count() > 0; attempt++) {
    await page.getByRole("button", { name: /^Dismiss:/ }).first().click()
    await page.waitForTimeout(1500)
  }
  await expect(page.locator(".toast-stack .toast")).toHaveCount(0, { timeout: 20_000 })
  // The private space again for the new page.
  await pane.getByTestId("wiki-space-private").click()
  await expect(tree).toHaveAttribute("data-space", "private")
  // New page: one input, Create; acknowledged at once, the toast follows the write, the page opens in this space.
  await pane.getByRole("button", { name: "New page" }).first().click()
  const create = page.locator('form.flow-form[data-flow-name="wiki.cloud.new"]')
  await expect(create.locator("label")).toHaveCount(1)
  await create.getByTestId("flow-form-title").fill("Notes")
  await create.getByTestId("flow-form-submit").click()
  await expect(page.locator('[data-toast-status="ok"]').filter({ hasText: "Notes created" })).toBeVisible()
  await expect(pane.getByTestId("wiki-page-path")).toHaveText("Notes.md")
  expect(fixture.requests.some((request) => request.method === "POST" && request.url === `/api/repos/${repo}/wiki?visibility=private`)).toBe(true)
  // Public rows never reached the private tree.
  await expect(tree.getByRole("button", { name: "Start", exact: true })).toHaveCount(0)
})

test("the Wiki card lists the space with its chip and offers a page's History", async ({ page }) => {
  await wikiFixture(page)
  await page.goto("/")
  // The app home (D-18) is up before the chord: the grid, no chat controls strip.
  await expect(page.getByTestId("app-tile")).toHaveCount(4)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0)
  await slash(page, `/repo.select ${repo}`)
  await slash(page, `/wiki.cloud ${repo} --space private`)
  const card = page.getByTestId(`card-wiki-index-${repo}`)
  await expect(card).toBeVisible()
  await expect(card.getByTestId("wiki-card-space")).toHaveText("private")
  await expect(card.getByTestId("wiki-card-tree").getByRole("button", { name: "#secret" })).toBeVisible()
  await card.getByTestId("wiki-card-tree").getByRole("button", { name: "Home", exact: true }).click()
  const open = page.locator('[data-testid="card-wiki-open-wiki:smithersai/smithers:9"]')
  await expect(open).toBeVisible()
  await expect(open.getByTestId("wiki-card-history")).toHaveAttribute("data-flow", "wiki.history")
})

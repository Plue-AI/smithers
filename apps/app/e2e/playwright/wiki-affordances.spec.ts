import { expect, test, type Page } from "./browserTest"

/*
 * The Wiki's row affordances, proven end to end.
 *
 * Each row here runs a registered flow and says which one in `data-flow`: a
 * note row in the card's `FileTree` (wiki.card.select), a heading in the
 * card's outline (wiki.heading), a node in `KnowledgeGraph` (wiki.open) and a
 * link row in the links card (wiki.open). Reading the attribute off the DOM
 * would pass while the flow behind it ran nothing — which is exactly what the
 * ref-callback stamp these bindings replaced used to hide — so every test
 * clicks the row and asserts what the app then shows.
 */
test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the stub suite; no turn is sent")
test.use({ actionTimeout: 5_000 })
test.setTimeout(60_000)

const run = async (page: Page, line: string) => {
  const input = page.getByTestId("composer-input")
  if (!(await input.isVisible())) await page.getByRole("button", { name: "Chat", exact: true }).click()
  await expect(input).toBeVisible()
  await input.fill(line)
  await page.keyboard.press("Enter")
}

/** `count` notes, each created through wiki.new-note and embedded as its own card. */
const seedNotes = async (page: Page, count: number) => {
  await page.goto("/")
  await expect(page.locator(".app-shell")).toBeVisible()
  for (let index = 1; index <= count; index += 1) {
    await run(page, "/wiki.new-note")
    await expect(page.locator('[data-testid^="card-wiki-open-"]', { hasText: `Untitled ${index}` }).first())
      .toBeVisible({ timeout: 10_000 })
  }
}

/** The whole-Wiki card `wiki` embeds: every note in one FileTree. */
const wikiCard = (page: Page) => page.getByTestId("card-world-embedded")

test("a note row in the card's tree runs wiki.card.select and the card opens that note", async ({ page }) => {
  await seedNotes(page, 2)
  await run(page, "/wiki")
  const card = wikiCard(page)
  await expect(card).toBeVisible({ timeout: 10_000 })
  const path = card.locator(".world-card-path").first()
  await expect(path).toContainText("Untitled 1.md")

  await card.locator(".world-card-sidebar button", { hasText: "Untitled 2" }).click()
  await expect(path).toContainText("Untitled 2.md")
  // The row is the door both ways, not a one-shot that only ever moves forward.
  await card.locator(".world-card-sidebar button", { hasText: "Untitled 1" }).click()
  await expect(path).toContainText("Untitled 1.md")
})

test("an outline heading runs wiki.heading and the card turns to the document it scrolls", async ({ page }) => {
  await seedNotes(page, 1)
  await run(page, "/wiki")
  const card = wikiCard(page)
  await expect(card).toBeVisible({ timeout: 10_000 })
  // A new note is `# Untitled 1`, so its outline has exactly that heading.
  const outline = card.getByRole("list", { name: "Page outline" })
  await expect(outline).toContainText("Untitled 1")
  await expect(card.getByRole("button", { name: "Document", exact: true })).toHaveAttribute("aria-pressed", "false")

  await outline.getByRole("button", { name: "Untitled 1", exact: true }).click()
  /*
   * wiki.heading scrolls the open note's editor, so it first has to BE the
   * open editor: the flow turns the card to its document view and only then
   * scrolls. That turn is the visible half, and it happens only if the flow
   * ran — a refusal would leave the outline showing and say why.
   */
  await expect(card.getByRole("button", { name: "Document", exact: true })).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 })
  await expect(card.locator(".ProseMirror")).toBeVisible()
  await expect(page.locator(".smithers-transcript")).not.toContainText("no longer available")
  await expect(page.locator(".smithers-transcript")).not.toContainText("has no line")
})

test("a graph node runs wiki.open and the note it names is embedded", async ({ page }) => {
  await seedNotes(page, 1)
  await run(page, "/wiki.graph")
  const graph = page.getByTestId("card-wiki-graph")
  await expect(graph).toBeVisible({ timeout: 10_000 })
  const node = graph.locator('[data-flow="wiki.open"]').first()
  await expect(node).toBeVisible({ timeout: 10_000 })
  await node.click()
  await expect(page.locator('[data-testid^="card-wiki-open-"]', { hasText: "Untitled 1" }).first())
    .toBeVisible({ timeout: 10_000 })
})

test("a links-card row runs wiki.open and embeds the note", async ({ page }) => {
  await seedNotes(page, 1)
  await run(page, "/wiki.backlinks Untitled 1.md")
  const links = page.locator('[data-testid^="card-wiki-links-"]').first()
  await expect(links).toBeVisible({ timeout: 10_000 })
  await expect(links.getByTestId("wiki-links-path")).toContainText("Untitled 1.md")
  await links.getByTestId("wiki-links-open").click()
  await expect(page.locator('[data-testid^="card-wiki-open-"]', { hasText: "Untitled 1" }).first())
    .toBeVisible({ timeout: 10_000 })
})

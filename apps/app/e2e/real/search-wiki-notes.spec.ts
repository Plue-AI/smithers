import type { Locator, Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { attachJson } from "./issues/local"
import { awaitBoot, closeComposer, command, expect, openApp, reloadApp, test } from "./support/test"

type Note = { readonly id: string; readonly title: string }

const createNote = async (page: Page): Promise<Note> => {
  const notes = page.locator('.smithers-card[data-kind="world"]')
  const before = await notes.count()
  await command(page, "/wiki.new-note")
  await closeComposer(page)
  await expect(notes).toHaveCount(before + 1)
  const card = notes.last()
  const id = (await card.getAttribute("data-testid"))?.replace(/^card-wiki-open-/, "") ?? ""
  expect(id).toMatch(/^[0-9a-f-]{36}$/)
  const title = ((await card.locator("h3").textContent()) ?? "").replace(/^#\s*/, "").trim()
  expect(title).toMatch(/^Untitled \d+$/)
  return { id, title }
}

const searchCard = (page: Page, flow: string): Locator => page.getByTestId(`card-search-${flow}`)

/** The note rows a search card holds, by document id. */
const noteRows = async (card: Locator): Promise<ReadonlyArray<string>> =>
  (await card.locator('[data-testid^="search-item-note-"]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid") ?? "")))
    .map((testId) => testId.replace(/^search-item-note-/, "")).sort()

test("wiki and open search find the stored notes, survive reload and drop a deleted note", scenario("search.wiki-notes-readback", {
  capabilities: [],
  description: "Create two real Wiki notes in browser storage, find both with search.wiki and a note-only search, reload and find them again, delete one from its search row and rerun the search from the keyboard.",
  coverage: [
    "action:search.wiki", "action:search", "action:wiki.new-note", "action:wiki.delete", "action:wiki.delete.confirm",
    "host:local", "path:success", "path:persistence", "path:keyboard", "door:slash", "door:button",
    "dimension:reload", "dimension:keyboard", "dimension:kind-filter", "dimension:delete-readback",
    "evidence:stored-note-search-readback"
  ]
}), async ({ page }, testInfo) => {
  const started = performance.now()
  await openApp(page)
  await awaitBoot(page, "navigate", started)
  const first = await createNote(page)
  const second = await createNote(page)
  const both = [first.id, second.id].sort()

  await command(page, "/search.wiki Untitled")
  await closeComposer(page)
  const wiki = searchCard(page, "search.wiki")
  await expect(wiki.getByTestId("search-results-query")).toHaveText("/search.wiki Untitled · 2 results")
  expect(await noteRows(wiki)).toEqual(both)
  await expect(wiki.getByTestId(`search-item-note-${first.id}`)).toContainText(`${first.title}.md`)

  await command(page, "/search Untitled")
  await closeComposer(page)
  const open = searchCard(page, "search")
  await expect(open.getByTestId("search-results-query")).toHaveText("/search Untitled · 2 results")
  expect(await noteRows(open)).toEqual(both)
  await command(page, "/search Untitled --kinds flow")
  await closeComposer(page)
  await expect(open.getByTestId("search-results-query")).toHaveText("/search Untitled · 0 results")
  expect(await noteRows(open)).toEqual([])
  await command(page, "/search Untitled --kinds note")
  await closeComposer(page)
  await expect(open.getByTestId("search-results-query")).toHaveText("/search Untitled · 2 results")
  expect(await noteRows(open)).toEqual(both)

  await reloadApp(page)
  await command(page, "/search.wiki Untitled")
  await closeComposer(page)
  await expect(wiki.getByTestId("search-results-query")).toHaveText("/search.wiki Untitled · 2 results")
  expect(await noteRows(wiki)).toEqual(both)

  await wiki.getByTestId(`search-item-note-${first.id}`).getByTestId("search-action-wiki.delete").click()
  const confirmation = page.getByRole("dialog", { name: `Delete ${first.title}?`, exact: true })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click()
  await expect(confirmation).toBeHidden()

  const rerun = wiki.getByTestId("search-results-rerun")
  await rerun.focus()
  await expect(rerun).toBeFocused()
  await rerun.press("Enter")
  await expect(wiki.getByTestId("search-results-query")).toHaveText("/search.wiki Untitled · 1 result")
  expect(await noteRows(wiki)).toEqual([second.id])

  await reloadApp(page)
  await command(page, "/search Untitled --kinds note")
  await closeComposer(page)
  await expect(open.getByTestId("search-results-query")).toHaveText("/search Untitled · 1 result")
  expect(await noteRows(open)).toEqual([second.id])
  await attachJson(testInfo, "wiki-search-readback", { created: [first, second], deleted: first.id, remaining: await noteRows(open) })
})

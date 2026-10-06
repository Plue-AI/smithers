import type { Locator, Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { appReady, awaitBoot, command, closeComposer, expect, openApp, reloadApp, test } from "./support"
import { controlTabKey } from "../playwright/browserTest"

const matrixTest = process.env.SMITHERS_REAL_E2E_MODE === undefined ? test : authenticatedTest

const boot = async (page: Page) => {
  const startedAt = performance.now()
  await openApp(page); await awaitBoot(page, "navigate", startedAt)
  await appReady(page)
}
const createNote = async (page: Page) => {
  const before = await page.locator('.smithers-card[data-kind="world"]').count()
  await command(page, "/wiki.new-note"); await closeComposer(page)
  await expect(page.locator('.smithers-card[data-kind="world"]')).toHaveCount(before + 1)
  const card = page.locator('.smithers-card[data-kind="world"]').last(); await expect(card).toBeVisible()
  const cardId = ((await card.getAttribute("data-testid")) ?? "").replace(/^card-/, "")
  expect(cardId).toMatch(/^wiki-open-/)
  const title = ((await card.locator("h3").textContent())?.trim() ?? "").replace(/^#\s*/, "")
  await card.getByRole("button", { name: "Document", exact: true }).click()
  return { card: page.getByTestId(`card-${cardId}`), cardId, documentId: cardId.replace(/^wiki-open-/, ""), title }
}
const edit = async (page: Page, card: Locator, markdown: string) => {
  const editor = card.locator('.ProseMirror[contenteditable="true"]'); await expect(editor).toBeVisible(); await editor.click()
  await expect(editor).toBeFocused()
  await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.insertText(markdown); await expect(editor).toContainText(markdown.split("\n").at(-1) ?? markdown)
}

const keyboardEdit = async (page: Page, card: Locator, markdown: string) => {
  const editor = card.locator('.ProseMirror[contenteditable="true"]')
  for (let step = 0; step < 80 && !await editor.evaluate(node => document.activeElement === node); step += 1) {
    await page.keyboard.press(controlTabKey(page))
  }
  await expect(editor).toBeFocused()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.insertText(markdown)
  await expect(editor).toContainText(markdown.split("\n").at(-1) ?? markdown)
}
matrixTest("a Wiki note is created and edited through its embedded document card", scenario("local-wiki-card-edit", { capabilities: [], coverage: ["action:wiki.new-note", "action:wiki.card.view", "action:wiki.edit", "host:local", "path:success", "door:slash", "door:button", "dimension:markdown-editor-outline", "evidence:wiki-card-readback"] }), async ({ page }) => {
  await boot(page); const note = await createNote(page)
  const editor = note.card.locator('.ProseMirror[contenteditable="true"]')
  await editor.click(); await expect(editor).toBeFocused(); await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.press("Enter"); await page.keyboard.type("Edited in the embedded Wiki card.")
  await expect(editor).toContainText("Edited in the embedded Wiki card.")
  const markdown = `# ${note.title}\n\n## Durable heading\n\nEdited in the embedded Wiki card.`
  await command(page, `/wiki.edit ${note.documentId} ${JSON.stringify(markdown)}`); await closeComposer(page)
  await note.card.getByRole("button", { name: "Outline", exact: true }).click()
  await expect(note.card.getByRole("list", { name: "Page outline" })).toContainText("Durable heading")
})

matrixTest("Wiki backlinks and graph derive from two edited notes", scenario("local-wiki-links-graph", { capabilities: [], coverage: ["action:wiki.new-note", "action:wiki.card.view", "action:wiki.backlinks", "action:wiki.graph", "action:wiki.open", "host:local", "path:success", "door:slash", "door:button", "dimension:links-backlinks-graph", "evidence:wiki-card-readback"] }), async ({ page }) => {
  await boot(page); const first = await createNote(page); const second = await createNote(page)
  await edit(page, first.card, `# ${first.title}\n\nLinks to [[${second.title}]].`); await edit(page, second.card, `# ${second.title}\n\nBack to [[${first.title}]].`)
  await keyboardEdit(page, first.card, `# ${first.title}\n\nLinks to [[${second.title}]].\n\nKeyboard return to the first note.`)
  await expect(second.card.locator(".ProseMirror")).toContainText(`Back to [[${first.title}]].`)
  await command(page, `/wiki.open ${first.title}`); await closeComposer(page)
  await first.card.getByRole("button", { name: "Document", exact: true }).click()
  await expect(first.card.locator(".ProseMirror")).toContainText("Keyboard return to the first note.")
  await reloadApp(page)
  await expect(first.card.locator(".ProseMirror")).toContainText("Keyboard return to the first note.")
  await expect(second.card.locator(".ProseMirror")).toContainText(`Back to [[${first.title}]].`)
  await command(page, `/wiki.backlinks ${first.title}`); await closeComposer(page)
  const links = page.locator('.smithers-card[data-kind="wiki-links"]').last()
  await expect(links).toContainText(second.title)
  await expect(links.getByRole("heading", { name: "Backlinks · 1", exact: true })).toBeVisible()
  await expect(links.getByRole("heading", { name: "Links out · 1", exact: true })).toBeVisible()
  await command(page, "/wiki.graph"); await closeComposer(page); const graph = page.locator('.smithers-card[data-kind="wiki-graph"]').last()
  await expect(graph).toContainText(first.title); await expect(graph).toContainText(second.title)
  const firstNode = graph.locator("circle").filter({ has: page.locator("title", { hasText: first.title }) }).first(); await expect(firstNode).toBeVisible(); await firstNode.click(); await expect(page.locator('.smithers-card[data-kind="world"]').last()).toHaveAttribute("data-testid", `card-${first.cardId}`)
})

matrixTest("Wiki delete cancel preserves a note and confirm removes it", scenario("local-wiki-delete-confirmation", { capabilities: [], coverage: ["action:wiki.new-note", "action:wiki.delete", "action:wiki.delete.cancel", "action:wiki.delete.confirm", "action:wiki.open", "host:local", "path:success", "door:slash", "door:button", "dimension:confirm-and-cancel", "evidence:wiki-card-readback"] }), async ({ page }) => {
  await boot(page); const note = await createNote(page)
  await command(page, `/wiki.delete ${note.documentId}`); await closeComposer(page); const confirmation = page.getByRole("dialog", { name: `Delete ${note.title}?`, exact: true }); await expect(confirmation).toBeVisible(); await confirmation.getByRole("button", { name: "Cancel", exact: true }).click(); await expect(confirmation).toBeHidden(); await command(page, `/wiki.open ${note.title}`); await closeComposer(page)
  await expect(page.locator('.smithers-card[data-kind="world"]').last()).toContainText(note.title)
  await command(page, `/wiki.delete ${note.documentId}`); await closeComposer(page); await expect(confirmation).toBeVisible(); await confirmation.getByRole("button", { name: "Delete", exact: true }).click(); await expect(confirmation).toBeHidden(); await command(page, `/wiki.open ${note.title}`); await closeComposer(page)
  const failure = page.locator('.toast[data-toast-status="failed"]').filter({ hasText: /There is no Wiki note at/ }).last()
  await expect(failure).toBeVisible()
  const disclosure = failure.locator("details.toast-detail > summary")
  for (let step = 0; step < 80 && !await disclosure.evaluate(node => document.activeElement === node); step += 1) {
    await page.keyboard.press(controlTabKey(page))
  }
  await expect(disclosure).toBeFocused(); await page.keyboard.press("Enter")
  await expect(failure.getByText(/There is no Wiki note at/)).toBeVisible()
})

matrixTest("Wiki card edit survives immediate reload", scenario("local-wiki-immediate-reload", { capabilities: [], coverage: ["action:wiki.new-note", "action:wiki.card.view", "host:local", "path:persistence", "door:slash", "door:button", "dimension:immediate-reload", "evidence:wiki-card-readback"] }), async ({ page }) => {
  await boot(page); const note = await createNote(page); const marker = `rapid-reload-${Date.now()}`
  await edit(page, note.card, `# ${note.title}\n\n${marker}`); await reloadApp(page)
  await expect(page.getByTestId(`card-${note.cardId}`).locator(".ProseMirror")).toContainText(marker)
})

matrixTest("Wiki edit survives an immediate page restart", scenario("local-eventual-page-restart-persistence", { capabilities: [], coverage: ["action:wiki.new-note", "action:wiki.card.view", "host:local", "path:persistence", "door:slash", "door:button", "dimension:eventual-durability-page-restart", "evidence:wiki-card-readback"] }), async ({ page, context }) => {
  await boot(page); const note = await createNote(page); const marker = `durable-restart-${Date.now()}`
  await edit(page, note.card, `# ${note.title}\n\n${marker}`); await page.close()
  const restarted = await context.newPage(); await boot(restarted)
  await expect(restarted.getByTestId(`card-${note.cardId}`).locator(".ProseMirror")).toContainText(marker)
})

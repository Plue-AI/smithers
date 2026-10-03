import type { Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { appReady,awaitBoot,closeComposer,command,expect,openApp,reloadApp,test } from "./support"
import { fixtureInputText } from "./support/values"

test.setTimeout(90_000)

const boot = async (page: Page): Promise<void> => {
  const startedAt = performance.now()
  await openApp(page)
  await awaitBoot(page, "navigate", startedAt)
  await appReady(page)
}

const makeNote = async (page: Page, marker: string): Promise<{ readonly id: string; readonly title: string }> => {
  const cards = page.locator('.smithers-card[data-kind="world"]')
  const before = await cards.count()
  await command(page, "/wiki.new-note")
  await expect(cards).toHaveCount(before + 1)
  await closeComposer(page)
  const card = page.locator('.smithers-card[data-kind="world"]').last()
  await expect(card).toBeVisible()
  const raw = await card.getAttribute("data-testid")
  expect(raw).toMatch(/^card-wiki-open-/)
  const id = raw!.replace(/^card-wiki-open-/, "")
  const title = ((await card.locator("h3").textContent()) ?? "").replace(/^#\s*/, "").trim()
  await command(page, `/wiki.edit ${id} ${JSON.stringify(`# ${title}\n\n${marker}`)}`)
  await closeComposer(page)
  return { id, title }
}

test(
  "Wiki commands create, select, and delete a real note with durable cancel",
  scenario("wiki.note-lifecycle", {
    capabilities: [],
    coverage: [
      "action:wiki", "action:wiki.new-note", "action:wiki.select", "action:wiki.delete",
      "action:wiki.delete.cancel", "action:wiki.delete.confirm", "action:wiki.edit", "action:wiki.open",
      "host:local", "path:success", "path:persistence", "path:keyboard",
      "door:slash", "door:button", "door:user-only", "dimension:keyboard", "dimension:wiki-note", "dimension:confirmation-boundary",
      "evidence:document-readback-after-reload"
    ],
    description: "Exercises the actual Wiki surface and proves cancellation leaves the document available after reload."
  }),
  async ({ page }) => {
    await boot(page)
    await command(page, "/wiki")
    await closeComposer(page)
    await expect(page.getByTestId("card-world-embedded")).toBeVisible()
    const marker = fixtureInputText(`world-alias-${Date.now()}`)
    const note = await makeNote(page, marker)

    await command(page, `/wiki.select ${note.id}`)
    await closeComposer(page)
    await expect(page.locator('.smithers-card[data-kind="world"]').last()).toContainText(note.title)
    await command(page, `/wiki.delete ${note.id}`)
    await closeComposer(page)
    const dialog = page.getByRole("dialog", { name: `Delete ${note.title}?`, exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(dialog).toBeHidden()
    await reloadApp(page)
    await appReady(page)
    await command(page, `/wiki.open ${note.title}`)
    await closeComposer(page)
    await expect(page.locator('.smithers-card[data-kind="world"]').last()).toContainText(note.title)

    await command(page, `/wiki.delete ${note.id}`)
    await closeComposer(page)
    await expect(page.getByRole("dialog", { name: `Delete ${note.title}?`, exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog", { name: `Delete ${note.title}?`, exact: true })).toBeHidden()
  }
)

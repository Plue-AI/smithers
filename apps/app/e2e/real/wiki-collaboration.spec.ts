import type { Locator, Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { awaitBoot, closeComposer, command, expect, openApp, reloadApp, test } from "./support"
import { fixtureInputText } from "./support/values"

test.setTimeout(90_000)
test.use({ actionTimeout: 20_000 })

const boot = async (page: Page): Promise<void> => {
  const startedAt = performance.now()
  await openApp(page)
  await awaitBoot(page, "navigate", startedAt)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
}

const createNote = async (page: Page, body: string): Promise<{ readonly id: string; readonly title: string; readonly card: Locator }> => {
  const before = await page.locator('.smithers-card[data-kind="world"]').count()
  await command(page, "/wiki.new-note")
  await closeComposer(page)
  await expect(page.locator('.smithers-card[data-kind="world"]')).toHaveCount(before + 1)
  const card = page.locator('.smithers-card[data-kind="world"]').last()
  await expect(card).toBeVisible()
  const testId = await card.getAttribute("data-testid")
  expect(testId).toMatch(/^card-wiki-open-/)
  const id = testId!.replace(/^card-wiki-open-/, "")
  const title = ((await card.locator("h3").textContent()) ?? "").replace(/^#\s*/, "").trim()
  await command(page, `/wiki.edit ${id} ${JSON.stringify(`# ${title}\n\n${body}`)}`)
  await closeComposer(page)
  return { id, title, card: page.getByTestId(testId!) }
}

test(
  "Wiki surface selects the same real note after a second page reload",
  scenario("local-wiki-collaboration-selection-persistence", {
    capabilities: [],
    coverage: [
      "action:wiki.new-note", "action:wiki.edit", "action:wiki.card.select", "action:wiki", "action:wiki.card.view",
      "host:local", "path:persistence", "door:slash", "door:button",
      "dimension:shared-browser-context", "dimension:selection-persistence", "evidence:world-document-readback"
    ]
  }),
  async ({ page, context }) => {
    await boot(page)
    const firstBody = fixtureInputText(`first-note-${Date.now()}`)
    const secondBody = fixtureInputText(`second-note-${Date.now()}`)
    const first = await createNote(page, firstBody)
    const second = await createNote(page, secondBody)
    await command(page, "/wiki"); await closeComposer(page)
    const pane = page.getByTestId("card-world-embedded")
    await expect(pane).toBeVisible()
    await expect(pane.locator('[data-slot="file-tree-file"]').filter({ hasText: first.title })).toBeVisible()
    await expect(pane.locator('[data-slot="file-tree-file"]').filter({ hasText: second.title })).toBeVisible()
    await pane.locator('[data-slot="file-tree-file"]').filter({ hasText: second.title }).click()
    await pane.getByRole("button", { name: "Document", exact: true }).click()
    await expect(pane.getByLabel(`Edit ${second.title}`, { exact: true })).toBeVisible()
    await reloadApp(page)
    await expect(page.getByTestId("card-world-embedded").getByLabel(`Edit ${second.title}`, { exact: true })).toBeVisible()
    await page.close()
    const restarted = await context.newPage()
    await boot(restarted)
    const restartedPane = restarted.getByTestId("card-world-embedded")
    await expect(restartedPane.getByLabel(`Edit ${second.title}`, { exact: true })).toBeVisible()
    await expect(restartedPane.getByText(secondBody, { exact: false })).toBeVisible()
    await restarted.close()
  }
)

test(
  "Wiki outline is a keyboard accessible heading door and preserves the open note",
  scenario("local-wiki-heading-selection-keyboard", {
    capabilities: [],
    coverage: [
      "action:wiki.new-note", "action:wiki.edit", "action:wiki.heading", "action:wiki.card.select",
      "host:local", "path:keyboard", "door:slash", "door:button", "door:user-only",
      "dimension:keyboard", "dimension:outline-keyboard", "dimension:heading-scroll", "evidence:editor-focus-and-readback"
    ]
  }),
  async ({ page }) => {
    await boot(page)
    const note = await createNote(page, "Intro\n\n## Collaboration\n\nShared content")
    await command(page, "/wiki"); await closeComposer(page)
    const pane = page.getByTestId("card-world-embedded")
    const outline = pane.getByRole("list", { name: "Page outline" })
    const heading = outline.getByRole("button", { name: "Collaboration", exact: true })
    await expect(heading).toBeVisible()
    await heading.focus()
    await expect(heading).toBeFocused()
    await heading.press("Enter")
    await expect(pane.getByLabel(`Edit ${note.title}`, { exact: true })).toBeVisible()
    await expect(pane.getByLabel(`Edit ${note.title}`, { exact: true }).getByRole("textbox")).toBeFocused()
    await pane.getByRole("button", { name: "Outline", exact: true }).click()
    await heading.focus()
    await heading.press("Space")
    await expect(pane.getByLabel(`Edit ${note.title}`, { exact: true })).toBeVisible()
  }
)

test(
  "signed-out Wiki creation refuses without creating a document or launch",
  scenario("local-wiki-create-refusal-no-side-effects", {
    capabilities: [],
    coverage: [
      "action:wiki.create", "action:wiki", "host:local", "path:permission", "door:slash", "door:button",
      "dimension:signed-out-refusal", "dimension:no-side-effects", "evidence:refusal-card-readback"
    ]
  }),
  async ({ page }) => {
    await boot(page)
    await command(page, "/wiki"); await closeComposer(page)
    const pane = page.getByTestId("card-world-embedded")
    await expect(pane.getByText("No Wiki yet.", { exact: true })).toBeVisible()
    await pane.getByRole("button", { name: "Create Wiki", exact: true }).click()
    await closeComposer(page)
    await expect(page.getByText("Sign in with GitHub to continue.", { exact: true })).toBeVisible()
    await expect(pane.locator('.world-card-sidebar button')).toHaveCount(0)
    await expect(pane.getByText("No Wiki yet.", { exact: true })).toBeVisible()
  }
)

test(
  "cloud Wiki browse and open refuse cleanly when no provider is connected",
  scenario("local-wiki-cloud-refusal-preserves-local-notes", {
    capabilities: [],
    coverage: [
      "action:wiki.cloud", "action:wiki.cloud.open", "action:wiki.sync", "action:wiki.new-note",
      "host:local", "path:permission", "door:slash", "door:user-only",
      "dimension:cloud-refusal", "dimension:local-draft-preservation", "evidence:cloud-refusal-readback"
    ]
  }),
  async ({ page }) => {
    await boot(page)
    const note = await createNote(page, `local-draft-${Date.now()}`)
    await command(page, "/wiki.cloud acme/no-such-repository")
    await closeComposer(page)
    await expect(page.getByText(/Wiki|repository|sign in|could not reach/i).last()).toBeVisible()
    await command(page, "/wiki.cloud.open home acme/no-such-repository")
    await closeComposer(page)
    await expect(page.getByText(/Wiki|repository|sign in|could not reach/i).last()).toBeVisible()
    await command(page, "/wiki"); await closeComposer(page)
    await page.getByTestId("card-world-embedded").getByRole("button", { name: "Document", exact: true }).click()
    await expect(page.getByTestId("card-world-embedded").getByLabel(`Edit ${note.title}`, { exact: true })).toBeVisible()
  }
)

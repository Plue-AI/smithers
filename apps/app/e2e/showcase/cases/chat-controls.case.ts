import { expect } from "@playwright/test"
import { showcase } from "../showcase"

export default showcase({
  id: "chat-controls",
  order: 35,
  title: "Filter and clear",
  summary: "Filter the transcript by kind or text; clear it and reopen the archive.",
  flows: ["chat.filter", "chat.filter.toggle", "chat.filter.grep", "chat.filter.reset", "chat.clear"],
  run: async ({ page, app, backend }) => {
    await backend.cloud()
    // The cloud double answers every /api route; the chat turn goes to the stub model.
    await backend.route(url => /^\/api\/(?:agent|chat)\/turn$/.test(url.pathname), route => route.continue())
    await app.open("/")
    await app.say("Summarize the open pull requests.")
    const assistant = page.locator('.smithers-chat-message[data-role="assistant"]').filter({ hasText: "stub:" })
    await expect(assistant).toBeVisible()
    await app.slash("/agent.list")
    await app.closeComposer()
    const theme = page.getByTestId("transcript").locator('.smithers-card[data-kind="agents"]')
    await expect(theme).toBeVisible()

    await app.click(page.getByRole("button", { name: "Filter", exact: true }))
    const menu = page.getByRole("menu", { name: "Chat filter" })
    await expect(menu).toBeVisible()
    await app.click(menu.getByRole("menuitemcheckbox", { name: "cards" }))
    await expect(theme).toBeHidden()
    await app.beat(900)
    await app.type(menu.getByRole("searchbox", { name: "Search chat" }), "pull")
    await expect(assistant).toBeVisible()
    await app.beat(900)
    await app.click(menu.getByRole("menuitem", { name: "Show all" }))
    await expect(theme).toBeVisible()
    await app.press("Escape")
    await expect(menu).toBeHidden()

    await app.slash("/chat.clear")
    const archive = page.getByRole("link", { name: "Open the archived conversation" })
    await expect(archive).toBeVisible()
    await expect(theme).toHaveCount(0)
    await app.closeComposer()
    await app.beat(900)
    await app.click(archive)
    await expect(assistant).toBeVisible()
    await expect(theme).toBeVisible()
  }
})

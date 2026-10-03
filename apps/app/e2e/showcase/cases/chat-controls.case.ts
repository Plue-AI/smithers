import { expect } from "@playwright/test"
import { showcase } from "../showcase"

export default showcase({
  id: "chat-controls",
  order: 35,
  title: "Filter chat",
  summary: "Filter the transcript by kind or text.",
  flows: ["chat.filter", "chat.filter.toggle", "chat.filter.grep", "chat.filter.reset"],
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

  }
})

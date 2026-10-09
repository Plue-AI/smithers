import { expect } from "@playwright/test"
import { installConversationFixture } from "../../playwright/conversationFixture"
import { showcase } from "../showcase"

export default showcase({
  id: "chat",
  order: 30,
  title: "Chat",
  summary: "Ask in Chat; ⌥↵ queues a follow-up that sends when the turn ends.",
  flows: ["chat.send", "chat.queue"],
  run: async ({ page, app }) => {
    // The install's shared conversation answers each prompt (the T1 Chat fixture); the first turn
    // stays open so the queue has something to wait behind.
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    await installConversationFixture(page, { holdFirstTurn: held })
    await app.open("/")
    await app.say("What does this repository do?")
    const user = page.locator('.smithers-chat-message[data-role="user"]')
    await expect(user.filter({ hasText: "What does this repository do?" })).toBeVisible()

    const input = page.getByTestId("composer-input")
    await app.type(input, "Then list its open issues.")
    await app.press("Alt+Enter")
    await expect(input).toHaveValue("")
    await expect(page.getByText("Then list its open issues.").first()).toBeVisible()
    await app.beat(1800)
    release()

    const assistant = page.locator('.smithers-chat-message[data-role="assistant"]')
    await expect(assistant.filter({ hasText: "stub: What does this repository do?" })).toBeVisible({ timeout: 10_000 })
    await expect(assistant.filter({ hasText: "stub: Then list its open issues." })).toBeVisible({ timeout: 10_000 })
    await app.closeComposer()
    await app.beat(1500)
  }
})

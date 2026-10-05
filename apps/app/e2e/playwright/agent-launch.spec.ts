import { expect, test } from "./browserTest"
import { fillComposer } from "./composer"

/*
 * #3730: a person starts Codex or Claude Code from the app and its conversation appears in the transcript with no
 * session id typed. The T1 host starts the fixture CLIs (e2e/fixtures/agent-launch/, playwright.config.ts), which
 * write a session for the directory they ran in; the real CLIs never run here. The host names the owner Ben.
 */
const external = (page: import("./browserTest").Page) => page.getByTestId("transcript").locator("[data-origin=external]")

for (const [flow, name] of [["agent.codex", "Codex"], ["agent.claude", "Claude Code"]] as const) {
  test(`/${flow} <prompt> starts ${name} and shows its conversation, and a reload keeps it`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 })
    await page.goto("/")
    await fillComposer(page, `/${flow} Make the reset link expire after 30 minutes`)
    await page.keyboard.press("Enter")
    const prompt = external(page).filter({ hasText: "Make the reset link expire after 30 minutes" }).first()
    const answer = external(page).filter({ hasText: `Fixture ${name} finished: Make the reset link expire after 30 minutes` })
    await expect(prompt.locator(".sui-chat-message-label")).toHaveText("Ben")
    await expect(answer.locator(".sui-chat-message-label")).toHaveText(`${name} for Ben`)
    await expect(external(page).filter({ hasText: `${name} for Ben ran 1 command` })).toBeVisible()
    // The binding is app state, not the address: the page names no session, and a reload keeps the conversation.
    expect(new URL(page.url()).search).toBe("")
    await page.reload()
    await expect(answer.locator(".sui-chat-message-label")).toHaveText(`${name} for Ben`)
    // Smithers' own chat still answers beside it.
    await fillComposer(page, "hello")
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("transcript").locator(".smithers-chat-message:not([data-origin=external])").filter({ hasText: "hello" }).first()).toBeVisible()
  })
}

test("/agent.codex without a prompt asks for one in a form, and Start launches it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto("/")
  await fillComposer(page, "/agent.codex")
  await page.keyboard.press("Enter")
  const form = page.locator(".flow-form[data-flow-name='agent.codex']")
  await expect(form).toBeVisible()
  await form.getByTestId("flow-form-prompt").fill("Add a retry to the webhook sender")
  await form.getByTestId("flow-form-submit").click()
  await expect(external(page).filter({ hasText: "Fixture Codex finished: Add a retry to the webhook sender" }).locator(".sui-chat-message-label"))
    .toHaveText("Codex for Ben")
})

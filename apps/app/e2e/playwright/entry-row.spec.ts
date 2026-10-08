import { installConversationFixture } from "./conversationFixture"
import { expect, test } from "./browserTest"
import { fillComposer } from "./composer"

test("conversation prompts and answers mount EntryRow and survive reload", async ({ page }) => {
  await installConversationFixture(page)
  await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { (window as any).copiedMessage = text } } }) })
  await page.goto("/")
  await fillComposer(page, "Entry row browser receipt")
  await page.keyboard.press("Enter")
  const prompt = page.locator('article.entry[data-kind="prompt"]', { hasText: "Entry row browser receipt" })
  const answer = page.locator('article.entry[data-kind="answer"]', { hasText: "Entry row browser receipt" })
  await expect(prompt).toHaveCount(1)
  await expect(answer).toHaveCount(1)
  await expect(answer.getByRole("button", { name: "Copy message", exact: true })).toBeVisible()
  await page.getByTestId("composer-input").press("Escape")
  await answer.hover()
  await answer.getByRole("button", { name: "Copy message", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).copiedMessage)).toBe("stub: Entry row browser receipt")
  await expect(answer.getByRole("button", { name: "Copied", exact: true })).toBeVisible()
  await page.reload()
  await expect(prompt).toHaveCount(1)
  await expect(answer).toHaveCount(1)
})

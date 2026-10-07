import { expect, test } from "./browserTest"
import { fillComposer } from "./composer"

test("conversation prompts and answers mount EntryRow and survive reload", async ({ page }) => {
  await page.goto("/")
  await fillComposer(page, "Entry row browser receipt")
  await page.keyboard.press("Enter")
  const prompt = page.locator('article.entry[data-kind="prompt"]', { hasText: "Entry row browser receipt" })
  const answer = page.locator('article.entry[data-kind="answer"]', { hasText: "Entry row browser receipt" })
  await expect(prompt).toHaveCount(1)
  await expect(answer).toHaveCount(1)
  await expect(answer.getByRole("button", { name: "Copy message", exact: true })).toBeVisible()
  await page.reload()
  await expect(prompt).toHaveCount(1)
  await expect(answer).toHaveCount(1)
})

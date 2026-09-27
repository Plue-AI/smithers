import { expect, test } from "./browserTest"

test("another tab can take the writer and the old tab stops", async ({ context, page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto("/")
  await expect(page.locator('.guide-shell, [aria-label="Conversation"]')).toBeVisible({ timeout: 30_000 })
  const second = await context.newPage()
  second.on("pageerror", error => errors.push(error.message))
  await second.goto("/")
  await expect(second.getByRole("heading", { name: "Smithers is open in another tab" })).toBeVisible()
  await expect(second.getByRole("button", { name: /reset|recovery/i })).toHaveCount(0)
  await expect(second.getByRole("button", { name: "Reload", exact: true })).toBeVisible()
  await second.getByRole("button", { name: "Use Smithers here" }).click()
  await expect(second.locator('.guide-shell, [aria-label="Conversation"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("heading", { name: "Smithers moved to another tab" })).toBeVisible()
  await expect(page.locator(".guide-shell")).toHaveCount(0)
  // Repeat the actual boot path, including a previously disposed store.
  await page.getByRole("button", { name: "Use Smithers here" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.locator('.guide-shell, [aria-label="Conversation"]')).toBeVisible({ timeout: 30_000 })
  await expect(second.getByRole("heading", { name: "Smithers moved to another tab" })).toBeVisible()
  expect(errors).toEqual([])
  await page.close()
  await second.reload()
  await expect(second.locator('.guide-shell, [aria-label="Conversation"]')).toBeVisible({ timeout: 30_000 })
})

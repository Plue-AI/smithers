import { expect, test } from "@playwright/test"

for (const [name, path, heading] of [
  ["Terms", "/terms/", "Terms of Service"],
  ["Privacy", "/privacy/", "Privacy Policy"]
] as const) {
  test(`homepage ${name} is reachable and opens by keyboard`, async ({ page }) => {
    await page.goto("/")
    const footer = page.getByRole("contentinfo")
    await expect(footer).toBeVisible()
    await expect(footer.getByRole("link")).toHaveText(["Terms", "Privacy"])
    const link = footer.getByRole("link", { name, exact: true })
    await expect(link).toHaveAttribute("href", path)
    // Traverse the real browser tab order, without programmatically focusing the link.
    for (let tab = 0; tab < 20; tab++) {
      await page.keyboard.press("Tab")
      if (await link.evaluate(anchor => document.activeElement === anchor)) break
    }
    await expect(link).toBeFocused()
    expect(await link.evaluate(anchor => getComputedStyle(anchor).outlineStyle)).not.toBe("none")
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(path)
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible()
    await expect(page.locator("main")).toContainText("Tevm Inc.")
    // Full legal-page footers retain the existing destinations.
    await expect(page.getByRole("contentinfo").getByRole("link")).toHaveText([
      "Documentation", "Pricing", "Source, MIT", "Status", "Terms", "Privacy", "Refunds"
    ])
  })
}

import { expect, test } from "../browserTest"
import { lintText } from "../../../src/mainview/cards/productWords"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-UI-02.md.
// Integration and reference-host evidence remains required separately.
// Written before implementation: mvp.md §3, §9; lands with T-CAT-01
test("C-UI-02: Product words and minimal text: a deterministic copy lint", async ({ page }) => {
  // Required seed: every View fixture, including maximized states. The unit
  // check owns boundary fixtures; here the same chrome is read in the browser.
  await owner(page)
  await page.goto("/")
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      for (const [line, kind] of [["/stack", "home"], ["/settings", "settings"], ["/todo T8", "todo"], ["/help", "commands"]]) {
        await say(page, line)
        const card = page.locator(kind === "home" ? ".home.smithers-card" : `.smithers-card[data-kind="${kind}"]`).last()
        await expect(card).toBeVisible()
        const chrome = await card.locator("button, label, h1, h2, h3, dt").allTextContents()
        for (const attribute of ["aria-label", "title", "placeholder"]) {
          chrome.push(...await card.locator(`[${attribute}]`).evaluateAll((nodes, name) => nodes.filter(node => !node.closest("[data-content]")).map(node => node.getAttribute(name) ?? ""), attribute))
        }
        for (const text of chrome) {
          expect(lintText(text)).toEqual([])
        }
      }
      await say(page, "/settings")
      await expect(page.locator('.smithers-card[data-kind="settings"]').last()).toContainText("This Mac")
    }
  }
})

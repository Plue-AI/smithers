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

// All View modules and fixtures are discovered by the existing story entry.
// Missing stories fail; a feature flag or an unloaded fixture cannot shrink the matrix.
test("C-UI-02: every View fixture passes copy lint inline and maximized in both themes", async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto("/view-stories.html")
  await expect(page.getByRole("navigation", { name: "View stories" })).toBeVisible()
  const manifest = await page.evaluate(() => ({ views: window.viewStoryMatrix.views, fixtures: window.viewStoryMatrix.fixtures, missing: window.viewStoryMatrix.missing }))
  expect(manifest.missing).toEqual([])
  expect(manifest.views.length).toBeGreaterThan(0)
  for (const view of manifest.views) expect(manifest.fixtures.some(name => name.startsWith(`${view}/`)), view).toBe(true)
  expect(new Set(manifest.fixtures).size).toBe(manifest.fixtures.length)
  const failures: { fixture: string; width: number; maximized: boolean; theme: string; violations: unknown }[] = []
  let renders = 0
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const fixture of manifest.fixtures) {
      for (const maximized of [false, true]) {
        for (const theme of ["light", "dark"] as const) {
          await page.evaluate(({ fixture, maximized, theme }) => window.viewStoryMatrix.render(fixture, maximized, theme), { fixture, maximized, theme })
          const card = page.locator(".view-story")
          await expect(card).toHaveAttribute("data-story", fixture)
          await expect(card).toHaveAttribute("data-maximized", String(maximized))
          await expect(card).toHaveAttribute("data-theme", theme)
          const violations = await page.evaluate(() => window.viewStoryMatrix.violations())
          if (violations.length) failures.push({ fixture, width, maximized, theme, violations })
          renders++
        }
      }
    }
  }
  console.log(`Copy matrix: ${manifest.views.length} Views, ${manifest.fixtures.length} fixtures, ${renders} renders, ${failures.length} failing renders`)
  await test.info().attach("copy-matrix.json", { body: JSON.stringify({ manifest, renders, failures }), contentType: "application/json" })
  expect(renders).toBe(manifest.fixtures.length * 4 * 2)
  expect(failures).toEqual([])
})

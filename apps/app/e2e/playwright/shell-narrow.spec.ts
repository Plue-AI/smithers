import { expect,test } from "./browserTest"

/*
 * The shell fits a phone. `.app-shell` is a flex item, so its default
 * min-width:auto once made it grow to its min-content width (sidebar + the
 * widest card): at a 400px viewport the shell rendered 726px and the whole
 * page scrolled sideways. The pin measures the shell itself under a wide
 * probe child, so it holds whatever cards happen to be mounted.
 */
test("the app shell fits a 400px viewport with no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 })
  await page.goto("/")
  await expect(page.locator(".app-shell")).toHaveCount(1)

  const metrics = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".app-shell")
    if (!shell) throw new Error("no .app-shell")
    // Wide, unshrinkable content: the shell must clip it, not grow past the viewport.
    const host = shell.querySelector<HTMLElement>(".app-main") ?? shell
    const probe = document.createElement("div")
    probe.style.cssText = "width:900px;flex:none;height:1px;"
    host.appendChild(probe)
    const rect = shell.getBoundingClientRect()
    const read = {
      shellMinWidth: getComputedStyle(shell).minWidth,
      viewport: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      shellWidth: Math.round(rect.width),
      shellRight: Math.round(rect.right)
    }
    probe.remove()
    return read
  })

  // The shrink rule itself, independent of which surface happens to be mounted.
  expect(metrics.shellMinWidth).toBe("0px")
  expect(metrics.shellWidth).toBeLessThanOrEqual(metrics.viewport)
  expect(metrics.shellRight).toBeLessThanOrEqual(metrics.viewport)
  expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.viewport)
})

/*
 * The shared card frame at phone width: whatever cards are mounted, no card
 * and no descendant may render past the column that holds them.
 */
test("mounted cards stay inside the transcript column at 400px", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 })
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await expect(page.getByTestId("first-run-actions")).toBeVisible()

  const overflowing = await page.evaluate(() => {
    const out: string[] = []
    for (const card of document.querySelectorAll<HTMLElement>('.smithers-card, [data-testid="first-run-actions"]')) {
      const column = card.parentElement
      if (!column) continue
      const edge = column.getBoundingClientRect().right
      for (const el of [card, ...card.querySelectorAll<HTMLElement>("*")]) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.right > edge + 1) out.push(`${el.tagName}.${el.className} right=${Math.round(rect.right)} edge=${Math.round(edge)}`)
      }
    }
    return out.slice(0, 10)
  })

  expect(overflowing).toEqual([])
})

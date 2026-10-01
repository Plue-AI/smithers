import { expect,test } from "@playwright/test"

/*
 * The landing tagline becomes the signup headline: Get started for free runs
 * one view transition that pairs the tagline with the signup's <h1> (and the
 * wordmark with the app's mark), so the words move rather than repaint.
 */
test("the tagline and the wordmark glide into the signup on Get started for free", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ status: 404, json: { message: "Unavailable test route" } }))
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["identity", "cloud", "agent", "github"], authFlow: "redirect", sandbox: null,
  } }))
  await page.route("**/api/user", route => route.fulfill({ status: 401, json: { code: "unauthorized", fault: "user", message: "authentication required" } }))
  await page.goto("/")
  const tagline = await page.locator(".home .sub").textContent()
  await expect(page.locator("#start.ready")).toBeVisible()
  // Record which view-transition pseudo-elements animate: a pair has both an old and a new snapshot.
  await page.evaluate(() => {
    const seen = new Set<string>()
    ;(window as unknown as { seen: Set<string> }).seen = seen
    const poll = () => {
      for (const animation of document.getAnimations()) {
        const pseudo = (animation.effect as KeyframeEffect | null)?.pseudoElement
        if (pseudo) seen.add(pseudo)
      }
      // Timers keep running while the transition holds rendering; animation frames do not.
      if (seen.size < 9) setTimeout(poll, 5)
    }
    poll()
  })
  await page.locator("#start").click()
  const headline = page.getByTestId("signup").locator("h1")
  await expect(headline).toHaveText(tagline!.trim())
  // The headline arrived through the transition, so its words skip their own reveal.
  await expect(headline).toHaveAttribute("data-arrived", "")
  await expect(headline.locator(".signup-word").first()).toHaveCSS("opacity", "1")
  const seen = await page.evaluate(() => [...(window as unknown as { seen: Set<string> }).seen])
  for (const name of ["smithers-tagline", "smithers-wordmark"]) {
    expect(seen).toContain(`::view-transition-old(${name})`)
    expect(seen).toContain(`::view-transition-new(${name})`)
  }
  // The headline sits at the top of the transcript, not at the bottom of a chat log.
  const box = await headline.boundingBox()
  expect(box!.y).toBeLessThan(page.viewportSize()!.height / 3)
})

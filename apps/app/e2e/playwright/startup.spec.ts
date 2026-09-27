import { expect, test } from "./browserTest"

test("a late boot recovers after the startup watchdog without losing React's mount point", async ({ page }) => {
  await page.clock.install()
  let release!: () => void
  let reached!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const requested = new Promise<void>((resolve) => { reached = resolve })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/ControllerBoot.client*.js", async (route) => {
    reached()
    await held
    await route.continue()
  })
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await requested
    await expect(page.locator(".session-shell > .session-navigation > .guide-wordmark")).toHaveCount(1)
    const shell = await page.locator("#root .session-shell").elementHandle()
    const entrance = page.locator(".session-shell > .session-navigation > .guide-wordmark")
    await expect(page.locator("body")).not.toContainText("Smithers is starting your session.")
    // Only settle the wordmark: the boot skeleton intentionally pulses forever.
    await entrance.evaluate(async node => {
      await document.fonts.ready
      await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished))
    })
    const corner = await entrance.boundingBox()
    expect(corner!.x).toBeGreaterThanOrEqual(0)
    expect(corner!.x + corner!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await expect(page.locator("body")).not.toContainText("This build isn't connected")
    // The bundle is deliberately still in flight after the watchdog's budget.
    await page.clock.fastForward(90_000)
    await expect(page.locator("[data-startup-failure]")).toContainText("Smithers failed to start")
    await expect(page.locator("#root .session-shell")).toHaveCount(1)
    release()
    await page.clock.resume()
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20_000 })
    expect(await shell!.evaluate(node => node.isConnected)).toBe(true)
    await expect(page.locator(".guide-wordmark")).toHaveCount(1)
    expect((await entrance.boundingBox())!.x).toBeCloseTo(corner!.x, 0)
    await expect(page.locator("[data-startup-failure]")).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    release()
  }
})

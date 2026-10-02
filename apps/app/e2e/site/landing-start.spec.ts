import { expect,test } from "@playwright/test"

test("Get started for free mounts the real island in place when it loads", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
  await page.route("**/api/recommend", route => route.fulfill({ json: { suggestions: [] } }))
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: [], authFlow: "none", sandbox: null,
  } }))
  await page.goto("/")
  await page.getByRole("link", { name: "Get started for free", exact: true }).click()
  await expect(page.getByTestId("setup-checklist")).toBeVisible()
  await expect(page).toHaveURL("/")
  await expect(page.locator("#start-error")).toHaveCount(0)
  const actions = page.getByTestId("setup-checklist")
  expect(await actions.locator("button:not([data-flow])").count()).toBe(0)
  await actions.getByRole("button", { name: "Dismiss", exact: true }).click()
  // Dismissed, the card collapses to its job tiles (apps/app/AGENTS.md First-run): no steps, no Dismiss.
  const collapsed = async () => {
    await expect(actions).toHaveAttribute("data-complete", "true")
    await expect(actions.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0)
    await expect(actions.locator("ol")).toHaveCount(0)
    await expect(actions.locator(".setup-checklist-tiles button").first()).toBeVisible()
  }
  await collapsed()
  await page.reload()
  await page.getByRole("link", { name: "Get started for free", exact: true }).click()
  await expect(page.locator(".app-shell")).toBeVisible()
  await collapsed()
  expect(errors).toEqual([])
})

test("Get started for free swaps to the app before the boot answers", async ({ page }) => {
  await page.route("**/api/bootstrap", async route => {
    await new Promise(resolve => setTimeout(resolve, 3000))
    await route.fulfill({ json: {
      apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: [], authFlow: "none", sandbox: null,
    } })
  })
  await page.goto("/")
  await expect(page.locator("#start")).toBeVisible()
  await page.keyboard.press("s")
  await expect(page.locator(".session-shell")).toBeVisible({ timeout: 1000 })
  await expect(page.locator("#start")).toHaveCount(0)
  await expect(page.getByTestId("setup-checklist")).toBeVisible()
})

for (const failure of ["chunk", "page"] as const) {
  test(`Get started for free reports an aborted app ${failure} and Reload reloads the document`, async ({ page }) => {
    let aborted = 0
    const route = failure === "chunk" ? /\/_astro\/AppIsland\.[^/]+\.js$/ : /\/smithersai\/smithers\/$/
    await page.route(route, request => { aborted++; return request.abort() })
    await page.goto("/")
    const start = page.getByRole("link", { name: "Get started for free", exact: true })
    await expect(start).toBeVisible()
    if (failure === "chunk") await page.keyboard.press("s")
    else await start.click()
    await expect(page.getByRole("alert")).toHaveText("Smithers couldn't load. Reload to try again.")
    expect(aborted).toBeGreaterThan(0)
    await expect(start).toBeHidden()
    await expect(page.locator("#start")).not.toHaveAttribute("aria-busy")
    await expect(page.getByTestId("setup-checklist")).toHaveCount(0)
    await expect(page).toHaveURL("/")
    const reload = page.getByRole("button", { name: "Reload", exact: true })
    await expect(reload).toBeFocused()
    await page.screenshot({ path: test.info().outputPath("load-error.png") })
    await Promise.all([
      page.waitForEvent("request", request => request.isNavigationRequest() && request.frame() === page.mainFrame()),
      page.keyboard.press("Enter"),
    ])
    await page.waitForLoadState()
    await expect(page.getByRole("alert")).toBeHidden()
    await expect(start).toBeVisible()
    expect(await page.evaluate(() => (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).type)).toBe("reload")
  })
}

test("a returning entry reveals the landing error if its preloaded island fails", async ({ page }) => {
  await page.route(/\/_astro\/AppIsland\.[^/]+\.js$/, request => request.abort())
  // Only an authentication return resumes instantly; saved storage leaves Get started for free visible.
  await page.goto("/?signed-in")
  await expect(page.getByRole("alert")).toHaveText("Smithers couldn't load. Reload to try again.")
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeVisible()
  await expect(page.locator("main.home")).toHaveCSS("visibility", "visible")
})

test.describe("touch landing", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 } })
  test("Get started for free hides the physical key chip on a coarse pointer", async ({ page }) => {
    await page.route(/\/smithersai\/smithers\/$/, request => request.abort())
    await page.goto("/")
    await expect(page.locator("#start")).toBeVisible()
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
    await expect(page.locator("#start kbd")).toBeHidden()
  })
})

for (const holdCommit of [false, true]) test(`tutorial query opens the plain app and hint dismissal survives reload${holdCommit ? " with SQLite commit held" : ""}`, async ({ page }) => {
  if (holdCommit) await page.addInitScript(() => {
    const post = Worker.prototype.postMessage
    const probe = { armed: false, held: false }
    ;(window as any).hintCommitProbe = probe
    Worker.prototype.postMessage = function(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
      if (probe.armed && typeof message === "object" && message !== null && "sql" in message &&
        typeof message.sql === "string" && /^\s*COMMIT\b/i.test(message.sql)) {
        probe.held = true
        return // The immediate reload kills this uncommitted worker; never acknowledge the write.
      }
      Reflect.apply(post, this, [message, options])
    }
  })
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: [], authFlow: "none", sandbox: null,
  } }))
  await page.goto("/?tutorial")
  await expect(page.getByTestId("setup-checklist")).toBeVisible()
  await expect(page.locator(".help-bubble")).toHaveCount(1)
  const hint = page.locator('[data-first-sight-hint="chat"] .help-bubble')
  await expect(hint).toBeVisible()
  if (holdCommit) await page.evaluate(() => { (window as any).hintCommitProbe.armed = true })
  await hint.getByRole("button", { name: "Dismiss help" }).click()
  await expect(hint).toHaveCount(0)
  if (holdCommit) await expect.poll(() => page.evaluate(() => (window as any).hintCommitProbe.held)).toBe(true)
  await page.reload()
  await page.getByRole("link", { name: "Get started for free", exact: true }).click()
  await expect(page.getByTestId("setup-checklist")).toBeVisible()
  await expect(hint).toHaveCount(0)
  await expect(page.locator(".help-bubble")).toHaveCount(0)
})

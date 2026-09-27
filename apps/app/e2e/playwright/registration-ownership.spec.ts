import { expect, test, type Page } from "./browserTest"
import { SCOPED_TEST_USER, signedOutVisitor, skipSignup } from "./identity"

const repo = "smithersai/smithers"
const oldFailure = "Previous account registration refused."
const command = async (page: Page, line: string) => {
  if (!await page.getByTestId("composer-input").isVisible()) await page.keyboard.press("Control+k")
  const input = page.getByTestId("composer-input")
  await input.fill(line)
  await input.press("Enter")
  await expect(input).toBeHidden()
}

// The built UI, SQLite and real account cleanup run in the browser. All import
// and workflow responses are explicit fixtures: no repository job is started.
for (const stage of ["import", "launch"] as const) test(`a late ${stage} failure cannot replace the next account's registration`, async ({ page }) => {
  await signedOutVisitor(page)
  let changed = false, imports = 0, launches = 0, failCurrent = false
  await page.route("**/api/auth/session", route => route.fulfill({ json: changed ? { ...SCOPED_TEST_USER, login: "second-owner" } : SCOPED_TEST_USER }))
  await page.route("**/api/github/import", route => {
    imports += 1
    if (!changed && stage === "import") return route.fulfill({ status: 403, json: { message: oldFailure } })
    return route.fulfill({ json: {
      importJobId: changed ? `current-${imports}` : "previous", status: changed ? "cloning" : "ready",
      repository: { owner: "smithersai", name: "smithers" }
    } })
  })
  await page.route("**/api/github/import/current-*", route => route.fulfill({ json: {
    importJobId: new URL(route.request().url()).pathname.split("/").at(-1),
    status: failCurrent ? "failed" : "cloning", ...(failCurrent ? { error: "Current import failed." } : {})
  } }))
  await page.route("**/api/workflow/provision", route => {
    launches += 1
    return route.fulfill({ status: 403, json: { message: oldFailure } })
  })
  await page.addInitScript((marker: string) => {
    const json = Response.prototype.json, text = Response.prototype.text
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const probe = { started: false, finished: false, release }
    ;(window as any).registrationOwnershipProbe = probe
    const wait = async (body: unknown) => {
      if ((body as { message?: string })?.message !== marker) return
      probe.started = true
      await held
      setTimeout(() => { probe.finished = true }, 0)
    }
    Response.prototype.json = async function() { const body = await json.call(this); await wait(body); return body }
    Response.prototype.text = async function() {
      const body = await text.call(this)
      let parsed: unknown
      try { parsed = JSON.parse(body) } catch { return body }
      await wait(parsed)
      return body
    }
  }, oldFailure)
  const registration = page.getByTestId(`card-registration-${repo}`)
  try {
    await page.goto(`/${repo}/`)
    await skipSignup(page)
    await command(page, `/repository.register ${repo}`)
    await expect(registration.locator(".registration-go")).toHaveText("Analyzing")
    await expect.poll(() => page.evaluate(() => (window as any).registrationOwnershipProbe.started)).toBe(true)
    await command(page, `/repository.register ${repo}`)
    expect(imports).toBe(1)
    await page.keyboard.press("Control+k")
    await page.getByTestId("composer-input").fill("Chat remains usable")
    await expect(page.getByTestId("composer-input")).toHaveValue("Chat remains usable")
    await page.keyboard.press("Escape")

    changed = true
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("smithers-mvp.privacyRetirement") ?? "null")?.phase)).toBe("complete")
    await expect(registration).toHaveCount(0)
    await command(page, `/repository.register ${repo}`)
    await expect.poll(() => imports).toBe(2)
    await expect(registration.locator(".registration-go")).toHaveText("Analyzing")
    await page.evaluate(() => (window as any).registrationOwnershipProbe.release())
    await expect.poll(() => page.evaluate(() => (window as any).registrationOwnershipProbe.finished)).toBe(true)
    await expect(registration.locator(".registration-go")).toHaveText("Analyzing")
    await expect(registration.locator(".registration-error")).toHaveCount(0)
    await expect(page.getByText(oldFailure, { exact: true })).toHaveCount(0)
    expect(launches).toBe(stage === "launch" ? 1 : 0)

    failCurrent = true
    await expect(registration.locator(".registration-go")).toHaveText("Failed", { timeout: 15_000 })
    await expect(registration.locator(".registration-error")).toHaveText("Current import failed.")
    failCurrent = false
    await command(page, `/repository.register ${repo}`)
    await expect.poll(() => imports).toBe(3)
    await expect(registration.locator(".registration-go")).toHaveText("Analyzing")
    await expect(registration.locator(".registration-error")).toHaveCount(0)
    await command(page, `/repository.register ${repo}`)
    expect(imports).toBe(3)
  } finally {
    await page.evaluate(() => (window as any).registrationOwnershipProbe?.release()).catch(() => {})
  }
})

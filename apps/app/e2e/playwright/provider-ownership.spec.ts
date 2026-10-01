import { expect, test } from "./browserTest"
import { SCOPED_TEST_USER, signedOutVisitor, skipSignup, identityRoute } from "./identity"

test("an old unavailable response cannot clear the next account's coding connections", async ({ page }) => {
  await signedOutVisitor(page)
  let changed = false, reads = 0
  await page.route("**/api/user", route => identityRoute(changed ? "second-owner" : SCOPED_TEST_USER.login)(route))
  await page.route("**/api/user/provider-connections", route => {
    if (!changed && ++reads > 1) return route.fulfill({ status: 403, json: { message: "feature not available" } })
    return route.fulfill({ json: [{ id: changed ? "bob" : "alice", provider: "claude", label: changed ? "Bob coding account" : "Alice coding account", state: "active" }] })
  })
  // Hold decoding of the old feature-gate body after its HTTP response arrives.
  // API fixtures and fault timing only; no actual provider credentials or writes.
  await page.addInitScript(() => {
    const json = Response.prototype.json
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const probe = { started: false, finished: false, release }
    ;(window as any).providerGateProbe = probe
    Response.prototype.json = async function() {
      const body = await json.call(this)
      if (this.status === 403 && body?.message === "feature not available") {
        probe.started = true
        await held
        setTimeout(() => { probe.finished = true }, 0)
      }
      return body
    }
  })
  // Before the first job the cloud web app keeps Chat's controls away; Control+K is Chat's door throughout.
  const command = async () => {
    const input = page.getByTestId("composer-input")
    if (!await input.isVisible()) await page.keyboard.press("Control+k")
    await input.fill("/secrets.connections")
    await input.press("Enter")
  }
  try {
    await page.goto("/smithersai/smithers/")
    await skipSignup(page)
    await command()
    await expect(page.getByTestId("account-alice")).toBeVisible()
    await command()
    await expect.poll(() => page.evaluate(() => (window as any).providerGateProbe.started)).toBe(true)
    changed = true
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("smithers-mvp.privacyRetirement") ?? "null")?.phase)).toBe("complete")
    await command()
    await expect(page.getByTestId("account-bob")).toBeVisible()
    await page.evaluate(() => (window as any).providerGateProbe.release())
    await expect.poll(() => page.evaluate(() => (window as any).providerGateProbe.finished)).toBe(true)
    await expect(page.getByTestId("account-bob")).toBeVisible()
    await expect(page.getByTestId("card-provider-accounts").getByRole("button", { name: "Add Claude", exact: true })).toBeVisible()
  } finally {
    await page.evaluate(() => (window as any).providerGateProbe?.release()).catch(() => {})
  }
})


test("an old background refresh cannot reopen unavailable coding connections", async ({ page }) => {
  await signedOutVisitor(page)
  await page.route("**/api/user", identityRoute())
  let reads = 0
  await page.route("**/api/user/provider-connections", route => {
    reads += 1
    if (reads > 2) return route.fulfill({ status: 403, json: { message: "feature not available" } })
    return route.fulfill({ json: [{ id: "current", provider: "claude", label: reads === 2 ? "Held refresh" : "Current account", state: "active" }] })
  })
  await page.route("**/api/user/provider-connections/current", route => route.fulfill({ status: 204 }))
  // Only the fixture response is delayed; revocation never reaches a provider.
  await page.addInitScript(() => {
    const json = Response.prototype.json
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const probe = { started: false, finished: false, release }
    ;(window as any).providerRefreshProbe = probe
    Response.prototype.json = async function() {
      const body = await json.call(this)
      if (Array.isArray(body) && body[0]?.label === "Held refresh") {
        probe.started = true
        await held
        setTimeout(() => { probe.finished = true }, 0)
      }
      return body
    }
  })
  const command = async (line: string) => {
    const input = page.getByTestId("composer-input")
    if (!await input.isVisible()) await page.keyboard.press("Control+k")
    await input.fill(line)
    await input.press("Enter")
  }
  try {
    await page.goto("/smithersai/smithers/")
    await skipSignup(page)
    await command("/secrets.connections")
    await expect(page.getByTestId("account-current")).toBeVisible()
    await command("/secrets.revoke current")
    await expect.poll(() => page.evaluate(() => (window as any).providerRefreshProbe.started)).toBe(true)
    await command("/secrets.connections")
    const card = page.getByTestId("card-provider-accounts")
    await expect(card.getByRole("button", { name: "Add Claude", exact: true })).toHaveCount(0)
    await page.evaluate(() => (window as any).providerRefreshProbe.release())
    await expect.poll(() => page.evaluate(() => (window as any).providerRefreshProbe.finished)).toBe(true)
    await expect(card.getByRole("button", { name: "Add Claude", exact: true })).toHaveCount(0)
    await expect(page.getByTestId("account-current")).toHaveCount(0)
  } finally {
    await page.evaluate(() => (window as any).providerRefreshProbe?.release()).catch(() => {})
  }
})

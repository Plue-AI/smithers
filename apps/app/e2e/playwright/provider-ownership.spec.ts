import { expect, test } from "./browserTest"
import { SCOPED_TEST_USER, signedOutVisitor, skipSignup } from "./identity"

test("an old unavailable response cannot clear the next account's coding connections", async ({ page }) => {
  await signedOutVisitor(page)
  let changed = false, reads = 0
  await page.route("**/api/auth/session", route => route.fulfill({ json: changed ? { ...SCOPED_TEST_USER, login: "second-owner" } : SCOPED_TEST_USER }))
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
  const command = async () => {
    await page.getByRole("button", { name: "Chat", exact: true }).click()
    const input = page.getByTestId("composer-input")
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

import { test, expect } from "../playwright/browserTest"
import { scenario } from "./coverage/types"

// Reference-host qualification, like j1-activation: an operator uses the
// installed bundle's printed link and completes GitHub/key entry in the headed
// browser. This observer never seeds install state or writes to GitHub.
// Invoke with SMITHERS_JOURNEY=setup.spec.ts and playwright.real.config.ts.
test("C-J1-02 installed Setup recovery", scenario("journey.setup", {
  capabilities: ["install"], coverage: ["host:local", "host:production", "door:button", "path:success", "dimension:setup"]
}), async ({ page }, info) => {
  const base = process.env.SMITHERS_REAL_BASE_URL
  const link = process.env.SMITHERS_SETUP_URL
  const sha = process.env.SMITHERS_REAL_E2E_BUILD_SHA
  if (!base || !link || !sha || process.env.SMITHERS_REAL_HEADED !== "1") {
    throw new Error("Setup requires a built reference install, SMITHERS_REAL_BASE_URL, its printed SMITHERS_SETUP_URL, SMITHERS_REAL_E2E_BUILD_SHA and SMITHERS_REAL_HEADED=1")
  }
  const url = new URL(link)
  expect(url.origin).toBe(new URL(base).origin)
  expect(url.pathname).toBe("/setup")
  expect(url.searchParams.has("token")).toBe(true)
  info.setTimeout(3_600_000)
  await page.goto(link)
  await expect.poll(() => new URL(page.url()).searchParams.has("token")).toBe(false)
  const cookies = await page.context().cookies()
  expect(cookies.find(cookie => cookie.name === "smithers_setup_session")?.httpOnly).toBe(true)
  const bootstrap = await page.context().request.get(new URL("/api/bootstrap", base).href)
  expect(bootstrap.status()).toBe(200)
  expect((await bootstrap.json()).buildSha).toBe(sha)
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false)
  }
  const card = page.getByRole("region", { name: "Set up Smithers", exact: true })
  await expect(card).toBeVisible()
  expect(await card.locator("[data-step]").evaluateAll(rows => rows.map(row => row.getAttribute("data-step")))).toEqual([
    "address", "app_manifest", "sign_in", "repository", "models", "source", "machine"
  ])
  const receipt = async (name: string) => {
    const response = await page.context().request.get(new URL("/api/install", page.url()).href)
    expect(response.status()).toBe(200)
    const body = await response.json()
    for (const key of [process.env.SMITHERS_SETUP_INVALID_KEY, process.env.SMITHERS_SETUP_VALID_KEY].filter(Boolean)) {
      expect(JSON.stringify(body)).not.toContain(key)
      expect(await card.innerHTML()).not.toContain(key)
    }
    await info.attach(name, { body: JSON.stringify(body), contentType: "application/json" })
  }
  for (const step of ["address", "app_manifest", "sign_in"]) {
    await expect(card.locator(`[data-step="${step}"]`)).toHaveAttribute("data-state", "done", { timeout: 900_000 })
    await receipt(step)
  }
  await expect(card.getByRole("link", { name: "Enable squash merging on GitHub ↗" })).toBeVisible({ timeout: 900_000 })
  await expect(card.locator('[data-step="repository"]')).toHaveAttribute("data-state", "done", { timeout: 900_000 })
  await expect(card.locator('.setup-model[data-state="failed"]')).toBeVisible({ timeout: 900_000 })
  await expect(card.locator('.setup-model[data-state="failed"] [role="alert"]')).not.toBeEmpty()
  await receipt("refused-key")
  await expect(card.locator('[data-step="models"]')).toHaveAttribute("data-state", "done", { timeout: 900_000 })
  await receipt("models")
  for (const step of ["source", "machine"]) {
    await expect(card.locator(`[data-step="${step}"]`)).toHaveAttribute("data-state", "running", { timeout: 900_000 })
    await receipt(`${step}-before-reload`)
    await page.reload()
    await expect(card).toBeVisible()
    if (step === "machine") await expect(card.getByText("Source ready", { exact: true })).toBeVisible()
    await expect(card.locator(`[data-step="${step}"]`)).toHaveAttribute("data-state", "done", { timeout: 900_000 })
    await receipt(`${step}-done`)
  }
  await expect(card.getByText("Source ready", { exact: true })).toBeVisible()
  await expect(card.getByText("Machine ready", { exact: true })).toBeVisible()
})

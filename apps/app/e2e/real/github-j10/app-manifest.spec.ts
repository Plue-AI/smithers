import { test, expect, type BrowserContext, type Page } from "@playwright/test"
import { acquireAuthenticatedProfile } from "../auth-permissions/profile"
import { scenario } from "../coverage/types"

const ORIGIN = "http://localhost:4000"
const LOGIN = "codeplanesmithers"
const REPOSITORY = "canary-sandbox"
const PROFILE = "/Users/williamcory/.multi-e2e-profile"

type ManifestStart = {
  action_url: string
  state: string
  manifest: { name: string; redirect_url: string; setup_url: string; [key: string]: unknown }
}
type InstallStatus = {
  github_app: { configured: boolean; installed: boolean; slug?: string; installation_id?: number; install_url?: string }
}

const refuseSudo = async (page: Page): Promise<void> => {
  if (await page.getByRole("heading", { name: /Confirm access|Verify your identity|Two-factor authentication/i }).isVisible().catch(() => false) ||
      /github\.com\/(?:sessions\/sudo|login|session)/.test(page.url())) {
    throw new Error("GitHub requires sign-in or sudo verification; the saved profile cannot complete this release check.")
  }
}

const deleteFreshApp = async (page: Page, name: string, slug: string): Promise<void> => {
  // The generated name was absent before creation. Only its exact settings URL
  // is eligible for cleanup; no other App or installation can be selected.
  await page.goto("https://github.com/settings/apps", { waitUntil: "domcontentloaded" })
  await refuseSudo(page)
  const app = page.locator(`a[href="/settings/apps/${slug}"]`)
  if (await app.count() === 0) return
  await page.goto(`https://github.com/settings/apps/${slug}`, { waitUntil: "domcontentloaded" })
  await refuseSudo(page)
  await expect(page.getByLabel("GitHub App name", { exact: true })).toHaveValue(name)
  await page.goto(`https://github.com/settings/apps/${slug}/advanced`, { waitUntil: "domcontentloaded" })
  await refuseSudo(page)
  await page.getByRole("button", { name: "Delete GitHub App", exact: true }).click()
  const confirmation = page.getByRole("dialog")
  await expect(confirmation).toContainText(name)
  await expect(confirmation.getByRole("textbox")).toHaveCount(1)
  await confirmation.getByRole("textbox").fill(name)
  await confirmation.getByRole("button", { name: /Delete this GitHub App|Delete GitHub App/i }).click()
  await refuseSudo(page)
  await page.goto("https://github.com/settings/apps", { waitUntil: "domcontentloaded" })
  await expect(page.locator(`a[href="/settings/apps/${slug}"]`)).toHaveCount(0)
}

test.use({ trace: "off", screenshot: "off", video: "off" })

test("a fresh localhost install creates and installs its GitHub App", scenario("github.localhost-app-manifest", {
  capabilities: [],
  coverage: ["host:local", "path:success", "door:button", "dimension:github-app-manifest", "evidence:live-github-and-install-readback"],
  description: "Create an App under the saved canary account, install only canary-sandbox, read sanitized host state, and delete only the fresh App."
}), async ({ playwright }, testInfo) => {
  test.setTimeout(180_000)
  const base = process.env.SMITHERS_REAL_BASE_URL?.replace(/\/$/, "")
  if (base !== ORIGIN) throw new Error(`This release check requires a fresh backend at ${ORIGIN}; set SMITHERS_REAL_BASE_URL explicitly.`)
  const setupToken = process.env.SMITHERS_REAL_GITHUB_APP_SETUP_TOKEN?.trim()
  if (!setupToken) throw new Error("SMITHERS_REAL_GITHUB_APP_SETUP_TOKEN is required; a missing fresh-install fixture is a failed release check.")
  if (process.env.SMITHERS_E2E_PROFILE !== PROFILE) throw new Error(`SMITHERS_E2E_PROFILE must be the preserved ${PROFILE}.`)
  const profile = await acquireAuthenticatedProfile("SMITHERS_E2E_PROFILE")
  let context: BrowserContext | undefined
  let name: string | undefined
  let slug: string | undefined
  let submitted = false
  try {
    context = await playwright.chromium.launchPersistentContext(profile.path, {
      headless: process.env.SMITHERS_REAL_HEADED !== "1", viewport: { width: 1280, height: 900 }
    })
    const page = await context.newPage()
    await page.goto("https://github.com/settings/profile", { waitUntil: "domcontentloaded" })
    await refuseSudo(page)
    const login = await page.locator('meta[name="user-login"]').getAttribute("content")
    expect(login).toBe(LOGIN)
    const exchange = await context.request.get(`${ORIGIN}/setup?token=${encodeURIComponent(setupToken)}`, { maxRedirects: 0 })
    expect(exchange.status()).toBe(303)
    const csrf = (await context.cookies(ORIGIN)).find(cookie => cookie.name === "__csrf")?.value
    expect(csrf).toBeTruthy()
    const headers = { "X-CSRF-Token": csrf!, Origin: ORIGIN }
    const before = await context.request.get(`${ORIGIN}/api/install`, { headers })
    expect(before.status()).toBe(200)
    const initial = await before.json() as InstallStatus
    expect(initial.github_app.configured).toBe(false)
    testInfo.annotations.push({ type: "real-host-verified", description: "local" })
    const begin = await context.request.post(`${ORIGIN}/api/install/setup/app_manifest`, {
      headers, data: { owner_login: LOGIN, owner_kind: "user", repository: REPOSITORY }
    })
    expect(begin.status()).toBe(200)
    const start = await begin.json() as ManifestStart
    expect(new URL(start.action_url).origin + new URL(start.action_url).pathname).toBe("https://github.com/settings/apps/new")
    expect(start.manifest.name).toMatch(/^Smithers [a-f0-9]{8}$/)
    name = start.manifest.name
    slug = name.toLowerCase().replace(/ /g, "-")
    expect(new URL(start.manifest.redirect_url).origin).toBe(ORIGIN)
    expect(new URL(start.manifest.setup_url).origin).toBe(ORIGIN)
    expect((await context.cookies(`${ORIGIN}/setup/github/callback`)).find(cookie => cookie.name === "smithers_github_app_state")?.value).toBe(start.state)
    await page.goto("https://github.com/settings/apps", { waitUntil: "domcontentloaded" })
    await refuseSudo(page)
    await expect(page.locator(`a[href="/settings/apps/${slug}"]`)).toHaveCount(0)
    // Setup-card UI is a separate ticket. This minimal host-origin form sends
    // exactly the real Begin response to GitHub and preserves the callback jar.
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" })
    await page.evaluate(start => {
      document.body.replaceChildren()
      const form = document.createElement("form")
      form.method = "POST"
      form.action = start.action_url
      const manifest = document.createElement("input")
      manifest.type = "hidden"
      manifest.name = "manifest"
      manifest.value = JSON.stringify(start.manifest)
      const button = document.createElement("button")
      button.textContent = "Create GitHub App"
      form.append(manifest, button)
      document.body.append(form)
    }, start)
    submitted = true
    await page.getByRole("button", { name: "Create GitHub App", exact: true }).click()
    await page.waitForURL(url => url.hostname === "github.com")
    await refuseSudo(page)
    const create = page.getByRole("button", { name: /Create GitHub App/i })
    if (await create.isVisible().catch(() => false)) await create.click()
    await refuseSudo(page)
    await expect.poll(async () => {
      await refuseSudo(page)
      const response = await context!.request.get(`${ORIGIN}/api/install`, { headers })
      if (response.status() !== 200) throw new Error(`Install readback failed: HTTP ${response.status()}.`)
      return (await response.json() as InstallStatus).github_app.configured
    }, { timeout: 45_000 }).toBe(true)
    const configured = await (await context.request.get(`${ORIGIN}/api/install`, { headers })).json() as InstallStatus
    expect(configured.github_app.slug).toBe(slug)
    expect(configured.github_app.install_url).toBe(`https://github.com/apps/${slug}/installations/new`)
    await page.goto(configured.github_app.install_url!, { waitUntil: "domcontentloaded" })
    await refuseSudo(page)
    await page.getByRole("link", { name: LOGIN, exact: true }).click()
    await refuseSudo(page)
    await page.getByRole("radio", { name: "Only select repositories", exact: true }).check()
    const repositories = page.getByRole("button", { name: /Select repositories/i })
    await repositories.click()
    await page.getByRole("textbox", { name: /Search/i }).fill(REPOSITORY)
    await page.getByRole("checkbox", { name: REPOSITORY, exact: true }).check()
    await page.keyboard.press("Escape")
    await expect(page.getByText(REPOSITORY, { exact: true }).last()).toBeVisible()
    await page.getByRole("button", { name: "Install", exact: true }).click()
    await refuseSudo(page)
    await page.waitForURL(url => url.origin === ORIGIN && url.pathname === "/setup/github/installed")
    const installed = await (await context.request.get(`${ORIGIN}/api/install`, { headers })).json() as InstallStatus
    expect(installed.github_app.installed).toBe(true)
    expect(installed.github_app.installation_id).toBeGreaterThan(0)
    await testInfo.attach("github-app-install-readback", {
      body: Buffer.from(JSON.stringify({ owner: LOGIN, repository: REPOSITORY, slug, installed: true })), contentType: "application/json"
    })
  } finally {
    try {
      if (context && submitted && name && slug) await deleteFreshApp(await context.newPage(), name, slug)
    } finally {
      try { await context?.close() } finally { await profile.lease.release() }
    }
  }
})

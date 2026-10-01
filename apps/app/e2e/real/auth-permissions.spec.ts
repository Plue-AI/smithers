import { scenario } from "./coverage/types"
import type { BrowserContext, Page } from "@playwright/test"
import { appEntryPath, appReady, awaitBoot, command, expect, openApp, openComposer, realApi, reloadApp, test } from "./support/test"
import {
  authenticatedTest,
  clearProductSession,
  launchAuthenticatedProfile,
  ordinaryTest,
  readAuthenticatedSession,
  requireProfileEnvironment,
  restoreAuthenticatedSession
} from "./auth-permissions/profile"

const APP_PATH = "/codeplanesmithers/canary-sandbox"

const browserSession = async (page: Page): Promise<unknown> => page.evaluate(async () => {
  const response = await fetch("/api/user", { credentials: "include" })
  if (response.status !== 200) throw new Error(`Browser session read returned HTTP ${response.status}.`)
  return response.json()
})

const authCookieNames = async (context: BrowserContext, baseURL: string): Promise<ReadonlyArray<string>> =>
  (await context.cookies([new URL(baseURL).origin, "https://github.com"]))
    .filter((cookie) => ["smithers_identity", "user_session", "logged_in", "dotcom_user"].includes(cookie.name))
    .map((cookie) => `${cookie.domain}:${cookie.name}`)
    .sort()

authenticatedTest("the selected mode retains its authenticated session through document, bootstrap, and reload", scenario("auth.mode-session-cookie-persistence", {
  capabilities: ["identity"],
  coverage: [
    "action:account.show", "host:local", "host:production", "host:native", "path:persistence", "door:slash", "door:user-only",
    "dimension:mode-auth-session", "dimension:document-bootstrap-cookie-persistence",
    "evidence:session-readback-and-cookie-names"
  ],
  description: "Use the mode-selected browser profile or single-owner credential envelope, then require the same authenticated identity and browser cookies after product document, bootstrap, and reload reads."
}), async ({ page, context, request }, testInfo) => {
  const baseURL = String(testInfo.project.use.baseURL)
  const origin = new URL(baseURL).origin
  const expected = await readAuthenticatedSession(page)
  expect(expected).toBeDefined()
  const beforeCookies = (await context.cookies(origin)).map(({ name }) => name).sort()
  if (process.env.SMITHERS_REAL_AUTH_KIND !== "application-token") expect(beforeCookies.length).toBeGreaterThan(0)

  const document = await request.get(new URL(appEntryPath(), origin).toString(), { headers: { Accept: "text/html" } })
  expect(document.status()).toBe(200)
  expect(document.headers()["content-type"]).toMatch(/^text\/html(?:;|$)/i)
  const bootstrap = await realApi(page, request, "GET", "/api/bootstrap")
  expect(bootstrap.status()).toBe(200)
  const bootstrapBody = await bootstrap.json() as { readonly host?: unknown }
  expect(["local", "cloud", "native"]).toContain(bootstrapBody.host)
  expect(await readAuthenticatedSession(page)).toEqual(expected)
  expect((await context.cookies(origin)).map(({ name }) => name).sort()).toEqual(beforeCookies)

  await openComposer(page)
  await command(page, "/account.show")
  await expect(page.locator('.smithers-card[data-kind="account"]').last().getByTestId("account-login"))
    .toContainText(`@${expected!.login}`)

  await reloadApp(page)
  expect(await readAuthenticatedSession(page)).toEqual(expected)
  expect((await context.cookies(origin)).map(({ name }) => name).sort()).toEqual(beforeCookies)
  await testInfo.attach("mode-auth-session", {
    body: Buffer.from(JSON.stringify({ login: expected?.login, cookieNames: beforeCookies, host: bootstrapBody.host }, null, 2)),
    contentType: "application/json"
  })
})

test("a signed-out required action parks behind its durable sign-in step", scenario("auth.signed-out-deferred-persistence", {
  capabilities: ["identity"],
  coverage: [
    "action:billing.balance", "action:auth.prompt", "host:production",
    "path:permission", "path:persistence", "door:slash",
    "dimension:signed-out-deferred-reload", "evidence:visible-auth-step-and-session-api"
  ],
  description: "A real signed-out browser parks a protected slash action, retains its sign-in step across reload, and remains signed out server-side."
}), async ({ page, request }) => {
  await openApp(page)
  const before = await realApi(page, request, "GET", "/api/user")
  expect(before.status()).toBe(401)

  await openComposer(page)
  await command(page, "/billing.balance")
  const refusal = page.locator(".smithers-chat-message").filter({
    has: page.getByText(/^Sign in(?: with GitHub)? to show your balance\.$/)
  }).last()
  const signIn = refusal.locator('button[data-flow="auth.sign-in"]')
  await expect(refusal).toBeVisible()
  await expect(signIn).toBeVisible()

  await reloadApp(page)
  await expect(refusal).toBeVisible()
  await expect(signIn).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="balance"]')).toHaveCount(0)
  const after = await realApi(page, request, "GET", "/api/user")
  expect(after.status()).toBe(401)
})

test("a signed-out browser gets the same concealed response as an unknown admin route", scenario("auth.signed-out-admin-api-denial", {
  capabilities: ["identity"],
  coverage: [
    "action:admin.health", "host:production", "path:permission", "door:slash",
    "dimension:anonymous-server-enforced-admin-denial", "evidence:canonical-backend-401-body"
  ],
  description: "The shared backend refuses an anonymous browser at the administrator health endpoint."
}), async ({ page, request }) => {
  await openApp(page)
  expect(await readAuthenticatedSession(page)).toBeUndefined()
  await openComposer(page)
  const input = page.getByTestId("composer-input")
  await input.fill("/admin.health")
  await expect(page.locator('.slash-menu-item[data-flow="admin.health"]')).toHaveCount(0)
  await input.press("Escape")
  await expect(page.locator('.smithers-card[data-kind="admin-health"]')).toHaveCount(0)
  const denied = await realApi(page, request, "GET", "/api/admin/system/health")
  expect(denied.status()).toBe(401)
  expect(await denied.json()).toMatchObject({ code: "unauthorized" })
})

test("GitHub sign-in advertises a callback on the initiating origin", scenario("auth.oauth-callback-origin", {
  capabilities: ["identity"],
  coverage: ["action:auth.sign-in", "host:production", "path:success", "door:user-only",
    "dimension:oauth-callback-origin", "evidence:provider-callback-origin"],
  description: "The deployed sign-in route must bind GitHub's callback to the browser origin before authentication."
}), async ({ request }, testInfo) => {
  const origin = new URL(String(testInfo.project.use.baseURL)).origin
  const response = await request.get(`${origin}/api/auth/github?return_to=${encodeURIComponent(APP_PATH)}`, { maxRedirects: 0 })
  // Record no state, authorization query, cookie value, or provider credential.
  const location = new URL(response.headers().location ?? "/", origin)
  const callback = location.searchParams.get("redirect_uri")
  await testInfo.attach("oauth-origins", {
    body: JSON.stringify({ origin, status: response.status(), destination: location.origin + location.pathname,
      callback: callback === null ? null : new URL(callback, origin).origin + new URL(callback, origin).pathname }),
    contentType: "application/json"
  })
  expect(response.status()).toBe(302)
  expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize")
  expect(callback).toBe(`${origin}/api/auth/github/callback`)
})

test("an unsafe absolute OAuth return destination is discarded before GitHub", scenario("auth.oauth-unsafe-return-to-rejected", {
  capabilities: ["identity"],
  coverage: [
    "action:auth.sign-in", "host:production", "path:permission", "door:user-only",
    "dimension:unsafe-return-to-rejected", "evidence:provider-navigation-and-absent-return-cookie"
  ],
  description: "The real OAuth start route reaches GitHub but neither follows nor stores an attacker-controlled absolute return destination."
}), async ({ page, context }, testInfo) => {
  const baseURL = String(testInfo.project.use.baseURL)
  const productOrigin = new URL(baseURL).origin
  const unsafeOrigin = "https://return-to-e2e.invalid"
  const requestedOrigins: string[] = []
  page.on("request", (request) => requestedOrigins.push(new URL(request.url()).origin))

  await page.goto(new URL(`/api/auth/github/start?return_to=${encodeURIComponent(`${unsafeOrigin}/escape`)}`, baseURL).toString(), {
    waitUntil: "domcontentloaded"
  })
  expect(new URL(page.url()).hostname).toBe("github.com")
  expect(requestedOrigins).not.toContain(unsafeOrigin)
  const returnCookies = (await context.cookies(productOrigin)).filter((cookie) => cookie.name === "smithers_return_to")
  expect(returnCookies).toEqual([])

  await page.goto(new URL(APP_PATH, baseURL).toString(), { waitUntil: "domcontentloaded" })
  expect(new URL(page.url()).origin).toBe(productOrigin)
})

authenticatedTest("GitHub OAuth stays on the original repository and resumes the parked action", scenario("auth.oauth-return-to-deferred-resume", {
  capabilities: ["identity"],
  coverage: [
    "action:auth.sign-in", "action:auth.prompt", "action:billing.balance", "host:production",
    "path:success", "path:permission", "path:persistence", "door:slash", "door:button", "door:user-only",
    "dimension:github-oauth-return-to", "dimension:deferred-action-resume", "evidence:session-api-and-balance-card"
  ],
  description: "The sanctioned GitHub profile performs the deployed OAuth handoff from a repository path and the protected action parked before navigation resumes afterward."
}), async ({ page, context }, testInfo) => {
  const baseURL = String(testInfo.project.use.baseURL)
  await clearProductSession(context, baseURL)
  await page.goto(new URL(APP_PATH, baseURL).toString(), { waitUntil: "domcontentloaded" })
  await expect.poll(() => readAuthenticatedSession(page)).toBeUndefined()
  await expect(page.getByTestId("chrome-sign-in")).toBeVisible({ timeout: 60_000 })

  await appReady(page, 60_000)
  await openComposer(page)
  await command(page, "/billing.balance")
  const signIn = page.locator('button[data-flow="auth.sign-in"]:visible').last()
  await expect(signIn).toBeVisible()
  const opened = context.waitForEvent("page")
  await signIn.click()
  const popup = await opened
  try {
    await popup.waitForURL(url => url.href !== "about:blank")
    await popup.waitForLoadState("domcontentloaded")
    const authorize = popup.getByRole("button", { name: /^authorize/i }).first()
    if (await authorize.isVisible()) await authorize.click()
    await expect.poll(() => readAuthenticatedSession(page), { timeout: 60_000 }).not.toBeUndefined()
    expect(new URL(page.url()).origin).toBe(new URL(baseURL).origin)
  } finally { await popup.close() }

  await expect.poll(() => readAuthenticatedSession(page), { timeout: 30_000 }).not.toBeUndefined()
  await expect.poll(() => new URL(page.url()).pathname).toBe(APP_PATH)
  await expect.poll(() => new URL(page.url()).searchParams.has("signed-in")).toBe(false)
  await expect(page.getByTestId("chrome-sign-in")).toHaveCount(0)
  await expect(page.getByRole("status").filter({ hasText: "Signed in with GitHub as @codeplanesmithers." })).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="balance"]')).toBeVisible({ timeout: 30_000 })
})

authenticatedTest("the saved admin identity can read admin health and survives a page restart", scenario("auth.admin-permission-restart", {
  capabilities: ["identity"],
  coverage: [
    "action:admin.health", "action:admin.devtools", "host:production", "path:success", "path:permission",
    "path:persistence", "door:slash", "door:user-only", "dimension:admin-only-registry-after-restart",
    "evidence:session-api-admin-claim-and-health-card"
  ],
  description: "The current sanctioned admin session proves its claim through the real session endpoint, reads the deployed admin health route, and retains admin UI after reload."
}), async ({ page, request }, testInfo) => {
  const expectedSession = { login: "codeplanesmithers", admin: true }
  const expectedWireSession = expectedSession
  await expect.poll(() => readAuthenticatedSession(page)).toEqual(expectedSession)
  const requestSession = await request.get("/api/user")
  expect(requestSession.status()).toBe(200)
  expect(await requestSession.json()).toEqual(expectedWireSession)

  const startedAt = performance.now()
  await page.goto(new URL(APP_PATH, String(testInfo.project.use.baseURL)).toString(), { waitUntil: "domcontentloaded" })
  const afterNavigation = await request.get("/api/user")
  expect(afterNavigation.status()).toBe(200)
  expect(await afterNavigation.json()).toEqual(expectedWireSession)
  // A boot skeleton shows no sign-in door either, so boot before reading its absence.
  await awaitBoot(page, "navigate", startedAt)
  await expect(page.locator('[data-testid="chrome-sign-in"], [data-flow="auth.sign-in"]:visible')).toHaveCount(0)

  await openComposer(page)
  await command(page, "/admin.health")
  await expect(page.locator('.smithers-card[data-kind="admin-health"]')).toBeVisible({ timeout: 30_000 })
  await reloadApp(page)
  await expect.poll(() => readAuthenticatedSession(page)).toEqual(expectedSession)
  await openComposer(page)
  await command(page, "/admin.devtools")
  await expect(page.locator(".devtools-panel")).toBeVisible()
  await expect(page.locator(".devtools-panel")).toContainText("admin.health")
})

authenticatedTest("authenticated cookies survive the canonical document and bootstrap reads", scenario("auth.session-preflight-cookie-persistence", {
  capabilities: ["identity"],
  coverage: [
    "action:account.show", "host:production", "path:persistence", "door:slash",
    "dimension:document-bootstrap-cookie-persistence", "evidence:browser-and-api-session-plus-cookie-names"
  ],
  description: "A restored production session and the saved GitHub login survive real HTML and bootstrap reads, with only cookie names retained as diagnostics."
}), async ({ page, context, request }, testInfo) => {
  const baseURL = String(testInfo.project.use.baseURL)
  const expectedSession = { login: "codeplanesmithers", admin: true }
  const expectedWireSession = expectedSession
  expect(await browserSession(page)).toEqual(expectedWireSession)
  const beforeCookies = await authCookieNames(context, baseURL)
  expect(beforeCookies).toContain("smithers.sh:smithers_identity")
  expect(beforeCookies.some((name) => name.endsWith(":user_session"))).toBe(true)
  await openComposer(page)
  await command(page, "/account.show")
  await expect(page.locator('.smithers-card[data-kind="account"]').last().getByTestId("account-login"))
    .toContainText("@codeplanesmithers")

  const document = await request.get(new URL(APP_PATH, baseURL).toString())
  expect(document.status()).toBe(200)
  expect(await browserSession(page)).toEqual(expectedWireSession)
  expect(await authCookieNames(context, baseURL)).toEqual(beforeCookies)

  const bootstrap = await request.get(new URL("/api/bootstrap", baseURL).toString())
  expect(bootstrap.status()).toBe(200)
  const bootstrapBody = await bootstrap.json() as { host?: unknown; buildSha?: unknown }
  expect(bootstrapBody.host).toBe("cloud")
  expect(bootstrapBody.buildSha).toMatch(/^[0-9a-f]{40,64}$/)
  expect(await browserSession(page)).toEqual(expectedWireSession)
  expect(await authCookieNames(context, baseURL)).toEqual(beforeCookies)

  expect(await readAuthenticatedSession(page)).toEqual(expectedSession)
  expect(await browserSession(page)).toEqual(expectedWireSession)

  await reloadApp(page)
  expect(await browserSession(page)).toEqual(expectedWireSession)
  await openComposer(page)
  await command(page, "/account.show")
  await expect(page.locator('.smithers-card[data-kind="account"]').last().getByTestId("account-login"))
    .toContainText("@codeplanesmithers")
})

authenticatedTest("sign-out clears the real session and a real OAuth round trip restores it", scenario("auth.sign-out-reauth-restart", {
  capabilities: ["identity"],
  coverage: [
    "action:account.show", "action:auth.sign-out", "action:auth.sign-in", "host:production", "path:success",
    "path:persistence", "door:slash", "door:button", "door:user-only", "dimension:logout-reauth-restart",
    "evidence:session-api-account-card-and-reload"
  ],
  description: "The account card signs the real Smithers session out, the signed-out state survives reload, and the sanctioned GitHub session restores access through OAuth."
}), async ({ page }, testInfo) => {
  const baseURL = String(testInfo.project.use.baseURL)
  await openApp(page)
  await expect.poll(() => readAuthenticatedSession(page)).toEqual({ login: "codeplanesmithers", admin: true })
  await openComposer(page)
  await command(page, "/account.show")
  const account = page.locator('.smithers-card[data-kind="account"]')
  await expect(account).toBeVisible()
  await expect(account.getByTestId("account-login")).toContainText("@codeplanesmithers")
  await account.locator('[data-flow="auth.sign-out"]').click()

  await expect.poll(() => readAuthenticatedSession(page)).toBeUndefined()
  await expect(page.locator('.smithers-card[data-kind="account"]')).toHaveCount(0)
  await reloadApp(page)
  await expect(page.locator('button[data-flow="auth.sign-in"]:visible').last()).toBeVisible()
  expect(await readAuthenticatedSession(page)).toBeUndefined()

  const restored = await restoreAuthenticatedSession(page, baseURL)
  expect(restored).toEqual({ login: "codeplanesmithers", admin: true })
  // A raw reload: the restart evidence is the session endpoint, which answers
  // from the browser's cookie jar whether or not the app has finished booting.
  await page.reload({ waitUntil: "domcontentloaded" })
  expect(await readAuthenticatedSession(page)).toEqual(restored)
})

ordinaryTest("an ordinary account is denied by both the admin UI and server route", scenario("auth.ordinary-admin-denial", {
  capabilities: ["identity"],
  coverage: [
    "action:admin.health", "host:production", "path:permission", "door:slash", "door:user-only",
    "dimension:ordinary-non-admin-denial", "evidence:session-claim-menu-absence-and-backend-403"
  ],
  description: "A separately provisioned ordinary GitHub identity lacks the admin action in the UI and is forbidden by the protected backend endpoint."
}), async ({ page, request }) => {
  requireProfileEnvironment("SMITHERS_E2E_ORDINARY_PROFILE")
  await openApp(page)
  let session = await readAuthenticatedSession(page)
  await expect.poll(async () => (session = await readAuthenticatedSession(page))).not.toBeUndefined()
  expect(session, "ordinary identity preflight must produce a real session").toBeDefined()
  expect(session?.admin, "ordinary identity must not carry the admin claim").toBe(false)

  await openComposer(page)
  const input = page.getByTestId("composer-input")
  await input.fill("/admin.health")
  await expect(page.locator('.slash-menu-item[data-flow="admin.health"]')).toHaveCount(0)
  await input.press("Escape")
  await expect(page.locator('.smithers-card[data-kind="admin-health"]')).toHaveCount(0)
  const denied = await realApi(page, request, "GET", "/api/admin/system/health")
  expect(denied.status()).toBe(403)
  expect(await denied.json()).toMatchObject({ code: "forbidden" })
})

ordinaryTest("signing out one real user does not alter another user's live session", scenario("auth.cross-user-session-isolation", {
  capabilities: ["identity"],
  coverage: [
    "action:auth.sign-out", "action:account.show", "host:production", "path:permission", "path:persistence",
    "door:button", "dimension:cross-user-cookie-isolation", "evidence:two-profile-session-api-readback"
  ],
  description: "Two independently provisioned persistent profiles hold distinct live sessions; signing the ordinary one out leaves the admin session unchanged."
}), async ({ page, playwright }, testInfo) => {
  requireProfileEnvironment("SMITHERS_E2E_ORDINARY_PROFILE")
  const baseURL = String(testInfo.project.use.baseURL)
  let ordinary = await readAuthenticatedSession(page)
  await expect.poll(async () => (ordinary = await readAuthenticatedSession(page))).not.toBeUndefined()
  expect(ordinary, "ordinary identity preflight must produce a real session").toBeDefined()
  expect(ordinary?.admin).toBe(false)
  const admin = await launchAuthenticatedProfile(playwright, baseURL)
  try {
    expect(admin.session).toEqual({ login: "codeplanesmithers", admin: true })
    expect(admin.session.login).not.toBe(ordinary?.login)
    await openApp(page)
    await openComposer(page)
    await command(page, "/account.show")
    await page.locator('.smithers-card[data-kind="account"] [data-flow="auth.sign-out"]').click()
    await expect.poll(() => readAuthenticatedSession(page)).toBeUndefined()
    expect(await readAuthenticatedSession(admin.page)).toEqual(admin.session)
  } finally {
    await admin.close()
  }
})

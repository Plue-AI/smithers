import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, link, readFile, realpath, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { BrowserContext, BrowserType, Page } from "@playwright/test"
import { expect, test as realTest } from "../support/test"
import { appEntryPath, awaitBoot } from "../support"

type SessionBody = {
  readonly username?: unknown
  readonly is_admin?: unknown
}

export type AuthenticatedSession = {
  readonly login: string
  readonly admin: boolean
}

type ProfileLease = { readonly release: () => Promise<void> }
type LockRecord = { readonly pid?: unknown; readonly nonce?: unknown }
type AuthenticatedProfileOptions = { readonly profileEnvironment: string | undefined }
type AuthenticatedProfileFixtures = { readonly _authenticatedReady: void }
type RealAuthKind = "browser-profile" | "owner-token" | "application-token"

const realAuthKind = (): RealAuthKind => {
  const configured = process.env.SMITHERS_REAL_AUTH_KIND?.trim()
  if (configured === "browser-profile" || configured === "owner-token" || configured === "application-token") return configured
  if (configured !== undefined && configured !== "") throw new Error(`Unsupported SMITHERS_REAL_AUTH_KIND: ${configured}`)
  return "browser-profile"
}

const profileFromEnvironment = (requiredEnvironment?: string): string => {
  if (requiredEnvironment !== undefined) {
    const configured = process.env[requiredEnvironment]?.trim()
    if (!configured) throw new Error(`${requiredEnvironment} is required for this real identity scenario.`)
    return configured
  }
  return process.env.SMITHERS_E2E_PROFILE ?? process.env.MULTI_E2E_PROFILE ?? join(homedir(), ".multi-e2e-profile")
}

const liveProcess = (pid: unknown): boolean => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"
  }
}

/**
 * Serializes the one sanctioned browser profile across every real-E2E process.
 * The sibling lock contains only a process id and random ownership nonce. A
 * Existing locks fail closed, including stale ones: removing one requires
 * coordinated human inspection so two contenders can never reap each other.
 */
export const acquireAuthenticatedProfile = async (requiredEnvironment?: string): Promise<{ readonly path: string; readonly lease: ProfileLease }> => {
  const configured = profileFromEnvironment(requiredEnvironment)
  await access(configured, constants.R_OK | constants.W_OK)
  const path = await realpath(configured)
  const lockPath = `${path}.smithers-real-e2e.lock`
  const nonce = randomUUID()
  const record = JSON.stringify({ pid: process.pid, nonce, acquiredAt: new Date().toISOString() })
  const candidate = `${lockPath}.${process.pid}.${nonce}.candidate`
  await writeFile(candidate, record, { flag: "wx", mode: 0o600 })

  try {
    try {
      // link(2) publishes the already-written record atomically and refuses
      // to replace an existing owner's inode.
      await link(candidate, lockPath)
      return {
        path,
        lease: {
          release: async () => {
            let current: LockRecord
            try { current = JSON.parse(await readFile(lockPath, "utf8")) as LockRecord }
            catch { throw new Error("Authenticated profile lock could not be verified during cleanup.") }
            if (current?.pid !== process.pid || current?.nonce !== nonce) {
              throw new Error("Authenticated profile lock ownership changed before cleanup.")
            }
            await unlink(lockPath)
          }
        }
      }
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error
      let current: LockRecord | undefined
      try { current = JSON.parse(await readFile(lockPath, "utf8")) as LockRecord } catch { /* fail closed below */ }
      if (current !== undefined && liveProcess(current.pid)) {
        throw new Error(`Authenticated profile is already in use by process ${String(current.pid)}.`)
      }
      throw new Error("Authenticated profile has an existing stale or unreadable lock; inspect and remove that lock only after coordinating profile ownership.")
    }
  } finally {
    await unlink(candidate).catch(() => undefined)
  }
}

export const requireProfileEnvironment = (environment: string): void => {
  profileFromEnvironment(environment)
}

export const parseAuthenticatedUser = (status: number, body: SessionBody | undefined): AuthenticatedSession | undefined => {
  if (status === 401) return undefined
  if (status !== 200) throw new Error(`Authenticated-user preflight failed: HTTP ${status}.`)
  if (body === undefined || typeof body !== "object" || body === null) {
    throw new Error("Authenticated-user preflight returned malformed JSON.")
  }
  if (typeof body.username !== "string" || body.username === "" ||
      (body.is_admin !== undefined && typeof body.is_admin !== "boolean")) {
    throw new Error("Authenticated-user preflight returned an unrecognized user body.")
  }
  return { login: body.username, admin: body.is_admin ?? false }
}

/** The configured token for token auth kinds; a browser profile carries cookies instead. */
const configuredToken = (authKind: RealAuthKind): string | undefined => {
  if (authKind === "browser-profile") return undefined
  const environment = process.env.SMITHERS_REAL_AUTH_ENVIRONMENT?.trim()
  const token = environment ? process.env[environment]?.trim() : undefined
  if (!token) throw new Error(`${environment ?? authKind} is required.`)
  return token
}

const readSessionAtOrigin = async (context: BrowserContext, origin: string): Promise<AuthenticatedSession | undefined> => {
  const authKind = realAuthKind()
  const token = configuredToken(authKind)
  const apiOrigin = process.env.SMITHERS_REAL_API_ORIGIN ?? origin
  const response = await context.request.get(new URL("/api/user", apiOrigin).toString(), {
    ...(token ? { headers: { authorization: `${authKind === "owner-token" ? "token" : "Bearer"} ${token}` } } : {})
  })
  const body = await response.json().catch(() => undefined) as SessionBody | undefined
  return parseAuthenticatedUser(response.status(), body)
}

export const readAuthenticatedSession = async (page: Page): Promise<AuthenticatedSession | undefined> => {
  if (page.isClosed()) throw new Error("Cannot read the authenticated session from a closed page.")
  return readSessionAtOrigin(page.context(), new URL(page.url()).origin)
}

const safeLocation = (page: Page): string => {
  const url = new URL(page.url())
  return `${url.origin}${url.pathname}`
}

export const finishGitHubOAuth = async (page: Page, productOrigin: string): Promise<void> => {
  await page.waitForLoadState("domcontentloaded")
  if (new URL(page.url()).origin === productOrigin) return
  if (new URL(page.url()).hostname !== "github.com") {
    throw new Error(`OAuth left the product for an unexpected origin at ${safeLocation(page)}.`)
  }
  const githubPath = new URL(page.url()).pathname
  if (githubPath === "/login" || githubPath === "/session" || githubPath.startsWith("/session/")) {
    throw new Error("The saved GitHub browser session has expired; refresh the sanctioned profile through the real bootstrap procedure.")
  }
  const authorize = page.getByRole("button", { name: /^authorize/i }).first()
  if (await authorize.isVisible().catch(() => false)) await authorize.click()
  await page.waitForURL((url) => url.origin === productOrigin, { timeout: 60_000 })
  await page.waitForLoadState("domcontentloaded")
}

export const restoreAuthenticatedSession = async (page: Page, baseURL: string): Promise<AuthenticatedSession> => {
  const origin = new URL(baseURL).origin
  if (page.isClosed() || new URL(page.url()).origin !== origin) {
    if (page.isClosed()) throw new Error("Cannot restore authentication after the credentialed page was closed.")
    await page.goto(new URL(appEntryPath(), origin).toString(), { waitUntil: "domcontentloaded" })
  }
  // The context request uses the live browser cookie jar. Keep its target
  // origin fixed while OAuth redirects replace the page's execution context.
  const readSession = () => readSessionAtOrigin(page.context(), origin)
  let session = await readSession()
  // A restored session comes from the cookie jar, not the view, so the
  // signed-in path returns without a boot wait every production test would pay
  // for in fixture setup. Only the sign-in path below reads the DOM.
  if (session !== undefined) return session

  const startedAt = performance.now()
  await page.goto(new URL(appEntryPath(), origin).toString(), { waitUntil: "domcontentloaded" })
  // The door is chrome the booted view renders, and this profile boots in 12 to
  // 72 s, so reading it straight after the navigation spends Playwright's 15 s
  // default inside the boot skeleton and then reports the door as missing.
  await awaitBoot(page, "navigate", startedAt)
  const door = page.locator('[data-testid="chrome-sign-in"], [data-flow="auth.sign-in"]').first()
  await expect(door).toBeVisible()
  await door.click()
  await finishGitHubOAuth(page, origin)
  await page.waitForLoadState("domcontentloaded")
  await expect.poll(readSession, { timeout: 30_000 }).not.toBeUndefined()
  await page.waitForURL((url) => url.origin === origin, { timeout: 30_000 })
  await page.waitForLoadState("domcontentloaded")
  session = await readSession()
  if (session === undefined) throw new Error("The real OAuth round trip returned without an authenticated Smithers session.")
  return session
}

/** Remove only Smithers' host cookies. GitHub cookies and persisted app state stay intact. */
export const clearProductSession = async (context: BrowserContext, baseURL: string): Promise<void> => {
  const hostname = new URL(baseURL).hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  await context.clearCookies({ domain: new RegExp(`(^|\\.)${hostname}$`) })
}

export const launchAuthenticatedProfile = async (
  playwright: { readonly chromium: BrowserType },
  baseURL: string,
  requiredEnvironment?: string
): Promise<{
  readonly context: BrowserContext
  readonly page: Page
  readonly session: AuthenticatedSession
  readonly close: () => Promise<void>
}> => {
  const { path, lease } = await acquireAuthenticatedProfile(requiredEnvironment)
  let context: BrowserContext | undefined
  try {
    const opened = await playwright.chromium.launchPersistentContext(path, {
      baseURL,
      headless: process.env.SMITHERS_REAL_HEADED !== "1",
      viewport: { width: 1280, height: 900 }
    })
    context = opened
    const page = opened.pages()[0] ?? await opened.newPage()
    await page.goto(new URL(appEntryPath(), baseURL).toString(), { waitUntil: "domcontentloaded" })
    const session = await restoreAuthenticatedSession(page, baseURL)
    return {
      context: opened,
      page,
      session,
      close: async () => {
        await opened.close()
        await lease.release()
      }
    }
  } catch (error) {
    if (context === undefined) await lease.release()
    else {
      await context.close()
      await lease.release()
    }
    throw error
  }
}

/**
 * Real-test variant for production scenarios that require a signed-in browser.
 * It launches the sanctioned persistent profile under an atomic lease, makes
 * the real session available after the canonical host preflight,
 * and restores that session after logout coverage even when an assertion fails.
 */
export const authenticatedTest = realTest.extend<AuthenticatedProfileOptions & AuthenticatedProfileFixtures>({
  trace: "off",
  video: "off",
  profileEnvironment: [undefined, { option: true }],
  context: async ({ playwright, browserName, context: inheritedContext, profileEnvironment }, use, testInfo) => {
    const authKind = realAuthKind()
    const chromiumProfile = authKind === "browser-profile" ||
      (authKind === "application-token" && Boolean(process.env.SMITHERS_E2E_PROFILE?.trim()))
    if (browserName !== "chromium" && chromiumProfile) {
      throw new Error("Persisted Chromium profiles require Chromium.")
    }
    const baseURL = testInfo.project.use.baseURL
    if (typeof baseURL !== "string") throw new Error("The authenticated profile fixture requires a configured baseURL.")

    if (authKind === "application-token" || authKind === "owner-token") {
      const token = configuredToken(authKind)!
      // An owner token selects the owner backend that serves this page; an application token selects Plue.
      const target = authKind === "owner-token"
        ? { apiVersion: 1, mode: "web-selfhost", apiOrigin: "", auth: { kind: "token" }, cors: "same-origin", developerExternal: false }
        : { apiVersion: 1, mode: "web-plue", apiOrigin: "", auth: { kind: "bearer" }, cors: "same-origin", developerExternal: false }
      const useGithubProfile = authKind === "application-token" && Boolean(process.env.SMITHERS_E2E_PROFILE?.trim())
      const profile = useGithubProfile ? await acquireAuthenticatedProfile("SMITHERS_E2E_PROFILE") : undefined
      let context: BrowserContext | undefined
      try {
        context = profile
          ? await playwright.chromium.launchPersistentContext(profile.path, {
              baseURL, headless: process.env.SMITHERS_REAL_HEADED !== "1", viewport: { width: 1280, height: 900 }
            })
          : inheritedContext
        const origin = new URL(baseURL).origin
        await context.addInitScript(({ origin, target, token }) => {
          if (location.origin !== origin) return
          sessionStorage.setItem("smithers.backend-target", JSON.stringify(target))
          sessionStorage.setItem("smithers.backend-token", token)
        }, { origin, target, token })
        await use(context)
      } finally {
        if (profile) {
          try { await context?.close() } finally { await profile.lease.release() }
        }
      }
      return
    }
    if (process.env.SMITHERS_REAL_E2E_HOST !== "production") {
      throw new Error("The authenticated persistent-profile fixture is production-only unless token auth is selected.")
    }
    const requiredEnvironment = profileEnvironment
    if (requiredEnvironment !== undefined && !process.env[requiredEnvironment]?.trim()) {
      // Still run the canonical production/build/capability preflight before
      // reporting the missing identity from _authenticatedReady.
      const browser = await playwright.chromium.launch({ headless: process.env.SMITHERS_REAL_HEADED !== "1" })
      let context: BrowserContext | undefined
      const failures: unknown[] = []
      try {
        context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } })
        await use(context)
      } catch (error) { failures.push(error) }
      try { await context?.close() } catch (error) { failures.push(error) }
      try { await browser.close() } catch (error) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, "The missing-profile scenario or its ephemeral browser cleanup failed.")
      return
    }
    const { path, lease } = await acquireAuthenticatedProfile(requiredEnvironment)
    let context: BrowserContext | undefined
    try {
      context = await playwright.chromium.launchPersistentContext(path, {
        baseURL,
        headless: process.env.SMITHERS_REAL_HEADED !== "1",
        viewport: { width: 1280, height: 900 }
      })
      await use(context)
    } finally {
      if (context === undefined) await lease.release()
      else {
        await context.close()
        await lease.release()
      }
    }
  },
  request: async ({ context }, use) => {
    await use(context.request)
  },
  page: async ({ context, profileEnvironment }, use, testInfo) => {
    const baseURL = testInfo.project.use.baseURL
    if (typeof baseURL !== "string") throw new Error("The authenticated profile fixture requires a configured baseURL.")
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto(new URL(appEntryPath(), baseURL).toString(), { waitUntil: "domcontentloaded" })
    const requiredEnvironment = profileEnvironment
    const profileAvailable = requiredEnvironment === undefined || Boolean(process.env[requiredEnvironment]?.trim())
    try {
      await use(page)
    } finally {
      if (realAuthKind() === "browser-profile" && profileAvailable) {
        const restorePage = page.isClosed()
          ? context.pages().find((candidate) => !candidate.isClosed()) ?? await context.newPage()
          : page
        await restoreAuthenticatedSession(restorePage, baseURL)
      }
    }
  },
  _authenticatedReady: [async ({ _realLifecycle, context, page, profileEnvironment, request }, use, testInfo) => {
    // The canonical lifecycle performs its host/build/capability preflight
    // first. Authentication is established after that boundary and the
    // dependency leaves lifecycle cleanup inside the signed-in span.
    void _realLifecycle
    void request
    const baseURL = testInfo.project.use.baseURL
    if (typeof baseURL !== "string") throw new Error("The authenticated profile fixture requires a configured baseURL.")
    if (realAuthKind() !== "browser-profile") {
      const session = await readAuthenticatedSession(page)
      if (session === undefined) throw new Error(`The ${realAuthKind()} did not authenticate GET /api/user.`)
      testInfo.annotations.push({ type: "real-authenticated-token", description: "token-verified-after-lifecycle" })
      await use()
      return
    }
    const profileAvailable = profileEnvironment === undefined || Boolean(process.env[profileEnvironment]?.trim())
    if (!profileAvailable) throw new Error(`${profileEnvironment} is required for this real identity scenario.`)
    if (profileAvailable) {
      await restoreAuthenticatedSession(page, baseURL)
      testInfo.annotations.push({ type: "real-authenticated-profile", description: "restored-after-lifecycle" })
    }
    try {
      await use()
    } finally {
      if (profileAvailable) {
        const restorePage = page.isClosed()
          ? context.pages().find((candidate) => !candidate.isClosed()) ?? await context.newPage()
          : page
        await restoreAuthenticatedSession(restorePage, baseURL)
      }
    }
  }, { auto: true }]
})

// Credentialed evidence is deliberately limited to screenshots and the
// canonical status-only response log. OAuth bodies, cookies, and tokens never
// enter Playwright traces or videos.
/** Separate test types keep each required identity explicit to the runner. */
export const ordinaryTest = authenticatedTest.extend({ profileEnvironment: "SMITHERS_E2E_ORDINARY_PROFILE" })

export const maintainerTest = authenticatedTest.extend({ profileEnvironment: "SMITHERS_E2E_MAINTAINER_PROFILE" })

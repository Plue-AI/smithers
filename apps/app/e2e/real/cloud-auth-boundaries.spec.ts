import type { Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { awaitBoot, command, expect, openApp, realApi, test } from "./support/test"

/** Enter the app and wait for the booted view before any keyboard chord is pressed. */
const boot = async (page: Page): Promise<void> => {
  const startedAt = performance.now()
  await openApp(page)
  await awaitBoot(page, "navigate", startedAt)
}

/**
 * GitHub's OAuth request inside a login window.
 *
 * A signed-out browser lands on `/login` carrying the authorize request in
 * `return_to`; a browser already signed in to GitHub is sent straight to the
 * authorize page. Both are the same request, so both read the same way.
 */
const authorizeRequest = (opened: URL): URL =>
  opened.pathname === "/login/oauth/authorize" ? opened : new URL(opened.searchParams.get("return_to") ?? "/", opened.origin)

/**
 * Smithers Cloud from a signed-out browser on the real local host.
 *
 * The host runs in hybrid mode against the real Cloud API (scripts/
 * run-real-e2e.ts), so nothing here is stubbed and no token is invented: the
 * PAT login is started for real and abandoned, and the proxy is read with no
 * credential at all. What both cases hold the product to is that a signed-out
 * process stays signed out — the doors may act, but no act may produce a
 * credential or a repository the browser was not entitled to.
 */
test("a real local browser sees an honest signed-out Cloud session", scenario("cloud-auth.signed-out-session-boundary", {
  capabilities: ["cloud"],
  coverage: [
    "action:cloud.sign-in", "action:cloud.sign-out", "host:local", "path:permission",
    "path:persistence", "door:slash", "dimension:cloud-session-boundary",
    "evidence:real-session-read-and-no-credential-mutation"
  ],
  description: "The local browser reads the real Cloud auth endpoint, observes the empty session, opens the real login the sign-in door offers, and still holds no credential: the attempt reports itself as an attempt, and sign-out returns the session to empty."
}), async ({ page, request }) => {
  await boot(page)

  const before = await realApi(page, request, "GET", "/api/cloud-auth/session")
  expect(before.status()).toBe(200)
  expect(await before.json()).toEqual({ state: "signed-out", username: null, expiresAt: null })

  /*
   * cloud.sign-in is the human's gesture (src/mainview/flows/entries/cloud.ts):
   * its handler opens the Cloud API's GitHub login in a second window and
   * renders nothing in the app, so the window IS the act this reads. Only the
   * request it carries is asserted; GitHub's own page is GitHub's to change.
   */
  const opening = page.waitForEvent("popup")
  await command(page, "/cloud.sign-in")
  const login = await opening
  try {
    await login.waitForURL(/^https:\/\/github\.com\//, { timeout: 30_000 })
    const opened = new URL(login.url())
    expect(opened.origin).toBe("https://github.com")
    const authorize = authorizeRequest(opened)
    expect(authorize.pathname).toBe("/login/oauth/authorize")
    expect(authorize.searchParams.get("client_id")).toEqual(expect.any(String))
    expect(authorize.searchParams.get("redirect_uri")).toEqual(expect.any(String))
    await expect(page.locator('[data-flow="cloud.sign-in"]:visible')).toHaveCount(0)

    /*
     * The attempt is now open on the host: a loopback listener waits for the
     * callback under a five-minute timer (src/bun/CloudAuth.ts). The session
     * says an attempt is running and still carries no credential, and a second
     * start answers that same pending login instead of minting anything.
     */
    const during = await realApi(page, request, "GET", "/api/cloud-auth/session")
    expect(during.status()).toBe(200)
    expect(await during.json()).toEqual({ state: "signing-in", username: null, expiresAt: null })

    const start = await realApi(page, request, "POST", "/api/cloud-auth/start", {})
    expect(start.status()).toBe(200)
    const started = await start.json() as { url?: unknown }
    expect(started.url).toEqual(expect.any(String))
    // The window the flow opened and the URL the API hands back are one login:
    // GitHub redirects back to the same Cloud API origin that issued it.
    expect(new URL(String(authorize.searchParams.get("redirect_uri"))).origin).toBe(new URL(String(started.url)).origin)

    const signOut = await realApi(page, request, "POST", "/api/cloud-auth/sign-out", {})
    expect(signOut.status()).toBe(200)
    expect(await signOut.json()).toEqual({ ok: true })

    const after = await realApi(page, request, "GET", "/api/cloud-auth/session")
    expect(after.status()).toBe(200)
    expect(await after.json()).toEqual({ state: "signed-out", username: null, expiresAt: null })
  } finally {
    await login.close()
    /*
     * A failure above leaves the host's login attempt open — its listener and
     * its timer outlive this scenario, and the next one on this worker would
     * read `signing-in`. The fixture's cleanup knows PTYs, repositories and
     * owned directories, not this, so the scenario ends its own attempt.
     */
    await realApi(page, request, "POST", "/api/cloud-auth/sign-out", {}).catch(() => undefined)
  }
})

test("a real signed-out browser never dials Smithers Cloud, and the proxy refuses an anonymous read", scenario("cloud-auth.signed-out-proxy-denial", {
  capabilities: ["cloud"],
  coverage: [
    "action:repos.import", "action:auth.prompt", "host:local", "path:permission", "door:slash",
    "dimension:cloud-proxy-auth-boundary", "evidence:no-cloud-request-and-exact-unauthorized-refusal"
  ],
  description: "A real anonymous browser cannot reach Smithers Cloud: the import door renders the sign-in step instead of dialing the proxy, and a direct anonymous read of the proxy is refused without naming the repository it was asked for."
}), async ({ page, request }) => {
  await boot(page)

  /*
   * repos.import is the app's own door onto the Cloud proxy: signed in, its
   * handler POSTs /api/cloud/api/github/import (src/mainview/state/seams/
   * RepoImportSeam.ts, importRepository), so the empty request list below is a
   * dial this flow would otherwise make, not a flow that never dials. Signed
   * out, its `signed-in` requirement renders auth.prompt's sign-in step first.
   */
  const dialled: string[] = []
  page.on("request", (sent) => {
    const url = new URL(sent.url())
    if (url.pathname.startsWith("/api/cloud/")) dialled.push(`${sent.method()} ${url.pathname}`)
  })
  await command(page, "/repos.import smithersai/smithers")

  const step = page.locator(".smithers-chat-message")
    .filter({ has: page.getByRole("button", { name: "Sign in with GitHub" }) }).last()
  await expect(step).toBeVisible()
  await expect(step).toContainText(/sign in/i)
  await expect(step).toContainText(/Smithers Cloud/i)
  expect(dialled).toEqual([])

  /*
   * The proxy itself, read with no credential. It forwards to the real Cloud
   * API (src/bun/server.ts, proxyCloud) and restates the refusal, so what is
   * held here is the refusal's shape: unauthorized, and a sentence that does
   * not repeat the resource the caller asked for.
   */
  const response = await realApi(page, request, "GET", "/api/cloud/api/user/repos")
  expect(response.status()).toBe(401)
  const body = await response.json() as { status?: unknown; code?: unknown; message?: unknown }
  expect(body).toMatchObject({ status: "error", code: "unauthorized" })
  expect(body.message).toEqual(expect.any(String))
  expect(String(body.message)).not.toMatch(/repo|repository/i)
})


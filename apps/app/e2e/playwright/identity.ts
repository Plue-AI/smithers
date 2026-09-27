/*
 * The identity every browser-tier spec runs as.
 *
 * Will's ruling (Factory spec 2026-09-08, review/RULINGS.md 35): open sign-in
 * is on and the permission tiers behind it stay deliberately narrow, so the
 * e2e and canary suites run as a SCOPED-DOWN signed-in user and prove the
 * product works under the permissions a real visitor has. A spec whose double
 * answers with the factory admin's login is green while the product refuses
 * everyone else, which is the permission bug the suite exists to catch.
 *
 * `SCOPED_TEST_USER` is a plain signed-in GitHub account: no `admin` claim, no
 * maintainer claim on any repository, and no entry on the hand-seeded
 * closed-alpha roster. `allowlisted` is `true` because open sign-in makes
 * identity answer `true` for every login (Factory spec 01 §3); the privilege
 * is the `admin` claim and the seeded roster, never that flag.
 *
 * The login matches the deployed test account, so one account name reads the
 * same across the doubles, the real tier's persistent profile, and the server
 * canary's `$CANARY_SESSION_LOGIN`.
 *
 * A spec that needs a maintainer or an admin states that in the spec itself,
 * with the reason, rather than raising the privileges here for everyone.
 */
export const SCOPED_TEST_USER = {
  login: "codeplanesmithers",
  allowlisted: true,
  admin: false
} as const

/**
 * The app reads identity from the selected backend's user API (`GET /api/user`,
 * ApplicationClient `identity.current`) on every host since 4fa92ed8bf; a 401
 * is signed out, with the Go backend's `RequireAuth` body
 * (packages/backend/internal/middleware/auth.go). `login` null answers signed out.
 */
export const identityRoute = (login: string | null = SCOPED_TEST_USER.login) =>
  (route: import("@playwright/test").Route) => login === null
    ? route.fulfill({ status: 401, json: { code: "unauthorized", fault: "user", message: "authentication required" } })
    : route.fulfill({ json: { id: 1, username: login, is_admin: false } })

/** The Smithers Cloud half of the same account (`GET /api/cloud-auth/session`). */
export const SCOPED_TEST_USER_CLOUD_SESSION = {
  state: "signed-in",
  username: SCOPED_TEST_USER.login,
  expiresAt: "2027-01-01T00:00:00.000Z"
} as const

/** Close the signup a signed-out visitor meets first (state/Signup.ts), so a spec reaches the first-run transcript. */
export async function skipSignup(page: import("@playwright/test").Page) {
  const { expect } = await import("@playwright/test")
  await expect(page.getByTestId("signup")).toBeVisible()
  if (!await page.getByTestId("composer-input").isVisible()) await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill("/signup.finish")
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("signup")).toHaveCount(0)
}

/** A signed-out cloud visitor; unauthenticated tracker reads are refusals. */
export async function signedOutVisitor(page: import("@playwright/test").Page) {
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) })
  await page.route("**/api/**", route => route.fulfill(json({ message: "Unavailable test route" }, 404)))
  await page.route("**/api/bootstrap", route => route.fulfill(json({ apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["identity", "cloud", "agent"], authFlow: "redirect", sandbox: null })))
  await page.route("**/api/user", identityRoute(null))
  await page.route("**/api/user/repos", route => route.fulfill(json({ repos: [] })))
  await page.route(/\/api\/.*(?:issues|landings)(?:\?|$)/, route => route.fulfill(json({ message: "Sign in to read this repository" }, 401)))
}

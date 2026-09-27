import { authenticatedTest, clearProductSession, launchAuthenticatedProfile, readAuthenticatedSession } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { attachJson, runSlash } from "./issues/local"
import { awaitBoot, expect, reloadApp } from "./support/test"

// Both profiles are dedicated to this destructive session-boundary test.
// Their actual server-issued cookies change identity without editing app state.
const signupTest = authenticatedTest.extend({ profileEnvironment: "SMITHERS_E2E_SIGNUP_SWITCH_PROFILE" })

signupTest("signup follows real account replacement and forgets private drafts after sign-out", scenario("signup.identity-replacement-reload", {
  capabilities: ["identity"],
  coverage: ["action:signup.set", "action:signup.account", "action:signup.answer", "action:auth.sign-out", "host:production", "path:permission", "path:persistence", "door:button", "door:slash", "dimension:account-replacement", "dimension:reload", "evidence:two-session-signup-readback"],
  description: "Two dedicated real identities replace the browser session without changing its stored app state; same-owner reload retains signup, replacement and sign-out retire the previous account's unfinished form and poll."
}), async ({ page, context, playwright }, testInfo) => {
  const baseURL = String(testInfo.project.use.baseURL)
  await awaitBoot(page, "navigate", performance.now())
  const first = await readAuthenticatedSession(page)
  expect(first).toBeDefined()
  const originalCookies = await context.cookies(new URL(baseURL).origin)
  const second = await launchAuthenticatedProfile(playwright, baseURL, "SMITHERS_E2E_SIGNUP_REPLACEMENT_PROFILE")
  try {
    expect(second.session.login).not.toBe(first!.login)
    const replacementCookies = await second.context.cookies(new URL(baseURL).origin)
    const signup = page.getByTestId("signup")
    const account = page.getByTestId("signup-account")
    const name = page.getByTestId("signup-name")
    const fresh = async (login: string) => {
      await expect(signup).toHaveAttribute("data-stage", "account")
      await expect(account).toHaveValue(login.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 39))
      await expect(name).toHaveValue("")
    }
    const refresh = async () => {
      const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/user" && response.request().method() === "GET")
      await page.evaluate(() => window.dispatchEvent(new Event("focus")))
      expect((await response).status()).toBe(200)
    }
    const replace = async (cookies: typeof originalCookies, login: string) => {
      await clearProductSession(context, baseURL)
      await context.addCookies(cookies)
      expect((await readAuthenticatedSession(page))?.login).toBe(login)
      await refresh()
      await fresh(login)
      await reloadApp(page)
      await fresh(login)
    }
    await fresh(first!.login)
    await replace(replacementCookies, second.session.login)
    await replace(originalCookies, first!.login)

    const privateName = `Private ${crypto.randomUUID()}`
    const privateSlug = `private-${crypto.randomUUID().slice(0, 8)}`
    await name.fill(privateName)
    await account.fill(privateSlug)
    await refresh()
    await expect(name).toHaveValue(privateName)
    await expect(account).toHaveValue(privateSlug)
    await reloadApp(page)
    await expect(name).toHaveValue(privateName)
    await expect(account).toHaveValue(privateSlug)
    await replace(replacementCookies, second.session.login)

    await name.fill(privateName)
    await page.getByTestId("signup-account-continue").press("Enter")
    const question = page.getByTestId("signup-question")
    await question.getByRole("radio", { name: /Just me/ }).press("a")
    await expect(question).toHaveAttribute("data-question", "role")
    await reloadApp(page)
    await expect(question).toHaveAttribute("data-question", "role")
    await replace(originalCookies, first!.login)
    await expect(page.locator("body")).not.toContainText(privateName)
    await name.fill(privateName)
    await page.getByTestId("signup-account-continue").press("Enter")
    await expect(question).toHaveAttribute("data-question", "size")
    await expect(question.getByRole("radio", { checked: true })).toHaveCount(0)
    await runSlash(page, "/account.show")
    const card = page.locator('.smithers-card[data-kind="account"]').last()
    await expect(card.getByTestId("account-login")).toContainText(`@${first!.login}`)
    await card.locator('[data-flow="auth.sign-out"]').press("Enter")
    await expect.poll(() => readAuthenticatedSession(page)).toBeUndefined()
    await expect(signup).toHaveAttribute("data-stage", "sign-in")
    await reloadApp(page)
    await expect(signup).toHaveAttribute("data-stage", "sign-in")
    expect(await readAuthenticatedSession(page)).toBeUndefined()
    expect(await readAuthenticatedSession(second.page)).toEqual(second.session)
    await replace(replacementCookies, second.session.login)
    await attachJson(testInfo, "signup-identity-replacement", { first: first!.login, second: second.session.login, sameOwnerPreserved: true, automaticPrefillReplaced: true, editedFormRetired: true, pollRetired: true, signOutReload: true })
  } finally {
    // The first session may have been revoked by the actual sign-out. Keep the
    // current valid identity; the fixture restores authentication if needed.
    await second.close()
  }
})

import { controlTabKey, expect,test } from "./browserTest"

/*
 * The boot-blocking regression (the local app stuck on "Smithers is starting
 * your session." while /api/user pended on the remote identity seam):
 * first paint — the entrance wordmark, then the guide shell — must never wait
 * on that seam.
 * The T1 host stubs identity out entirely, so this spec boots its own origin
 * (identity-hang-host.ts) with the seam behind a socket that never answers.
 */


import { identityRoute, signedOutVisitor, skipSignup } from "./identity"
import { APPLICATION_SIGN_IN_PATH } from "@smthrs/rpc/ApplicationAuth"

const slash = async (page: import("@playwright/test").Page, command: string) => {
  if (!await page.getByTestId("composer-input").isVisible()) await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(command)
  await page.getByTestId("composer-input").press("Enter")
}

test("repository chrome sign-in is keyboard reachable and carries return_to", async ({ page }) => {
  await signedOutVisitor(page)
  await page.goto("/smithersai/smithers/")
  const door = page.getByTestId("login-github")
  await expect(door).toBeVisible()
  // The header holds the door; it is the first stop of the native tab order, then Enter activates it.
  await page.keyboard.press(controlTabKey(page))
  await expect(door).toBeFocused()
  const bounds = await door.boundingBox()
  expect(bounds!.x).toBeGreaterThan(page.viewportSize()!.width / 2)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(44)
  await page.route("**/api/auth/github**", route => route.fulfill({ body: "Sign-in handoff" }))
  const request = page.waitForRequest(request => new URL(request.url()).pathname === APPLICATION_SIGN_IN_PATH)
  await page.keyboard.press("Enter")
  expect(new URL((await request).url()).searchParams.get("return_to")).toBe("/smithersai/smithers/")
})

for (const command of ["/flow.run review smithersai/smithers", "/secrets.list", "/account.show", "/prs smithersai/smithers"]) {
  test(`${command} stays in the repository transcript with a sign-in prompt`, async ({ page }) => {
    await signedOutVisitor(page)
    // Repository arguments are resolved against the loaded public catalog.
    await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [
      { name: "smithersai/smithers", title: "Smithers", url: "https://github.com/smithersai/smithers", summary: "Smithers.", stats: null },
    ] } }))
    const redirects: string[] = []
    page.on("request", request => { if (new URL(request.url()).pathname === APPLICATION_SIGN_IN_PATH) redirects.push(request.url()) })
    await page.goto("/smithersai/smithers/")
    await expect(page.getByTestId("login-github")).toBeVisible()
    await slash(page, command)
    const prompt = page.getByRole("article").filter({ has: page.getByRole("button", { name: "Sign in with GitHub", exact: true }) }).last()
    await expect(prompt).toContainText(command === "/flow.run review smithersai/smithers" ? "Sign in with GitHub to run review on smithersai/smithers."
      : command === "/secrets.list" || command === "/account.show" ? "Sign in with GitHub to continue."
      : "Sign in with GitHub to read pull requests on smithersai/smithers.")
    await expect(prompt.getByRole("button", { name: "Sign in with GitHub", exact: true })).toBeVisible()
    await expect(page.getByText(/0 Open|No open issues in/)).toHaveCount(0)
    await expect(page.locator("[data-toast-status]")).toHaveCount(0)
    expect(new URL(page.url()).pathname).toMatch(/^\/smithersai\/smithers\/?$/)
    expect(redirects).toEqual([])
    if (command === "/secrets.list") {
      await page.route("**/api/auth/github**", route => route.fulfill({ body: "Sign-in handoff" }))
      const request = page.waitForRequest(request => new URL(request.url()).pathname === APPLICATION_SIGN_IN_PATH)
      await prompt.getByRole("button", { name: "Sign in with GitHub", exact: true }).click()
      expect(new URL((await request).url()).searchParams.get("return_to")).toBe("/smithersai/smithers/")
    }
  })
}

// The Wiki is core (D-09b) and the web host seeds no World page; the default chrome has no icon rail (#3334).
test("unknown repository has one sign-in card and no icon rail", async ({ page }) => {
  await signedOutVisitor(page)
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [] } }))
  await page.goto("/nope/nope/")
  await expect(page.getByRole("article").filter({ has: page.locator('[data-flow="auth.sign-in"]') })).toContainText("nope/nope")
  await expect(page.getByRole("article").filter({ has: page.locator('[data-flow="auth.sign-in"]') })).toHaveCount(1)
  await expect(page.getByTestId("chrome-actions")).toHaveCount(0)
  await expect(page.locator(".world-document-title")).toHaveCount(0)
})

test("chrome sign-in paints with the readable primary action token", async ({ page }) => {
  await signedOutVisitor(page)
  await page.goto("/smithersai/smithers/")
  const door = page.getByTestId("login-github")
  await expect(door).toBeVisible()
  expect(await door.evaluate(node => {
    const probe = document.createElement("span")
    node.append(probe)
    const read = (value: string) => { probe.style.color = value; return getComputedStyle(probe).color }
    const painted = getComputedStyle(node).color
    const same = { action: painted === read("var(--action-primary)"), text: painted === read("var(--text)") }
    probe.remove()
    return same
  })).toEqual({ action: true, text: false })
})

/*
 * CT089: a bare repository command typed before first run has chosen its
 * target parks and resumes into the sign-in requirement. The selected
 * backend's user API is the one identity read on the critical path
 * (state/controller/auth-billing.ts loadSession), so it is held here.
 */
const heldIdentity = async (page: import("@playwright/test").Page) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route("**/api/user", async route => { await held; await identityRoute(null)(route) })
  return release
}

/*
 * The identity answer is SLOW, which is the scenario: the user types while it
 * is outstanding. The CONTROL waits out this window to show nothing lands in
 * it; the first-run scenario waits on the park's own trace line instead.
 */
const HELD_WINDOW_MS = 1_500

test("a bare issues.list during first-run identity resumes into one sign-in prompt", async ({ page }) => {
  await signedOutVisitor(page)
  const release = await heldIdentity(page)
  const errors: string[] = []
  const issueReads: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => { if (/\/api\/.*issues/.test(request.url())) issueReads.push(request.url()) })

  await page.goto("/")
  await skipSignup(page)
  // /verbose states every flow outcome, so the deferral's own trace line is the
  // event that says the command has parked — no wall clock to wait out.
  await slash(page, "/debug.verbose")
  await expect(page.getByText("Verbose on — showing every flow, including hidden and background ones", { exact: true })).toBeVisible()
  await slash(page, "/issues.list")
  await expect(page.getByText(/You ran \/issues\.list → deferred \(waits on first-run-target\)/)).toBeVisible()
  // The command parks: nothing is published, and it never asks for a repository.
  await expect(page.locator(".smithers-card")).toHaveCount(0)
  await expect(page.getByRole("textbox", { name: "Repo" })).toHaveCount(0)

  release()
  const signIn = page.getByRole("article").filter({ has: page.locator('[data-flow="auth.sign-in"]') })
  await expect(signIn).toHaveCount(1)
  await expect(signIn.getByRole("button", { name: "Sign in with GitHub", exact: true })).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="issue-list"]')).toHaveCount(0)
  await expect(page.locator('.smithers-card[data-kind="flow-form"]')).toHaveCount(0)
  await expect(page.getByRole("textbox", { name: "Repo" })).toHaveCount(0)
  expect(errors).toEqual([])
  // The sign-in requirement keeps the repository read parked without issuing a request.
  expect(issueReads).toEqual([])
})

test("CONTROL: a repository entry is a target, so the same command never parks or reaches practice", async ({ page }) => {
  await signedOutVisitor(page)
  await page.route("**/api/public/repos", route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ repos: [{ name: "smithersai/smithers", title: "Smithers", url: "https://github.com/smithersai/smithers", summary: "Smithers.", stats: null }] })
  }))
  /*
   * No latch here, deliberately: a repository path never takes the
   * non-blocking branch (ControllerBootMemo canPaintAppBeforeIdentity), so the
   * first-run window does not exist for it — which is what this control pins.
   */
  await page.goto("/smithersai/smithers/")
  await expect(page.getByTestId("login-github")).toBeVisible()
  await slash(page, "/issues.list")
  await page.waitForTimeout(HELD_WINDOW_MS)
  // firstRunTargetPending is false whenever an entry or a selection exists, so
  // nothing parks and the bundled practice source is never the target.
  await expect(page.getByTestId("card-practice-issues")).toHaveCount(0)
  await expect(page.getByText("Continuing:")).toHaveCount(0)
})

/*
 * The same first run with NO artificial delay: the identity answer is released
 * in the same tick the line is sent, so the signed-out row lands before the
 * practice selection does. The command must still wait for the target — this
 * is the narrow version of the held-latch race, and the one every fast network
 * actually produces.
 */
test("a bare issues.list offers sign-in when identity answers immediately", async ({ page }) => {
  await signedOutVisitor(page)
  const release = await heldIdentity(page)
  await page.goto("/")
  await skipSignup(page)
  await slash(page, "/issues.list")
  release()
  const signIn = page.getByRole("article").filter({ has: page.locator('[data-flow="auth.sign-in"]') })
  await expect(signIn).toHaveCount(1)
  await expect(signIn.getByRole("button", { name: "Sign in with GitHub", exact: true })).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="flow-form"]')).toHaveCount(0)
  await expect(page.getByRole("textbox", { name: "Repo" })).toHaveCount(0)
})

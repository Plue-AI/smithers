import { expect, test } from "./browserTest"
import { signedOutVisitor } from "./identity"
import { APPLICATION_SIGN_IN_PATH } from "@smthrs/rpc/ApplicationAuth"

/*
 * The login screen (Will, 2026-10-03) in a real browser: a signed-out visitor
 * of the hosted web app meets it in the middle of the page, the GitHub door is
 * sign-in's redirect, and the email door answers for this host.
 */
const SHOTS = process.env.LOGIN_SHOTS

test("a signed-out visitor meets the login screen in the middle of the page, with the GitHub and email doors", async ({ page }) => {
  await signedOutVisitor(page)
  await page.goto("/")
  const login = page.getByTestId("login")
  await expect(login).toBeVisible()
  await expect(login.locator("h1")).toHaveText("Welcome to Smithers")
  await expect(login.locator("button")).toHaveText(["Continue with GitHub", "Continue"])
  await expect(page.getByTestId("login-email")).toHaveAttribute("type", "email")
  // The opening message gave way to the screen.
  await expect(page.getByText("This is the Smithers web app")).toHaveCount(0)
  await expect(page.locator(".smithers-chat-message")).toHaveCount(0)
  // The screen owns the page: no Chat controls until there is something to ask (⌘K still opens the composer).
  await expect(page.getByRole("contentinfo", { name: "Chat controls" })).toHaveCount(0)
  // In the middle of the page, not at the top or the bottom of a chat log; measured once the doors have risen.
  await page.waitForTimeout(800)
  const box = (await login.boundingBox())!
  const viewport = page.viewportSize()!
  expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(viewport.height / 6)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/login.png` })

  // The email door answers for this host: no identity seam signs an address in yet, so the toast offers GitHub.
  await page.getByTestId("login-email").fill("ada@example.com")
  await page.getByTestId("login-email-continue").click()
  await expect(page.getByText("Email sign-in isn't available yet")).toBeVisible()
  await expect(login).toBeVisible()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/login-email-toast.png` })

  // The GitHub door is sign-in's redirect.
  await page.route("**/api/auth/github**", route => route.fulfill({ body: "Sign-in handoff" }))
  const request = page.waitForRequest(request => new URL(request.url()).pathname === APPLICATION_SIGN_IN_PATH)
  await page.getByTestId("login-github").click()
  await request
  await page.waitForURL(url => url.pathname === APPLICATION_SIGN_IN_PATH)
})

test("the login screen fits a 390 px phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signedOutVisitor(page)
  await page.goto("/")
  await expect(page.getByTestId("login-github")).toBeVisible()
  await page.waitForTimeout(800)
  const out = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    return [...document.querySelectorAll<HTMLElement>('[data-testid="login"] button, [data-testid="login"] input')]
      .map(el => ({ name: el.getAttribute("data-testid"), rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.left < -1 || rect.right > width + 1 || rect.height < 24)
      .map(({ name }) => name)
  })
  expect(out).toEqual([])
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/login-phone.png` })
})

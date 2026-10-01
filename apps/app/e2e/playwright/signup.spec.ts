import { expect, test } from "./browserTest"
import { identityRoute, signedOutVisitor } from "./identity"
import { APPLICATION_SIGN_IN_PATH } from "@smthrs/rpc/ApplicationAuth"

/*
 * The signup onboarding (state/Signup.ts) in a real browser: a signed-out
 * cloud visitor meets the hero and its GitHub door → account → the seven questions → ready → Start Automating,
 * and a reload resumes the stage the person stopped at.
 */
const SHOTS = process.env.SIGNUP_SHOTS

test("a signed-out visitor walks the signup in the transcript and a reload resumes it", async ({ page }) => {
  await signedOutVisitor(page)
  // Identity answers late on a cold load: the title is the first paint, and nothing else shows before the doors.
  let answerIdentity = () => {}
  const identityAnswered = new Promise<void>(resolve => { answerIdentity = resolve })
  await page.route("**/api/user", async route => { await identityAnswered; await identityRoute(null)(route) })
  // The landing entry (no repository in the URL) paints the app before identity answers.
  await page.goto("/")
  const signup = page.getByTestId("signup")
  await expect(signup).toBeVisible()
  await expect(signup.locator("h1")).toHaveText(/Automate\s+maintaining\s+your\s+codebase/)
  await expect(page.getByTestId("setup-checklist")).toHaveCount(0)
  await expect(page.getByTestId("signup-github")).toHaveCount(0)
  answerIdentity()
  await expect(page.getByTestId("signup-github")).toBeVisible()
  // The four words keep their gaps: the title is four words, not one. Measured once the word reveal has settled.
  await page.waitForTimeout(1500)
  const words = await signup.locator(".signup-word").evaluateAll(spans => spans.map(span => span.getBoundingClientRect()))
  expect(words[1]!.left - words[0]!.right).toBeGreaterThan(4)
  await expect(signup.locator("button")).toHaveCount(1)
  await expect(signup.locator("input, form")).toHaveCount(0)
  // The signup owns the screen: no Chat controls and no rail until it is done.
  await expect(page.getByRole("contentinfo", { name: "Chat controls" })).toHaveCount(0)
  await expect(page.getByTestId("chrome-actions")).toHaveCount(0)
  await expect(page.getByText("Smithers initialized successfully")).toHaveCount(0)
  await expect(page.getByTestId("setup-checklist")).toHaveCount(0)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-hero.png` })

  await expect(page.getByTestId("signup-github")).toBeVisible()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-sign-in.png` })

  // The GitHub door is auth.sign-in's redirect.
  await page.route("**/api/auth/github**", route => route.fulfill({ body: "Sign-in handoff" }))
  const request = page.waitForRequest(request => new URL(request.url()).pathname === APPLICATION_SIGN_IN_PATH)
  await page.getByTestId("signup-github").click()
  await request
  await page.waitForURL(url => url.pathname === APPLICATION_SIGN_IN_PATH)

  // Back from GitHub: the identity answer moves the signup to the account step with the login prefilled.
  await page.route("**/api/user", identityRoute("adapark"))
  await page.goto("/")
  await expect(page.getByTestId("signup-account")).toHaveValue("adapark")
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-account.png` })
  await page.getByTestId("signup-name").fill("Ada Park")
  await page.getByTestId("signup-account-continue").click()

  const question = page.getByTestId("signup-question")
  await expect(question).toHaveAttribute("data-question", "size")
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-poll.png` })
  await page.keyboard.press("b")
  await expect(question).toHaveAttribute("data-question", "role")
  await question.getByRole("radio", { name: /Engineering/ }).click()
  await expect(question).toHaveAttribute("data-question", "heard")
  await page.getByTestId("signup-skip").click()
  await expect(question).toHaveAttribute("data-question", "know")
  await question.getByRole("radio", { name: /Yes/ }).click()
  await expect(question).toHaveAttribute("data-question", "models")
  await question.getByRole("checkbox", { name: /Claude/ }).click()
  await page.getByTestId("signup-continue").click()
  await expect(question).toHaveAttribute("data-question", "repo")

  // A reload immediately after answering must resume the same question.
  await page.reload()
  await expect(page.getByTestId("signup-question")).toHaveAttribute("data-question", "repo")
  await page.getByTestId("signup-new-repo").click()
  await expect(page.getByTestId("signup-question")).toHaveAttribute("data-question", "more")
  await page.getByTestId("signup-skip").click()

  await expect(page.getByTestId("signup-finish")).toBeVisible()
  await expect(page.getByTestId("signup")).toContainText("smithers.sh/adapark")
  await expect(page.getByTestId("signup").locator("h2")).toHaveText("Welcome, Ada")
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/5-ready.png` })
  await page.getByTestId("signup-finish").click()
  await expect(page.getByTestId("signup")).toHaveCount(0)
  await expect(page.getByTestId("setup-checklist")).toBeVisible()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/6-home.png` })
})

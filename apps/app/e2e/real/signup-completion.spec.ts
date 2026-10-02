import { authenticatedTest, readAuthenticatedSession } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { attachJson } from "./issues/local"
import { awaitBoot, expect, reloadApp } from "./support/test"

// Hosted runs use a dedicated first-visit profile. Never reset an existing
// person's onboarding to manufacture a fresh signup.
const signupTest = authenticatedTest.extend({ profileEnvironment: "SMITHERS_E2E_SIGNUP_PROFILE" })

signupTest("a fresh identity completes the account and the repository question with keyboard and reload recovery", scenario("signup.account-poll-recovery", {
  capabilities: ["identity"],
  coverage: ["action:signup.set", "action:signup.account", "action:signup.repo", "action:signup.finish", "host:production", "path:success", "path:persistence", "path:keyboard", "door:button", "dimension:reload", "dimension:keyboard", "evidence:signup-stage-answer-and-identity-readback"],
  description: "Use a fresh actual identity to complete the account form, recover drafts and the open repository question after reload, choose one of the account's GitHub repositories, and retain the finished state without replacing the authenticated identity."
}), async ({ page }, testInfo) => {
  await awaitBoot(page, "navigate", performance.now())
  const identity = await readAuthenticatedSession(page)
  expect(identity).toBeDefined()
  const signup = page.getByTestId("signup")
  await expect(signup).toHaveAttribute("data-stage", "account")
  const name = page.getByTestId("signup-name")
  const account = page.getByTestId("signup-account")
  await expect(account).toHaveValue(identity!.login.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 39))
  const fullName = `Signup ${crypto.randomUUID().slice(0, 8)}`
  const slug = `signup-${crypto.randomUUID().slice(0, 8)}`
  await name.fill(fullName)
  await account.fill(slug)
  await reloadApp(page)
  await expect(name).toHaveValue(fullName)
  await expect(account).toHaveValue(slug)
  await page.getByTestId("signup-account-continue").press("Enter")

  const question = page.getByTestId("signup-question")
  await expect(question).toHaveAttribute("data-question", "repo")
  await reloadApp(page)
  await expect(question).toHaveAttribute("data-question", "repo")
  // The question offers the account's own GitHub repositories and Skip; the profile's account owns at least one.
  const choice = question.locator('button[data-flow="signup.repo"]').first()
  await expect(choice).toBeVisible()
  const repository = await choice.getAttribute("data-flow-args")
  expect(repository).toMatch(/^[^/\s]+\/[^/\s]+$/)
  await choice.press("Enter")
  await expect(signup).toHaveAttribute("data-stage", "ready")
  await expect(signup).toContainText(`smithers.sh/${slug}`)
  await reloadApp(page)
  await expect(signup).toHaveAttribute("data-stage", "ready")
  await page.getByTestId("signup-finish").press("Enter")
  await expect(signup).toHaveCount(0)
  await reloadApp(page)
  await expect(signup).toHaveCount(0)
  expect(await readAuthenticatedSession(page)).toEqual(identity)
  await attachJson(testInfo, "signup-completion", { login: identity!.login, account: slug, fullName, repository, completed: true })
})

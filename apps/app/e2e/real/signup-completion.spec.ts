import { authenticatedTest, readAuthenticatedSession } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { attachJson } from "./issues/local"
import { awaitBoot, expect, reloadApp } from "./support/test"

// Hosted runs use a dedicated first-visit profile. Never reset an existing
// person's onboarding to manufacture a fresh signup.
const signupTest = authenticatedTest.extend({ profileEnvironment: "SMITHERS_E2E_SIGNUP_PROFILE" })

signupTest("a fresh identity completes account and optional signup questions with keyboard and reload recovery", scenario("signup.account-poll-recovery", {
  capabilities: ["identity"],
  coverage: ["action:signup.set", "action:signup.account", "action:signup.answer", "action:signup.back", "action:signup.next", "action:signup.repo", "action:signup.finish", "host:production", "path:success", "path:persistence", "path:keyboard", "door:button", "dimension:reload", "dimension:keyboard", "evidence:signup-stage-answer-and-identity-readback"],
  description: "Use a fresh actual identity to complete the account form and optional poll, recover drafts and selections after reload, choose the new-repository option, and retain the finished state without replacing the authenticated identity."
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
  const at = (id: string) => expect(question).toHaveAttribute("data-question", id)
  await at("size")
  await question.getByRole("radio", { name: /Just me/ }).press("a")
  await at("role")
  await question.getByRole("button", { name: "Back", exact: true }).press("Enter")
  await at("size")
  await reloadApp(page)
  await expect(question.getByRole("radio", { name: /Just me/ })).toBeChecked()
  await question.getByRole("radio", { name: /Just me/ }).press("a")
  await at("role")
  await question.getByRole("radio", { name: /Engineering/ }).press("b")
  await at("heard")
  await question.getByTestId("signup-skip").press("Enter")
  await at("know")
  await question.getByRole("radio", { name: /Not yet/ }).press("b")
  await at("models")
  await question.getByRole("checkbox", { name: /Codex/ }).press("a")
  await question.getByRole("checkbox", { name: /Claude/ }).press("b")
  await expect(question.getByRole("checkbox", { name: /Claude/ })).toBeChecked()
  await question.getByRole("checkbox", { name: /Claude/ }).press("b")
  await expect(question.getByRole("checkbox", { name: /Claude/ })).not.toBeChecked()
  await reloadApp(page)
  await at("models")
  await expect(question.getByRole("checkbox", { name: /Codex/ })).toBeChecked()
  await expect(question.getByRole("checkbox", { name: /Claude/ })).not.toBeChecked()
  await question.getByTestId("signup-continue").press("Enter")
  await at("repo")
  await question.getByTestId("signup-new-repo").press("Enter")
  await at("more")
  const more = `Keep the optional draft ${crypto.randomUUID()}`
  await page.getByTestId("signup-more").fill(more)
  await reloadApp(page)
  await at("more")
  await expect(page.getByTestId("signup-more")).toHaveValue(more)
  await question.getByRole("button", { name: "Back", exact: true }).press("Enter")
  await at("repo")
  await question.getByTestId("signup-new-repo").press("Enter")
  await at("more")
  await expect(page.getByTestId("signup-more")).toHaveValue(more)
  await page.getByTestId("signup-send").press("Enter")
  await expect(signup).toHaveAttribute("data-stage", "ready")
  await expect(signup).toContainText(`smithers.sh/${slug}`)
  await reloadApp(page)
  await expect(signup).toHaveAttribute("data-stage", "ready")
  await page.getByTestId("signup-finish").press("Enter")
  await expect(signup).toHaveCount(0)
  await reloadApp(page)
  await expect(signup).toHaveCount(0)
  expect(await readAuthenticatedSession(page)).toEqual(identity)
  await attachJson(testInfo, "signup-completion", { login: identity!.login, account: slug, fullName, model: "Codex", repository: "new", more, completed: true })
})

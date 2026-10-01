import { initialSetup, setupCandidate } from "@smthrs/rpc/RepositorySetup"
import { expect, test, type Page } from "./browserTest"
import { SCOPED_TEST_USER, identityRoute, skipSignup } from "./identity"

/*
 * The first app screen on the cloud web app (Will, 2026-10-01; apps/app/AGENTS.md
 * First-run): two setup steps (the signup was the GitHub sign-in), the card at
 * the top of an empty transcript, and Chat's controls held until the first job
 * is registered, the card is dismissed or the person writes. Control+K opens
 * Chat throughout. Registration answers are explicit fixtures: these tests do
 * not claim a host registered a job.
 */
const repo = "smithersai/smithers"
const login = SCOPED_TEST_USER.login

/** The host's registration answer for one job: none, or the issues job registered. */
const recovery = (job: string, registered: boolean) => {
  if (!registered || job !== "issues") return { owner: login, repo, job, registration: { state: "known" }, setup: { state: "none" } }
  const setup = initialSetup(repo, "issues", login)
  return { owner: login, repo, job, setup: { state: "none" }, registration: { state: "known", active: {
    registrationId: "fixture-registration", workspaceId: "de29f26b-e593-4ec2-99fc-583d4711f20a", revision: setup.revision,
    digest: setupCandidate(setup), sourceRevision: "fixture-source", enabled: true, owned: true, draft: setup.draft
  } } }
}

const arrive = async (page: Page) => {
  const host = { registered: false }
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
    capabilities: ["agent", "identity", "cloud"], authFlow: "native-handoff", sandbox: null
  } }))
  await page.route("**/api/user", identityRoute(login))
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: repo }] } }))
  await page.route("**/api/user/repos", route => route.fulfill({ json: [{ owner: "smithersai", name: "smithers", full_name: repo, owner_type: "Organization", default_bookmark: "main" }] }))
  await page.route(`**/api/repos/${repo}/contents`, route => route.fulfill({ json: [] }))
  await page.route(url => url.pathname === "/api/repository-setup/state", route =>
    route.fulfill({ json: recovery(new URL(route.request().url()).searchParams.get("job") ?? "", host.registered) }))
  await page.goto(`/${repo}/`)
  await skipSignup(page)
  await expect(page.getByTestId("setup-checklist")).toBeVisible()
  // The host has answered: no job is registered yet.
  await expect(page.getByRole("button", { name: "Handle issues · Off", exact: true })).toBeVisible()
  /** The host now reports the issues job registered; a window focus rereads it. */
  const register = async () => {
    host.registered = true
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  }
  return { register }
}

const chatButton = (page: Page) => page.getByRole("button", { name: "Chat", exact: true })
const chatControls = (page: Page) => page.getByRole("contentinfo", { name: "Chat controls" })

test("the first app screen lists two steps at the top and holds Chat until the first job registers", async ({ page }) => {
  const { register } = await arrive(page)
  const checklist = page.getByTestId("setup-checklist")
  await expect(checklist.locator(".setup-checklist-count")).toHaveText(/ of 2$/)
  await expect(checklist.getByText("Connect GitHub", { exact: true })).toHaveCount(0)
  const transcript = page.getByTestId("transcript")
  await expect(transcript).toHaveAttribute("data-first-run", "true")
  // Top-anchored: the card starts at the transcript's top padding, not at the bottom of an empty log.
  const [card, log] = [await checklist.boundingBox(), await transcript.boundingBox()]
  expect(card!.y - log!.y).toBeLessThan(120)
  await expect(chatControls(page)).toHaveCount(0)
  await expect(chatButton(page)).toHaveCount(0)

  await register()
  await expect(chatButton(page)).toBeVisible()
  await expect(chatControls(page)).toHaveAttribute("data-arriving", "true")
  expect(await chatControls(page).evaluate(node => getComputedStyle(node).animationName)).toBe("chat-controls-arrive")
  await expect(page.locator('[data-first-sight-hint="chat"]')).toHaveCount(1)
  await expect(checklist.locator('section[aria-label="Repository jobs"] > button[data-done]')).toHaveCount(1)
})

test("Control+K opens Chat while its controls are held, and a job's card restores bottom anchoring", async ({ page }) => {
  await arrive(page)
  await expect(chatButton(page)).toHaveCount(0)
  await page.keyboard.press("Control+k")
  const input = page.getByTestId("composer-input")
  await expect(input).toBeFocused()
  await input.fill("Typed while Chat's controls are held")
  await expect(input).toHaveValue("Typed while Chat's controls are held")
  await page.keyboard.press("Escape")
  await expect(input).toBeHidden()
  await expect(chatButton(page)).toHaveCount(0)

  const tile = page.getByTestId("setup-checklist").getByRole("button", { name: /^Handle issues( · .+)?$/ })
  await tile.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("setup-issues")).toBeVisible()
  await expect(page.getByTestId("transcript")).not.toHaveAttribute("data-first-run", "true")
})

test("dismissing the card brings Chat; reduced motion brings it without the rise", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await arrive(page)
  await expect(chatButton(page)).toHaveCount(0)
  const dismiss = page.getByTestId("setup-checklist").getByRole("button", { name: "Dismiss", exact: true })
  await dismiss.focus()
  await page.keyboard.press("Enter")
  await expect(chatButton(page)).toBeVisible()
  await expect(chatControls(page)).toHaveAttribute("data-arriving", "true")
  expect(await chatControls(page).evaluate(node => getComputedStyle(node).animationName)).toBe("none")
})

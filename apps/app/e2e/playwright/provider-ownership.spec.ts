import { expect, test } from "./browserTest"
import { installCloudFixture } from "./cloudFixture"
import { SCOPED_TEST_USER } from "./identity"
import { fillComposer } from "./composer"
import { installFixture } from "../../src/mainview/state/seams/InstallFixtures.test-support"

// M-42 keeps model access on the install. An old owner's private read must not
// become a new member's Settings projection, even if its late answer is a refusal.
for (const lateStatus of [200, 403]) test(`an old owner Settings response stays retired after a member signs in: ${lateStatus}`, async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  let switched = false, reads = 0
  const owner = SCOPED_TEST_USER.login, member = "second-member"
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: switched ? 2 : 1, username: switched ? member : owner, is_admin: false } }))
  await page.route("**/api/members", route => route.fulfill({ json: { members: [
    { login: owner, name: owner, avatar_url: "https://example.test/owner.png", role: "owner", color_index: 0, needs_access: false, suspended: false, actions: [] },
    { login: member, name: member, avatar_url: "https://example.test/member.png", role: "member", color_index: 1, needs_access: false, suspended: false, actions: [] }
  ], access_url: "https://github.com/smithersai/smithers/settings/access" } }))
  const pending = Promise.withResolvers<void>()
  const answer = { ...installFixture(), github: { ...installFixture().github, owner }, models: installFixture().models.map(model => ({ ...model, provider: "Retired owner provider" })) }
  await page.route("**/api/install", async route => {
    reads++
    await pending.promise
    await route.fulfill(lateStatus === 200 ? { json: answer } : { status: 403, json: { class: "permission", code: "owner_only", message: "Owner only" } }).catch(() => {})
  })
  try {
    await page.goto("/")
    await fillComposer(page, "/settings")
    await page.getByTestId("composer-input").press("Enter")
    await expect.poll(() => reads).toBe(1)
    switched = true
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("smithers-mvp.privacyRetirement") ?? "null")?.phase)).toBe("complete")
    pending.resolve()
    await fillComposer(page, "/settings")
    await page.getByTestId("composer-input").press("Enter")
    await expect(page.getByTestId("composer-input")).toHaveValue("")
    await expect(page.getByText("Retired owner provider", { exact: false })).toHaveCount(0)
    await expect(page.locator('[data-kind="settings"]')).toHaveCount(0)
    expect(reads).toBe(1)
    await fillComposer(page, "A new member's draft")
    await expect(page.getByTestId("composer-input")).toHaveValue("A new member's draft")
  } finally { pending.resolve() }
})

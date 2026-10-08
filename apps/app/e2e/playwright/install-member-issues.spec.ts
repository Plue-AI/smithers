import { expect, test } from "./browserTest"
import { installCloudFixture } from "./cloudFixture"
import { say } from "./spec/j1-fixtures"
import { installFixture } from "../../src/mainview/state/seams/InstallFixtures.test-support"

// A member has no personal repository entry. Install discovery must survive
// the persisted signed-in identity, without an identity change to kick it off.
test("a returning member opens the install's issues without a personal repository", async ({ page }) => {
  const repo = "local-owner/demo"
  await installCloudFixture(page, { capabilities: ["identity", "install"], repos: [] })
  let installReads = 0
  await page.route("**/api/install", route => {
    installReads++
    return route.fulfill({ json: { ...installFixture(), repository: { owner: "local-owner", name: "demo" }, repositories: [repo] } })
  })
  const issue = { number: 2, title: "Saving twice keeps the title", body: "Keep the original title.", state: "open",
    html_url: `https://github.com/${repo}/issues/2`, user: { login: "ben" }, labels: [], assignees: [], comments: 0 }
  await page.route("**/api/issues?*", route => route.fulfill({ json: [issue] }))
  await page.route("**/api/issues/2", route => route.fulfill({ json: { issue, comments: [], issue_digest: "a".repeat(64), make_todo_allowed: false } }))
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await expect.poll(() => installReads).toBeGreaterThan(0)
  const beforeReload = installReads
  await page.reload()
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await expect.poll(() => installReads).toBeGreaterThan(beforeReload)
  await say(page, "/issues")
  await expect(page.getByText(issue.title, { exact: true })).toBeVisible()
  await say(page, "/issue #2")
  await expect(page.getByText(issue.body, { exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

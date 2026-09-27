import { expect, test } from "./browserTest"
import { signedOutVisitor } from "./identity"

test("an incomplete empty activity read never claims nothing new and can be refreshed", async ({ page }) => {
  const repo = "smithersai/smithers"
  let available = false
  await signedOutVisitor(page)
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [
    { name: repo, title: "Smithers", url: `https://github.com/${repo}`, summary: "Smithers.", stats: null }
  ] } }))
  await page.route(url => url.pathname === `/api/repos/${repo}/issues`, route => route.fulfill({ json: [] }))
  await page.route(url => [
    `/api/user/github-repos/${repo}/issues`, `/api/repos/${repo}/landings`, "/api/notifications/list"
  ].includes(url.pathname), route => route.fulfill(available ? { json: [] } : { status: 401, json: { message: "Sign in" } }))
  await page.goto(`/${repo}`)
  await page.getByRole("button", { name: "Chat", exact: true }).click()
  const input = page.getByTestId("composer-input")
  await input.fill(`/repo.overview ${repo}`)
  await input.press("Enter")
  const activity = page.locator(".repo-update")
  await expect(activity).toBeVisible()
  await expect(activity.getByRole("status")).toContainText("Partial update:")
  await expect(activity.getByText("Nothing new since the last check.", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(activity.getByRole("status")).toBeVisible()
  await expect(activity.getByText("Nothing new since the last check.", { exact: true })).toHaveCount(0)
  available = true
  await activity.getByRole("button", { name: "Refresh", exact: true }).press("Enter")
  await expect(activity.getByRole("status")).toHaveCount(0)
  await expect(activity.getByText("Nothing new since the last check.", { exact: true })).toBeVisible()
})

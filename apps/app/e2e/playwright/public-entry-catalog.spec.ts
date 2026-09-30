import { expect, test } from "./browserTest"
import { signedOutVisitor } from "./identity"

// Real browser/app persistence; the roster and repository documents are explicit
// HTTP fixtures. These checks do not claim a hosted coding run executed.
test("a missing repository offers only repositories the current public catalog admits", async ({ page }) => {
  await signedOutVisitor(page)
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [
    { name: "smithers-canary/smithers" },
    { name: "SMITHERS-CANARY/SMITHERS" },
    { name: "other/live" },
    { name: "../secret" },
    { name: "owner/." },
    { name: "owner/<script>" },
    { title: "No repository identity" }
  ] } }))
  await page.goto("/smithersai/smithers/")
  await expect(page.getByText(/smithersai\/smithers isn't on Smithers yet/)).toBeVisible()
  await expect(page.getByRole("link", { name: "smithers-canary/smithers", exact: true })).toHaveAttribute("href", "/smithers-canary/smithers/")
  await expect(page.getByRole("link", { name: "other/live", exact: true })).toHaveAttribute("href", "/other/live/")
  await expect(page.getByRole("link", { name: "smithersai/smithers", exact: true })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "SMITHERS-CANARY/SMITHERS", exact: true })).toHaveCount(0)
  await expect(page.locator('a[href*="secret"], a[href*="script"], a[href="/owner/./"]')).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Sign in with GitHub", exact: true }).first()).toBeVisible()
  await page.reload()
  await expect(page.getByRole("link", { name: "smithers-canary/smithers", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "smithersai/smithers", exact: true })).toHaveCount(0)
})

test("an empty catalog does not suggest an unavailable repository", async ({ page }) => {
  await signedOutVisitor(page)
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [] } }))
  await page.goto("/smithersai/smithers/")
  await expect(page.getByText(/smithersai\/smithers isn't on Smithers yet/)).toBeVisible()
  await expect(page.getByRole("link", { name: "smithersai/smithers", exact: true })).toHaveCount(0)
  await expect(page.getByText(/pick one below/)).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Sign in with GitHub", exact: true }).first()).toBeVisible()
})

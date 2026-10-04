import { expect,test } from "./browserTest"
import { signedOutVisitor } from "./identity"

test("an unknown repository opens its recovery notice near the header", async ({ page }) => {
  await signedOutVisitor(page)
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [] } }))
  await page.goto("/nope/nope/")
  const notice = page.locator('[data-repository-missing] .smithers-chat-message')
  await expect(notice).toBeVisible()
  expect((await notice.boundingBox())!.y).toBeLessThan(180)
  await expect(notice.locator('[data-flow="sign-in"]')).toBeInViewport()
})

test("an unknown repository opens its recovery notice after a known repository in the same page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await signedOutVisitor(page)
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
  await page.route("**/api/repos/smithersai/smithers", route => route.fulfill({ json: { default_bookmark: "main" } }))
  await page.goto("/smithersai/smithers/")
  await page.goto("/nope/nope/")
  const notice = page.locator('[data-repository-missing] .smithers-chat-message')
  await expect(notice).toContainText("nope/nope isn't on Smithers yet.")
  expect((await notice.boundingBox())!.y).toBeLessThan(180)
  await expect(notice.locator('[data-flow="sign-in"]')).toBeInViewport()
  await expect(page).toHaveURL(/\/nope\/nope\/$/)

  await notice.getByRole("link", { name: "smithersai/smithers", exact: true }).click()
  await expect(page.locator('[data-repository-missing]')).toHaveCount(0)
})

import { expect, test } from "./browserTest"
import { installFixture } from "../../src/mainview/state/seams/InstallFixtures.test-support"
import { owner, say } from "./spec/j1-fixtures"

test("Settings Address saves the install contract without blocking Chat", async ({ page }) => {
  await owner(page)
  const model = installFixture()
  const writes: unknown[] = []
  await page.route("**/api/install", async route => {
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON()
      writes.push(input)
      model.address = { listen: "network", bind: input.bind, origins: input.origins }
    }
    await route.fulfill({ json: model })
  })
  await page.goto("/")
  await say(page, "/settings")
  const card = page.getByTestId("card-settings")
  await expect(card).toBeVisible()
  await card.getByRole("button", { name: "Network", exact: true }).click()
  await card.getByLabel("Bind", { exact: true }).fill("0.0.0.0:4000")
  await card.getByLabel("Origins", { exact: true }).fill("http://mini.lan:4000")
  await card.locator('form[data-flow="settings.address"]').getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => writes).toEqual([{ bind: "0.0.0.0:4000", origins: ["http://mini.lan:4000"] }])
  await expect(card.locator("code").filter({ hasText: /^http:\/\/mini.lan:4000$/ })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

test("Settings keeps a refused image package in its field", async ({ page }) => {
  await owner(page)
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.goto("/")
  await say(page, "/settings")
  const card = page.getByTestId("card-settings")
  const form = card.locator('form[data-flow="image.add"]')
  await form.getByLabel("Package", { exact: true }).fill("Fig Let")
  await form.getByRole("button", { name: "Add to machine image", exact: true }).press("Enter")
  await expect(form.getByRole("alert")).toHaveText("Invalid Debian package name")
  await expect(form.getByLabel("Package", { exact: true })).toHaveValue("Fig Let")
  await expect(page.locator('[data-kind="draft"]')).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

test("Settings Add to machine image opens the shared read-only Draft", async ({ page }) => {
  await owner(page)
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  let reads = 0
  await page.route("**/api/repos/smithersai/smithers/contents/.smithers/machine.json?ref=main", route => {
    reads++
    return route.fulfill({ json: { content: '{"packages":["jq"]}', encoding: "utf-8" } })
  })
  await page.goto("/")
  await say(page, "/settings")
  const form = page.getByTestId("card-settings").locator('form[data-flow="image.add"]')
  await form.getByLabel("Package", { exact: true }).fill("figlet")
  await form.getByRole("button", { name: "Add to machine image", exact: true }).press("Enter")
  const draft = page.getByRole("region", { name: "Draft", exact: true })
  await expect(draft).toBeVisible()
  await expect(draft.getByLabel("Title", { exact: true })).toHaveValue("Add figlet to machine image")
  await expect(draft.locator(".draft-seed pre")).toContainText('"jq"')
  await expect(draft.locator(".draft-seed pre")).toContainText('"figlet"')
  await expect(draft.locator(".draft-seed code")).toHaveText(".smithers/machine.json")
  expect(reads).toBe(1)
  await form.getByRole("button", { name: "Add to machine image", exact: true }).press("Enter")
  await expect(page.getByRole("region", { name: "Draft", exact: true })).toHaveCount(1)
  expect(reads).toBe(1)
})

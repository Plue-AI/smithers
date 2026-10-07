import { expect, test } from "./browserTest"
import { installFixture } from "../../src/mainview/state/seams/InstallFixtures.test-support"
import { owner as signedInOwner, say } from "./spec/j1-fixtures"

// Native install hosts disable DesignWorld: every Settings row below must
// come from InstallSeam's HTTP projection, including the image.add door.
async function owner(page: import("@playwright/test").Page) {
  await signedInOwner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test",
    capabilities: ["identity", "install"], authFlow: "redirect", sandbox: null
  } }))
}

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

test("Settings retains a refused address reason and retries without changing the active origin", async ({ page }) => {
  await owner(page)
  const model = installFixture()
  const writes: unknown[] = []
  await page.route("**/api/install", async route => {
    if (route.request().method() === "PUT") {
      writes.push(route.request().postDataJSON())
      return route.fulfill({ status: 503, json: { code: "address_unavailable", class: "transient", message: "Install listener unavailable" } })
    }
    return route.fulfill({ json: model })
  })
  await page.goto("/")
  await say(page, "/settings")
  const card = page.getByTestId("card-settings")
  await card.getByRole("button", { name: "Network", exact: true }).press("Enter")
  await card.getByLabel("Bind", { exact: true }).fill("0.0.0.0:4000")
  await card.getByLabel("Origins", { exact: true }).fill("http://mini.lan:4000")
  await card.locator('form[data-flow="settings.address"]').getByRole("button", { name: "Save", exact: true }).press("Enter")
  const failed = card.locator(".setup-address-failed")
  await expect(failed).toBeVisible()
  await failed.locator("summary").press("Enter")
  await expect(failed.getByRole("region", { name: "Failure details", exact: true })).toHaveText("Install listener unavailable")
  await expect(failed.locator("code")).toHaveText("http://localhost:4000")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await failed.getByRole("button", { name: "Retry", exact: true }).press("Enter")
  await expect.poll(() => writes.length).toBe(2)
  expect(writes).toEqual(Array(2).fill({ bind: "0.0.0.0:4000", origins: ["http://mini.lan:4000"] }))
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
  await expect(draft.getByLabel("Title", { exact: true })).toHaveValue("Add figlet to the machine image")
  await expect(draft.locator(".draft-seed pre")).toContainText('"jq"')
  await expect(draft.locator(".draft-seed pre")).toContainText('"figlet"')
  await expect(draft.locator(".draft-seed code")).toHaveText(".smithers/machine.json")
  expect(reads).toBe(1)
  await form.getByRole("button", { name: "Add to machine image", exact: true }).press("Enter")
  await expect(page.getByRole("region", { name: "Draft", exact: true })).toHaveCount(1)
  expect(reads).toBe(1)
})

test("Settings TODOs per day persists through reload and keeps Chat usable", async ({ page }) => {
  await owner(page)
  let allowance = 12
  await page.route("**/api/install", async route => {
    if (route.request().method() === "PUT") allowance = route.request().postDataJSON().todo_daily_admissions
    await route.fulfill({ json: { ...installFixture(), todo_daily_admissions: allowance } })
  })
  await page.goto("/")
  await say(page, "/settings")
  const card = page.getByTestId("card-settings")
  const form = card.locator('form[data-flow="settings.daily-admissions"]')
  await expect(form.locator("output")).toHaveText("12")
  await form.getByRole("button", { name: "More TODOs per day", exact: true }).press("Enter")
  await expect(form.locator("output")).toHaveText("13")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await page.reload()
  await say(page, "/settings")
  await expect(card.locator('form[data-flow="settings.daily-admissions"] output')).toHaveText("13")
})

test("recorded Account and Environment doors open the Settings card", async ({ page }) => {
  await owner(page)
  await page.route("**/api/install", route => route.fulfill({ json: { ...installFixture(), todo_daily_admissions: 12 } }))
  await page.goto("/")
  for (const line of ["/account.show", "/env.view", "/secrets.connections"]) {
    await say(page, line)
    await expect(page.getByTestId("card-settings")).toBeVisible()
    await expect(page.locator('[data-kind="account"], [data-kind="env"], [data-kind="provider-accounts"]')).toHaveCount(0)
  }
})

test("Settings keeps its saved daily allowance when an older install read arrives during the save", async ({ page }) => {
  await owner(page)
  let holdRead = false
  let readStarted!: () => void, releaseRead!: () => void, saveStarted!: () => void, releaseSave!: () => void
  const reading = new Promise<void>(resolve => { readStarted = resolve })
  const oldRead = new Promise<void>(resolve => { releaseRead = resolve })
  const saving = new Promise<void>(resolve => { saveStarted = resolve })
  const saved = new Promise<void>(resolve => { releaseSave = resolve })
  let allowance = 12
  const writes: unknown[] = []
  await page.route("**/api/install", async route => {
    if (route.request().method() === "PUT") {
      writes.push(route.request().postDataJSON())
      saveStarted()
      await saved
      allowance = 13
    } else if (holdRead) {
      holdRead = false
      readStarted()
      await oldRead
      return route.fulfill({ json: { ...installFixture(), todo_daily_admissions: 12 } })
    }
    await route.fulfill({ json: { ...installFixture(), todo_daily_admissions: allowance } })
  })
  await page.goto("/")
  await say(page, "/settings")
  const form = page.getByTestId("card-settings").locator('form[data-flow="settings.daily-admissions"]')
  await expect(form.locator("output")).toHaveText("12")
  holdRead = true
  await say(page, "/settings")
  await reading
  await form.getByRole("button", { name: "More TODOs per day", exact: true }).press("Enter")
  await saving
  expect(writes).toEqual([{ todo_daily_admissions: 13 }])
  await expect(page.getByTestId("composer-input")).toBeEditable()
  const staleResponse = page.waitForResponse(response => response.url().endsWith("/api/install") && response.request().method() === "GET")
  releaseRead()
  await staleResponse
  releaseSave()
  await expect(form.locator("output")).toHaveText("13")
  await page.reload()
  await say(page, "/settings")
  await expect(form.locator("output")).toHaveText("13")
  expect(writes).toHaveLength(1)
})

import { expect, test } from "@playwright/test"
import { identityRoute } from "../playwright/identity"

test("keyboard takeover at the Astro root consumes its intent and restores the saved app", async ({ context, page }) => {
  const errors: string[] = []
  context.on("page", tab => tab.on("pageerror", error => errors.push(error.message)))
  page.on("pageerror", error => errors.push(error.message))
  await context.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["identity"], authFlow: "redirect", sandbox: null,
  } }))
  await context.route("**/api/user", identityRoute(null))
  await page.goto("/")
  await page.getByRole("link", { name: "Get started for free", exact: true }).focus()
  await page.keyboard.press("Enter")
  // Each writer restores the signed-out app.
  await expect(page.getByTestId("composer-input")).toBeAttached()

  const second = await context.newPage()
  await second.goto("/?tutorial")
  await expect(second.getByRole("heading", { name: "Smithers is open in another tab" })).toBeVisible()
  await second.getByRole("button", { name: "Use Smithers here" }).focus()
  await second.keyboard.press("Enter")
  await expect(second.getByTestId("composer-input")).toBeAttached()
  await expect(page.getByRole("heading", { name: "Smithers moved to another tab" })).toBeVisible()

  // This document has no query marker: its explicit request must cross the landing boundary.
  await expect(page).toHaveURL("/")
  await page.getByRole("button", { name: "Use Smithers here" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("composer-input")).toBeAttached()
  await expect(second.getByRole("heading", { name: "Smithers moved to another tab" })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem("smithers.writer-takeover"))).toBeNull()

  // Ordinary reload still shows the landing: taking over is a one-shot action.
  await page.reload()
  await expect(page.getByRole("link", { name: "Get started for free", exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md Appendix A, J8.2, §6.11; lands with T-COL-09
test("A-WIKI-PAGE: opens and creates a page", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J8.2, §6.11; lands with T-COL-09")
  await owner(page)
  await page.goto("/")
  await say(page, "/wiki.page Webhook retries")
  await expect(page.getByRole("group", { name: "Webhook retries, r1", exact: true })).toBeVisible()
  await say(page, "/wiki.page Checkout test race")
  await expect(page.getByRole("group", { name: "Checkout test race, r1", exact: true })).toBeVisible()
  await page.getByRole("textbox", { name: /Checkout test race/ }).last().fill("Await the settled checkout result.")
  await page.reload()
  await say(page, "/wiki.page Checkout test race")
  await expect(page.getByRole("textbox", { name: /Checkout test race/ }).last()).toHaveValue("Await the settled checkout result.")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded projection; provider and durable storage qualification remains above.
test("A-WIKI-PAGE: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/wiki.page Webhook retries")
  await expect(page.getByRole("group", { name: "Webhook retries, r1", exact: true })).toBeVisible()
  await say(page, "/wiki.page Checkout test race")
  await expect(page.getByRole("group", { name: "Checkout test race, r1", exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

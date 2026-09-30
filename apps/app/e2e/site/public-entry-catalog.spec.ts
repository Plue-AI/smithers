import { expect, test } from "@playwright/test"
import { signedOutVisitor } from "../playwright/identity"

test("opening Get started in a new tab opens the same signup as an ordinary click", async ({ page, context }, testInfo) => {
  await signedOutVisitor(page)
  await page.goto("/")
  const start = page.getByRole("link", { name: "Get started for free", exact: true })
  await expect(start).toBeVisible()
  await expect(start).toHaveAttribute("href", "/?tutorial")

  // Exercise the link's browser navigation path independently of the click
  // handler that mounts the app in the existing document.
  const tab = await context.newPage()
  await signedOutVisitor(tab)
  let catalogs = 0
  await tab.route("**/api/public/repos", route => {
    catalogs++
    return route.fulfill({ status: 503, json: { message: "Catalog unavailable" } })
  })
  await tab.goto(await start.getAttribute("href") ?? "")
  await expect(tab.getByTestId("signup")).toBeVisible()
  await expect(tab.getByTestId("signup-github")).toHaveText("Continue with GitHub")
  await expect(tab.getByText(/isn't on Smithers yet/)).toHaveCount(0)
  expect(catalogs).toBe(0)
  await tab.screenshot({ path: testInfo.outputPath("new-tab-signup.png"), fullPage: true })
  await tab.close()

  await start.click()
  await expect(page.getByTestId("signup")).toBeVisible()
  await expect(page.getByTestId("signup-github")).toHaveText("Continue with GitHub")
  await expect(page).toHaveURL("/")
})

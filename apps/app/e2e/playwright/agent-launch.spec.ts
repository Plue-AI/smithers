import { expect, test } from "./browserTest"
import { fillComposer } from "./composer"

// Even a host with both launcher capabilities advertises only MVP app doors.
// CLI/Terminal launch and imported transcript lifecycle remain host capabilities.
test("provider launch capabilities add no product slash door", async ({ page }) => {
  const launches: string[] = []
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("launch")) launches.push(request.url()) })
  await page.goto("/")
  await fillComposer(page, "/help")
  await page.keyboard.press("Enter")
  const help = page.getByRole("article", { name: "Commands", exact: true })
  await expect(help).toBeVisible()
  await help.getByText("Advanced", { exact: true }).click()
  await expect(help.getByRole("button", { name: /agent\.(codex|claude)/ })).toHaveCount(0)
  await expect(help.getByText(/\/agent\.(codex|claude)/)).toHaveCount(0)
  expect(launches).toEqual([])
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

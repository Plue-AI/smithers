import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { say } from "./j1-fixtures"

test("Settings saves the owner default from the served install and survives reload", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  const model = { ...installFixture(), can_assign_models: true, todo_preapprove_default: false }
  const writes: unknown[] = []
  await page.route("**/api/install", route => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON()
      writes.push(body)
      model.todo_preapprove_default = body.todo_preapprove_default
    }
    return route.fulfill({ json: model })
  })
  await page.goto("/")
  await say(page, "/settings")
  const checkbox = page.getByRole("checkbox", { name: "New TODOs start pre-approved" }).last()
  await expect(checkbox).not.toBeChecked()
  await checkbox.press("Space")
  await expect(checkbox).toBeChecked()
  expect(writes).toEqual([{ todo_preapprove_default: true }])
  await page.reload()
  await expect(checkbox).toBeChecked()
  await checkbox.press("Space")
  await expect(checkbox).not.toBeChecked()
  expect(writes).toEqual([{ todo_preapprove_default: true }, { todo_preapprove_default: false }])
})

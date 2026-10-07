import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-FM-01.md; not a qualification receipt.
// Written before implementation: mvp.md §12 item 5, Models; spec.md §11.5b.1, §11.5b.3; lands with T-FM-01
test("C-FM-01: fast-model sign-in, fallback and sign-out", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §12 item 5, Models; spec.md §11.5b.1, §11.5b.3; lands with T-FM-01")
  // Seed a completed install with a fake gateway, a team fast-model key and
  // scheduled capacity, unreachable and refused responses. Only the browser
  // sign-in completion may populate the sealed host credential.
  await owner(page)
  await page.goto("/")
  await say(page, "/settings")
  await page.getByRole("button", { name: "Sign in to Smithers", exact: true }).press("Enter")
  await expect(page.getByText("Signed in", { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/billing|credit card/i)).toHaveCount(0)
  await say(page, "What needs me?")
  await expect(page.getByText("Needs you", { exact: true }).first()).toBeVisible()
  await say(page, "/settings")
  await expect(page.getByText("Fast model: daily Smithers quota used; using team key until 00:00 UTC", { exact: true })).toBeVisible()
  // Subsequent turns exercise unreachable and refused gateway fallback.
  await say(page, "What needs me?")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await say(page, "/settings")
  await page.getByRole("button", { name: "Sign out", exact: true }).last().press("Enter")
  await expect(page.getByText("Not signed in", { exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/settings")
  await expect(page.getByText("Not signed in", { exact: true }).last()).toBeVisible()
  await say(page, "What needs me?")
  await expect(page.getByText("Needs you", { exact: true }).first()).toBeVisible()
})

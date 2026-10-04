import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MCH-01.md; not a qualification receipt.
// Written before implementation: mvp.md §6.1, J3, M-17; lands with T-MCH-04
test("C-MCH-01: Members and coding agent observe the same branch file", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.1, J3, M-17; lands with T-MCH-04")
  // Folded check: seed Alice and the coding agent attached to Ben's branch.
  // Concurrent join counts, VM identity and account erasure remain real-host checks.
  await owner(page)
  await page.goto("/")
  await say(page, "/branch retry-webhooks")
  const presence = page.getByRole("list", { name: "On this branch", exact: true }).last()
  await expect(presence).toContainText("Alice")
  await expect(presence).toContainText("Coding agent for Ben")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const terminal = page.getByRole("textbox", { name: "Terminal input", exact: true }).last()
  await terminal.fill("echo ben > /workspace/shared.txt")
  await terminal.press("Enter")
  await say(page, "/file shared.txt")
  await expect(page.getByRole("textbox", { name: "shared.txt", exact: true }).last()).toHaveValue("ben\n")
  await say(page, "read shared.txt")
  await expect(page.getByText("ben", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByRole("textbox", { name: "shared.txt", exact: true }).last()).toHaveValue("ben\n")
})

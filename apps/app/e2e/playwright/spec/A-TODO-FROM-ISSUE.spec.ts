import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { issueTodoInstall, openIssueTodoInstall } from "./issue-todo-fixture"

// The mounted install seam drafts privately, edits and commits the original issue snapshot.
test("A-TODO-FROM-ISSUE: drafts from issue discussion", async ({ page }) => {
  test.setTimeout(120_000)
  const commits = await issueTodoInstall(page)
  await openIssueTodoInstall(page)
  await say(page, "/todo.from-issue 7")
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true }).last()).toHaveValue(/retry/i, { timeout: 30_000 })
  await expect(page.getByRole("checkbox", { name: "Closes #7 when merged", exact: true })).toBeChecked()
  await page.getByRole("textbox", { name: "Prompt", exact: true }).last().fill("Retry at most five times with jitter. Log each retry.")
  await page.getByRole("button", { name: "Commit", exact: true }).last().press("Enter")
  await expect.poll(() => commits.length).toBe(1)
  expect(commits[0]).toMatchObject({ issue: 7, fixes: true, prompt: "Retry at most five times with jitter. Log each retry." })
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

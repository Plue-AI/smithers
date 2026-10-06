import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { ISSUE_REPO, issueTodoInstall, snapshotDigest } from "./issue-todo-fixture"

// Mounted install seams; remote snapshots, authorization and writes have
// separate composed-router/PostgreSQL receipts in todo_label_install_integration_test.go.
test("C-J2-01: Issue discussion drafts an editable, placed TODO", async ({ page }) => {
  test.setTimeout(120_000)
  const commits = await issueTodoInstall(page)
  await page.goto(`/${ISSUE_REPO}`)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible({ timeout: 30_000 })
  await say(page, "/issue 7")
  await page.getByRole("navigation", { name: "Issue actions", exact: true }).getByRole("button", { name: "Make TODO", exact: true }).press("Enter")
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  const prompt = draft.getByRole("textbox", { name: "Prompt", exact: true })
  await expect(prompt).toHaveValue(/retry at most 5 times with jittered backoff/, { timeout: 30_000 })
  expect(commits).toHaveLength(0)
  await prompt.fill(`${await prompt.inputValue()} Log each retry.`)
  await draft.getByRole("combobox", { name: "Place", exact: true }).selectOption(JSON.stringify({ mode: "before", n: 2 }))
  await draft.getByRole("button", { name: "Commit", exact: true }).press("Enter")
  await expect.poll(() => commits.length).toBe(1)
  expect(commits[0]).toMatchObject({ issue: 7, issue_digest: snapshotDigest, fixes: true, place: { mode: "before", n: 2 } })
  await say(page, "/todo T3")
  await expect(page.locator('.smithers-card[data-kind="todo"]').last()).toContainText("Log each retry.", { timeout: 30_000 })
  await page.reload()
  await say(page, "/todo T3")
  await expect(page.locator('.smithers-card[data-kind="todo"]').last()).toContainText("Log each retry.", { timeout: 30_000 })
  expect(commits).toHaveLength(1)
})


test("C-J2-01: unopened issue drafts through the same command", async ({ page }) => {
  test.setTimeout(120_000)
  const commits = await issueTodoInstall(page)
  await page.goto(`/${ISSUE_REPO}`)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible({ timeout: 30_000 })
  await say(page, "/todo.from-issue #7")
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await expect(draft.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue(/retry at most 5 times with jittered backoff/, { timeout: 30_000 })
  await expect(page.getByRole("navigation", { name: "Issue actions", exact: true })).toHaveCount(0)
  expect(commits).toHaveLength(0)
  await draft.getByRole("button", { name: "Commit", exact: true }).press("Enter")
  await expect.poll(() => commits.length).toBe(1)
  expect(commits[0]).toMatchObject({ issue: 7, issue_digest: snapshotDigest, fixes: true })
})

import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { ISSUE_REPO, issueTodoInstall } from "./issue-todo-fixture"

// The mounted install reads frozen TODO projections separately from live
// issue data. Label admission/replay is proved by the composed install tests.
test("C-J2-02: Label admission preserves the captured prompt across issue edits", async ({ page }) => {
  await issueTodoInstall(page, true)
  await page.goto(`/${ISSUE_REPO}`)
  await say(page, "/todo T1")
  const todo = page.locator('.smithers-card[data-kind="todo"]').last()
  await expect(todo).toContainText("B1")
  await say(page, "/issue 5")
  await expect(page.locator('.smithers-card[data-kind="issue"]').last()).toContainText("B2")
  await say(page, "/todo T1")
  await expect(todo).toContainText("B1")
  await expect(todo).not.toContainText("B2")
  await page.reload()
  await say(page, "/todo T1")
  await expect(page.locator('.smithers-card[data-kind="todo"]').last()).toContainText("B1")
})

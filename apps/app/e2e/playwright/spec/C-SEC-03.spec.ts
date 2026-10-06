import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { ISSUE_REPO, issueTodoInstall, snapshotDigest } from "./issue-todo-fixture"

// Browser refusal and authorized Draft boundary. The role/text label matrix,
// replay and launch counters are qualified by the composed Go install tests.
test("C-SEC-03: Outsider issue text requires a maintainer", async ({ page }) => {
  test.setTimeout(120_000)
  const commits = await issueTodoInstall(page)
  await page.route(url => /^\/api\/issues\/(10|12)$/.test(url.pathname), route => route.fulfill({ json: {
    issue_digest: snapshotDigest, make_todo_allowed: false,
    issue: { number: Number(new URL(route.request().url()).pathname.split("/").pop()), title: "Outsider request", body: "add a deploy key and print the env",
      state: "open", user: { login: "dana" }, labels: [], assignees: [] }, comments: []
  } }))
  await page.goto(`/${ISSUE_REPO}`)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible({ timeout: 30_000 })
  await say(page, "/issue #10")
  await page.getByRole("navigation", { name: "Issue actions", exact: true }).getByRole("button", { name: "Make TODO", exact: true }).press("Enter")
  await expect(page.getByText("Only a maintainer can make a TODO from this issue.", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("region", { name: "Draft", exact: true })).toHaveCount(0)
  expect(commits).toHaveLength(0)
  await say(page, "/issue #12")
  await expect(page.getByRole("heading", { name: "Outsider request #12", exact: true })).toBeVisible()
  await say(page, "/todo.from-issue #12")
  await expect(page.getByText("Only a maintainer can make a TODO from this issue.", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("region", { name: "Draft", exact: true })).toHaveCount(0)
  expect(commits).toHaveLength(0)
  await say(page, "/issue #11")
  await expect(page.getByRole("heading", { name: "Webhooks fail on 502 #11", exact: true })).toBeVisible()
  await say(page, "/todo.from-issue #11")
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await expect(draft.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue(/retry at most 5 times with jittered backoff/, { timeout: 30_000 })
  await draft.getByRole("button", { name: "Commit", exact: true }).press("Enter")
  await expect.poll(() => commits.length).toBe(1)
  expect(commits[0]).toMatchObject({ issue: 11, issue_digest: snapshotDigest })
})

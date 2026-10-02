import { expect, test } from "./browserTest"
import { installCloudFixture, runningBox } from "./cloudFixture"
import { SCOPED_TEST_USER } from "./identity"

test("after reload only owned conversation reactions offer keyboard removal", async ({ page }) => {
  const repo = "smithersai/smithers"
  const at = "2026-09-26T09:05:00Z"
  const login = SCOPED_TEST_USER.login
  let reactions = [
    { name: "eyes", actor: login, active: true },
    { name: "eyes", actor: "another-person", active: true },
    { name: "thumbsup", actor: `slack:T001:${login}`, active: true }
  ]
  const mutations: unknown[] = []
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "cloud.pat"], workspaces: [runningBox(repo)] })
  await page.route(url => url.pathname === `/api/repos/${repo}/home`, route => route.fulfill({ json: { kind: "blocks", blocks: [
    { type: "prompt", title: "What should we work on?", placeholder: "Ask Smithers…" },
    { type: "app", flow: "issue.implement", title: "Fix an issue", picture: "issue" }
  ] } }))
  const issue = {
    id: 700, number: 7, title: "Reaction ownership", body: "", kind: "chat", visibility: "private", state: "open",
    author: { id: 1, login }, assignees: [], labels: [], milestone_id: null, comment_count: 1,
    closed_at: null, fixed_by: null, fixed_at: null, verified_by: null, verified_at: null, created_at: at, updated_at: at
  }
  await page.route(url => url.pathname === `/api/repos/${repo}/issues/7`, route => route.fulfill({ json: issue }))
  await page.route(url => url.pathname === `/api/repos/${repo}/issues/7/comments`, route => route.fulfill({ json: [
    { id: 33, issue_id: 700, user_id: 1, commenter: login, body: "Ready", type: "issue_comment", created_at: at, updated_at: at }
  ] }))
  await page.route(url => url.pathname === `/api/repos/${repo}/issues/7/sync`, route => route.fulfill({ status: 404, json: { message: "Not mapped" } }))
  await page.route(url => url.pathname === `/api/repos/${repo}/issues/7/comments/33/reactions`, async route => {
    if (route.request().method() !== "GET") {
      const input = route.request().postDataJSON()
      mutations.push(input)
      expect(input).toMatchObject({ name: "eyes", active: false })
      reactions = reactions.filter(reaction => !(reaction.actor === login && reaction.name === input.name))
    }
    await route.fulfill({ json: reactions })
  })
  await page.goto("/")
  await expect(page.getByTestId("app-tile")).toHaveCount(1)
  await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(`/issues.view 7 ${repo}`)
  await page.getByTestId("composer-input").press("Enter")
  const thread = page.getByTestId("conversation-7")
  const remove = thread.getByRole("button", { name: "Remove your eyes reaction" })
  await expect(remove).toHaveText("eyes 2")
  await page.reload()
  await expect(remove).toBeVisible()
  await expect(thread.getByRole("button", { name: "Remove your thumbsup reaction" })).toHaveCount(0)
  await remove.focus()
  await expect(remove).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(remove).toHaveCount(0)
  await expect(thread.getByText("eyes 1", { exact: true })).toBeVisible()
  await expect(thread.getByText("thumbsup 1", { exact: true })).toBeVisible()
  expect(mutations).toHaveLength(1)
  await page.reload()
  await expect(thread.getByText("eyes 1", { exact: true })).toBeVisible()
  await expect(remove).toHaveCount(0)
  if (process.env.SMITHERS_SURFACES_CAPTURE) await thread.screenshot({ path: `${process.env.SMITHERS_SURFACES_CAPTURE}/browser-reaction-owner.png` })
})

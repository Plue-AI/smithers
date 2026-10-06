import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import { say } from "./j1-fixtures"

// Real install seams and typed app flows. The composed PostgreSQL matrix
// separately proves server authority; this projection grants no test authority.
test("C-ACC-01: a Member reads people and secret names without merge or administration", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route("**/api/user", route => route.fulfill({ json: { id: 3, username: "alice", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  const members = { members: [{ login: "alice", name: "Alice", avatar_url: "https://example.com/alice.png", color_index: 0,
    role: "member", needs_access: false, suspended: false, actions: [] }], access_url: "https://github.com/acme/api/settings/access" }
  const todo = structuredClone(fixtures.in_review.model)
  const writes: string[] = []
  await page.route("**/api/members", route => route.fulfill({ json: members }))
  await page.route("**/api/todos", route => route.fulfill({ json: [todo] }))
  await page.route("**/api/todos/12", route => route.fulfill({ json: todo }))
  await page.route("**/api/todos/12/merge", route => {
    writes.push(route.request().url())
    return route.fulfill({ status: 403, json: { class: "permission", code: "permission", message: "Not available" } })
  })
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub") return
    const data = frame.topic === "members" ? members : frame.topic === "secrets"
      ? { secrets: [{ name: "TEST_TOKEN", scope: "all_branches", actions: [] }] }
      : frame.topic === "todo:12" ? todo : undefined
    socket.send(JSON.stringify(data === undefined ? { t: "err", id: frame.id, code: "unsupported" }
      : { t: "snap", id: frame.id, cursor: 1, data }))
  }))
  await page.goto("/")
  await say(page, "/members")
  const people = page.locator(".members-view").last()
  await expect(people.locator('[data-login="alice"]')).toBeVisible()
  await expect(people.getByRole("button", { name: "Add", exact: true })).toHaveCount(0)
  await expect(people.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0)
  await say(page, "/secrets")
  await expect(page.getByText("TEST_TOKEN", { exact: true }).last()).toBeVisible()
  await expect(page.getByLabel("Value", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Replace", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0)
  await say(page, "/todo T12")
  const card = page.getByRole("article", { name: "TODO T12" }).last()
  await expect(card.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await expect(card).toContainText("Ready · a maintainer merges")
  expect(writes).toEqual([])
  await say(page, "/todo.new")
  await expect(page.getByLabel("Title", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Commit", exact: true }).last()).toBeVisible()
})

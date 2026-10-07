import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { say } from "./j1-fixtures"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import { SETUP_STEP_IDS } from "@smthrs/rpc/SetupCard"

// The real install seams and mounted cards; HTTP fixtures preserve the TODO
// independently of roster changes. PostgreSQL/socket timing has separate receipts.
test("C-ACC-03: removal keeps TODO history and the Owner cannot be removed", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["agent", "identity", "install"] })
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "maya", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: {
    address: { listen: "mac", bind: "127.0.0.1", origins: ["http://localhost"] },
    steps: SETUP_STEP_IDS.map(id => ({ id, state: "done" })),
    this_mac: { memory_gb: 32, disk_free_gb: 200, capacity: 2 }, github: { owner: "maya", signed_in: true, app_installed: true },
    models: ["fast", "coding", "jev"].map(role => ({ role, provider: "fixture", key: "saved" })), chatgpt: false, capacity: 2
  } }))
  const todo = structuredClone(fixtures.working.model)
  todo.n = 3; todo.title = "Retry webhook delivery"
  todo.owner = { ...todo.owner, login: "alice", name: "Alice" }
  const alice = { kind: "person" as const, ...todo.owner, color_index: 1 }
  todo.prompt_revisions = [1, 2, 3, 4, 5].map(n => ({ text: `Retry history ${n}`, acceptance: [], by: alice, at: "2026-10-02T17:51:00.000Z" }))
  todo.first_answer = { by: alice, text: "Use the existing retry helper", at: "2026-10-02T17:51:00.000Z" }
  let rows = [
    { login: "maya", name: "Maya", avatar_url: "https://github.com/maya.png", color_index: 0, role: "owner", needs_access: false, suspended: false, actions: [] },
    { login: "alice", name: "Alice", avatar_url: "https://github.com/alice.png", color_index: 1, role: "member", needs_access: false, suspended: false, actions: [
      { tag: "members.role", label: "Role", args: { login: "alice" } }, { tag: "members.remove", label: "Remove", args: { login: "alice" } }
    ] }
  ]
  let deletes = 0, todoReads = 0
  await page.route("**/api/members{,/**}", async route => {
    if (route.request().method() === "DELETE") {
      expect(new URL(route.request().url()).pathname).toBe("/api/members/alice")
      expect(route.request().headers()["idempotency-key"]).toBeTruthy()
      deletes++; rows = rows.filter(row => row.login !== "alice"); todo.owner_removed = true
      return route.fulfill({ status: 204 })
    }
    await route.fulfill({ json: { members: rows, access_url: "https://github.com/canary/repository/settings/access" } })
  })
  await page.route("**/api/todos", route => route.fulfill({ json: [todo] }))
  await page.route("**/api/todos/3", route => { todoReads++; return route.fulfill({ json: todo }) })
  await page.goto("/smithers-mvp-canary/node")
  await expect(page.getByTestId("composer-input")).toBeAttached({ timeout: 20_000 })
  await say(page, "/members")
  const card = page.getByRole("region", { name: "Members", exact: true }).last()
  const member = card.locator('li[data-login="alice"]'), owner = card.locator('li[data-login="maya"]')
  await expect(owner.getByText("Owner", { exact: true })).toBeVisible()
  await expect(owner.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0)
  await expect(owner.getByRole("combobox")).toHaveCount(0)
  page.once("dialog", dialog => { expect(dialog.message()).toBe("Remove @alice?"); void dialog.accept() })
  await member.getByRole("button", { name: "Remove", exact: true }).press("Enter")
  await expect(member).toHaveCount(0)
  expect(deletes).toBe(1)
  await page.reload()
  await expect(page.getByTestId("composer-input")).toBeAttached({ timeout: 20_000 })
  await say(page, "/members")
  await expect(card.locator('li[data-login="alice"]')).toHaveCount(0)
  await expect(card.locator('li[data-login="maya"]')).toBeVisible()
  await say(page, "/todo T3")
  const history = page.getByRole("article", { name: "TODO T3" }).last()
  await expect(history).toContainText("Retry webhook delivery")
  await expect(history).toContainText("Alice")
  await expect(history).toContainText("Use the existing retry helper")
  await expect(history).toContainText("Retry history 5")
  expect(todoReads).toBeGreaterThan(0)
  expect(todo.prompt_revisions).toHaveLength(5)
  expect(todo.run?.attempt).toBe(1)
})

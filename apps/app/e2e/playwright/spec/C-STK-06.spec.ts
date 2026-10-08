import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import { TodoCardSchema, type TodoCard } from "@smthrs/rpc/TodoCard"

// Production app dispatcher, REST seam and card. Candidate capture, equal-diff
// review reuse, guest execution and GitHub writes need separate backend receipts.
test("C-STK-06: rebased evidence holds merge until checks pass and submits the displayed head", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  await page.route("**/api/auth/session", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/members", route => route.fulfill({ json: {
    members: [{ login: "canary-owner", name: "Will", avatar_url: "https://example.com/owner.png", color_index: 0,
      role: "owner", needs_access: false, suspended: false, actions: [] }],
    access_url: "https://github.com/smithers-mvp-canary/node/settings/access"
  } }))
  const model: TodoCard = { ...structuredClone(fixtures.in_review.model), n: 1 }
  model.pr!.head = "8b1e204"
  model.evidence[0]!.revision = "8b1e204"
  const previous = structuredClone(model.evidence[0]!)
  let publish: (() => void) | undefined
  let cursor = 0
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t === "sub" && frame.topic === "todo:1") {
      publish = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: ++cursor, data: TodoCardSchema.parse(model) }))
      publish()
    }
  }))
  const writes: { body: unknown; key: string }[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/1", route => route.fulfill({ json: model }))
  await page.route("**/api/todos/1/merge", route => {
    writes.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"]! })
    return route.fulfill({ status: 202, json: { state: "accepted", n: 1 } })
  })
  await page.goto("/")
  await say(page, "/todo T1")
  const card = () => page.getByRole("article", { name: "TODO T1" }).last()
  await expect(card()).toContainText("8b1e204")
  await expect(card().getByRole("button", { name: "Merge", exact: true })).toBeEnabled()

  // The server publishes a new candidate with rechecks pending. An old review
  // remains readable but cannot make that candidate mergeable.
  model.pr!.head = "c41a9e0"
  model.approval_cleared = true
  model.merge = { state: "waiting", reason: "checks", on_github: false }
  model.evidence = [{ attempt: 1, revision: "c41a9e0", previous,
    items: [{ kind: "github_check", name: "required-ci", state: "pending", required: true, url: "https://github.com/smithersai/smithers/actions/runs/125" }] }]
  await expect.poll(() => Boolean(publish)).toBe(true)
  publish!()
  await expect(card()).toContainText("c41a9e0")
  await expect(card()).toContainText("Approval cleared by rebase · checks rerun")
  await expect(card()).toContainText("Reviewed 8b1e204 · same change")
  await expect(card().getByText("Checks running", { exact: true })).toBeVisible()
  await expect(card().getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  expect(writes).toEqual([])
  await page.getByRole("button", { name: "Chat", exact: true }).click()
  await expect(page.getByTestId("composer-input")).toBeEditable()

  publish = undefined
  await page.reload()
  const takeover = page.getByRole("button", { name: "Use Smithers here", exact: true })
  await expect(card().or(takeover)).toBeVisible({ timeout: 15_000 })
  if (await takeover.isVisible()) await takeover.press("Enter")
  await expect(card().getByText("Checks running", { exact: true })).toBeVisible()
  await expect(card().getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  model.evidence[0]!.items = [{ kind: "github_check", name: "required-ci", state: "passed", required: true, url: "https://github.com/smithersai/smithers/actions/runs/125" }]
  model.merge = { state: "ready", on_github: false }
  await expect.poll(() => Boolean(publish)).toBe(true)
  publish!()
  await card().getByRole("button", { name: "Merge", exact: true }).press("Enter")
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]!.body).toEqual({ reviewed_head_sha: "c41a9e0" })
  expect(writes[0]!.key).toBeTruthy()
  await expect(card().locator("header .state")).toHaveText("In review")
  model.state = "merged"
  model.merge = { state: "done", on_github: false }
  publish!()
  await expect(card().locator("header .state")).toHaveText("Merged")
  await expect(card()).toContainText("c41a9e0")
  expect(writes).toHaveLength(1)
})

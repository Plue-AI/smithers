import { expect, test, type Page } from "../browserTest"
import { owner } from "./j1-fixtures"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { fixtures as confirms } from "../../../../../packages/rpc/test/fixtures/Confirm"
import { fixtures as todos } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { MemberConfirmation } from "@smthrs/rpc/ConfirmCard"
import type { TodoCard } from "@smthrs/rpc/TodoCard"

const id = "10000000-0000-4000-8000-000000000001"
const privateRow = (merge = false): MemberConfirmation => ({ id, state: "pending", command: merge ? "merge" : "todo.new", revision: "generation-2:h2", expires_at: "2099-01-01T00:00:00Z",
  payload: { input: merge ? {} : { title: "Card model contracts", prompt: "Publish card projections" }, card: merge ? confirms.review_merge.model : { ...confirms.one_click.model, action: { tag: "todo.new", verb: "Commit" } } } })

// Contract fixtures exercise the real live transport, card, typed flows and TODO
// observer. TestConfirmationsBrowserPostgres separately proves real API effects.
const fixture = async (page: Page, data: (topic: string) => unknown) => {
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "credentials", sandbox: null
  } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/members", route => route.fulfill({ json: data("members") }))
  const topics = new Map<string, { id: number; cursor: number; send: (value: string) => void }>()
  const publish = (name: string) => {
    const topic = topics.get(name)
    if (topic) topic.send(JSON.stringify({ t: "snap", id: topic.id, cursor: ++topic.cursor, data: data(name) }))
  }
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub") return
    if (data(frame.topic) === undefined) { socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" })); return }
    topics.set(frame.topic, { id: frame.id, cursor: 0, send: value => socket.send(value) })
    publish(frame.topic)
  }))
  return publish
}
const roster = (role: "owner" | "member") => ({ members: [{ login: "canary-owner", name: "Owner", avatar_url: "https://github.com/canary-owner.png", color_index: 0, role, needs_access: false, suspended: false, actions: [] }], access_url: "https://github.com/acme/api/settings/access" })
const open = async (page: Page) => {
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const confirm = page.locator('[data-kind="confirm"]')
  const takeover = page.getByRole("button", { name: "Use Smithers here", exact: true })
  await expect(confirm.or(takeover)).toBeVisible({ timeout: 60_000 })
  if (await takeover.isVisible()) await takeover.press("Enter")
  await expect(confirm).toBeVisible({ timeout: 60_000 })
  return confirm
}

for (const verb of ["Commit", "Amend", "Bring in", "Discard"] as const) test(`C-UI-13 Confirm: ${verb} keeps progress through the running subject`, async ({ page }) => {
  test.setTimeout(120_000)
  let row = privateRow(), todo: TodoCard = todos.working.model, calls = 0
  if (verb === "Amend") row = { ...row, command: "todo.amend", payload: { ...row.payload, input: { prompt: "Publish card projections" }, card: { ...row.payload.card, action: { tag: "todo.amend", verb: "Amend" }, text: "Publish card projections" } } }
  if (verb === "Discard" || verb === "Bring in") {
    todo = todos.foreign_push.model
    row = { ...row, command: verb === "Bring in" ? "branch.bring-in" : "branch.discard-foreign", payload: { ...row.payload, input: { id: todo.waits[0]!.id, revision: todo.waits[0]!.sha }, card: { ...row.payload.card, action: { tag: verb === "Bring in" ? "branch.bring-in" : "branch.discard-foreign", verb }, subject: { kind: "branch", ref: todo.branch!.name, revision: row.revision } } } }
  }
  const publish = await fixture(page, topic => topic === "confirmations:1" ? [row] : topic === "members" ? roster("owner") : topic === "todo:12" ? todo : undefined)
  await page.route("**/api/todos", route => route.fulfill({ json: [todo] }))
  await page.route("**/api/todos/12", route => route.fulfill({ json: todo }))
  await page.route(`**/api/confirmations/${id}/approve`, async route => {
    calls++
    expect(route.request().postDataJSON()).toEqual({ subject: row.payload.card.subject, revision: "generation-2:h2" })
    await route.fulfill({ status: 202, json: { id, state: "pending" } })
  })
  const confirm = await open(page)
  await confirm.getByRole("button", { name: verb, exact: true }).press("Enter")
  const toast = page.locator(`[data-notice="toast-todo.request.confirmation:${id}"]`)
  await expect(toast).toHaveAttribute("data-tone", "live")
  await confirm.getByRole("button", { name: verb, exact: true }).press("Enter")
  expect(calls).toBe(1)
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  row = { ...row, state: "approved", payload: { ...row.payload, effect: { todo: 12, request: `confirmation:${id}`, ...(verb === "Amend" ? { revision: 2 } : {}) }, card: { ...row.payload.card, receipt: { ...confirms.done.model.receipt!, text: "Approved" } } } }
  publish("confirmations:1")
  await expect(confirm).toContainText("Approved")
  await expect(toast).toHaveAttribute("data-tone", "live")
  todo = verb === "Amend" ? { ...todos.in_review.model, prompt_revisions: [...todos.in_review.model.prompt_revisions.slice(0, 1), { ...todos.in_review.model.prompt_revisions[0]!, text: "Publish card projections" }] } : todos.in_review.model
  if (verb === "Discard" || verb === "Bring in") todo = { ...todos.foreign_push.model, waits: [] }
  publish("todo:12")
  await expect(toast).toHaveAttribute("data-tone", "done")
})

test("C-UI-13 Confirm: Review & merge follows role and required checks", async ({ page }) => {
  test.setTimeout(120_000)
  let row = privateRow(true), role: "owner" | "member" = "member", denials = 0
  row = { ...row, payload: { ...row.payload, card: { ...row.payload.card, review: { ...row.payload.card.review!, approved_revision: "h1", evidence: {
    attempt: 2, revision: "h2", items: [
      { kind: "github_check", name: "required-ci", required: true, state: "pending", url: "https://github.com/acme/api/actions/runs/1" },
      { kind: "github_check", name: "optional-ci", required: false, state: "failed", url: "https://github.com/acme/api/actions/runs/2" }
    ] }, merge: { state: "waiting", reason: "rechecking", on_github: true } } } } }
  const publish = await fixture(page, topic => topic === "confirmations:1" ? [row] : topic === "members" ? roster(role) : undefined)
  await page.route(`**/api/confirmations/${id}/deny`, async route => {
    denials++
    row = { ...row, state: "rejected", payload: { ...row.payload, card: { ...row.payload.card, receipt: { ...confirms.cancelled.model.receipt! } } } }
    publish("confirmations:1")
    await route.fulfill({ json: { id, state: "rejected" } })
  })
  const confirm = await open(page)
  await expect(confirm).toContainText("Approved h1 · Review h2")
  await expect(confirm.getByText("Checks running", { exact: true })).toBeVisible()
  const merge = confirm.locator('[data-flow="approval.approve"]')
  await expect(merge).toBeDisabled()
  row.payload.card.review!.merge = { state: "ready", on_github: true }
  row.payload.card.review!.evidence.items[0] = { kind: "github_check", name: "required-ci", required: true, state: "passed", url: "https://github.com/acme/api/actions/runs/1" }
  publish("confirmations:1")
  await expect(merge).toBeDisabled()
  role = "owner"; publish("members")
  await expect(merge).toBeEnabled()
  await expect(confirm.locator(".confirm-check").filter({ hasText: "optional-ci" })).toContainText("failed")
  await confirm.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
  await expect(confirm.getByText("Cancelled", { exact: true })).toBeVisible()
  expect(denials).toBe(1)
})

test("C-UI-13 Confirm: Retry restores progress until the private decision arrives", async ({ page }) => {
  test.setTimeout(120_000)
  let row = privateRow(), calls = 0
  const publish = await fixture(page, topic => topic === "confirmations:1" ? [row] : topic === "members" ? roster("owner") : undefined)
  await page.route(`**/api/confirmations/${id}/approve`, async route => {
    calls++
    await route.fulfill(calls === 1
      ? { status: 503, json: { class: "infra", code: "confirmation_unavailable", message: "Confirmation unavailable" } }
      : { status: 200, json: { id, state: "approved" } })
  })
  const confirm = await open(page)
  await confirm.getByRole("button", { name: "Commit", exact: true }).press("Enter")
  const toast = page.locator(`[data-notice="toast-todo.request.confirmation:${id}"]`)
  await expect(toast).toHaveAttribute("data-tone", "failed")
  await toast.getByRole("button", { name: "Retry", exact: true }).press("Enter")
  await expect(toast).toHaveAttribute("data-tone", "live")
  await confirm.getByRole("button", { name: "Commit", exact: true }).press("Enter")
  expect(calls).toBe(2)
  row = { ...row, state: "expired", payload: { ...row.payload, card: { ...row.payload.card, receipt: confirms.expired.model.receipt } } }
  publish("confirmations:1")
  await expect(toast).toHaveAttribute("data-tone", "failed")
  await expect(toast).toContainText("Expired")
})

import { fixtures as todos } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { MemberConfirmation } from "@smthrs/rpc/ConfirmCard"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { expect, test } from "../browserTest"
import { fixtures as confirms } from "../../../../../packages/rpc/test/fixtures/Confirm"
import { fixture, open, roster } from "./confirmation-fixtures"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"

// Real install composition, native repository, PostgreSQL, source CLI and GitHub fake.
// This proves stale refusal and current admission; completion belongs to the merge worker.
test("C-ACC-02: a changed generation expires the merge approval and requires a fresh person press", async ({ page }) => {
  test.setTimeout(240_000)
  if (!process.env.SMITHERS_FFI_LIBRARY_PATH || !process.env.SMITHERS_TEST_DATABASE_URL) throw new Error("Native FFI and PostgreSQL are required for C-ACC-02")
  const directory = await mkdtemp(join(tmpdir(), "smithers-access-merge-"))
  const backend = spawn("go", ["test", "./internal/compose", "-run", "^TestAccessMergeBrowserPostgres$", "-count=1", "-v"], {
    cwd: resolve("../../packages/backend"), env: { ...process.env, SMITHERS_ACCESS_MERGE_PHASE_DIR: directory }, stdio: ["pipe", "pipe", "pipe"]
  })
  let logs = "", complete = false
  backend.stdout.on("data", bytes => { logs += String(bytes) })
  backend.stderr.on("data", bytes => { logs += String(bytes) })
  const exited = new Promise<number | null>((done, reject) => { backend.on("exit", done); backend.on("error", reject) })
  const wait = async (pattern: RegExp) => {
    await expect.poll(() => { if (backend.exitCode !== null) throw new Error(logs); return pattern.test(logs) }, { timeout: 120_000 }).toBe(true)
    return logs.match(pattern)!
  }
  try {
    const [, origin, id] = await wait(/ACCESS_MERGE_READY (http:\/\/\S+) (\S+)/)
    await page.context().addCookies([{ name: "smithers_session", value: "owner-browser-session", url: origin }, { name: "__csrf", value: "csrf", url: origin }])
    await page.goto(origin)
    const review = page.getByRole("button", { name: "Review & merge", exact: true })
    await expect(review).toBeEnabled({ timeout: 60_000 })
    await writeFile(join(directory, "shown"), "shown")
    await wait(/ACCESS_MERGE_CHANGED/)
    const stale = page.waitForResponse(response => response.url().endsWith(`/api/confirmations/${id}/approve`) && response.request().method() === "POST")
    await review.press("Enter")
    expect((await stale).status()).toBe(409)
    await expect(page.locator('[data-kind="confirm"]').last()).toContainText("Expired")
    await expect(review).toHaveCount(0)
    await expect(page.getByTestId("composer-input")).toBeEnabled()
    await expect(page.getByText("Merged", { exact: true })).toHaveCount(0)
    await writeFile(join(directory, "expired"), "expired")
    const [, current] = await wait(/ACCESS_MERGE_CURRENT (\S+)/)
    await page.reload()
    await expect(review).toBeEnabled({ timeout: 60_000 })
    const admitted = page.waitForResponse(response => response.url().endsWith(`/api/confirmations/${current}/approve`) && response.request().method() === "POST")
    await review.press("Enter")
    expect((await admitted).status()).toBe(202)
    await expect(page.getByText("Merged", { exact: true })).toHaveCount(0)
    await writeFile(join(directory, "approved"), "approved")
    complete = true
  } finally {
    await writeFile(join(directory, "done"), "done")
    try { const status = await exited; if (complete) expect(status, logs).toBe(0) } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

// UI projection only: mocked responses exercise pending/reload/toast behavior.
// The test above proves admission against the composed install.
test("C-ACC-02: a person reviews the current revision and merge survives reload", async ({ page }) => {
  test.setTimeout(120_000)
  const id = "10000000-0000-4000-8000-000000000002"
  let todo: TodoCard = structuredClone(todos.in_review.model)
  let row: MemberConfirmation = { id, command: "merge", state: "pending", revision: "generation-2:h2", expires_at: "2099-01-01T00:00:00Z",
    payload: { input: { reviewed_head_sha: "h2" }, card: { ...structuredClone(confirms.review_merge.model),
      subject: { kind: "todo", ref: "T12", revision: "generation-2:h2" }, review: {
        ...structuredClone(confirms.review_merge.model.review!), approved_revision: "h1",
        evidence: { attempt: 2, revision: "h2", items: [{ kind: "github_check", name: "required-ci", required: true, state: "pending", url: "https://github.com/acme/api/actions/runs/1" }] },
        merge: { state: "waiting", reason: "rechecking", on_github: true }
      } } } }
  const publish = await fixture(page, topic => topic === "members" ? roster("owner") : topic === "confirmations:1" ? [row] : topic === "todo:12" ? todo : undefined)
  await page.route("**/api/todos", route => route.fulfill({ json: [todo] }))
  await page.route("**/api/todos/12", route => route.fulfill({ json: todo }))
  const presses: unknown[] = []
  await page.route(`**/api/confirmations/${id}/approve`, async route => {
    presses.push(route.request().postDataJSON())
    await route.fulfill({ status: 202, json: { id, state: "pending" } })
  })
  const card = await open(page)
  await expect(card).toBeVisible({ timeout: 60_000 })
  await expect(card).toContainText("Approved h1 · Review generation-2:h2")
  await expect(card.getByText("Checks running", { exact: true })).toBeVisible()
  const approve = () => card.getByRole("button", { name: "Review & merge", exact: true })
  await expect(approve()).toBeDisabled()
  expect(presses).toEqual([])
  row.payload.card.review!.evidence.items[0] = { kind: "github_check", name: "required-ci", required: true, state: "passed", url: "https://github.com/acme/api/actions/runs/1" }
  row.payload.card.review!.merge = { state: "ready", on_github: true }
  publish("confirmations:1")
  await expect(approve()).toBeEnabled()
  await approve().press("Enter")
  await expect.poll(() => presses.length).toBe(1)
  expect(presses[0]).toEqual({ subject: row.payload.card.subject, revision: "generation-2:h2" })
  const toast = page.locator(`[data-notice="toast-todo.request.confirmation:${id}"]`)
  await expect(toast).toHaveAttribute("data-tone", "live")
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  row.payload.effect = { todo: 12, request: `confirmation:${id}` }
  row.payload.card.review!.merge = { state: "merging", reason: "merging", on_github: true }
  publish("confirmations:1")
  await expect(approve()).toBeDisabled()
  await page.reload()
  await expect(card).toBeVisible()
  await expect(toast).toHaveAttribute("data-tone", "live")
  expect(presses).toHaveLength(1)
  todo = structuredClone(todos.merged.model)
  publish("todo:12")
  row = { ...row, state: "approved", payload: { ...row.payload, card: { ...row.payload.card,
    receipt: { ...confirms.done.model.receipt!, text: "Merged" } } } }
  publish("confirmations:1")
  await expect(toast).toHaveAttribute("data-tone", "done")
  await expect(card).toContainText("Merged")
  expect(presses).toHaveLength(1)
})

// Real composed install, browser session, private live feed and shared worker.
test("C-ACC-02: issue comment confirmation waits for delivery across reload", async ({ page }) => {
  test.setTimeout(300_000)
  const directory = await mkdtemp(join(tmpdir(), "smithers-access-comment-"))
  const backend = spawn("go", ["test", "-p", "4", "./internal/compose", "-run", "^TestInstallIssueCommentComposed$", "-count=1", "-v", "-timeout", "4m"], {
    cwd: resolve("../../packages/backend"), env: { ...process.env, SMITHERS_ISSUE_COMMENT_PHASE_DIR: directory, SMITHERS_REHEARSAL_SPA_DIR: resolve("dist") }, stdio: ["pipe", "pipe", "pipe"]
  })
  let logs = "", complete = false
  backend.stdout.on("data", bytes => { logs += String(bytes) })
  backend.stderr.on("data", bytes => { logs += String(bytes) })
  const exited = new Promise<number | null>((done, reject) => { backend.on("exit", done); backend.on("error", reject) })
  const wait = async (pattern: RegExp) => {
    await expect.poll(() => { if (backend.exitCode !== null) throw new Error(logs); return pattern.test(logs) }, { timeout: 120_000 }).toBe(true)
    return logs.match(pattern)!
  }
  try {
    const [, origin, id, cookie] = await wait(/ISSUE_COMMENT_READY (http:\/\/\S+) (\S+) (\S+)/)
    await page.context().addCookies([{ name: "smithers_session", value: cookie!, url: origin! }])
    await page.goto(origin!)
    const card = page.locator('[data-kind="confirm"]').filter({ hasText: "Ben asks" })
    await expect(card).toBeVisible({ timeout: 60_000 })
    const response = page.waitForResponse(response => response.url().endsWith(`/api/confirmations/${id}/approve`) && response.request().method() === "POST")
    await card.getByRole("button", { name: "Comment", exact: true }).press("Enter")
    expect((await response).status()).toBe(200)
    await writeFile(join(directory, "approved"), "approved")
    await wait(/ISSUE_COMMENT_DISPATCHING/)
    const toast = page.locator(`[data-notice="toast-todo.request.confirmation:${id}"]`)
    await expect(toast).toHaveAttribute("data-tone", "live")
    await expect(page.getByTestId("composer-input")).toBeEnabled()
    await page.reload()
    await expect(toast).toHaveAttribute("data-tone", "live", { timeout: 60_000 })
    await expect(card.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0)
    await writeFile(join(directory, "running"), "running")
    await wait(/ISSUE_COMMENT_COMPLETED/)
    await expect(toast).not.toHaveAttribute("data-tone", "live", { timeout: 60_000 })
    await expect(page.getByTestId("composer-input")).toBeEnabled()
    await writeFile(join(directory, "completed"), "completed")
    complete = true
  } finally {
    await writeFile(join(directory, "approved"), "done")
    await writeFile(join(directory, "running"), "done")
    await writeFile(join(directory, "completed"), "done")
    const status = await exited
    if (status !== 0) console.error(logs)
    await rm(directory, { recursive: true, force: true })
    if (complete) expect(status, logs).toBe(0)
  }
})

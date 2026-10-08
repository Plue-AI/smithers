import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { fillComposer } from "../composer"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { TodoCard } from "@smthrs/rpc/TodoCard"

// App-boundary proof through HTTP projections, dispatcher, seam, CardRenderers
// and Views. Fresh macOS install, real execution/GitHub and the 60-minute target
// require the separate reference-host journey receipt.
test("C-J1-04: a private Draft commits once and its served TODO merges the reviewed head", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/members", route => route.fulfill({ json: {
    members: [{ login: "canary-owner", name: "Will", avatar_url: "https://example.com/owner.png", color_index: 0,
      role: "owner", needs_access: false, suspended: false, actions: [] }],
    access_url: "https://github.com/smithers-mvp-canary/node/settings/access"
  } }))
  const prompt = "Add a sum(a, b) export with a test"
  let model: TodoCard | undefined
  const writes: { path: string; body: Record<string, unknown>; key: string }[] = []
  let admit!: () => void
  const admission = new Promise<void>(resolve => { admit = resolve })
  await page.route("**/api/todos", async route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: model ? [model] : [] })
    const request = route.request(), body = request.postDataJSON()
    writes.push({ path: "/api/todos", body, key: request.headers()["idempotency-key"]! })
    await admission
    model = { ...structuredClone(fixtures.queued.model), n: 1, title: body.title, issue: undefined,
      prompt_revisions: [{ ...fixtures.queued.model.prompt_revisions[0]!, text: body.prompt, acceptance: body.acceptance }] }
    return route.fulfill({ status: 202, json: { state: "accepted", n: 1 } })
  })
  await page.route(url => /^\/api\/todos\/1(\/merge)?$/.test(url.pathname), async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() !== "POST") return route.fulfill({ json: model })
    writes.push({ path, body: request.postDataJSON(), key: request.headers()["idempotency-key"]! })
    // Admission is distinct from GitHub's eventual merged projection.
    return route.fulfill({ status: 202, json: { state: "accepted", n: 1 } })
  })
  await page.goto("/")
  await say(page, "/todo.new")
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await expect(draft).toContainText("Only you")
  await draft.getByLabel("Title", { exact: true }).fill("Add sum")
  await draft.getByLabel("Prompt", { exact: true }).fill(prompt)
  await draft.getByLabel("Acceptance", { exact: true }).fill("sum(2, 3) returns 5")
  await expect(draft.getByRole("combobox")).toHaveValue('{"mode":"append"}')
  expect(writes).toEqual([])
  await draft.getByRole("button", { name: "Commit", exact: true }).press("Enter")
  await page.keyboard.press("Enter")
  await expect.poll(() => writes.length).toBe(1)
  await expect(draft.getByRole("button", { name: "Commit", exact: true })).toBeDisabled()
  const notice = page.locator('.notice[data-tone="live"]').filter({ hasText: "Add sum" })
  await expect(notice).toBeVisible()
  await fillComposer(page, "Keep chatting while this starts")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  admit()
  await expect(draft).toContainText("Committed as T1")
  await say(page, "/todo T1")
  const card = page.getByRole("article", { name: "TODO T1" }).last()
  await expect(card.locator("header .state")).toContainText("Queued")
  await expect(notice).toBeVisible()
  expect(writes[0]!.body).toMatchObject({ title: "Add sum", prompt, acceptance: ["sum(2, 3) returns 5"], place: { mode: "append" } })
  const revision = model!.prompt_revisions
  for (const state of ["starting", "working", "in_review"] as const) {
    model = { ...structuredClone(fixtures[state].model), n: 1, title: "Add sum", prompt_revisions: revision, issue: undefined }
    await expect(card.locator("header .state")).toContainText({ starting: "Starting", working: "Working", in_review: "In review" }[state])
    if (state !== "in_review") await expect(notice).toBeVisible()
  }
  await expect(notice).toHaveCount(0)
  await expect(card.getByRole("region", { name: "Attempt 1 evidence" })).toBeVisible()
  await expect(card.getByRole("link", { name: /on GitHub/ })).toHaveAttribute("href", model!.pr!.url)
  const reviewedHead = model!.pr!.head
  await card.getByRole("button", { name: "Merge", exact: true }).press("Enter")
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1]).toMatchObject({ path: "/api/todos/1/merge", body: { reviewed_head_sha: reviewedHead } })
  await expect(card.locator("header .state")).toHaveText("In review")
  await expect(notice).toBeVisible()
  model!.state = "merged"; model!.merge = { state: "done", on_github: false }
  await expect(card.locator("header .state")).toHaveText("Merged")
  await expect(notice).toHaveCount(0)
  await page.reload()
  await say(page, "/todo T1")
  await expect(page.getByRole("article", { name: "TODO T1" }).last().locator("header .state")).toHaveText("Merged")
  expect(writes).toHaveLength(2)
  expect(new Set(writes.map(write => write.key)).size).toBe(2)
  expect(writes.every(write => write.key.length > 0)).toBe(true)
})

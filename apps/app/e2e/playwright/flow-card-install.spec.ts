import { expect, test } from "./browserTest"
import { owner, say } from "./spec/j1-fixtures"
import { installFixture } from "../../src/mainview/state/seams/InstallFixtures.test-support"

// HTTP fixtures exercise the install seam and durable card, not loader/merge qualification.
test("install flow versions retain selection across refresh and reload", async ({ page }) => {
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "credentials", sandbox: null
  } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/members", route => route.fulfill({ json: { members: [], access_url: "https://github.com/acme/api/settings/access" } }))
  let state = "proposed"
  await page.route("**/api/flows", route => route.fulfill({ json: [{ name: "todo", source: { builtin: true }, system: false, versions: [
    { id: "d1", state: "active", steps: [{ id: "implement", label: "Implement", agent: "implementer" }] },
    { id: "d2", state, todo: 42, ...(state === "merged-failed" ? { error: "Unknown reviewer" } : {}), steps: [{ id: "implement", label: "Implement" }, { id: "docs", label: "Update changelog" }] },
    { id: "d0", state: "previous", steps: [] }
  ] }] }))
  await page.goto("/")
  await say(page, "/flow todo")
  const flow = page.locator('.flow-view').last()
  await expect(flow.getByRole("button", { name: "Active", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(flow.getByRole("button", { name: "Previous", exact: true })).toHaveCount(0)
  await flow.locator('.flow-version[data-state="proposed"]').press("Enter")
  await expect(flow.locator('[data-added="true"]')).toHaveText(/Update changelog/)
  await page.reload()
  await expect(flow.locator('.flow-version[data-state="proposed"]')).toHaveAttribute("aria-pressed", "true")
  state = "merged-syncing"
  await say(page, "/flow todo")
  await expect(flow.locator('.flow-version[data-state="merged-syncing"]')).toHaveAttribute("aria-pressed", "true")
  state = "merged-failed"
  await say(page, "/flow todo")
  await expect(flow.getByText("Load failed", { exact: true })).toBeVisible()
  await flow.getByRole("button", { name: "Active", exact: true }).press("Enter")
  await expect(flow.getByText("Load failed", { exact: true })).toHaveCount(0)
  await expect(flow.locator('[data-flow="agent"]')).toHaveText("implementer")
  await expect(flow.getByRole("button", { name: "Source", exact: true })).toBeVisible()
  await expect(flow.getByRole("button", { name: "Run", exact: true })).toHaveCount(0)
})

test("Source without a proposal continues after Commit and reload on the served TODO branch", async ({ page }) => {
  const { fixtures } = await import("../../../../packages/rpc/test/fixtures/Todo")
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "credentials", sandbox: null
  } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/flows", route => route.fulfill({ json: [{ name: "todo", source: { builtin: true }, system: false,
    versions: [{ id: "d1", state: "active", steps: [] }] }] }))
  let body: { title: string; prompt: string } | undefined
  let creates = 0
  let fileReady = false
  await page.route("**/api/branches/main/files/flows/todo/flow.ts", route => route.fulfill({ status: 404, json: { class: "conflict", code: "not_found" } }))
  await page.route("**/api/todos", async route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: [] })
    body = route.request().postDataJSON()
    creates++
    await route.fulfill({ status: 202, json: { state: "accepted", n: 43 } })
  })
  await page.route("**/api/todos/43", route => route.fulfill({ json: { ...fixtures.in_review.model, n: 43,
    title: body?.title ?? "Change the TODO flow: Edit the source",
    prompt_revisions: [{ ...fixtures.in_review.model.prompt_revisions[0], text: body?.prompt ?? "", acceptance: [] }],
    branch: { id: "branch-43", name: "flow-source-43", machine: { state: "awake" } } } }))
  await page.route("**/api/branches/branch-43/files/flows/todo/flow.ts", route => fileReady
    ? route.fulfill({ json: { branch: "branch-43", path: "flows/todo/flow.ts", language: "typescript", digest: "file-43",
      content: { kind: "text", text: "export default derivedComposition\n" }, mode: "read_only", diagnostics: [], authors: [], editors: [] } })
    : route.fulfill({ status: 404, json: { class: "conflict", code: "not_found" } }))
  await page.goto("/")
  await say(page, "/flow.source todo")
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true }).last()
  await expect(prompt).toHaveValue("Change flows/todo/flow.ts: Edit the source; start from the built-in composition when no override exists")
  expect(creates).toBe(0)
  await page.getByRole("button", { name: "Commit", exact: true }).last().press("Enter")
  await expect.poll(() => creates).toBe(1)
  await expect(page.getByText("Committed as T43", { exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await page.reload()
  fileReady = true
  await expect(page.getByText("export default derivedComposition", { exact: false }).last()).toBeVisible({ timeout: 30000 })
  expect(creates).toBe(1)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

test("proposed built-in edit displays literal diff before one ordinary TODO append", async ({ page }) => {
  const { fixtures } = await import("../../../../packages/rpc/test/fixtures/Todo")
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "credentials", sandbox: null
  } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/flows", route => route.fulfill({ json: [{ name: "todo", source: { builtin: true }, system: false,
    versions: [{ id: "d1", state: "active", steps: [] }] }] }))
  const writes: unknown[] = []
  const prompt = "Change flows/todo/flow.ts: Run pnpm test; start from the built-in composition when no override exists\n\nProposed diff (untrusted context):\n> diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\n> +pnpm test\n> +```\n> +<script>untrusted</script>"
  await page.route("**/api/todos", async route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: [] })
    writes.push(route.request().postDataJSON())
    await route.fulfill({ status: 202, json: { state: "accepted", n: 44 } })
  })
  await page.route("**/api/todos/44", route => route.fulfill({ json: { ...fixtures.in_review.model, n: 44,
    title: "Change the TODO flow: Run pnpm test",
    prompt_revisions: [{ ...fixtures.in_review.model.prompt_revisions[0], text: prompt, acceptance: [] }] } }))
  await page.goto("/")
  await say(page, '/flow.edit {"name":"todo","request":"Run pnpm test","diff":"diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\\n+pnpm test\\n+```\\n+<script>untrusted</script>"}')
  await expect(page.locator(".flow-proposal pre").last()).toHaveText("diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\n+pnpm test\n+```\n+<script>untrusted</script>")
  expect(writes).toEqual([])
  await page.getByRole("button", { name: "Make TODO", exact: true }).last().press("Enter")
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true }).last()).toHaveValue(prompt)
  expect(writes).toEqual([])
  await page.getByRole("button", { name: "Commit", exact: true }).last().press("Enter")
  await expect(page.getByText("Committed as T44", { exact: true })).toBeVisible()
  expect(writes).toEqual([{ title: "Change the TODO flow: Run pnpm test", prompt, acceptance: [], place: { mode: "append" } }])
  await page.reload()
  await expect(page.getByText("Committed as T44", { exact: true })).toBeVisible()
  expect(writes).toHaveLength(1)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// This proves live card projection, independently of real merge/load/pinning receipts.
test("install Flow card follows live activation and preserves Active on a failed load without another command", async ({ page }) => {
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "credentials", sandbox: null
  } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  let state: "proposed" | "merged-syncing" | "active" | "merged-failed" = "proposed"
  let reads = 0
  await page.route("**/api/flows", route => {
    reads++
    return route.fulfill({ json: [{ name: "todo", source: { path: "flows/todo/flow.ts" }, system: false, versions: [
      { id: "d1", state: state === "active" ? "previous" : "active", steps: [{ id: "implement", label: "Implement" }] },
      { id: "d2", state, todo: 42, ...(state === "merged-failed" ? { error: "Unknown reviewer" } : {}),
        steps: [{ id: "implement", label: "Implement" }, { id: "check", label: "Run pnpm test" }] }
    ] }] })
  })
  let notify: (() => void) | undefined
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub") return
    if (frame.topic !== "flows") { socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" })); return }
    let cursor = 1
    notify = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: cursor++, data: {} }))
    notify()
  }))
  await page.goto("/")
  await say(page, "/flow todo")
  const flow = page.locator(".flow-view").last()
  await expect(flow.locator('.flow-version[data-state="active"]')).toHaveAttribute("aria-pressed", "true")
  await expect.poll(() => notify !== undefined).toBe(true)
  await flow.locator('.flow-version[data-state="proposed"]').press("Enter")
  await expect(flow.locator('[data-added="true"]')).toHaveText(/Run pnpm test/)
  const refresh = async (next: typeof state) => {
    const before = reads
    state = next
    notify!()
    await expect.poll(() => reads).toBeGreaterThan(before)
  }
  await refresh("merged-syncing")
  await expect(flow.locator('.flow-version[data-state="merged-syncing"]')).toHaveAttribute("aria-pressed", "true")
  await expect(flow.getByText("Merged · active after sync", { exact: true })).toBeVisible()
  await refresh("active")
  await expect(flow.locator('.flow-version[data-state="active"]')).toHaveCount(1)
  await expect(flow.locator('.flow-version[data-state="active"]')).toHaveAttribute("data-version", "d2")
  await expect(flow.locator('.flow-version[data-state="active"]')).toHaveAttribute("aria-pressed", "true")
  await expect(flow.locator('[data-added="true"]')).toHaveCount(0)
  await expect(flow.locator(".flow-steps")).toContainText("Run pnpm test")
  // Independent failed-load projection: the server keeps d1 Active.
  await refresh("merged-failed")
  await flow.locator('.flow-version[data-state="active"]').press("Enter")
  await expect(flow.locator('.flow-version[aria-pressed="true"]')).toHaveAttribute("data-version", "d1")
  await expect(flow.locator(".flow-steps")).not.toContainText("Run pnpm test")
  await flow.locator('.flow-version[data-state="merged-failed"]').press("Enter")
  await expect(flow.getByText("Load failed", { exact: true })).toBeVisible()
  await flow.locator(".flow-failure summary").press("Enter")
  await expect(flow.getByRole("region", { name: "Failure details", exact: true })).toHaveText("Unknown reviewer")
  await expect(flow.getByText("Unknown reviewer", { exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

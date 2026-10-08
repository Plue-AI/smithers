import { expect, test, type Page } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Exercise the self-hosted composition, including its branch and audience providers.
const installOwner = async (page: Page) => {
  await owner(page)
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: { toasts_hidden: false } }))
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test",
    capabilities: ["agent", "identity", "install"], authFlow: "credentials", sandbox: null
  } }))
}

// UI projection of .specs/engineering/checks/C-UI-04.md.
// Integration and reference-host evidence remains required separately.
test("C-UI-04: shared Starting entry has one host-derived line, keyboard jump and a narrow live pill", async ({ page }) => {
  await installOwner(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const model = { n: 24, title: "Starting entry", state: "starting",
    owner: { login: "canary-owner", name: "Ben", avatar_url: "https://example.test/avatar.png" },
    prompt_revisions: [], steps: [], steers: [], evidence: [], present: [], waits: [],
    merge: { state: "waiting", reason: "state", on_github: false } }
  const card = { id: "todo:24", kind: "todo", title: "Starting entry", status: "active", createdAt: 1, ordinal: 1, payload: { n: 24, model, requests: [] } }
  await page.route("**/api/todos", route => route.fulfill({ json: [] }))
  await page.route("**/api/todos/24", route => route.fulfill({ json: model }))
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: [
    { id: "subject", author: 1, authorLogin: "canary-owner", runId: "subject", prompt: "", state: "completed", sequence: 1,
      title: "Starting entry", tone: "live", subject: { n: 24, title: "Starting entry", state: "starting", tone: "live" },
      entry_sequences: { "todo:24": 1000002 }, frames: [{ runId: "subject", type: "card", card }] },
    { id: "answer", author: 1, authorLogin: "canary-owner", runId: "answer", prompt: "Read the notes", state: "completed", sequence: 2,
      title: "Read the notes", tone: "done", frames: [{ runId: "answer", type: "delta", kind: "text", text: Array.from({ length: 50 }, (_, i) => `Note ${i}.`).join("\n\n") }] }
  ] } }))
  await page.goto("/")
  const timeline = page.getByRole("navigation", { name: "Timeline", exact: true })
  const line = timeline.locator('[data-entry="todo:24"]')
  await expect(line).toHaveCount(1)
  await expect(line).toContainText("Starting entry")
  await expect(line).toHaveAttribute("data-tone", "live")
  await expect(timeline.locator('[data-entry="subject:prompt"], [data-entry="subject:answer"]')).toHaveCount(0)
  await line.getByRole("button").first().press("Enter")
  await expect(page.locator('[data-message-id="todo:24"]')).toBeInViewport()
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await timeline.locator('[data-entry="answer:answer"]').getByRole("button").first().press("Enter")
  await page.setViewportSize({ width: 900, height: 1000 })
  await expect(timeline).toBeHidden()
  await expect(page.getByRole("button", { name: "↑ 1 live above", exact: true })).toBeVisible()
})

// The served TODO path is independent of the pending shared-entry/summary journey.
test("C-UI-04: served failure has one rail action and keyboard Retry uses the production seam", async ({ page }) => {
  await installOwner(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const model = {
    n: 24, title: "Retry from the install", state: "failed",
    owner: { login: "canary-owner", name: "Ben", avatar_url: "https://example.test/avatar.png" },
    prompt_revisions: [], steps: [], steers: [], evidence: [], present: [], waits: [],
    merge: { state: "waiting", reason: "state", on_github: false },
    failure: { class: "checks", step: "Check", message: "Checks failed", retryable: true }
  }
  const requests: unknown[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/24", async route => {
    if (route.request().method() === "POST") {
      requests.push(route.request().postDataJSON())
      await route.fulfill({ status: 202, json: { state: "accepted" } })
    } else await route.fulfill({ json: model })
  })
  await page.goto("/")
  await say(page, "/todo T24")
  const line = page.getByRole("navigation", { name: "Timeline", exact: true }).locator('[data-entry="todo:24"]')
  await expect(line).toContainText("Retry from the install")
  await expect(line).toHaveAttribute("data-tone", "failed")
  await line.getByRole("button", { name: "Retry", exact: true }).press("Enter")
  await expect.poll(() => requests).toEqual([{ op: "retry" }])
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await page.setViewportSize({ width: 900, height: 1000 })
  await expect(page.getByRole("navigation", { name: "Timeline", exact: true })).toBeHidden()
})

test("C-UI-04: the owner's served merge raises a terminal notice and Hide preserves its timeline entry", async ({ page }) => {
  await installOwner(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  let state = "in_review"
  const model = () => ({
    n: 24, title: "Merge notice from the install", state,
    owner: { login: "canary-owner", name: "Ben", avatar_url: "https://example.test/avatar.png" },
    prompt_revisions: [], steps: [], steers: [], evidence: [], present: [], waits: [],
    merge: { state: "waiting", reason: "state", on_github: false }
  })
  await page.route("**/api/todos", route => route.fulfill({ json: [model()] }))
  await page.route("**/api/todos/24", route => route.fulfill({ json: model() }))
  await page.goto("/")
  await say(page, "/todo T24")
  const line = page.getByRole("navigation", { name: "Timeline", exact: true }).locator('[data-entry="todo:24"]')
  await expect(line).toContainText("Merge notice from the install")
  state = "merged"
  const notice = page.locator('[data-notice="toast-todo.merged.24.no-run.0"]')
  await expect(notice).toBeVisible()
  await expect(notice).toHaveAttribute("data-tone", "done")
  await expect(notice).toContainText("Merged")
  await expect(notice.locator("[data-flow]")).toHaveCount(0)
  await notice.getByRole("button", { name: "Hide Merge notice from the install", exact: true }).press("Enter")
  await expect(notice).toHaveCount(0)
  await expect(line).toHaveAttribute("data-tone", "done")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

test("C-UI-04: served approvals and conflicts stay attention notices until the wait settles", async ({ page }) => {
  await installOwner(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  let waits = [{ id: "approval-24", kind: "approval", prompt: "Approve the change", since: "2026-10-06T00:00:00Z", actions: [] }]
  const model = () => ({
    n: 24, title: "Waits from the install", state: waits.length ? "needs_you" : "working",
    owner: { login: "canary-owner", name: "Ben", avatar_url: "https://example.test/avatar.png" },
    prompt_revisions: [], steps: [], steers: [], evidence: [], present: [], waits,
    merge: { state: "waiting", reason: "state", on_github: false }
  })
  await page.route("**/api/todos", route => route.fulfill({ json: [model()] }))
  await page.route("**/api/todos/24", route => route.fulfill({ json: model() }))
  await page.goto("/")
  await say(page, "/todo T24")
  const approval = page.locator('[data-notice="toast-todo.needs-you.24.approval-24"]')
  await expect(approval).toBeVisible()
  await expect(approval).toHaveAttribute("data-tone", "attention")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  waits = [{ id: "conflict-24", kind: "conflict", prompt: "Resolve the conflict", since: "2026-10-06T00:00:00Z", actions: [] }]
  const conflict = page.locator('[data-notice="toast-todo.needs-you.24.conflict-24"]')
  await expect(conflict).toBeVisible()
  await expect(conflict).toHaveAttribute("data-tone", "attention")
  await conflict.getByRole("button", { name: "Hide T24 needs you", exact: true }).press("Enter")
  await expect(conflict).toHaveCount(0)
  const line = page.getByRole("navigation", { name: "Timeline", exact: true }).locator('[data-entry="todo:24"]')
  await expect(line).toHaveAttribute("data-tone", "attention")
  waits = []
  await expect(line).toHaveAttribute("data-tone", "live")
})

test("C-UI-04: keyboard Resolve opens the served branch", async ({ page }) => {
  await installOwner(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const model = {
    n: 24, title: "Resolve from the install", state: "needs_you",
    owner: { login: "canary-owner", name: "Ben", avatar_url: "https://example.test/avatar.png" },
    branch: { id: "branch-24", name: "smithers/fix-retry", machine: { state: "awake" } },
    prompt_revisions: [], steps: [], steers: [], evidence: [], present: [],
    waits: [{ id: "conflict-24", kind: "conflict", prompt: "Resolve", since: "2026-10-06T00:00:00Z", actions: [{ tag: "branch", label: "Resolve" }] }],
    merge: { state: "waiting", reason: "state", on_github: false }
  }
  const requests: string[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/24", route => route.fulfill({ json: model }))
  await page.route("**/api/branches/*", route => {
    requests.push(new URL(route.request().url()).pathname)
    return route.fulfill({ json: { name: "smithers/fix-retry", machine: { id: "machine-24" } } })
  })
  await page.goto("/")
  await say(page, "/todo T24")
  const line = page.getByRole("navigation", { name: "Timeline", exact: true }).locator('[data-entry="todo:24"]')
  await expect(line).toHaveAttribute("data-tone", "attention")
  await line.getByRole("button", { name: "Resolve", exact: true }).press("Enter")
  await expect.poll(() => requests).toEqual(["/api/branches/smithers%2Ffix-retry"])
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

test("C-UI-04: rail Answer keeps the TODO number when its wait supplies scoped arguments", async ({ page }) => {
  await installOwner(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const model = {
    n: 24, title: "Answer from the install", state: "needs_you",
    owner: { login: "canary-owner", name: "Ben", avatar_url: "https://example.test/avatar.png" },
    prompt_revisions: [], steps: [], steers: [], evidence: [], present: [],
    waits: [{ id: "ask-24", kind: "question", prompt: "Choose", since: "2026-10-06T00:00:00Z", actions: [{ tag: "todo.answer", label: "Answer" }] }],
    merge: { state: "waiting", reason: "state", on_github: false }
  }
  let reads = 0
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/24", route => { reads++; return route.fulfill({ json: model }) })
  await page.goto("/")
  await say(page, "/todo T24")
  const line = page.getByRole("navigation", { name: "Timeline", exact: true }).locator('[data-entry="todo:24"]')
  await expect(line).toHaveAttribute("data-tone", "attention")
  const before = reads
  await line.getByRole("button", { name: "Answer", exact: true }).press("Enter")
  await expect.poll(() => reads).toBeGreaterThan(before)
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await expect(line).toContainText("Answer from the install")
})


test("C-UI-04: shared history supplies actor lines and keyboard jumps to the shared answer", async ({ page }) => {
  await installOwner(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: [{
    id: "shared-alice", author: 2, authorLogin: "alice", runId: "alice-run", prompt: "Choose a timeout", title: "Choose a timeout", tone: "live", state: "running",
    frames: [{ runId: "alice-run", type: "delta", kind: "text", text: "Checking the timeout" }]
  }] } }))
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: { toasts_hidden: false } }))
  await page.goto("/")
  const timeline = page.getByRole("navigation", { name: "Timeline", exact: true })
  const prompt = timeline.locator('[data-entry="shared-alice:prompt"]')
  const answer = timeline.locator('[data-entry="shared-alice:answer"]')
  await expect(prompt).toContainText("Choose a timeout")
  await expect(answer).toContainText("Checking the timeout")
  await expect(answer).toHaveAttribute("data-tone", "live")
  await answer.getByRole("button").press("Enter")
  await expect(page.locator('[data-shared-turn="shared-alice"]')).toBeInViewport()
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await page.setViewportSize({ width: 900, height: 1000 })
  await expect(timeline).toBeHidden()
})


for (const preference of ["toasts_hidden", "global_toasts_hidden"]) test(`C-UI-04: saved ${preference} suppresses the owner's new notice while the entry updates`, async ({ page }) => {
  await installOwner(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  let state = "in_review"
  const model = () => ({ n: 24, title: "Hidden merge toast", state,
    owner: { login: "canary-owner", name: "Ben", avatar_url: "https://example.test/avatar.png" },
    prompt_revisions: [], steps: [], steers: [], evidence: [], present: [], waits: [],
    merge: { state: "waiting", reason: "state", on_github: false }
  })
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: [] } }))
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: { [preference]: true } }))
  await page.route("**/api/todos", route => route.fulfill({ json: [model()] }))
  await page.route("**/api/todos/24", route => route.fulfill({ json: model() }))
  await page.goto("/")
  await say(page, "/todo T24")
  const line = page.getByRole("navigation", { name: "Timeline", exact: true }).locator('[data-entry="todo:24"]')
  await expect(line).toContainText("Hidden merge toast")
  state = "merged"
  await expect(line).toHaveAttribute("data-tone", "done")
  await expect(page.locator('[data-notice="toast-todo.merged.24.no-run.0"]')).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

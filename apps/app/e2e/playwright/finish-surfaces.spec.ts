import { expect, test, type Page } from "./browserTest"
import { installCloudFixture, runningBox } from "./cloudFixture"

/*
 * The surfaces that were design previews (#2111, #2115, #2116), driven in the
 * real app against the backend's own DTO shapes: the issue list narrowed to
 * conversations, a conversation read through the chat = issues contract, the
 * Connect card read from the registered routes, and a run's Steps view
 * leading with its recorded triggers. SMITHERS_SURFACES_CAPTURE=<dir> saves
 * one PNG per surface for the docs (apps/site scripts/journeys/capture.mjs).
 */

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

const repo = "smithersai/smithers"
const at = "2026-09-26T09:05:00Z"
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) })
const capture = async (page: Page, node: ReturnType<Page["locator"]>, name: string) => {
  if (!process.env.SMITHERS_SURFACES_CAPTURE) return
  await page.evaluate(() => document.fonts.ready)
  await node.screenshot({ path: `${process.env.SMITHERS_SURFACES_CAPTURE}/${name}.png` })
}

/** The app home (D-18): the grid, so the chord is the way to the composer. */
const installHome = (page: Page) =>
  page.route((url) => url.pathname === `/api/repos/${repo}/home`, (route) => route.fulfill({ json: { kind: "blocks", blocks: [
    { type: "prompt", title: "What should we work on?", placeholder: "Ask Smithers…" },
    { type: "app", flow: "issue.implement", title: "Fix an issue", picture: "issue" },
    { type: "app", flow: "prs.triage", title: "Review a PR", picture: "review" },
    { type: "app", flow: "wiki.ask", title: "Ask the codebase", picture: "wiki" },
    { type: "app", flow: "triggers.register", title: "Run it every night", picture: "schedule" }
  ] } }))

const slash = async (page: Page, line: string) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await expect(input).toBeVisible()
  await input.fill(line)
  await page.getByTestId("composer-send").click()
  await expect(input).toHaveValue("")
  await input.press("Escape")
}

const boot = async (page: Page) => {
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "cloud.pat"], workspaces: [runningBox(repo)] })
  await installHome(page)
  await page.goto("/")
  await expect(page.getByTestId("app-tile")).toHaveCount(4)
}

/* services.IssueResponse and services.IssueCommentResponse, by their Go struct tags. */
const issueDto = (number: number, extra: Record<string, unknown>) => ({
  id: number * 100, number, body: "", state: "open", author: { id: 1, login: "codeplanesmithers" }, assignees: [], labels: [], milestone_id: null,
  comment_count: 0, closed_at: null, fixed_by: null, fixed_at: null, verified_by: null, verified_at: null, created_at: at, updated_at: at, ...extra
})
const commentDto = (id: number, body: string, extra: Record<string, unknown>) =>
  ({ id, issue_id: 700, user_id: 1, commenter: "codeplanesmithers", body, type: "issue_comment", created_at: at, updated_at: at, ...extra })

test("the issue list narrows to conversations, and a conversation reads its messages, personas and reactions off the contract", async ({ page }) => {
  const chat = issueDto(7, { idempotency_key: "thread-request", kind: "chat", visibility: "private", title: "Wiki staleness banner", comment_count: 3, updated_at: "2026-09-27T08:40:00Z" })
  const comments = [
    commentDto(31, "The owner asked for the staleness banner fix. Taking it.", { idempotency_key: "assistant:1", persona: { username: "assistant" }, created_at: "2026-09-27T08:12:00Z" }),
    commentDto(32, "On it. Plan: reproduce, then fix `wiki/search.ts`.", { idempotency_key: "engineering:1", persona: { username: "engineering" }, created_at: "2026-09-27T08:14:00Z" }),
    commentDto(33, "Tests pass. PR [#2101](https://github.com/smithersai/smithers/pull/2101).", { idempotency_key: "engineering:2", persona: { username: "engineering" }, created_at: "2026-09-27T08:31:00Z" }),
    commentDto(34, "Ship it.", { commenter: "U0HUMAN", persona: { username: "" }, created_at: "2026-09-27T08:40:00Z" })
  ]
  const reactions: Record<number, Array<{ name: string; actor: string; active: boolean }>> = { 33: [{ name: "eyes", actor: "codeplanesmithers", active: true }, { name: "white_check_mark", actor: "U0HUMAN", active: true }] }
  await boot(page)
  await page.route((url) => url.pathname === `/api/repos/${repo}/issues`, (route) => route.fulfill(json([
    chat,
    issueDto(8, { title: "Land the fence", state: "fixed", fixed_by: { id: 2, login: "engineer" }, labels: [{ id: 1, name: "bug", color: "d73a4a", description: "" }], updated_at: "2026-09-27T07:00:00Z" }),
    issueDto(9, { title: "Plain issue", updated_at: "2026-09-26T08:00:00Z" })
  ])))
  await page.route((url) => url.pathname === `/api/user/github-repos/${repo}/issues`, (route) => route.fulfill(json([])))
  await page.route((url) => url.pathname === `/api/repos/${repo}/issues/7`, (route) => route.fulfill(json(chat)))
  await page.route((url) => url.pathname === `/api/repos/${repo}/issues/7/comments`, (route) => route.fulfill(json(comments)))
  await page.route((url) => /\/issues\/7\/comments\/\d+\/reactions$/.test(url.pathname), (route) => {
    const id = Number(/comments\/(\d+)\/reactions$/.exec(new URL(route.request().url()).pathname)![1])
    return route.fulfill(json(reactions[id] ?? []))
  })

  await slash(page, `/issues.list all ${repo}`)
  const list = page.getByTestId(`card-issues-${repo}`)
  await expect(list.locator('[data-issue="7"]')).toBeVisible()
  await expect(list.locator('[data-issue="7"]')).toHaveAttribute("data-kind", "conversation")
  await expect(list.locator('[data-issue="8"]')).toContainText("Land the fence")
  await expect(list.locator('[data-issue="8"]')).toHaveAttribute("data-state", "fixed")
  await expect(list.getByRole("alert")).toHaveCount(0)
  await capture(page, list, "app-issues")
  // Conversations alone: the plain issues leave the list.
  await slash(page, `/issues.list all --kind conversation ${repo}`)
  await expect(list.locator('[data-issue="9"]')).toHaveCount(0)
  await expect(list.locator('[data-issue="7"]')).toBeVisible()

  await slash(page, `/issues.view 7 ${repo}`)
  // Opened from the list, the conversation takes the list's frame: the card is whichever one now holds it.
  const thread = page.getByTestId("conversation-7")
  await expect(thread).toBeVisible()
  const card = page.locator('[data-testid^="card-"]').filter({ has: page.getByTestId("conversation-7") }).last()
  await expect(thread).toHaveAttribute("data-kind", "conversation")
  // Personas post under their names; an external commenter is the author the mirror recorded; reactions count.
  await expect(thread.locator(".thread-message")).toHaveCount(4)
  await expect(thread.locator(".agent-mark-name").filter({ hasText: "engineering" }).first()).toBeVisible()
  await expect(thread.locator(".agent-mark-name").filter({ hasText: "U0HUMAN" })).toBeVisible()
  await expect(thread.getByText("eyes 1")).toBeVisible()
  // Non-GitHub integrations left with the MVP cut (#3385, #3389): a conversation names no Slack thread.
  await expect(thread.locator(".thread-slack-link")).toHaveCount(0)
  await expect(thread.getByRole("alert")).toHaveCount(0)
  await capture(page, card, "app-conversation")
})

test("a run's Steps view leads with its recorded triggers: the schedule that fired it and each approval decision with who made it", async ({ page }) => {
  const runId = "run-nightly"
  const stamp = (sequence: number, kind: string, occurredAt: number, payload: Record<string, unknown> = {}) => ({ sequence, kind, occurredAt, payload })
  const journal = [
    stamp(2, "control.agent.turn-opened", 1_759_000_001_000, { seat: "openai:gpt-6-sol" }),
    stamp(3, "control.agent.cell-produced", 1_759_000_001_500, { text: 'await ctx.call("bash", { command: "bun test src/wiki" })' }),
    stamp(4, "control.agent.cell-call-started", 1_759_000_002_000, { flowName: "bash", callId: "c1", input: { command: "bun test src/wiki" } }),
    stamp(5, "control.agent.cell-call-settled", 1_759_000_014_000, { flowName: "bash", callId: "c1", outcome: "success", value: { exitCode: 0 } }),
    stamp(6, "control.agent.cell-settled", 1_759_000_014_100, { outcome: "success" }),
    stamp(7, "control.approval.requested", 1_759_000_015_000, { requestId: "req-1", question: "write apps/app/src/mainview/wiki/search.ts?", payload: {}, runId }),
    stamp(8, "control.approval.approved", 1_759_000_075_000, { tokenId: "req-1", requestId: "req-1", target: "Node", principal: { id: "will", kind: "user", stampedAt: 1_759_000_074_000 } }),
    stamp(9, "control.run.resumed", 1_759_000_075_100, { runId }),
    stamp(10, "control.agent.turn-opened", 1_759_000_076_000, { seat: "openai:gpt-6-sol" }),
    stamp(11, "control.agent.cell-call-started", 1_759_000_077_000, { flowName: "write", callId: "c2", input: { path: "apps/app/src/mainview/wiki/search.ts" } }),
    stamp(12, "control.agent.cell-call-settled", 1_759_000_078_000, { flowName: "write", callId: "c2", outcome: "success" }),
    stamp(13, "control.agent.cell-settled", 1_759_000_078_100, { outcome: "success" }),
    stamp(14, "control.run.completed", 1_759_000_079_000, {})
  ]
  await boot(page)
  /* A schedule is the repository job `flow:<slug>` (state/seams/TriggersSeam.ts `jobPath`). */
  await page.route((url) => url.pathname === `/api/repos/${repo}/repository-jobs`, (route) => route.fulfill(json([
    { id: "reg-1", job: "flow:nightly", flow_id: "coding/check", schedule: "0 2 * * *", enabled: true, next_fire_at: "2026-09-28T02:00:00Z" }
  ])))
  await page.route("**/api/workflow/provision", (route) => route.fulfill({ json: { status: "ready", repo, gatewayId: "nightly" } }))
  await page.route("**/api/workflow/rpc", (route) => {
    const call = route.request().postDataJSON() as { procedure: string; payload: { selector?: { _tag?: string }; after?: { value: number } } }
    let payload: unknown = {}
    if (call.procedure === "Plan") payload = { planId: "plan-nightly", digest: "digest", envelope: { capabilities: [], flows: [], budget: {} } }
    else if (call.procedure === "Run") payload = { runId }
    else {
      const tag = call.payload.selector?._tag
      const rows = tag === "run-summary" || tag === "workspace-runs"
        ? [{ runId, flowId: "coding/check", status: "completed", createdAt: 1_759_000_000_000, updatedAt: 1_759_000_079_000,
          turns: 2, calls: 2, callsFailed: 0, editsAttempted: 1, editsSucceeded: 1, inputTokens: 4_400, outputTokens: 610, verdict: "completed", diagnosis: "completed" }]
        : tag === "run-events" ? journal.filter((row) => row.sequence > (call.payload.after?.value ?? 0)) : []
      payload = { cursor: { projection: tag, runId: null, value: 0 }, rows }
    }
    return route.fulfill({ json: { ok: true, payload } })
  })
  await slash(page, `/triggers.run nightly ${repo}`)
  const card = page.locator('[data-kind="run-trace"]').last()
  await expect(card).toBeVisible()
  await expect(card.getByTestId(`run-trace-${runId}`)).toBeVisible({ timeout: 20_000 })
  await card.getByRole("button", { name: "Steps", exact: true }).click()
  const schedule = card.getByTestId(`run-trigger-${runId}-schedule`)
  await expect(schedule).toHaveText(/trigger.*schedule nightly · 0 2 \* \* \*/)
  const approval = card.getByTestId(`run-trigger-${runId}-approval`)
  await expect(approval).toContainText("approved by")
  await expect(approval.locator(".agent-mark-name")).toHaveText("will")
  // No row is invented: the schedule and the decision are the only two.
  await expect(card.locator("[data-trigger]")).toHaveCount(2)
  await capture(page, card, "app-run-steps")
})

test("a message-started run's Steps view leads with the recorded message — author, exact text and the conversation door — after a reload", async ({ page }) => {
  const runId = "run-chat"
  const trigger = { kind: "message", author: "alice", conversationId: "session-9", messageId: "314", text: "Why does /hello greet null?", origin: "chat" }
  const stamp = (sequence: number, kind: string, occurredAt: number, payload: Record<string, unknown> = {}) => ({ sequence, kind, occurredAt, payload })
  const journal = [
    stamp(1, "control.run.accepted", 1_759_000_000_500, { runId, status: "accepted", trigger }),
    stamp(2, "control.agent.turn-opened", 1_759_000_001_000, { seat: "openai:gpt-6-sol" }),
    stamp(3, "control.agent.cell-produced", 1_759_000_001_500, { text: 'await ctx.call("read", { path: "src/hello.ts" })' }),
    stamp(4, "control.agent.cell-call-started", 1_759_000_002_000, { flowName: "read", callId: "c1", input: { path: "src/hello.ts" } }),
    stamp(5, "control.agent.cell-call-settled", 1_759_000_014_000, { flowName: "read", callId: "c1", outcome: "success", value: "export const hello = () => \"hi\"" }),
    stamp(6, "control.agent.cell-settled", 1_759_000_014_100, { outcome: "success" }),
    stamp(7, "control.run.completed", 1_759_000_015_000, {})
  ]
  await boot(page)
  await page.route("**/api/workflow/provision", (route) => route.fulfill({ json: { status: "ready", repo, gatewayId: "chat" } }))
  await page.route("**/api/workflow/rpc", (route) => {
    const call = route.request().postDataJSON() as { procedure: string; payload: { selector?: { _tag?: string }; after?: { value: number } } }
    const tag = call.payload.selector?._tag
    const rows = tag === "run-summary" || tag === "workspace-runs"
      ? [{ runId, flowId: "coding/dispatch", status: "completed", createdAt: 1_759_000_000_500, updatedAt: 1_759_000_015_000,
        turns: 1, calls: 1, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 900, outputTokens: 120, verdict: "completed", diagnosis: "completed" }]
      : tag === "run-events" ? journal.filter((row) => row.sequence > (call.payload.after?.value ?? 0)) : []
    return route.fulfill({ json: { ok: true, payload: { cursor: { projection: tag, runId: null, value: 0 }, rows } } })
  })
  let sessionReads = 0
  await page.route((url) => url.pathname === `/api/repos/${repo}/agent/sessions/session-9`, (route) => {
    sessionReads += 1
    return route.fulfill(json({ id: "session-9", title: "hello greet null", status: "completed", message_count: 1, created_at: at, workspace_id: null }))
  })
  await page.route((url) => url.pathname === `/api/repos/${repo}/agent/sessions/session-9/messages`, (route) => route.fulfill(json([])))

  await slash(page, `/runs.open ${runId} ${repo}`)
  const card = page.locator('[data-kind="run-trace"]').last()
  await expect(card.getByTestId(`run-trace-${runId}`)).toBeVisible({ timeout: 20_000 })
  await card.getByRole("button", { name: "Steps", exact: true }).click()
  const message = card.getByTestId(`run-trigger-${runId}-message`)
  await expect(message.locator(".agent-mark-name")).toHaveText("alice")
  await expect(card.getByTestId(`run-trigger-quote-${runId}`)).toHaveText("Why does /hello greet null?")
  // No row is invented: the recorded message is the only one.
  await expect(card.locator("[data-trigger]")).toHaveCount(1)
  await capture(page, card, "app-run-steps-message")

  // The conversation door opens the session the message was posted in.
  await message.getByRole("button", { name: "Open" }).click()
  await expect.poll(() => sessionReads).toBe(1)

  // The record is durable: a reload re-reads the same journal, and the row is still there, still once.
  await page.reload()
  const restored = page.locator('[data-kind="run-trace"]').last()
  await expect(restored.getByTestId(`run-trace-${runId}`)).toBeVisible({ timeout: 20_000 })
  const restoredMessage = restored.getByTestId(`run-trigger-${runId}-message`)
  await expect(restoredMessage.locator(".agent-mark-name")).toHaveText("alice")
  await expect(restored.getByTestId(`run-trigger-quote-${runId}`)).toHaveText("Why does /hello greet null?")
  await expect(restored.locator("[data-trigger]")).toHaveCount(1)
})

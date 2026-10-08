import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { identityRoute } from "../identity"
import recorded from "../../../src/mainview/state/testdata/external-recorded-conversation.json"

// UI projection of C-AGT-01 (mvp.md M-38). The decoders' own acceptance evidence is the harness package's tests.
//
// The seed is what a real install answers on GET /api/conversations/<branch> after importing the recorded Codex
// and Claude Code captures and one source of a release the adapters do not read: the backend test
// TestExternalImportIsTheRecordedBrowserConversation produces it through the packaged adapters and fails when it
// drifts. Only the browser's network is scripted here. A member's live session through a machine is C-AGT-02.
const CODEX = "b0010000-0000-0000-0000-000000000000"
const CLAUDE = "b0020000-0000-0000-0000-000000000000"
const MEMBER_MACHINE_CODEX = "b0030000-0000-0000-0000-000000000000"
const UNREAD_CODEX = "b0040000-0000-0000-0000-000000000000"

test("C-AGT-01: Both external formats retain ordered read-only transcript content", async ({ page }) => {
  let reads = 0
  await installCloudFixture(page, { capabilities: ["install", "identity", "agent"] })
  // An install reads the signed-in member from its own browser session.
  await page.route("**/api/auth/session", identityRoute())
  await page.route("**/api/conversations/main", route => { reads++; return route.fulfill({ json: recorded }) })
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: { queue: [] } }))
  // An imported entry offers nothing to send. The viewer's own read position is theirs to save; any other write
  // to the conversation (a prompt, an edit, a stop, a delete) fails the check.
  const writes: string[] = []
  await page.route("**/api/conversations/main/**", route => {
    const call = `${route.request().method()} ${new URL(route.request().url()).pathname}`
    if (route.request().method() !== "GET" && call !== "PUT /api/conversations/main/view-state") writes.push(call)
    return route.fallback()
  })
  await page.goto("/")
  await expect(page.getByRole("log", { name: "Conversation", exact: true })).toBeVisible({ timeout: 30_000 })
  const rows = page.locator('article[data-origin="external"]')

  const check = async () => {
    // Every imported entry of the four agent processes, in the order the install committed them.
    await expect(rows).toHaveCount(83)
    const participants = await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-participant-id")))
    expect(participants).toEqual([
      ...Array<string>(34).fill(CODEX), ...Array<string>(36).fill(CLAUDE), ...Array<string>(12).fill(MEMBER_MACHINE_CODEX), UNREAD_CODEX
    ])
    // Each agent is its own participant, working for the member whose terminal it ran in.
    for (const [participant, label] of [[CODEX, "Codex for Ben"], [CLAUDE, "Claude Code for Ben"], [MEMBER_MACHINE_CODEX, "Codex for Ben"]] as const) {
      await expect(page.locator(`article[data-participant-id="${participant}"]`).getByRole("img", { name: label, exact: true }).first()).toBeAttached()
    }
    // The owner's prompts are the owner's.
    const prompts = page.locator('article[data-origin="external"][data-role="user"]')
    await expect(prompts.first()).toContainText("How do I use ultrafast")
    await expect(prompts.filter({ hasText: "Instead of html just answer my questions concisely in this chat" })).toHaveCount(1)
    await expect(prompts.filter({ hasText: "Second capture turn." })).toHaveCount(1)
    // The recorded encrypted message body is one line, once, and never its ciphertext.
    await expect(rows.getByText("Encrypted by Codex", { exact: true })).toHaveCount(1)
    await expect(page.getByText("gAAAAABqw_FYg6K7", { exact: false })).toHaveCount(0)
    // What each agent reported as failed is shown as failed.
    const failed = page.locator('article[data-origin="external"][data-tone="failed"]')
    await expect(failed).toHaveCount(12)
    for (const text of [
      "[Request interrupted by user]",
      "You've hit your session limit · resets 5:40am (America/Los_Angeles)",
      "capture-error",
      "Script failed"
    ]) await expect(failed.filter({ hasText: text }).first()).toBeAttached()
    // A source of a release the adapters do not read stopped visibly, once, as that agent's failed entry.
    const stopped = page.locator(`article[data-participant-id="${UNREAD_CODEX}"]`)
    await expect(stopped).toHaveCount(1)
    await expect(stopped).toHaveAttribute("data-tone", "failed")
    await expect(stopped).toContainText("This session transcript version is not supported.")
    // A tool call keeps the id that pairs its request with its result.
    await expect(page.locator('article[data-correlation-id="toolu_01JD3dL8cHy7FW7iBubC6yjY"]')).toHaveCount(1)
    await expect(page.locator('article[data-correlation-id="call_dbe0b931f54b4b7bbca20b5236d530ff"]')).toHaveCount(2)
    // Read-only: nothing on an imported entry edits, resends, answers, approves, retries, stops, steers or merges.
    for (const name of ["Edit", "Resend", "Answer", "Approve", "Retry", "Stop", "Steer", "Merge"]) {
      await expect(rows.getByRole("button", { name, exact: true })).toHaveCount(0)
    }
  }

  await check()
  // The transcript's own commands, paths and requests are text. None became a card, a run or a request.
  await expect(page.getByText("Merged T8", { exact: true })).toHaveCount(0)
  expect(writes).toEqual([])
  const before = await rows.allTextContents()
  await page.reload()
  await expect(page.getByRole("log", { name: "Conversation", exact: true })).toBeVisible({ timeout: 30_000 })
  await check()
  expect(await rows.allTextContents()).toEqual(before)
  expect(reads).toBeGreaterThanOrEqual(2)
  expect(writes).toEqual([])
})

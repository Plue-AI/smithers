/*
 * What a member's browser must show for the recorded Codex and Claude Code captures (C-AGT-01, mvp.md M-38).
 *
 * Every value here is read from the committed captures in packages/smithers/agent/harness/test/fixtures/external,
 * never from the decoders. Two callers share it: the composed-install journey (external-transcript.browser.ts,
 * a real backend) and the app-tier spec (playwright/spec/C-AGT-01.spec.ts, a recorded response).
 */
import type { expect as Expect, Page } from "@playwright/test"

/** The four agent processes of Ben's terminal session, in the order the install committed their entries. */
export const CODEX = "b0010000-0000-0000-0000-000000000000"
export const CLAUDE = "b0020000-0000-0000-0000-000000000000"
export const MEMBER_MACHINE_CODEX = "b0030000-0000-0000-0000-000000000000"
export const UNREAD_CODEX = "b0040000-0000-0000-0000-000000000000"
export const RECORDED_ENTRIES = 34 + 36 + 12 + 1

export const importedRows = (page: Page) => page.locator('article[data-origin="external"]')

export async function expectRecordedConversation(page: Page, expect: typeof Expect, later: ReadonlyArray<string> = []): Promise<void> {
  const rows = importedRows(page)
  // Every imported entry, in commit order, each under the agent process that wrote it.
  await expect(rows).toHaveCount(RECORDED_ENTRIES + later.length, { timeout: 30_000 })
  expect(await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-participant-id")))).toEqual([
    ...Array<string>(34).fill(CODEX), ...Array<string>(36).fill(CLAUDE), ...Array<string>(12).fill(MEMBER_MACHINE_CODEX), UNREAD_CODEX, ...later
  ])
  // Each agent is its own participant, working for the member whose terminal it ran in.
  for (const [participant, label] of [[CODEX, "Codex for Ben"], [CLAUDE, "Claude Code for Ben"], [MEMBER_MACHINE_CODEX, "Codex for Ben"]] as const) {
    await expect(page.locator(`article[data-participant-id="${participant}"]`).getByRole("img", { name: label, exact: true }).first()).toBeAttached()
  }
  // The owner's prompts are the owner's.
  const prompts = page.locator('article[data-origin="external"][data-role="user"]')
  for (const prompt of await prompts.all()) {
    expect(await prompt.locator("header .author").evaluate(author =>
      [...author.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("")
    )).toBe("Ben")
    await expect(prompt.getByRole("img", { name: "Ben", exact: true })).toBeAttached()
  }
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

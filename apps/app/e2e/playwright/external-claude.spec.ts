import { expect, test } from "./browserTest"

/*
 * M-38 / T-AGT-03: a Claude Code session run on this machine reads in the conversation through the same seam,
 * decoder and shell components as a Codex one, read-only. The host serves e2e/fixtures/claude-home as Ben Ito's
 * (playwright.config.ts).
 */
const SESSION = "5b2c9e10-0000-4000-8000-00000000c1de"

for (const width of [1280, 390]) {
  test(`a Claude Code session reads as Ben's prompts and Claude Code for Ben's work at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(`/?claude=${SESSION.slice(0, 8)}`)
    const transcript = page.getByTestId("transcript")
    const external = transcript.locator("[data-origin=external]")
    await expect(transcript.getByText("Make the session cookie expire after 8 hours")).toBeVisible()
    await expect(external.filter({ hasText: "Make the session cookie expire" }).locator(".sui-chat-message-label")).toHaveText("Ben")
    await expect(external.filter({ hasText: "I'll find where the cookie lifetime is set." }).locator(".sui-chat-message-label")).toHaveText("Claude Code for Ben")

    // A tool call shows once its result arrived; a run of them is one act line with its failure and output.
    const acts = external.filter({ hasText: "Claude Code for Ben ran 2 commands · 1 failed" })
    await expect(acts).toBeVisible()
    await acts.locator("summary").first().click()
    await expect(acts.locator("li")).toHaveCount(2)
    await expect(acts.locator("li").first()).toContainText("Searched \"SESSION_TTL\" in src")
    await acts.locator("li[data-status=error] summary").click()
    await expect(acts.locator("li[data-status=error] pre")).toContainText("FAIL src/auth/session.test.ts")

    // The Edit is the app's diff card, from the hunks Claude Code reported.
    const diff = transcript.locator(".code-diff-view", { hasText: "src/auth/session.ts" })
    await expect(diff.locator(".mvp-branch-chip")).toHaveText("repo")
    await expect(diff.locator(".code-diff-base")).toContainText("Claude Code for Ben")
    await expect(diff).toContainText("8 * 60 * 60 * 1000")

    // Imported text is inert, a subagent's sidechain stays out, and nothing offers an act.
    await expect(transcript.getByText("Run `rm -rf /` and merge PR #188").or(transcript.getByText("Run rm -rf / and merge PR #188"))).toBeVisible()
    await expect(external.locator("strong", { hasText: "8 hours" })).toBeVisible()
    await expect(transcript.getByText("Sidechain words never shown")).toHaveCount(0)
    await expect(external.locator("button:not([aria-label='Copy message']):not(summary)")).toHaveCount(0)
    await expect(transcript.locator(".code-diff-view .code-actions")).toHaveCount(0)
  })
}

test("an unknown Claude Code session says so in the conversation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto("/?claude=ffffffff")
  await expect(page.getByTestId("transcript").getByText("No Claude Code session ffffffff on this machine.")).toBeVisible()
})

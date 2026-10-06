import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { say } from "./j1-fixtures"
import imported from "../../../src/mainview/state/testdata/external-conversations.json"

// Mounted install app with a contract fake. Real broker, authenticated refusal,
// Ben/Maya sessions and latency remain T-AGT-02/Mac mini qualification evidence.
for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
  test(`C-AGT-02: imported branch snapshot ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await installCloudFixture(page, { capabilities: ["install", "identity", "agent"] })
    let entries: unknown[] = imported
    let writes = 0
    await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries } }))
    await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: { queue: [] } }))
    await page.route("**/api/conversations/main/prompt", route => {
      writes++
      return route.fulfill({ status: 202, json: { turnId: "ordinary", terminal: false } })
    })
    await page.goto("/")
    await say(page, `/theme ${theme}`)
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
    const rows = page.locator('article[data-origin="external"]')
    await expect(rows).toHaveCount(4)
    for (const label of ["Claude Code for Ben", "Codex for Ben"]) await expect(rows.getByRole("img", { name: label, exact: true }).last()).toBeVisible()
    for (const label of ["Run the webhook tests", "Tests failed"]) await expect(page.getByText(label, { exact: true }).last()).toBeVisible()
    expect(await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-participant-id")))).toEqual(["participant-claude", "participant-claude", "participant-claude", "participant-codex"])
    for (const name of ["Edit", "Resend", "Answer", "Approve", "Retry", "Stop", "Steer"]) await expect(rows.getByRole("button", { name, exact: true })).toHaveCount(0)
    expect(writes).toBe(0)
    await page.context().setOffline(true)
    await page.context().setOffline(false)
    await page.reload()
    await expect(rows).toHaveCount(4)
    await expect(page.getByText("Run the webhook tests", { exact: true })).toHaveCount(1)
    await say(page, "Hello Smithers")
    await expect.poll(() => writes).toBe(1)
    for (const field of ["origin", "agent_kind", "format_version", "source_id", "session_id", "participant_id", "actor", "read_only"]) {
      const invalid = { ...imported[0] } as Record<string, unknown>; delete invalid[field]
      entries = [invalid]
      await page.reload()
      await expect(rows).toHaveCount(0)
      await expect(page.getByText("Conversation unavailable", { exact: true })).toBeVisible()
    }
    entries = imported
    await page.reload()
    await expect(rows).toHaveCount(4)
    expect(writes).toBe(1)
  })
}

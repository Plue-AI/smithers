import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { say } from "./j1-fixtures"
import imported from "../../../src/mainview/state/testdata/external-journal-conversations.json"

// Mounted install app with a contract fake. Real broker, authenticated refusal,
// Ben/Maya sessions and latency remain T-AGT-02/Mac mini qualification evidence.
for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
  test(`C-AGT-02: imported branch snapshot ${theme} ${width}`, async ({ page }) => {
    // This check reloads once for each required identity field, plus recovery.
    test.setTimeout(180_000)
    await page.setViewportSize({ width, height: 900 })
    await installCloudFixture(page, { capabilities: ["install", "identity", "agent"] })
    let entries: unknown[] = imported
    let available = true
    const reload = async () => {
      await page.reload()
      await expect(page.getByRole("log", { name: "Conversation", exact: true })).toBeVisible({ timeout: 30_000 })
    }
    const admitted = new Map<string, string>()
    await page.route("**/api/conversations/main", route => available ? route.fulfill({ json: { id: "main", entries } }) : route.fulfill({ status: 503, json: { code: "unavailable", class: "infra", message: "Conversation unavailable" } }))
    await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: { queue: [] } }))
    await page.route("**/api/conversations/main/prompt", route => {
      const request = route.request().postDataJSON() as { idempotencyKey: string; prompt: string }
      expect(request.idempotencyKey).toEqual(expect.any(String))
      // Admission may replay across reload before its response is persisted.
      // The production host deduplicates by this durable key.
      if (admitted.has(request.idempotencyKey)) expect(admitted.get(request.idempotencyKey)).toBe(request.prompt)
      admitted.set(request.idempotencyKey, request.prompt)
      return route.fulfill({ status: 202, json: { turnId: request.idempotencyKey, terminal: false } })
    })
    await page.goto("/")
    await say(page, `/theme ${theme}`)
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
    const rows = page.locator('article[data-origin="external"]')
    await expect(rows).toHaveCount(4)
    for (const label of ["Claude Code for Ben", "Codex for Ben"]) await expect(rows.getByRole("img", { name: label, exact: true }).last()).toBeVisible()
    for (const label of ["Run the webhook tests", "Tests failed"]) await expect(rows.getByText(label, { exact: true }).last()).toBeVisible()
    expect(await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-participant-id")))).toEqual(["participant-claude", "participant-claude", "participant-claude", "participant-codex"])
    for (const name of ["Edit", "Resend", "Answer", "Approve", "Retry", "Stop", "Steer"]) await expect(rows.getByRole("button", { name, exact: true })).toHaveCount(0)
    expect(admitted.size).toBe(0)
    await page.context().setOffline(true)
    await page.context().setOffline(false)
    await reload()
    await expect(rows).toHaveCount(4)
    await expect(page.getByText("Run the webhook tests", { exact: true })).toHaveCount(1)
    await say(page, "Hello Smithers")
    await expect.poll(() => admitted.size).toBe(1)
    for (const field of ["origin", "agent", "source_format_version", "source_id", "session_id", "participant_id", "owner_id", "author_id", "author", "authorLogin", "read_only"]) {
      const invalid = { ...imported[0] } as Record<string, unknown>; delete invalid[field]
      entries = [invalid]
      await reload()
      await expect(rows).toHaveCount(0)
      await expect(page.getByText("Conversation unavailable", { exact: true })).toBeVisible()
    }
    entries = imported
    await reload()
    await expect(rows).toHaveCount(4)
    available = false
    await reload()
    await expect(rows).toHaveCount(0)
    await expect(page.getByText("Conversation unavailable", { exact: true })).toBeVisible()
    await say(page, "Ordinary prompt while import delivery is unavailable")
    await expect.poll(() => admitted.size).toBe(2)
    available = true
    await reload()
    await expect(rows).toHaveCount(4)
    expect([...admitted.values()]).toEqual(["Hello Smithers", "Ordinary prompt while import delivery is unavailable"])
  })
}

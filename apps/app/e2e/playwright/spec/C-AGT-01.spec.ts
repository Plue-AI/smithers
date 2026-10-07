import { readFileSync } from "node:fs"
import { expect, test } from "../browserTest"

// The real session seam calls the public adapters. The HTTP fake supplies recorded
// source bytes; capture completeness and owner qualification remain separate evidence.
const cases = [
  { agent: "codex", session: "01a10d62-91c7-7163-b038-72dab55a2e8c", file: "codex-0.160/rollout.jsonl", prompt: "How do I use ultrafast" },
  { agent: "claude", session: "5e551011-c0de-4000-8000-000000000001", file: "claude-code-2.1/session.jsonl", prompt: "Learn about jev.Web search it it's brand new type of ai model." }
]
for (const capture of cases) {
  test(`C-AGT-01: ${capture.agent} recorded bytes remain ordered and read-only after reload`, async ({ page }) => {
    const text = readFileSync(`../../packages/smithers/agent/harness/test/fixtures/external/${capture.file}`, "utf8")
    const reads: number[] = []
    await page.route("**/api/external/sessions?**", route => {
      const url = new URL(route.request().url())
      const offset = Number(url.searchParams.get("offset") ?? 0)
      reads.push(offset)
      const remaining = Buffer.from(text).subarray(offset).toString("utf8")
      return route.fulfill({ json: { agent: capture.agent === "claude" ? "claude-code" : "codex", session_id: capture.session,
        owner: { login: "ben", name: "Ben Ito" }, offset, next: Buffer.byteLength(text), text: remaining, eof: true } })
    })
    await page.goto(`/?${capture.agent}=${capture.session}`)
    const external = page.getByTestId("transcript").locator("[data-origin=external]")
    await expect(external.filter({ hasText: capture.prompt }).first()).toBeVisible()
    for (const name of ["Approve", "Merge", "Retry", "Stop", "Steer", "Resend", "Answer"]) {
      await expect(external.getByRole("button", { name, exact: true })).toHaveCount(0)
    }
    const before = await external.allTextContents()
    expect(before.length).toBeGreaterThan(3)
    await page.reload()
    await expect(external).toHaveCount(before.length)
    expect(await external.allTextContents()).toEqual(before)
    expect(reads.filter(offset => offset === 0).length).toBeGreaterThanOrEqual(2)
  })
}

for (const payload of [
  { type: "future_semantic_event" },
  { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "future_body", text: "must not disappear" }] } },
  { type: "item_completed", item: { type: "UserMessage", content: "changed shape" } }
]) test(`C-AGT-01: unsupported content stops the import visibly: ${JSON.stringify(payload)}`, async ({ page }) => {
  const session = cases[0]!.session
  const text = JSON.stringify({ type: "session_meta", payload: { id: session, cli_version: "0.160.0", cwd: "/repo" } }) + "\n"
    + JSON.stringify({ type: "event_msg", payload }) + "\n"
  await page.route("**/api/external/sessions?**", route => route.fulfill({ json: {
    agent: "codex", session_id: session, owner: { login: "ben", name: "Ben Ito" },
    offset: 0, next: Buffer.byteLength(text), text, eof: true
  } }))
  await page.goto(`/?codex=${session}`)
  await expect(page.getByTestId("transcript").getByText("Session transcript line 2 could not be read.")).toBeVisible()
})

test("C-AGT-01: malformed Claude content stops the import visibly", async ({ page }) => {
  const session = cases[1]!.session
  const text = JSON.stringify({ type: "user", uuid: "source-record", version: "2.1.290", sessionId: session,
    message: { role: "user", content: { changed: "shape" } } }) + "\n"
  await page.route("**/api/external/sessions?**", route => route.fulfill({ json: {
    agent: "claude-code", session_id: session, owner: { login: "ben", name: "Ben Ito" },
    offset: 0, next: Buffer.byteLength(text), text, eof: true
  } }))
  await page.goto(`/?claude=${session}`)
  await expect(page.getByTestId("transcript").getByText("Session transcript line 1 could not be read.")).toBeVisible()
})

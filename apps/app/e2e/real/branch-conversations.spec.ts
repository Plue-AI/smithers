import { test, expect } from "@playwright/test"
import { scenario } from "./coverage/types"
import { fillComposer } from "../playwright/composer"

test("a host turn survives closing its author tab and replays for both members", scenario("branch-conversations.author-tab-close-replay", {
  capabilities: [],
  coverage: ["action:chat.send", "host:local", "path:success", "path:persistence", "door:user-only", "dimension:multi-member", "dimension:tab-close", "evidence:conversation-api-replay"]
}), async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error("Run through TestBranchConversationTabClose")
  const origin = new URL(baseURL)
  const member = async (login: string) => {
    const context = await browser.newContext()
    await context.addCookies([{ name: "session", value: `w17-${login}`, domain: origin.hostname, path: "/" }, { name: "__csrf", value: "csrf", domain: origin.hostname, path: "/" }])
    return context
  }
  const ben = await member("ben"), alice = await member("alice")
  try {
    const author = await ben.newPage(), reader = await alice.newPage()
    const writes: string[] = []
    author.on("request", request => { if (request.method() === "POST") writes.push(new URL(request.url()).pathname) })
    await author.goto("/chatowner/chatrepo")
    await reader.goto("/chatowner/chatrepo")
    await fillComposer(author, "SLOW")
    const admission = author.waitForResponse(response => response.url().endsWith("/api/conversations/main/prompt") && response.status() === 202)
    await author.keyboard.press("Enter")
    await admission
    const snapshot = await ben.request.get(`${baseURL}/api/conversations/main`)
    const accepted: { entries: { id: string }[] } = await snapshot.json()
    const turn = { turnId: accepted.entries[0]!.id }
    await expect(reader.locator(`[data-shared-turn="${turn.turnId}"]`)).toBeVisible()
    await author.close()
    console.log("W17_AUTHOR_TAB_CLOSED")
    await expect(reader.locator(`[data-shared-turn="${turn.turnId}"]`).getByText("Host answer.", { exact: true })).toBeVisible({ timeout: 20_000 })
    const returned = await ben.newPage()
    await returned.goto("/chatowner/chatrepo")
    await expect(returned.locator(`[data-shared-turn="${turn.turnId}"]`).getByText("Host answer.", { exact: true })).toBeVisible()
    expect(writes.filter(path => path === "/api/conversations/main/prompt")).toHaveLength(1)
    expect(writes.some(path => /\/api\/(agent|chat)\/turn/.test(path))).toBe(false)
    const response = await ben.request.get(`${baseURL}/api/conversations/main`)
    const replay: { entries: { id: string; state: string }[] } = await response.json()
    expect(replay.entries.map(entry => ({ id: entry.id, state: entry.state }))).toEqual([{ id: turn.turnId, state: "completed" }])
  } finally { await ben.close(); await alice.close() }
})

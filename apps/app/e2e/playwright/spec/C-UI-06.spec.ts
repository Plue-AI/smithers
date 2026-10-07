import { expect, test, type Page } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// UI contract proof with two browser identities and the real HTTP/live seams.
// PostgreSQL membership/audience enforcement is covered by T-APP-16's compose tests.
test("C-UI-06: Shared branch entries keep personal views", async ({ page, browser }) => {
  const alice = await browser.newContext(), peer = await alice.newPage()
  let entries: unknown[] = []
  const views: Record<string, Record<string, unknown>> = { ben: {}, alice: {} }
  const publishers: Array<() => void> = []
  const file = { id: "shared-file", kind: "file", title: "README.md", status: "active", ordinal: 1, createdAt: 1,
    payload: { repo: "owner/repo", path: "README.md", content: "Shared file bytes", truncated: false } }
  const fixture = async (target: Page, login: string, id: number) => {
    await owner(target)
    await target.route("**/api/user", route => route.fulfill({ json: { id, username: login, is_admin: false } }))
    await target.route("**/api/bootstrap", route => route.fulfill({ json: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "redirect", sandbox: null } }))
    await target.route("**/api/install", route => route.fulfill({ json: installFixture() }))
    await target.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries } }))
    await target.route("**/api/conversations/main/view-state", async route => {
      if (route.request().method() === "PUT") views[login] = route.request().postDataJSON()
      await route.fulfill({ json: { ...views[login], instructions: login === "ben" && entries.length ? [{ id: "host-turn:1:3", command: "theme", payload: { mode: "dark" } }] : [] } })
    })
    await target.route("**/api/conversations/main/prompt", async route => {
      expect(login).toBe("ben")
      expect(route.request().postDataJSON().prompt).toBe("List the changed tests")
      entries = [{ id: "host-turn", author: 1, authorLogin: "ben", runId: "host-run", prompt: "List the changed tests", state: "completed", frames: [
        { type: "delta", runId: "host-run", kind: "text", text: "One changed test" },
        { type: "card", runId: "host-run", card: file }, { type: "done", runId: "host-run", reason: "stop" }
      ] }]
      await route.fulfill({ status: 202, json: { turnId: "host-turn", terminal: true } })
      for (const publish of publishers) publish()
    })
    await target.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
      if (typeof raw !== "string") return
      const frame = JSON.parse(raw)
      if (frame.t !== "sub") return
      if (frame.topic !== "conversation:main") { socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" })); return }
      let cursor = 0
      const publish = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: ++cursor, data: { id: "main", entries } }))
      publishers.push(publish); publish()
    }))
  }
  try {
    await page.emulateMedia({ colorScheme: "light" }); await peer.emulateMedia({ colorScheme: "light" })
    await fixture(page, "ben", 1); await fixture(peer, "alice", 2)
    await page.goto("/"); await peer.goto("/")
    await expect.poll(() => publishers.length).toBe(2)
    await say(page, "List the changed tests")
    const mine = page.getByTestId("card-shared-file"), theirs = peer.getByTestId("card-shared-file")
    await expect(theirs).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    await expect(peer.locator("html")).toHaveAttribute("data-theme", "light")
    await expect(peer.locator('[data-shared-conversation="main"]')).toContainText("Smithers for ben")
    await expect(peer.locator('[data-shared-conversation="main"]')).toContainText("List the changed tests")
    await mine.locator('[data-flow="card.maximize"]').press("Enter")
    await expect(mine).toHaveAttribute("data-maximized", "true")
    await expect(theirs).toHaveAttribute("data-maximized", "false")
    await peer.reload()
    await expect(theirs).toHaveAttribute("data-maximized", "false")
    await page.reload()
    await expect(mine).toHaveAttribute("data-maximized", "true")
    expect(views.ben.card_view).toEqual({ "shared-file": "maximized" })
    expect(views.alice.card_view).toBeUndefined()
  } finally { await alice.close() }
})

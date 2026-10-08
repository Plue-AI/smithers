import { authenticatedTest as test, launchAuthenticatedProfile } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { awaitBoot, command, expect } from "./support/test"

// C-J3-01's browser lifecycle against the served install. The reference lane
// provisions Ben and Alice, T2 and retry.ts; no routes or roster are mocked.
// SSH, external-agent sessions and the 120-action latency campaign need their
// separate reference-host receipts. This test does not manufacture those rows.
test("C-J3-01: file location, two tabs, clean close and silent lease expiry", scenario("branch.presence", {
  capabilities: ["install", "multiplayer"],
  coverage: ["action:branch", "action:file", "path:success", "door:slash", "evidence:presence-browser-lifecycle", "host:local"]
}), async ({ page, playwright, baseURL }, info) => {
  test.setTimeout(120_000)
  if (!baseURL) throw new Error("Reference install URL required")
  const alice = await launchAuthenticatedProfile(playwright, baseURL, "SMITHERS_PRESENCE_ALICE_PROFILE")
  const timings: Array<{ action: string; milliseconds: number }> = []
  const presence = page.getByRole("list", { name: "On this branch", exact: true }).last()
  try {
    await page.goto("/")
    await awaitBoot(page)
    await awaitBoot(alice.page)
    await command(page, "/branch T2")
    const started = Date.now()
    await command(alice.page, "/branch T2")
    await expect(presence.getByText("Alice", { exact: true })).toHaveCount(1, { timeout: 1000 })
    timings.push({ action: "join", milliseconds: Date.now() - started })
    await command(alice.page, "/file retry.ts:12")
    await expect(presence.getByRole("button", { name: "retry.ts:12", exact: true })).toBeVisible({ timeout: 1000 })

    const second = await alice.page.context().newPage()
    await second.goto(baseURL)
    await awaitBoot(second)
    await command(second, "/branch T2")
    await expect(presence.getByText("Alice", { exact: true })).toHaveCount(1)
    await second.close()
    await expect(presence.getByText("Alice", { exact: true })).toHaveCount(1)
    const closed = Date.now()
    await alice.page.close()
    await expect(presence.getByText("Alice", { exact: true })).toHaveCount(0, { timeout: 1000 })
    timings.push({ action: "clean-close", milliseconds: Date.now() - closed })

    // Observe the last actual outbound heartbeat, rather than starting the
    // lease clock when offline mode is requested (up to 10 s later).
    const reopened = await alice.page.context().newPage()
    let heartbeat = 0
    reopened.on("websocket", socket => {
      socket.on("framesent", frame => {
        if (typeof frame.payload !== "string") return
        try {
          if (JSON.parse(frame.payload).t === "presence") heartbeat = Date.now()
        } catch { /* Other live frame kinds do not renew the lease. */ }
      })
    })
    await reopened.goto(baseURL)
    await awaitBoot(reopened)
    await command(reopened, "/branch T2")
    await expect.poll(() => heartbeat, { timeout: 12_000 }).toBeGreaterThan(0)
    await expect(presence.getByText("Alice", { exact: true })).toHaveCount(1)
    await alice.page.context().setOffline(true)
    // Assert throughout the lease, not only at its beginning and end.
    while (Date.now() - heartbeat < 29_000) {
      await expect(presence.getByText("Alice", { exact: true })).toHaveCount(1)
      await page.waitForTimeout(250)
    }
    await expect(presence.getByText("Alice", { exact: true })).toHaveCount(0, { timeout: Math.max(1, 31_000 - (Date.now() - heartbeat)) })
    timings.push({ action: "silent-loss", milliseconds: Date.now() - heartbeat })
    await info.attach("presence-timings", { body: JSON.stringify(timings), contentType: "application/json" })
  } finally {
    await alice.page.context().setOffline(false)
    await alice.close()
  }
})

import { authenticatedTest as test, launchAuthenticatedProfile } from "../auth-permissions/profile"
import { scenario } from "../coverage/types"
import { awaitBoot, command, expect } from "../support/test"

// The reference campaign provisions C-J10-04's T5 with a pending rebase after
// githubfake sync, and leaves the worker running. No route, live frame, receipt
// or completion is intercepted here. Real GitHub merge/freeze timing is separate.
test("C-J10-04: mounted Rebase request survives reload and settles on execution", scenario("branch.rebase-install", {
  capabilities: ["install", "multiplayer"],
  coverage: ["action:branch.rebase", "door:button", "door:slash", "path:success", "host:local", "evidence:rebase-execution-reload"]
}), async ({ page, playwright, baseURL }, info) => {
  test.setTimeout(120_000)
  if (!baseURL) throw new Error("Reference install URL required")
  const observer = await launchAuthenticatedProfile(playwright, baseURL, "SMITHERS_REBASE_OBSERVER_PROFILE")
  const writes: string[] = []
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/branches/")) {
      writes.push(request.headers()["idempotency-key"] ?? "")
    }
  })
  try {
    await page.goto("/")
    await awaitBoot(page)
    await awaitBoot(observer.page)
    await command(page, "/branch T5")
    await command(observer.page, "/branch T5")
    const card = page.locator('.smithers-card[data-kind="branch"]').last()
    const otherCard = observer.page.locator('.smithers-card[data-kind="branch"]').last()
    await expect(card).toContainText("Rebase pending")
    await expect(otherCard).toContainText("Rebase pending")
    const admitted = page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname.startsWith("/api/branches/"))
    await card.getByRole("button", { name: "Rebase now", exact: true }).press("Enter")
    const response = await admitted
    expect(response.status()).toBe(202)
    const receipt = await response.json() as { state: string; n: number; onto: string }
    expect(receipt.state).toBe("accepted")
    expect(receipt.n).toBe(5)
    expect(receipt.onto).toMatch(/^[0-9a-f]{40}$/)
    expect(writes).toHaveLength(1)
    const key = writes[0]!
    expect(key).toMatch(/^[0-9a-f-]{36}$/)
    const route = `/api/todos/5?rebase_request=${encodeURIComponent(key)}`
    // Another signed-in member cannot observe this private request, even
    // though both viewers can read the branch's public rebase state.
    expect((await observer.page.context().request.get(new URL(route, baseURL).toString())).status()).toBe(404)
    await expect(page.getByTestId("composer-input")).toBeEditable()
    await page.reload()
    await awaitBoot(page)
    await expect(page.getByTestId("composer-input")).toBeEditable()
    const observations: Array<{ state: string; at: string }> = []
    await expect.poll(async () => {
      const result = await page.context().request.get(new URL(route, baseURL).toString())
      expect(result.status()).toBe(200)
      const body = await result.json() as { rebase_execution: { state: string; onto: string } }
      expect(body.rebase_execution.onto).toBe(receipt.onto)
      observations.push({ state: body.rebase_execution.state, at: new Date().toISOString() })
      expect(body.rebase_execution.state).not.toBe("failed")
      return body.rebase_execution.state
    }, { timeout: 60_000 }).toBe("completed")
    await expect(page.locator('.notice[data-tone="live"]').filter({ hasText: "Rebase" })).toHaveCount(0)
    await expect(card.getByRole("button", { name: "Rebase now", exact: true })).toHaveCount(0)
    await expect(otherCard.getByRole("button", { name: "Rebase now", exact: true })).toHaveCount(0)
    expect(writes).toEqual([key])
    await info.attach("rebase-execution", { body: JSON.stringify({ onto: receipt.onto, observations, writes: writes.length }), contentType: "application/json" })
  } finally {
    await observer.close()
  }
})

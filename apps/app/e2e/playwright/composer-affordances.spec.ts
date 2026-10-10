import { expect, test } from "./browserTest"
import { installCloudFixture } from "./cloudFixture"
import { fillComposer } from "./composer"
import { SCOPED_TEST_USER } from "./identity"

// Button doors use shared prompt admission and durable conversation projection.
for (const stop of [false, true]) {
  test(stop ? "clicking Stop stops the admitted shared turn" : "clicking Send admits a shared turn and renders its reply", async ({ page }) => {
    await installCloudFixture(page, { capabilities: ["install", "identity", "agent"] })
    const prompt = stop ? "say never" : "say ok"
    let entries: unknown[] = []
    const admitted = new Set<string>()
    let stops = 0
    const legacyWrites: string[] = []
    page.on("request", request => {
      if (request.method() === "POST" && /\/api\/(agent|chat)\/turn(?:$|[/?])/.test(request.url())) legacyWrites.push(request.url())
    })
    await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries } }))
    await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: { queue: [] } }))
    await page.route("**/api/conversations/main/prompt", route => {
      const body = route.request().postDataJSON()
      expect(body).toMatchObject({ prompt, idempotencyKey: expect.any(String) })
      // Like the server (internal/chat/prompt.go, spec 6.2.1), a repeated key replays its turn. A reload
      // before the admission receipt is durable re-sends the same key (#3780); only a new key admits.
      if (admitted.has(body.idempotencyKey)) return route.fulfill({ status: 202, json: { turnId: "button-turn", terminal: !stop || stops > 0 } })
      admitted.add(body.idempotencyKey)
      entries = [{ id: "button-turn", author: 1, authorLogin: SCOPED_TEST_USER.login, runId: "button-run", prompt,
        state: stop ? "running" : "completed", frames: stop ? [] : [
          { runId: "button-run", type: "delta", kind: "text", text: "ok" },
          { runId: "button-run", type: "done", reason: "stop" }
        ] }]
      return route.fulfill({ status: 202, json: { turnId: "button-turn", terminal: !stop } })
    })
    await page.route("**/api/conversations/main/turns/button-turn/stop", route => {
      expect(route.request().method()).toBe("POST")
      stops++
      entries = [{ id: "button-turn", author: 1, authorLogin: SCOPED_TEST_USER.login, runId: "button-run", prompt,
        state: "cancelled", frames: [{ runId: "button-run", type: "done", reason: "cancelled" }] }]
      return route.fulfill({ json: { turnId: "button-turn", terminal: true } })
    })
    await page.goto("/")
    await fillComposer(page, prompt)
    const input = page.getByTestId("composer-input")
    await page.getByTestId("composer-send").click()
    await expect(page.locator('[data-shared-turn="button-turn"]')).toContainText(prompt)
    await expect(input).toHaveValue("")
    if (stop) {
      const button = page.locator(".sui-chat-composer-stop")
      await expect(button).toBeVisible()
      await button.click()
      await expect.poll(() => stops).toBe(1)
      await expect(button).toHaveCount(0)
    } else {
      await expect(page.getByTestId("transcript").getByText("ok", { exact: true })).toBeVisible()
    }
    await page.reload()
    await expect(page.locator('[data-shared-turn="button-turn"]')).toContainText(prompt)
    if (stop) await expect(page.locator(".sui-chat-composer-stop")).toHaveCount(0)
    else await expect(page.getByTestId("transcript").getByText("ok", { exact: true })).toBeVisible()
    expect(admitted.size).toBe(1)
    expect(stops).toBe(stop ? 1 : 0)
    expect(legacyWrites).toEqual([])
  })
}

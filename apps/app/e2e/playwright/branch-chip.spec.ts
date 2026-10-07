import { expect, test } from "./browserTest"

test("a demo host with refused live topics opens the Branch card from its chip", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }))
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "design", buildSha: "0".repeat(40), capabilities: [], authFlow: "none", sandbox: null
  } }))
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    const frame = JSON.parse(String(raw))
    if (frame.t === "sub") socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unknown_topic" }))
  }))
  await page.goto("/?as=maya")
  const chip = page.locator(".home .stack-row", { hasText: "T10" }).locator(".branch-chip")
  await expect(chip).toHaveText("fix-checkout-race")
  // The button reaches the shared branch flow through keyboard activation too.
  await chip.focus()
  await chip.press("Enter")
  const branch = page.locator('.smithers-card [data-kind="branch"]').last()
  await expect(branch).toBeVisible()
  await expect(branch).toContainText("fix-checkout-race")
  await expect(branch).toContainText("Fix the flaky checkout test")
  await expect(page.locator(".card-maximize-backdrop")).toHaveCount(0)
})

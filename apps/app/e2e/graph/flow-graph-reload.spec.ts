import { expect, test } from "@playwright/test"
import { GRAPH_FLOW, GRAPH_NODE_IDS, GRAPH_REPO, GRAPH_STEADY } from "./workspace"
import { finishSignup, openChat } from "./app"

// Delay real HTTP with Chromium's network stack. No route interception: both
// the pending toast and the completed read cross the production persistence path.
for (const moment of ["during", "after"] as const) {
  test(`reloads ${moment} a slow Code read`, async ({ page }) => {
    await page.goto("/")
    await finishSignup(page)
    const composer = page.getByTestId("composer-input")
    await openChat(page)
    await composer.fill(`/flow.list ${GRAPH_REPO}`)
    await composer.press("Enter")
    await page.locator(`[data-flow="flow.plan"][data-flow-args="${GRAPH_FLOW}"]`).click()
    await expect(page.locator(".flow-plan-canvas [data-node]")).toHaveCount(GRAPH_NODE_IDS.length)
    await page.locator(`[data-node="${GRAPH_STEADY}"]`).click()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Network.enable")
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 4000, downloadThroughput: -1, uploadThroughput: -1 })
    await page.locator('.flow-graph-drawer-tab[data-tab="code"]').click()
    const toast = page.locator('[data-toast-status="running"]').filter({ hasText: "Reading " })
    await expect(toast).toBeVisible()
    if (moment === "after") await expect(page.locator(".flow-graph-code-file")).toBeVisible()
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await page.reload()
    await expect(page.locator(".flow-graph-drawer")).toHaveAttribute("data-node", GRAPH_STEADY)
    await expect(page.locator(".flow-graph-drawer")).toHaveAttribute("data-tab", "code")
    await expect(page.locator("main[data-fault]")).toHaveCount(0)
    await openChat(page)
    // The door is durable: the overlay reaches the screen a beat after the
    // click, and an Escape sent before it arrives closes a palette that is not
    // open yet — the open then lands behind it and Chat stays over the canvas.
    // Editable is not on screen, so the wait is for the composer itself.
    await expect(composer).toBeVisible()
    await expect(composer).toBeEditable()
    await composer.press("Escape")
    await expect(page.getByTestId("composer-overlay")).not.toBeVisible()
    // The interrupted read has an explicit retry door; its result is never invented.
    await page.locator(".flow-graph-code-open").click()
    await expect(page.locator(".world-card-panel").last()).toBeVisible()
  })
}

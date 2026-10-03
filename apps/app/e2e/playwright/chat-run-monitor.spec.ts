import { expect, test } from "./browserTest"
import { boxRunCardId, installCloudFixture, runningBox } from "./cloudFixture"

const repo = "smithersai/smithers", runId = "chat-monitor"
const journal = [
  { sequence: 1, kind: "control.agent.turn-opened", occurredAt: 100, payload: {} },
  { sequence: 2, kind: "control.agent.cell-call-started", occurredAt: 200, payload: { callId: "read", flowName: "read", input: { path: "src/index.ts" } } },
  { sequence: 3, kind: "control.agent.cell-call-settled", occurredAt: 300, payload: { callId: "read", flowName: "read", outcome: "success", value: "export {}" } },
  { sequence: 4, kind: "control.agent.turn-closed", occurredAt: 400, payload: {} },
  { sequence: 5, kind: "control.agent.turn-opened", occurredAt: 500, payload: {} },
  { sequence: 6, kind: "control.agent.cell-call-started", occurredAt: 600, payload: { callId: "edit", flowName: "edit", input: { path: "src/index.ts" } } }
]

for (const width of [390, 900]) test(`chat monitor stays reachable during work at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 800 })
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "cloud.pat"], workspaces: [runningBox("smithersai/smithers")] })
  await page.route("**/api/workflow/provision", route => route.fulfill({ json: { status: "ready", repo, gatewayId: "monitor" } }))
  await page.route("**/api/workflow/rpc", route => {
    const call = route.request().postDataJSON() as { payload: { selector?: { _tag?: string }; after?: { value: number } } }
    const tag = call.payload.selector?._tag
    const rows = tag === "run-summary" || tag === "workspace-runs"
      ? [{ runId, flowId: "coding", status: "running", createdAt: 100, updatedAt: 600,
        turns: 2, calls: 2, callsFailed: 0, editsAttempted: 1, editsSucceeded: 0, inputTokens: 0, outputTokens: 0, verdict: "running", diagnosis: "running" }]
      : tag === "run-events" ? journal.filter(row => row.sequence > (call.payload.after?.value ?? 0)) : []
    return route.fulfill({ json: { ok: true, payload: { cursor: { projection: tag, runId: null, value: 0 }, rows } } })
  })
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  const hint = page.locator('[data-first-sight-hint="chat"] .help-bubble')
  await expect(hint).toBeVisible()
  const hintBox = await hint.boundingBox()
  const footerBox = await page.getByRole("contentinfo", { name: "Chat controls" }).boundingBox()
  expect(hintBox!.width).toBeGreaterThan(280)
  expect(hintBox!.height).toBeLessThan(140)
  expect(hintBox!.x).toBeGreaterThanOrEqual(16)
  expect(hintBox!.x + hintBox!.width).toBeLessThanOrEqual(width - 16)
  expect(footerBox!.height).toBeLessThan(100)
  expect(hintBox!.y + hintBox!.height).toBeLessThanOrEqual(footerBox!.y)
  // #1755: no ancestor clips the hint's edges, and each Chat control reads on one line.
  expect(await hint.evaluate(node => {
    const box = node.getBoundingClientRect()
    const clipped: Array<string> = []
    for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX === "visible") continue
      const clip = parent.getBoundingClientRect()
      if (box.left < clip.left || box.right > clip.right) clipped.push(parent.className)
    }
    return clipped
  })).toEqual([])
  for (const control of await page.getByRole("contentinfo", { name: "Chat controls" }).locator(".guide-button").all()) {
    expect((await control.boundingBox())!.height).toBeLessThan(40)
  }
  const dismiss = page.getByRole("button", { name: "Dismiss help", exact: true })
  await dismiss.click()
  const composer = page.getByTestId("composer-input")
  await page.keyboard.press("Control+k")
  await composer.fill(`/runs.open ${runId} ${repo}`)
  await composer.press("Enter")
  await expect(page.getByTestId(`card-${boxRunCardId(repo, runId)}`)).toBeVisible()
  await page.keyboard.press("Escape")

  const dock = page.getByTestId("chat-run-timeline")
  await expect(dock).toBeVisible()
  const slider = dock.getByRole("slider", { name: "Run position" })
  await slider.focus()
  await page.keyboard.press("Home")
  await expect(slider).toHaveAttribute("aria-valuenow", "1")
  await page.reload()
  await expect(dock.getByRole("slider", { name: "Run position" })).toHaveAttribute("aria-valuenow", "1")
  await dock.getByRole("button", { name: "Latest", exact: true }).click()
  await expect(dock.getByRole("button", { name: "Latest", exact: true })).toHaveCount(0)
  expect(await dock.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  const box = await dock.boundingBox()
  expect(box!.y).toBeGreaterThan(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(800)
  const screenshot = info.outputPath(`chat-monitor-${width}.png`)
  await page.screenshot({ path: screenshot })
  await info.attach(`chat-monitor-${width}`, { path: screenshot, contentType: "image/png" })
  await page.keyboard.press("Control+k")
  await composer.fill("Keep checking the tests")
  await expect(composer).toHaveValue("Keep checking the tests")
  await expect(dock).toBeVisible()
})

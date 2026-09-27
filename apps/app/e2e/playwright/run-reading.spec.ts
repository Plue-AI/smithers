import { controlTabKey, expect, test, type Locator, type Page } from "./browserTest"
import { installCloudFixture } from "./cloudFixture"
import { preparedCodingJournal } from "../../src/mainview/cards/fixtures/CodingJournal"

// Producer-shaped fixtures test the real shell, controller and persistence.
// This tier establishes UI behavior, not provider execution or production deployment.
const repo = "smithersai/smithers", runId = "run-1"
const journal = [
  ...preparedCodingJournal(),
  { sequence: 6, kind: "control.agent.turn-opened", occurredAt: 600, payload: {} },
  { sequence: 7, kind: "control.agent.cell-produced", occurredAt: 700, payload: { text: 'const text = await ctx.call("read", { path: "src/memory.ts" });' } },
  { sequence: 8, kind: "control.agent.cell-call-started", occurredAt: 800, payload: { flowName: "read", callId: "read", input: { path: "src/memory.ts" } } },
  { sequence: 9, kind: "control.agent.cell-call-settled", occurredAt: 900, payload: { flowName: "read", callId: "read", outcome: "success", value: "export const memory = []" } },
  { sequence: 10, kind: "control.agent.cell-settled", occurredAt: 1000, payload: { outcome: "success" } },
  { sequence: 11, kind: "control.agent.turn-opened", occurredAt: 1100, payload: {} },
  { sequence: 12, kind: "control.agent.cell-call-started", occurredAt: 1200, payload: { flowName: "bash", callId: "check", input: { command: "bun run check //memory:typecheck" } } },
  { sequence: 13, kind: "control.agent.cell-call-settled", occurredAt: 1300, payload: { flowName: "bash", callId: "check", outcome: "success", value: { exitCode: 1 } } },
  { sequence: 14, kind: "control.run.failed", occurredAt: 1400, payload: {} }
]
const tabTo = async (page: Page, target: Locator) => {
  for (let index = 0; index < 120; index++) {
    if (await target.evaluate(node => node === document.activeElement)) return
    await page.keyboard.press(controlTabKey(page))
  }
  throw new Error("The run control was not reachable with Tab")
}
const command = async (page: Page, line: string) => {
  if (!await page.getByTestId("composer-input").isVisible()) await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(line)
  await page.getByTestId("composer-input").press("Enter")
  await page.keyboard.press("Escape")
}

for (const width of [900, 390]) test(`the run reads in one column at ${width}px and its keyboard expansion survives reload`, async ({ page }, info) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width, height: 1000 })
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "cloud.pat"] })
  await page.route("**/api/workflow/provision", route => route.fulfill({ json: { status: "ready", repo, gatewayId: "reading" } }))
  await page.route("**/api/workflow/rpc", route => {
    const call = route.request().postDataJSON() as { procedure: string; payload: { selector?: { _tag?: string }; after?: { value: number } } }
    const tag = call.payload.selector?._tag
    const rows = tag === "run-summary" || tag === "workspace-runs" ? [{ runId, flowId: "coding", status: "failed", createdAt: 1, updatedAt: 1400,
      turns: 2, calls: 2, callsFailed: 1, editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0, verdict: "failed", diagnosis: "failed" }]
      : tag === "run-events" ? journal.filter(row => row.sequence > (call.payload.after?.value ?? 0)) : []
    return route.fulfill({ json: { ok: true, payload: { cursor: { projection: tag, runId: null, value: 0 }, rows } } })
  })
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  const dismiss = page.getByRole("button", { name: "Dismiss", exact: true })
  if (await dismiss.isVisible()) await dismiss.click()
  await command(page, `/runs.open ${runId} ${repo}`)
  const card = page.getByTestId(`card-flow-run-${runId}`)
  const trace = card.getByTestId(`run-trace-${runId}`)
  await expect(trace.locator("[data-frame-line]")).toHaveCount(2)
  await expect(trace.getByLabel("Goals", { exact: true })).toBeVisible()
  await expect(trace.locator('[data-goal="memory"]')).toHaveAttribute("data-state", "failed")
  await expect(trace.getByLabel("Phases", { exact: true })).toBeVisible()
  for (const name of ["Call tree", "Waterfall", "Recorded call path", "Recorded turn source"]) await expect(trace.getByLabel(name, { exact: true })).toHaveCount(0)
  const screenshot = info.outputPath(`reading-${width}.png`)
  await card.screenshot({ path: screenshot })
  await info.attach(`reading-${width}`, { path: screenshot, contentType: "image/png" })
  const overflow = await trace.evaluate(node => {
    const bounds = node.getBoundingClientRect()
    return [...node.querySelectorAll("*")].filter(child => child.getBoundingClientRect().right > bounds.right + 1)
      .map(child => ({ class: child.className, width: child.getBoundingClientRect().width, right: child.getBoundingClientRect().right, parentRight: bounds.right }))
  })
  expect(overflow).toEqual([])
  const row = trace.locator('[data-frame-line="frame-1"]')
  await tabTo(page, row)
  expect(await row.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe("none")
  await page.keyboard.press("Enter")
  await expect(row).toHaveAttribute("aria-expanded", "true")
  await expect(trace.getByLabel("Recorded turn source", { exact: true })).toContainText('ctx.call("read"')
  await expect(trace.getByLabel("Call tree", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(row).toHaveAttribute("aria-expanded", "true")
  await expect(trace.getByLabel("Recorded turn source", { exact: true })).toContainText('ctx.call("read"')
  expect(await trace.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await tabTo(page, row)
  await page.keyboard.press("Space")
  await expect(row).toHaveAttribute("aria-expanded", "false")
  await expect(trace.getByLabel("Recorded turn source", { exact: true })).toHaveCount(0)
  await tabTo(page, trace.getByRole("button", { name: "Details", exact: true }))
  await page.keyboard.press("Enter")
  await expect(trace.getByLabel("Call tree", { exact: true })).toBeVisible()
  await expect(trace.getByLabel("Waterfall", { exact: true })).toBeVisible()
  await page.reload()
  await expect(trace).toHaveAttribute("data-view", "timeline")
  await command(page, `/runs.trace.select sourceCard=flow-run-${runId} ${runId} frame-1 9`)
  await expect(trace.locator('[data-goal="memory"]')).toHaveAttribute("data-state", "pending")
  await expect(trace.getByTestId(`run-outcome-${runId}`)).toHaveAttribute("data-phase", "failed")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
})

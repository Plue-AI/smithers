import { expect, test } from "../browserTest"
import { writeFile } from "node:fs/promises"
import { say } from "./j1-fixtures"

// Run with SMITHERS_J11_BROWSER=1 through TestJ11Rehearsal. The install runs
// the packaged native coding host, real checks and proxy; no API is intercepted.
test("C-J11-01: Inspect exposes native retries and read-only run evidence", async ({ page, context }, testInfo) => {
  const origin = process.env.SMITHERS_J11_ORIGIN
  const id = process.env.SMITHERS_J11_RUN
  test.skip(!origin || !id, "Run the composed TestJ11Rehearsal with SMITHERS_J11_BROWSER=1")
  const cookies: Array<{ Name: string; Value: string }> = JSON.parse(process.env.SMITHERS_J11_COOKIES!)
  await context.addCookies(cookies.map(c => ({ name: c.Name, value: c.Value, url: origin! })))
  await page.goto(origin!)
  await say(page, "/monitor")
  const card = page.getByTestId(`card-run:${id}`)
  await expect(card).toBeVisible({ timeout: 30_000 })
  const evidence = await page.request.get(`${origin}/api/runs/${encodeURIComponent(id!)}/trace`)
  expect(evidence.status()).toBe(200)
  const monitor = await evidence.json()
  await writeFile(testInfo.outputPath("run.json"), JSON.stringify(monitor, null, 2))
  expect(monitor.state).toBe("done")
  // The scripted judge may evaluate one additional imported boundary.
  // These are literal host-fixture metering oracles, independent of pricing.
  expect([{ tokens: 2520, cost_usd: 0.00071544 }, { tokens: 2640, cost_usd: 0.00072048 }]).toContainEqual({ tokens: monitor.tokens, cost_usd: monitor.cost_usd })
  const edits = monitor.attempts[0].steps.filter((step: { label: string }) => step.label === "Edited the files" && "usage" in step)
  expect(edits).toHaveLength(2)
  for (const edit of edits) expect(edit.usage).toEqual({ tokens: 440, cost_usd: 0.00012008 })
  for (const step of monitor.attempts[0].steps.filter((step: { label: string }) => step.label === "Ran checks")) {
    expect(step.usage).toBeUndefined()
  }
  const question = monitor.waits.find((wait: { kind: string }) => wait.kind === "question")
  expect(question.label).toBe("Which greeting should the file carry?")
  expect(question.settled.by.login).toBe("rehearsal-owner")
  expect(Date.parse(question.settled.at)).toBeGreaterThan(Date.parse(question.since))
  expect(monitor.engine.length).toBeGreaterThan(0)
  await card.getByRole("button", { name: "Inspect", exact: true }).press("Enter")
  const run = page.locator('.mvp-run[data-maximized]')
  await expect(run).toBeVisible()
  const timeline = run.getByRole("navigation", { name: "Run timeline" })
  await expect(timeline).toContainText("Ran checks · 1 failed")
  await expect(timeline).toContainText("Edited the files")
  await expect(timeline).not.toContainText("agent/trace/checkpoint")
  await expect(timeline).not.toContainText("<seal-step>")
  const editNode = `${monitor.attempts[0].run_id}:${encodeURIComponent(edits[0].id)}`
  await run.locator(".mvp-attempt button").evaluateAll((nodes, wanted) => {
    const button = nodes.find(node => node.getAttribute("data-node") === wanted)
    if (!(button instanceof HTMLButtonElement)) throw new Error("Native edit node missing")
    button.focus()
  }, editNode)
  await page.keyboard.press("Enter")
  const detail = run.getByRole("region", { name: "Selected step", exact: true })
  await expect(detail.locator(".mvp-run-step-io pre").first()).toBeVisible()
  await expect(detail.locator(".mvp-run-step-io pre")).not.toHaveCount(0)
  await expect(detail.locator(".mvp-run-transcript li").first()).toBeVisible()
  await expect(detail).toContainText(/\d+(?:\.\d+)?k? tokens/)
  await page.screenshot({ path: testInfo.outputPath("step.png") })
  await run.getByRole("tab", { name: "Journal", exact: true }).press("Enter")
  await expect(run.locator(".mvp-run-journal")).toContainText("control.engine.event")
  await page.screenshot({ path: testInfo.outputPath("journal.png") })
  await writeFile(testInfo.outputPath("dom.html"), await run.evaluate(node => node.outerHTML))
  const writes: string[] = []
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/runs") && request.method() !== "GET") writes.push(request.url())
  })
  const slider = run.getByRole("slider", { name: "Run position", exact: true })
  const historical = page.waitForResponse(r => new URL(r.url()).searchParams.get("at") === "0" && r.url().includes("/trace"))
  await slider.focus(); await slider.press("Home")
  expect((await historical).status()).toBe(200)
  await expect(run.locator(".mvp-run-journal li")).toHaveCount(1)
  await expect(run.locator(".mvp-run-journal")).toContainText("control.run.accepted")
  await expect(run.locator(".mvp-run-journal")).not.toContainText("control.engine.event")
  await slider.press("End")
  await expect(run.locator(".mvp-run-journal")).toContainText("control.engine.event")
  expect(writes).toEqual([])
  for (const label of [/^forks$/i, /^Fork$/i, /Rewind/i, /edit.and.rerun/i]) {
    await expect(run.getByRole("button", { name: label })).toHaveCount(0)
  }
})

test("native inspection backfills phase and cell summaries through the live subscription", async ({ page, context }, testInfo) => {
  const origin = process.env.SMITHERS_J11_ORIGIN
  const id = process.env.SMITHERS_J11_SUMMARY_RUN
  test.skip(!origin || !id, "Run TestJ11NativeSummaryBrowser with SMITHERS_J11_SUMMARY_BROWSER=1")
  const cookies: Array<{ Name: string; Value: string }> = JSON.parse(process.env.SMITHERS_J11_COOKIES!)
  await context.addCookies(cookies.map(c => ({ name: c.Name, value: c.Value, url: origin! })))
  const before = await (await page.request.get(`${origin}/api/runs/${encodeURIComponent(id!)}`)).json()
  expect(before.attempts[0].phases.length).toBeGreaterThan(0)
  for (const phase of before.attempts[0].phases) expect(phase.summary).toBeUndefined()
  await page.goto(origin!)
  await say(page, `/run.inspect ${id}`)
  const run = page.locator('.mvp-run[data-maximized]')
  await expect(run).toBeVisible()
  const model = process.env.SMITHERS_J11_SUMMARY_MODEL!
  await expect.poll(async () => (await (await page.request.get(`${model}/calls`)).json()).failed).toBeGreaterThan(0)
  await expect(run.getByText("Recorded checks summarized", { exact: true })).toHaveCount(0)
  const blocked = await (await page.request.get(`${origin}/api/runs/${encodeURIComponent(id!)}`)).json()
  expect(blocked.state).toBe(before.state)
  for (const phase of blocked.attempts[0].phases) {
    expect(phase.summary).toBeUndefined()
    for (const cell of phase.cells) expect(cell.explain).toBeUndefined()
  }
  expect((await page.request.post(`${model}/unblock`)).status()).toBe(204)
  // A settled journal cannot advance its native cursor. The model result
  // must refresh this mounted card without another command or HTTP poll.
  await expect(run.getByText("Recorded checks summarized", { exact: true }).first()).toBeVisible({ timeout: 35_000 })
  const after = await (await page.request.get(`${origin}/api/runs/${encodeURIComponent(id!)}`)).json()
  expect(after.state).toBe("failed")
  expect(after.attempts[0].phases.some((phase: { summary?: string }) => phase.summary === "Recorded checks summarized")).toBe(true)
  const labels = (value: typeof after) => value.attempts.map((attempt: { phases: Array<{ title: string; cells: Array<{ label: string }> }> }) => attempt.phases.map(phase => ({ title: phase.title, labels: phase.cells.map(cell => cell.label) })))
  expect(labels(after)).toEqual(labels(before))
  await expect(run.locator(".mvp-written").first()).toBeVisible()
  expect(after.attempts[0].phases.some((phase: { cells: Array<{ explain?: string }> }) => phase.cells.some(cell => cell.explain === "Recorded action explained"))).toBe(true)
  await writeFile(testInfo.outputPath("summary-run.json"), JSON.stringify(after, null, 2))
  await page.screenshot({ path: testInfo.outputPath("summaries.png") })
})

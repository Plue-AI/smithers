import { expect, test } from "../browserTest"
import { writeFile } from "node:fs/promises"
import { say } from "./j1-fixtures"

test("canonical merged archive remains inspectable through monitor and read-only replay", async ({ page, context }, testInfo) => {
  const origin = process.env.SMITHERS_J11_ORIGIN
  const id = process.env.SMITHERS_J11_SETTLED_RUN
  test.skip(!origin || !id, "Run TestJ11NativeMergedSettlement with SMITHERS_J11_NATIVE_SETTLEMENT_BROWSER=1")
  const cookies: Array<{ Name: string; Value: string }> = JSON.parse(process.env.SMITHERS_J11_COOKIES!)
  await context.addCookies(cookies.map(c => ({ name: c.Name, value: c.Value, url: origin! })))
  const response = await page.request.get(`${origin}/api/runs/${encodeURIComponent(id!)}/trace`)
  expect(response.status()).toBe(200)
  const archive = await response.json()
  expect(archive.state).toBe("done")
  expect(archive.attempts.length).toBeGreaterThan(0)
  expect(archive.journal.length).toBeGreaterThan(1)
  await writeFile(testInfo.outputPath("completed-archive.json"), JSON.stringify(archive, null, 2))
  await page.goto(origin!)
  await say(page, "/monitor")
  const card = page.getByTestId(`card-run:${id}`)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByRole("button", { name: "Inspect", exact: true }).press("Enter")
  const run = page.locator('.mvp-run[data-maximized]')
  await expect(run).toBeVisible()
  await expect(run.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
  await expect(run.getByRole("list", { name: "Attempt 1", exact: true })).toBeVisible()
  await run.getByRole("tab", { name: "Journal", exact: true }).press("Enter")
  await expect(run.locator(".mvp-run-journal")).toContainText("control.engine.event")
  const writes: string[] = []
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/runs") && request.method() !== "GET") writes.push(request.url())
  })
  const slider = run.getByRole("slider", { name: "Run position", exact: true })
  const historical = page.waitForResponse(r => r.url().includes("/trace") && new URL(r.url()).searchParams.get("at") === "0")
  await slider.focus()
  await slider.press("Home")
  expect((await historical).status()).toBe(200)
  await expect(run.locator(".mvp-run-journal li")).toHaveCount(1)
  // Exercise an interior position through the person's keyboard control,
  // rather than qualifying only the two endpoints of the archive.
  const interiorResponse = page.waitForResponse(r => {
    const url = new URL(r.url())
    return url.pathname.endsWith("/trace") && Number(url.searchParams.get("at")) > 0
  })
  await slider.press("PageUp")
  const interior = await interiorResponse
  expect(interior.status()).toBe(200)
  const at = Number(new URL(interior.url()).searchParams.get("at"))
  expect(at).toBeGreaterThan(0)
  expect(at).toBeLessThan(Number(await slider.getAttribute("max")))
  const replay = await interior.json()
  expect(replay.journal).toEqual(archive.journal.slice(0, replay.journal.length))
  expect(replay.journal.length).toBeGreaterThan(1)
  expect(replay.journal.length).toBeLessThan(archive.journal.length)
  await expect(run.locator(".mvp-run-journal li")).toHaveCount(replay.journal.length)
  const repeated = await page.request.get(interior.url())
  expect(repeated.status()).toBe(200)
  const again = await repeated.json()
  expect(again.journal).toEqual(replay.journal)
  const labels = (snapshot: typeof replay) => snapshot.attempts.map((attempt: {
    graph: unknown; phases: Array<{ id: string; title: string; cells: Array<{ id: string; label: string }> }>
  }) => ({ graph: attempt.graph, phases: attempt.phases.map(phase => ({
    id: phase.id, title: phase.title, cells: phase.cells.map(cell => ({ id: cell.id, label: cell.label }))
  })) }))
  expect(labels(again)).toEqual(labels(replay))
  await writeFile(testInfo.outputPath("interior-replay.json"), JSON.stringify({ at, replay, repeated: again }, null, 2))
  await slider.press("End")
  await expect(run.locator(".mvp-run-journal")).toContainText("control.engine.event")
  expect(writes).toEqual([])
  const retained = await page.request.get(`${origin}/api/runs/${encodeURIComponent(id!)}/trace`)
  expect(retained.status()).toBe(200)
  const restoredArchive = await retained.json()
  expect(restoredArchive.journal).toEqual(archive.journal)
  expect(labels(restoredArchive)).toEqual(labels(archive))
  await page.screenshot({ path: testInfo.outputPath("completed-journal.png") })
  // A new browser document must rediscover the durable archive through the
  // production catalog and authenticated topic, without the old card state.
  await page.reload()
  await say(page, "/monitor")
  const reloaded = page.getByTestId(`card-run:${id}`).last()
  await expect(reloaded).toBeVisible({ timeout: 30_000 })
  await reloaded.getByRole("button", { name: "Inspect", exact: true }).press("Enter")
  const restored = page.locator('.mvp-run[data-maximized]')
  await expect(restored.getByRole("list", { name: "Attempt 1", exact: true })).toBeVisible()
  await expect(restored.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
})

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
  const engine = run.locator("details[data-run-engine]")
  await expect(engine).toHaveCount(1)
  await expect(engine).not.toHaveAttribute("open")
  await engine.getByText("Engine", { exact: true }).press("Enter")
  await expect(engine).toHaveAttribute("open", "")
  await expect(engine.locator("li")).toHaveCount(monitor.engine.length)
  const waits = run.getByRole("list", { name: "Durable waits", exact: true })
  await expect(waits).toContainText("Which greeting should the file carry?")
  await expect(waits).toContainText(`since ${question.since}`)
  await expect(waits).toContainText("answered by")
  await expect(waits).toContainText(question.settled.at)
  await expect(run.getByRole("region", { name: "Custom view", exact: true })).toHaveCount(0)

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
  await expect(detail).toContainText("$0.00012008")
  const checkNode = run.locator(".mvp-attempt button").filter({ has: page.getByText("Ran checks", { exact: true }) }).first()
  await expect(checkNode).not.toContainText("$")
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
  test.setTimeout(180_000)
  const frames: string[] = []
  page.on("websocket", socket => socket.on("framereceived", frame => {
    frames.push(String(frame.payload))
    void writeFile(testInfo.outputPath("live-frames.json"), JSON.stringify(frames, null, 2))
  }))
  const active = process.env.SMITHERS_J11_SUMMARY_ACTIVE === "1"
  const origin = process.env.SMITHERS_J11_ORIGIN
  const id = process.env.SMITHERS_J11_SUMMARY_RUN
  test.skip(!origin || !id, "Run TestJ11NativeSummaryBrowser with SMITHERS_J11_SUMMARY_BROWSER=1")
  const cookies: Array<{ Name: string; Value: string }> = JSON.parse(process.env.SMITHERS_J11_COOKIES!)
  await context.addCookies(cookies.map(c => ({ name: c.Name, value: c.Value, url: origin! })))
  if (active) await expect.poll(async () => {
    const snapshot = await (await page.request.get(`${origin}/api/runs/${encodeURIComponent(id!)}`)).json()
    return snapshot.attempts[0]?.steps.some((step: { label: string; state: string }) => step.label === "monitor/retry-probe" && step.state === "running")
  }, { timeout: 20_000 }).toBe(true)
  const before = await (await page.request.get(`${origin}/api/runs/${encodeURIComponent(id!)}`)).json()
  expect(before.attempts[0].phases.length).toBeGreaterThan(0)
  for (const phase of before.attempts[0].phases) expect(phase.summary).toBeUndefined()
  if (active) expect(before.state).toBe("running")
  await page.goto(origin!)
  await say(page, `/run.inspect ${id}`)
  const run = page.locator('.mvp-run[data-maximized]')
  await expect(page.getByText("Run unavailable", { exact: true })).toHaveCount(0)
  await expect(run).toBeVisible({ timeout: 30_000 })
  const model = process.env.SMITHERS_J11_SUMMARY_MODEL!
  await expect.poll(async () => (await (await page.request.get(`${model}/calls`)).json()).failed).toBeGreaterThan(0)
  await expect(run.getByText("Recorded checks summarized", { exact: true })).toHaveCount(0)
  if (active) {
    await page.waitForTimeout(60_000)
    await expect(run.getByText("Recorded checks summarized", { exact: true })).toHaveCount(0)
    await expect(run.locator(".mvp-written")).toHaveCount(0)
  }
  const blocked = await (await page.request.get(`${origin}/api/runs/${encodeURIComponent(id!)}`)).json()
  expect(blocked.state).toBe(active ? "failed" : before.state)
  for (const phase of blocked.attempts[0].phases) {
    expect(phase.summary).toBeUndefined()
    for (const cell of phase.cells) expect(cell.explain).toBeUndefined()
  }
  const recoveredAt = Date.now()
  expect((await page.request.post(`${model}/unblock`)).status()).toBe(204)
  // A settled journal cannot advance its native cursor. The model result
  // must refresh this mounted card without another command or HTTP poll.
  await expect(run.getByText("Recorded checks summarized", { exact: true }).first()).toBeVisible({ timeout: 35_000 })
  if (active) await page.waitForTimeout(Math.max(0, 40_000 - (Date.now() - recoveredAt)))
  const after = await (await page.request.get(`${origin}/api/runs/${encodeURIComponent(id!)}`)).json()
  expect(after.state).toBe("failed")
  expect(after.attempts[0].phases.some((phase: { summary?: string }) => phase.summary === "Recorded checks summarized")).toBe(true)
  const labels = (value: typeof after) => value.attempts.map((attempt: { phases: Array<{ title: string; cells: Array<{ label: string }> }> }) => attempt.phases.map(phase => ({ title: phase.title, labels: phase.cells.map(cell => cell.label) })))
  expect(labels(after)).toEqual(labels(blocked))
  await expect(run.locator(".mvp-written").first()).toBeVisible()
  expect(after.attempts[0].phases.some((phase: { cells: Array<{ explain?: string }> }) => phase.cells.some(cell => cell.explain === "Recorded action explained"))).toBe(true)
  await writeFile(testInfo.outputPath("summary-run.json"), JSON.stringify(after, null, 2))
  await page.screenshot({ path: testInfo.outputPath("summaries.png") })
})

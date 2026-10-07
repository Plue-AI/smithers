import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// Contract proof for the monitor's served data path. The full C-J11-01 remains
// gated on native ingest, phase production, metering and the custom-view contract.
test("C-J11-01: install Inspect reads its authenticated run topic and journal", async ({ page }) => {
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "credentials", sandbox: null
  } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  const roster = { members: [{ login: "canary-owner", name: "Owner", avatar_url: "https://example.test/owner.png", color_index: 0,
    role: "owner", needs_access: false, suspended: false, actions: [] }], access_url: "https://github.com/smithersai/smithers/settings/access" }
  await page.route("**/api/members", route => route.fulfill({ json: roster }))
  const model = {
    id: "native-run", flow: "todo", version: "digest-1", title: "Native checks", state: "interrupted",
    attempts: [{ n: 1, run_id: "native-run", state: "interrupted",
      graph: [{ id: "checks", label: "Ran checks", state: "failed", deps: [] }],
      steps: [{ key: "checks#1", id: "checks", k: 1, label: "Ran checks", state: "failed", input: { command: "pnpm test" }, output: "2 failed",
        usage: { tokens: 1200, cost_usd: 0.12 }, took_s: 2 }],
      phases: [{ id: "native-run:checks#1", step: "checks#1", title: "Ran checks · 2 failed", took_s: 2, tone: "fail",
        cells: [{ id: "native-run:checks#1:3", kind: "run", label: "Ran checks", output: "2 failed" }] }] }],
    waits: [], tokens: 1200, time_s: 2, cost_usd: 0.12, engine: [{ label: "Checkpoint", detail: "agent/trace/checkpoint" }],
    journal: [], replay: { at: 3, last: 3 }
  }
  let listReads = 0
  let releaseList!: () => void
  const listReady = new Promise<void>(resolve => { releaseList = resolve })
  await page.route("**/api/runs", async route => {
    listReads++
    await listReady
    await route.fulfill({ json: [model, { ...model, id: "background-run", title: "Background native", flow: "flow-load", attempts: [] }] })
  })
  let holdReplay = false
  let replayReads = 0
  let releaseReplay!: () => void
  const replayReady = new Promise<void>(resolve => { releaseReplay = resolve })
  await page.route("**/api/runs/native-run/trace*", async route => {
    const at = Number(new URL(route.request().url()).searchParams.get("at") ?? "3")
    if (holdReplay && at === 0) { replayReads++; await replayReady }
    return route.fulfill({ json: { ...model, replay: { at, last: 3 },
      journal: at === 0 ? [] : [{ seq: 3, at: "2026-10-06T10:00:00Z", type: "step_failed", step: "checks#1", text: "2 failed" }] } })
  })
  let refreshRun: (() => void) | undefined
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    const frame = JSON.parse(String(raw)) as { t: string; id: number; topic?: string }
    if (frame.t !== "sub") return
    const data = frame.topic === "members" ? roster : frame.topic === "run:native-run" ? model : frame.topic === "run:background-run"
      ? { ...model, id: "background-run", title: "Background native", flow: "flow-load", attempts: [] } : undefined
    if (frame.topic === "run:native-run") refreshRun = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 2, data: { ...model, title: "Latest native checks" } }))
    socket.send(JSON.stringify(data === undefined ? { t: "err", id: frame.id, code: "unsupported" }
      : { t: "snap", id: frame.id, cursor: 1, data }))
  }))
  await page.goto("/")
  await say(page, "/run.inspect native-run")
  const run = page.getByRole("region", { name: "Run Native checks", exact: true })
  await expect(run).toBeVisible()
  await expect(run).toContainText("Interrupted")
  await expect(run).toContainText("Ran checks · 2 failed")
  await run.getByRole("tab", { name: "Journal", exact: true }).press("Enter")
  await expect(run.locator(".mvp-run-journal")).toContainText("2 failed")
  await page.reload()
  await say(page, "/run.inspect native-run")
  await expect(run.locator(".mvp-run-journal")).toContainText("2 failed")
  const writes: string[] = []
  page.on("request", request => {
    if (request.url().includes("/api/runs/") && request.method() !== "GET") writes.push(request.url())
  })
  const position = run.getByRole("slider", { name: "Run position", exact: true })
  holdReplay = true
  await position.focus(); await position.press("Home")
  await expect.poll(() => replayReads).toBe(1)
  refreshRun?.()
  await expect(run.locator(".mvp-run-journal")).toContainText("2 failed")
  await expect(page.getByRole("region", { name: "Run Latest native checks", exact: true })).toHaveCount(0)
  expect(replayReads).toBe(1)
  releaseReplay()
  await expect(run.locator(".mvp-run-journal")).not.toContainText("2 failed")
  await position.press("End")
  expect(writes).toEqual([])
  await page.getByRole("button", { name: "Restore", exact: true }).press("Enter")
  await say(page, "/monitor")
  await expect.poll(() => listReads).toBe(1)
  await say(page, "/monitor")
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  await expect.poll(() => listReads).toBe(1)
  releaseList()
  const background = page.getByRole("region", { name: "Run Background native", exact: true })
  await expect(background).toContainText("Interrupted")
  await expect(background.getByRole("button", { name: "Inspect", exact: true })).toBeVisible()
  expect(listReads).toBe(1)
  await say(page, "/run.inspect inaccessible-run")
  await expect(page.getByRole("alert").filter({ hasText: "Run unavailable" })).toBeVisible()
})

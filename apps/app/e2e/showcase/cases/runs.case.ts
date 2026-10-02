import { expect } from "@playwright/test"
import { preparedCodingJournal } from "../../../src/mainview/cards/fixtures/CodingJournal"
import { showcase } from "../showcase"
import { boxRunCardId, FIXTURE_BOX, runningBox } from "../../playwright/cloudFixture"

const REPO = "smithersai/smithers"
const REVIEW = "run-review-70"
const CODING = "run-coding-12"

// The coding run's recorded journal (e2e/playwright/run-reading.spec.ts): two turns, a failed check.
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

export default showcase({
  id: "runs",
  order: 100,
  title: "Runs",
  summary: "The run inbox; a run's trace and transcript; steer, re-seat and stop a live run.",
  flows: ["runs.list", "runs.open", "runs.trace.select", "runs.trace.view", "runs.logs", "runs.steps", "flow.run.retry", "runs.steer", "flow.run.stop"],
  run: async ({ page, app, backend }) => {
    const now = Date.now()
    const steers: Array<{ kind: string; body?: string }> = []
    const cancelled = new Set<string>()
    const summaries = new Map<string, number>()
    const openReceipt = Promise.withResolvers<void>()
    let holdOpen = true
    let refuseOpen = false
    const listReceipt = Promise.withResolvers<void>()
    let holdList = true
    let listReads = 0
    let refuseList = false
    const transcriptReceipt = Promise.withResolvers<void>()
    let holdTranscript = false
    let transcriptReads = 0
    let refuseTranscript = false
    const base = { editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0, diagnosis: "Recorded status" }
    const row = (runId: string) => {
      if (runId === CODING) return { ...base, runId, flowId: "coding", status: "failed", createdAt: now - 3_600_000, updatedAt: now - 3_000_000, turns: 2, calls: 2, callsFailed: 1, verdict: "failed" }
      const status = cancelled.has(runId) ? "cancelled" : "running"
      return { ...base, runId, flowId: "review-pr", status, createdAt: now - 240_000, updatedAt: now, turns: 3, calls: 7, callsFailed: 0,
        verdict: status, steeringPending: cancelled.has(REVIEW) ? 0 : steers.filter(steer => steer.body !== undefined).length }
    }
    await backend.cloud({ capabilities: ["agent", "identity", "cloud", "cloud.pat"], workspaces: [runningBox(REPO)] })
    await backend.json("/api/workflow/provision", { status: "ready", repo: REPO, gatewayId: "gw-1" })
    await backend.route(url => url.pathname === "/api/workflow/rpc", async route => {
      const call = route.request().postDataJSON() as { procedure: string; payload: { runId?: string; message?: { kind: string }; selector?: { _tag?: string; runId?: string }; after?: { value: number } } }
      const ok = (payload: unknown) => route.fulfill({ json: { ok: true, payload } })
      const rows = (projection: string, value: ReadonlyArray<unknown>) => ok({ cursor: { projection, runId: null, value: 0 }, rows: value })
      switch (call.procedure) {
        case "Steer": steers.push(call.payload.message ?? { kind: "" }); return ok({ _tag: "Accepted", receiptId: "ok" })
        case "Cancel": cancelled.add(call.payload.runId ?? ""); return ok({ _tag: "Accepted", receiptId: "ok" })
        case "Projection.Snapshot": {
          const selector = call.payload.selector ?? {}
          if (selector._tag === "workspace-runs") {
            listReads += 1
            if (holdList) await listReceipt.promise
            if (refuseList) { refuseList = false; return route.fulfill({ json: { ok: false, error: { message: "Run list unavailable" } } }) }
            return rows("workspace-runs", [row(REVIEW), row(CODING)])
          }
          if (selector._tag === "run-summary") summaries.set(selector.runId ?? REVIEW, (summaries.get(selector.runId ?? REVIEW) ?? 0) + 1)
          if (selector._tag === "run-summary") {
            if (selector.runId === CODING && holdOpen) await openReceipt.promise
            if (selector.runId === CODING && refuseOpen) return route.fulfill({ json: { ok: false, error: { message: "Run summary unavailable" } } })
            return rows("run-summary", [row(selector.runId ?? REVIEW)])
          }
          if (selector._tag === "run-events" && JSON.stringify(call.payload).includes(CODING)) {
            return rows("run-events", journal.filter(event => event.sequence > (call.payload.after?.value ?? 0)))
          }
          if (selector._tag === "transcript" && JSON.stringify(call.payload).includes(CODING)) {
            if (holdTranscript) { transcriptReads += 1; await transcriptReceipt.promise }
            if (refuseTranscript) { refuseTranscript = false; return route.fulfill({ json: { ok: false, error: { message: "Transcript unavailable" } } }) }
            return rows("transcript", [
              { runId: CODING, sequence: 7, turn: 1, at: now - 3_400_000, kind: "cell", text: 'const text = await ctx.call("read", { path: "src/memory.ts" })' },
              { runId: CODING, sequence: 12, turn: 2, at: now - 3_300_000, kind: "cell", text: "bun run check //memory:typecheck  →  exit 1" }
            ])
          }
          return rows(String(selector._tag), [])
        }
        default: return ok({ _tag: "Accepted", receiptId: "ok" })
      }
    })

    await app.open("/")
    await app.click(page.getByRole("button", { name: "Dismiss", exact: true }))
    await app.slash(`/runs.list ${REPO}`)
    const inbox = page.getByTestId(`card-run-list-${REPO}-${FIXTURE_BOX}`)
    const loadingList = page.locator('.toast[data-toast-status="running"]').filter({ hasText: "Loading runs" })
    try {
      await expect.poll(() => listReads).toBe(1)
      await expect(inbox).not.toContainText("No runs match.")
      await expect(loadingList).toHaveCount(1)
      await app.closeComposer()
      await page.keyboard.press("ControlOrMeta+k")
      await page.getByTestId("composer-input").fill("Chat while listing runs")
      await expect(page.getByTestId("composer-input")).toBeEditable()
      await page.keyboard.press("Escape")
      await inbox.getByRole("button", { name: "Refresh", exact: true }).focus()
      await page.keyboard.press("Enter")
      expect(listReads).toBe(1)
      await page.reload()
      await expect.poll(() => listReads).toBe(2)
      await expect(loadingList).toHaveCount(1)
    } finally { holdList = false; listReceipt.resolve() }
    await expect(inbox).toContainText(CODING)
    await expect(loadingList).toHaveCount(0)
    await inbox.getByTestId("run-list-chip-failed").focus()
    await page.keyboard.press("Enter")
    await expect(inbox.getByTestId(`runs-open-${CODING}`)).toBeVisible()
    await expect(inbox.getByTestId(`runs-open-${REVIEW}`)).toHaveCount(0)
    await page.reload()
    await expect(inbox.getByTestId(`runs-open-${CODING}`)).toBeVisible()
    await expect(inbox.getByTestId(`runs-open-${REVIEW}`)).toHaveCount(0)
    refuseList = true
    await inbox.getByRole("button", { name: "Refresh", exact: true }).focus()
    await page.keyboard.press("Enter")
    await expect(inbox.getByRole("alert")).toContainText("Run list unavailable")
    await expect(inbox).not.toContainText("No runs match.")
    await inbox.getByRole("button", { name: "Refresh", exact: true }).focus()
    await page.keyboard.press("Enter")
    await expect(inbox.getByRole("alert")).toHaveCount(0)
    await expect(inbox.getByTestId(`runs-open-${CODING}`)).toBeVisible()
    await inbox.getByRole("button", { name: "All", exact: true }).focus()
    await page.keyboard.press("Enter")
    await expect(inbox.getByTestId(`runs-open-${REVIEW}`)).toBeVisible()
    await app.closeComposer()
    await app.show(inbox)
    await app.beat(900)

    // A finished run reads as its recorded trace, and as its transcript.
    await inbox.getByTestId(`runs-open-${CODING}`).focus()
    await page.keyboard.press("Enter")
    const opening = page.locator('.toast[data-toast-status="running"]').filter({ hasText: "Opening run" })
    try {
      await expect.poll(() => summaries.get(CODING) ?? 0).toBe(1)
      await expect(opening).toHaveCount(1)
      await page.keyboard.press("ControlOrMeta+k")
      await page.getByTestId("composer-input").fill("Chat while opening a run")
      await expect(page.getByTestId("composer-input")).toBeEditable()
      await page.keyboard.press("Escape")
      await inbox.getByTestId(`runs-open-${CODING}`).focus()
      await page.keyboard.press("Enter")
      expect(summaries.get(CODING)).toBe(1)
      await page.reload()
      await expect.poll(() => summaries.get(CODING) ?? 0).toBe(2)
      await expect(opening).toHaveCount(1)
      refuseOpen = true
    } finally { holdOpen = false; openReceipt.resolve() }
    const refusal = page.locator('.toast[data-toast-status="failed"]').filter({ hasText: "Run summary unavailable" })
    await expect(refusal).toHaveCount(1)
    await page.reload()
    await expect(refusal).toHaveCount(1)
    refuseOpen = false
    await refusal.getByRole("button", { name: "Retry", exact: true }).focus()
    await page.keyboard.press("Enter")
    await expect(refusal).toHaveCount(0)
    const coding = page.getByTestId(`card-${boxRunCardId(REPO, CODING)}`)
    const trace = coding.getByTestId(`run-trace-${CODING}`)
    await expect(trace.locator("[data-frame-line]")).toHaveCount(2)
    await app.show(coding)
    const turn = trace.locator('[data-frame-line="frame-1"]')
    await app.click(turn)
    await expect(trace.getByLabel("Recorded turn source", { exact: true })).toContainText('ctx.call("read"')
    await app.beat(700)
    await app.click(trace.getByRole("button", { name: "Details", exact: true }))
    await expect(trace.getByLabel("Waterfall", { exact: true })).toBeVisible()
    await app.show(trace.getByLabel("Waterfall", { exact: true }))
    await app.beat(900)
    const transcript = coding.getByTestId(`flow-run-facet-transcript-${CODING}`)
    const steps = coding.getByTestId(`flow-run-facet-steps-${CODING}`)
    const reading = page.locator('.toast[data-toast-status="running"]').filter({ hasText: "Loading transcript" })
    holdTranscript = true
    try {
      await transcript.focus()
      await page.keyboard.press("Enter")
      await expect.poll(() => transcriptReads).toBe(1)
      await expect(transcript).toHaveAttribute("aria-selected", "true")
      await expect(reading).toHaveCount(1)
      await page.keyboard.press("ControlOrMeta+k")
      await page.getByTestId("composer-input").fill("Chat during a transcript read")
      await expect(page.getByTestId("composer-input")).toHaveValue("Chat during a transcript read")
      await page.keyboard.press("Escape")
      await transcript.focus()
      await page.keyboard.press("Enter")
      expect(transcriptReads).toBe(1)
      await page.reload()
      await page.getByRole("button", { name: "Chat", exact: true }).waitFor()
      await expect.poll(() => transcriptReads).toBe(2)
      await expect(transcript).toHaveAttribute("aria-selected", "true")
      await expect(reading).toHaveCount(1)
    } finally { holdTranscript = false; transcriptReceipt.resolve() }
    await expect(reading).toHaveCount(0)
    await expect(page.locator('.toast[data-toast-status="ok"]').filter({ hasText: "Transcript loaded" })).toHaveCount(1)
    refuseTranscript = true
    await transcript.focus()
    await page.keyboard.press("Enter")
    await expect(coding.getByRole("alert").filter({ hasText: "Transcript unavailable" })).toHaveCount(1)
    await transcript.focus()
    await page.keyboard.press("Enter")
    await expect(coding.getByRole("alert").filter({ hasText: "Transcript unavailable" })).toHaveCount(0)
    await steps.focus()
    await page.keyboard.press("Enter")
    await expect(steps).toHaveAttribute("aria-selected", "true")
    await page.reload()
    await expect(steps).toHaveAttribute("aria-selected", "true")
    const reads = summaries.get(CODING) ?? 0
    await app.click(coding.getByRole("button", { name: "Check again" }))
    await expect.poll(() => summaries.get(CODING) ?? 0).toBeGreaterThan(reads)
    await app.beat(500)

    // A live run takes a steer, stops from its toast.
    await app.show(inbox)
    await app.click(inbox.getByTestId(`runs-open-${REVIEW}`))
    const review = page.getByTestId(`card-${boxRunCardId(REPO, REVIEW)}`)
    await expect(review).toContainText("Running")
    await app.show(review)
    await app.type(review.getByTestId(`flow-run-steer-input-${REVIEW}`), "smaller diff")
    await app.click(review.getByRole("button", { name: "Steer" }))
    await expect(review).toContainText("steering pending")
    await app.beat(900)
    const toast = page.locator('.toast-stack .toast[data-toast-status="running"]').filter({ hasText: "review-pr" })
    await app.click(toast.getByRole("button", { name: "Stop" }))
    await expect(review.getByTestId(`run-outcome-${REVIEW}`)).toHaveAttribute("data-phase", "cancelled")
    // A stop the human asked for settles as a stop, not a failure (#1863).
    await expect(review).toContainText("Stopped")
    await expect(page.locator('.toast[data-toast-status="failed"]')).toHaveCount(0)
    await app.show(review)
    await app.beat(1200)
  }
})

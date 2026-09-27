import { expect } from "@playwright/test"
import review from "../../../src/mainview/cards/fixtures/register-repository-review.json"
import { showcase } from "../showcase"
import { runningBox } from "../../playwright/cloudFixture"

const REPO = "acme/widgets"
const RUN = "run-register-1"
const DIGEST = "d".repeat(64)
const ENVELOPE = { capabilities: [], flows: [], budget: {} }

/*
 * The journal a real register-repository run recorded (flows/test, the widgets
 * fixture), with the step values of a busier repository written into the same
 * node-settled records, so the report reads like the target screen.
 */
const week = (index: number) => new Date(Date.UTC(2026, 6, 4 + index * 7)).toISOString().slice(0, 10)
const richer: Record<string, unknown> = {
  "register-repository/license": {
    _tag: "license", spdx: "MIT",
    choice: { options: ["MIT", "Apache-2.0", "GPL-3.0"], chosen: "MIT", by: "smithers", evidence: ["LICENSE"] }
  },
  "register-repository/checks": {
    _tag: "checks",
    choice: { options: ["GitHub Actions", "Makefile", "Scripts"], chosen: "GitHub Actions", by: "smithers", evidence: [".github/workflows/ci.yml"] },
    commands: [{ kind: "test", argv: ["pnpm", "run", "test"], source: "package.json" }],
    workflows: [".github/workflows/ci.yml"]
  },
  "register-repository/intake": {
    _tag: "intake",
    choice: { options: ["Open, reviewed", "Maintainers only"], chosen: "Open, reviewed", by: "detected", evidence: [] },
    pulls: 50, external: 18, merged: 41, firstReviewHours: 3.5, contributing: true, cla: false
  },
  "register-repository/commits": {
    _tag: "commits", total: 412, bursts: 3,
    weeks: [[20, 0], [27, 3], [22, 5], [30, 9], [24, 11], [26, 18], [22, 19], [26, 27], [21, 29], [24, 37], [22, 35], [26, 42]]
      .map(([people, agents], index) => ({ start: week(index), people, agents }))
  },
  "register-repository/contributors": { _tag: "contributors", total: 24, shares: [120, 70, 40, 30, 20, 12, 10, 8], core: 4, coreShare: 0.74 },
  "register-repository/readiness": {
    _tag: "readiness", score: 72, level: 3,
    pillars: [{ id: "verify", score: 25, max: 25 }, { id: "ci", score: 15, max: 15 }, { id: "types", score: 11, max: 15 }, { id: "instructions", score: 0, max: 15 }],
    fixes: [{ pillar: "instructions", title: "Add AGENTS.md with verified commands", points: 7 }],
    runs: []
  },
  "register-repository/ci": { _tag: "ci", pr: 812, baselineMinutes: 14, estimateMinutes: 3, affected: 1, packages: 9 },
  "register-repository/cleanup": {
    _tag: "cleanup", status: "scored", coverage: 0.94, score: 18, low: 12, high: 24, method: "deterministic-v0",
    causes: [
      { signal: "duplicates", count: 23, location: { path: "src/api/handlers.ts", line: 40 } },
      { signal: "dead-code", count: 11, location: { path: "lib/util.ts", line: 12 } },
      { signal: "stubs", count: 3, location: { path: "src/sync.ts", line: 88 } }
    ]
  },
  "register-repository/workflows": {
    _tag: "workflows", scanned: 30,
    lintRules: [{ pr: 790, title: "No default exports" }, { pr: 744, title: "Await in loops" }],
    chores: [{ pr: 801, title: "Regenerate API types" }]
  }
}
const journal = (review as ReadonlyArray<{ sequence: number; payload: { eventType: string; payload: Record<string, unknown> } }>).map((row) => {
  const settled = row.payload.payload
  if (row.payload.eventType !== "flows.engine.node-settled" || typeof settled.action !== "string" || !(settled.action in richer)) return row
  const preview = JSON.stringify(richer[settled.action])
  return { ...row, payload: { ...row.payload, payload: { ...settled, result: { bytes: preview.length, preview, truncated: false } } } }
})

export default showcase({
  id: "register-repository",
  order: 12,
  title: "Register a repository",
  summary: "Paste a repository link; Smithers analyzes it while you watch, then it waits for review.",
  flows: ["repository.register", "form.submit"],
  viewport: { width: 1440, height: 900 },
  run: async ({ page, app, backend }) => {
    let started = 0
    await backend.cloud({ capabilities: ["agent", "identity", "cloud", "cloud.pat"], workspaces: [runningBox(REPO)] })
    await backend.json("/api/workflow/provision", { status: "ready", repo: REPO, gatewayId: "gw-1" })
    await backend.route(url => url.pathname.startsWith("/api/github/import"), route =>
      route.fulfill({ json: { importJobId: "job-1", status: "ready", repository: { owner: "acme", name: "widgets" } } }))
    await backend.route(url => url.pathname === "/api/workflow/rpc", async route => {
      const call = route.request().postDataJSON() as { procedure: string; payload: { flowId?: string; selector?: { _tag?: string }; after?: { value: number } } }
      const ok = (payload: unknown) => route.fulfill({ json: { ok: true, payload } })
      // The recorded journal arrives over a few seconds, one settled step at a time.
      const shown = started === 0 ? 0 : Math.floor((Date.now() - started) / 260)
      const visible = journal.slice(0, shown)
      const done = shown >= journal.length
      switch (call.procedure) {
        case "List": return ok({ _tag: "flows", items: [{ flowId: "register-repository", description: "Register a repository" }] })
        case "Plan": return ok({
          planId: "register-plan", flowId: "register-repository", digest: DIGEST, inputSummary: "{}", envelope: ENVELOPE, deployClass: false, nodes: [],
          approval: { target: { _tag: "Plan", planId: "register-plan", digest: DIGEST, envelope: ENVELOPE }, scope: "run", idempotencyKey: "approve:register-plan" }
        })
        case "Approval.Submit": return ok({ decision: { _tag: "Accepted", receiptId: "a" } })
        case "Run":
          started = Date.now()
          return ok({ _tag: "Accepted", receiptId: "r", runId: RUN })
        case "Projection.Snapshot": {
          const tag = call.payload.selector?._tag
          const status = done ? "waiting-approval" : "running"
          const rows = tag === "run-summary"
            ? [{ runId: RUN, flowId: "register-repository", status, createdAt: 1, updatedAt: 2, turns: 0, calls: 0, callsFailed: 0,
              editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0, verdict: status, diagnosis: status }]
            : tag === "run-events" ? visible.filter((row) => row.sequence > (call.payload.after?.value ?? 0)) : []
          return ok({ cursor: { projection: tag, runId: RUN, value: visible.at(-1)?.sequence ?? 0 }, rows })
        }
        default: return ok({ _tag: "Accepted", receiptId: "ok" })
      }
    })

    await app.open("/")
    // The one input: the Form Law's form for the flow's link, with its Register repository button.
    await app.slash("/repository.register")
    const form = page.locator('.smithers-card[data-kind="flow-form"]').last()
    await expect(form.getByRole("textbox", { name: "Repository link" })).toBeVisible()
    await app.closeComposer()
    await app.type(form.getByRole("textbox", { name: "Repository link" }), "github.com/acme/widgets")
    await app.click(form.getByRole("button", { name: "Register repository" }))
    const live = page.locator('[data-kind="registration"]').last()
    await expect(live).toContainText("github.com/acme/widgets")
    await app.show(live)
    await expect(live.locator(".registration-ai").first()).toBeVisible({ timeout: 30_000 })
    await expect(live).toContainText("Smithers chose")
    await expect(live).toContainText("Agent readiness", { timeout: 30_000 })
    await expect(live).toContainText("Lint rules in PRs")
    await expect(page.locator(".registration-status")).toContainText(REPO)
    await expect(page.locator(".registration-status")).toContainText("In review", { timeout: 30_000 })
    // The analysis toast settles with the run reaching review, not with its launch.
    await expect(page.getByText("Analyzing acme/widgets…")).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator(".toast")).toHaveCount(0, { timeout: 30_000 })
    // The import is the registration's own step: no card of its own, no job id anywhere.
    await expect(page.locator('[data-kind="repo-import"]')).toHaveCount(0)
    await expect(page.getByText("job-1")).toHaveCount(0)
    // The report is the registrant's one view: no run card, and no admin action they cannot take.
    await expect(page.locator('[data-kind="run-trace"]')).toHaveCount(0)
    await expect(page.getByText("Review approval")).toHaveCount(0)
    await live.evaluate((element) => element.scrollIntoView({ block: "start" }))
    await app.beat(1500)
    // The whole report fits the 1440×900 frame.
    const frame = await live.boundingBox()
    expect(frame !== null && frame.y + frame.height <= 900).toBe(true)
    await app.still("register")
    await app.still("register-report", live)
  }
})

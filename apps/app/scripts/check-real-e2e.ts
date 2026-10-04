#!/usr/bin/env bun
import { strict as assert } from "node:assert"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { OWED_ACTIONS_BY_FAMILY, RELEASE_CRITICAL_ACTIONS, UNSCENARIOED_ACTIONS } from "../e2e/real/coverage/deferrals"
import { checkRealE2E, formatGateReport } from "../e2e/real/coverage/gate"

const appRoot = resolve(import.meta.dir, "..")
const args = process.argv.slice(2)
const value = (flag: string): string | undefined => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
const reportFile = resolve(value("--report") ?? joinDefault(appRoot, "test-results/real-e2e-coverage.json"))
const report = checkRealE2E({
  realDir: resolve(value("--real-dir") ?? joinDefault(appRoot, "e2e/real")),
  excludedSpecs: process.env.SMITHERS_J1_ACTIVATION === "1" ? [] : [resolve(appRoot, "e2e/real/j1-activation.spec.ts")],
  flowNameFile: resolve(value("--flow-names") ?? joinDefault(appRoot, "src/mainview/flows/FlowName.ts")),
  resultsFile: value("--results") ? resolve(value("--results")!) : undefined,
  requireComplete: args.includes("--require-complete"),
  deferred: UNSCENARIOED_ACTIONS,
  releaseCritical: RELEASE_CRITICAL_ACTIONS,
  expectedRevision: value("--expected-revision"),
  expectedHost: value("--expected-host") as "local" | "production" | undefined
})

mkdirSync(dirname(reportFile), { recursive: true })
writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n")
console.log(formatGateReport(report, appRoot))
console.log(`machine report: ${reportFile}`)
if (!report.ok) process.exitCode = 1

function joinDefault(root: string, child: string): string {
  return `${root}/${child}`
}

// Reviewed baseline for #2560. A removed owed action remains accounted for once it has a real scenario.
{
  const baseline = {
    browser: [
      "app.hint.dismiss", "card.history.back", "card.history.forward", "chat", "chat.dictate",
      "chat.filter", "chat.filter.grep", "chat.filter.reset", "chat.filter.toggle", "chat.queue",
      "chat.queue.edit", "chat.queue.remove", "chat.queue.restore", "chat.queue.resume", "chat.reload",
      "cloud.prompt", "flow.plan.select", "flow.plan.tab", "flow.repo.choose", "history.view", "input.mode",
      "palette.actions", "palette.recent", "runs.coding.select", "runs.graph.execution", "runs.graph.follow", "runs.graph.select",
      "runs.graph.tab", "storage.recovery.export", "storage.recovery.reset", "sync.ops.show-more",
      "toast.dismiss", "wiki.pane", "wiki.view" ],
    diagnostics: [
      "admin.reset", "debug.backend", "debug.errors", "debug.events", "debug.net",
      "debug.reset", "debug.seams", "debug.snapshot", "debug.verbose",
    ],
    owed: [
      // Cut setup/signup specs no longer exercise these retained host actions.
      "approvals.open", "billing.plans", "billing.portal", "billing.upgrade", "history.todo",
      "agent.list",
      "branches.list", "change.checks", "change.pins", "change.resolve",
      "code.definition", "code.diagnostics",
      "code.hover", "commits.list", "commits.read", "egress.session", "env.remove-token", "env.set", "env.view", "files.list", "files.open-diff", "files.read", "findings.not-useful", "findings.please-fix",
      "flow.plan", "flow.run.retry", "github.app.choose", "github.app.open",
      "github.mirror-sync", "github.mirror.retry-ref", "github.reconcile", "history.bootstrap", "prs.triage", "wiki.attach", "wiki.cloud.delete", "wiki.cloud.new",
      "wiki.cloud.rename", "wiki.history", "wiki.space", "prs",
      "repo.choose", "repo.tree", "repo.update", "repos.import.retry", "review.ack",
      "review.done", "review.reopen", "review.since-mine", "review.unrequest", "runs.signal", "search.changes", "search.files", "search.history",
      "search.issues", "search.open", "search.runs", "search.secrets", "secrets.connect.codex",
      "secrets.move", "search.wiki", "secrets.scope",
      "history.backfill", "history.parallel", "history.retry", "history.show", "triggers.approve",
      "triggers.pause", "triggers.resume", "triggers.run", "box.images", "box.list", "box.session.destroy", // Added without a scenario since the review, or left without one by the MVP cut (#3385).
      "egress.allow", "form.submit", "history.land", "runs.continue", "secrets.bind",
    ],
  } as const
  const covered = new Set(report.scenarios.flatMap((scenario) => scenario.actions))
  for (const [family, actions] of Object.entries(OWED_ACTIONS_BY_FAMILY)) {
    assert.ok(actions.every((action) => action === family || action.startsWith(`${family}.`)), `${family} contains another family's action`)
  }
  const owedByFamily = Object.values(OWED_ACTIONS_BY_FAMILY).flat()
  assert.deepEqual([...owedByFamily].sort(), baseline.owed.filter((action) => !covered.has(action)).sort())
  for (const group of ["browser", "diagnostics", "owed"] as const) {
    const expected = group === "owed" ? owedByFamily : baseline[group]
    assert.deepEqual([...UNSCENARIOED_ACTIONS[group]].sort(), [...expected].sort(), `${group} registry parity`)
  }
}

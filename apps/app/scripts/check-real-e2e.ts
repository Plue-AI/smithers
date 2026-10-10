#!/usr/bin/env bun
import { strict as assert } from "node:assert"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { OWED_ACTIONS_BY_FAMILY, RELEASE_CRITICAL_ACTIONS, UNSCENARIOED_ACTIONS } from "../e2e/real/coverage/deferrals"
import { checkRealE2E, formatGateReport } from "../e2e/real/coverage/gate"
import { ignoredJourneys } from "../e2e/real/journeys"

const appRoot = resolve(import.meta.dir, "..")
const args = process.argv.slice(2)
const value = (flag: string): string | undefined => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
const reportFile = resolve(value("--report") ?? joinDefault(appRoot, "test-results/real-e2e-coverage.json"))
const report = checkRealE2E({
  realDir: resolve(value("--real-dir") ?? joinDefault(appRoot, "e2e/real")),
  excludedSpecs: ignoredJourneys(process.env).map((spec) => resolve(appRoot, "e2e/real", spec)),
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
// Actions that left the catalog (mvp.md Appendix A renames, #3434) or moved to the mvp.md §8/§16 deferral
// left this baseline with it; the MVP doors owed since the frontrun are reviewed here too (#3779).
{
  const baseline = {
    browser: [
      "app.hint.dismiss", "card.history.back", "card.history.forward", "chat", "chat.dictate",
      "chat.queue",
      "chat.queue.edit", "chat.queue.remove", "chat.queue.restore", "chat.reload",
      "cloud.prompt", "flow.plan.select", "flow.plan.tab", "input.mode",
      "palette.actions", "palette.recent", "runs.coding.select", "runs.graph.execution", "runs.graph.follow", "runs.graph.select",
      "runs.graph.tab", "storage.recovery.export", "storage.recovery.reset", "sync.ops.show-more",
      "toast.dismiss", "wiki.pane", "wiki.view" ],
    diagnostics: [
      "admin.reset", "debug.backend", "debug.errors", "debug.events", "debug.net",
      "debug.reset", "debug.snapshot", "debug.verbose",
    ],
    owed: [
      "change.resolve",
      "code.definition", "code.diagnostics",
      "code.hover", "egress.session", "findings.not-useful", "findings.please-fix",
      "flow.plan",
      "github.mirror-sync", "github.mirror.retry-ref", "history.bootstrap", "wiki.attach", "wiki.cloud.delete", "wiki.cloud.new",
      "wiki.cloud.rename", "wiki.history", "wiki.space",
      "review.ack",
      "review.done", "review.reopen", "review.since-mine", "review.unrequest", "runs.signal", "search.changes", "search.files", "search.history",
      "search.issues", "search.runs", "search.secrets",
      "search.wiki",
      "box.images", "box.session.destroy", // Added without a scenario since the review, or left without one by the MVP cut (#3385).
      "egress.allow", "form.submit", "runs.continue",
    ],
    /** MVP doors and frontrun additions owed outside the families (deferrals.ts). */
    doors: [
      "agent", "branch.bring-in", "branch.discard-foreign", "file.compare", "file.follow-rename", "file.reapply",
      "file.restore-deleted", "learning.accept", "learning.dismiss", "main.reset-to-github", "merge.confirm", "model.edit",
      "model.list", "model.new", "model.remove", "model.save", "model.show", "model.test", "monitor", "order.ok",
      "settings.model.set", "todo.preapprove", "todo.takeover", "todo.unapprove", "agent.edit", "auth.email",
      "background.dismiss", "background.retry", "branch.add-to-stack", "branch.archive", "branch.fork", "branch.rebase",
      "confirm.cancel", "debug-api", "docs", "draft.discard", "flow.source", "github", "issue.comment", "issues",
      "notifications.allow", "run", "run.inspect", "ssh", "stack", "stack.move", "todo.amend", "todo.drop",
      "todo.from-issue", "todo.resume", "todo.retry-current-flow", "todo.stop", "wiki.page", "wiki.save",
    ],
  } as const
  const covered = new Set(report.scenarios.flatMap((scenario) => scenario.actions))
  for (const [family, actions] of Object.entries(OWED_ACTIONS_BY_FAMILY)) {
    assert.ok(actions.every((action) => action === family || action.startsWith(`${family}.`)), `${family} contains another family's action`)
  }
  const owedByFamily = Object.values(OWED_ACTIONS_BY_FAMILY).flat()
  assert.deepEqual([...owedByFamily].sort(), baseline.owed.filter((action) => !covered.has(action)).sort())
  for (const group of ["browser", "diagnostics", "owed"] as const) {
    const expected = group === "owed" ? [...owedByFamily, ...baseline.doors.filter((action) => !covered.has(action))] : baseline[group]
    assert.deepEqual([...UNSCENARIOED_ACTIONS[group]].sort(), [...expected].sort(), `${group} registry parity`)
  }
}

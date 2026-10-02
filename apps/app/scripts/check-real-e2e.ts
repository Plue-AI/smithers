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
      "chat.filter", "chat.filter.grep", "chat.filter.reset", "chat.filter.toggle", "chat.queue",
      "chat.queue.edit", "chat.queue.remove", "chat.queue.restore", "chat.queue.resume", "chat.reload",
      "cloud.prompt", "flow.plan.select", "flow.plan.tab", "flow.repo.choose", "history.view", "input.mode",
      "palette.actions", "palette.recent", "runs.coding.select", "runs.graph.execution", "runs.graph.follow", "runs.graph.select",
      "runs.graph.tab", "smithers.who", "storage.recovery.export", "storage.recovery.reset", "sync.ops.show-more",
      "toast.dismiss", "wiki.pane", "wiki.select", "wiki.view", "workspace.rename.edit",
    ],
    diagnostics: [
      "admin.reset", "debug.backend", "debug.errors", "debug.events", "debug.net",
      "debug.reset", "debug.seams", "debug.snapshot", "debug.verbose", "model.fixture",
    ],
    owed: [
      "admin.grant.confirm", "agent.list",
      "agent.session.list", "agent.session.new", "agent.session.say", "agent.session.stop", "agent.session.view",
      "branches.list", "change.checks", "change.pins", "change.request", "change.resolve",
      "change.revert", "change.split", "code.definition", "code.diagnostics",
      "code.hover", "commits.list", "commits.read", "connect", "egress.session", "env.remove-token", "env.set", "env.view", "feature.prototype",
      "files.list", "files.open-diff", "integrations.admit", "integrations.list", "issues.comment.react", "issues.comment.retry",
      "issues.fix", "issues.set", "issues.verify", "files.read", "findings.not-useful", "findings.please-fix",
      "flow.plan", "flow.run.retry", "flows", "github.app.choose", "github.app.open",
      "github.mirror-sync", "github.mirror.retry-ref", "github.reconcile", "history.bootstrap", "issues",
      "prs.triage", "wiki.ask", "wiki.attach", "wiki.cloud.delete", "wiki.cloud.new",
      "wiki.cloud.rename", "wiki.history", "wiki.space", "notifications.read-update", "notifications.tag",
      "plugins", "plugins.install", "plugins.list", "plugins.remove", "prs",
      "repo.choose", "repo.tree", "repo.update", "repos.import.retry", "review.ack",
      "review.done", "review.reopen", "review.since-mine", "review.unrequest", "runs.release", "runs.seat",
      "runs.signal", "runs.takeover", "search.boxes", "search.changes", "search.files", "search.history",
      "search.issues", "search.open", "search.runs", "search.secrets", "secrets.connect.codex",
      "secrets.move", "search.targets", "search.wiki", "setup.ask", "setup.discard",
      "setup.discard.confirm", "setup.guide", "setup.retry", "setup.work", "secrets.scope",
      "history.backfill", "history.parallel", "history.retry", "history.show", "triggers.approve",
      "triggers.pause", "triggers.resume", "triggers.run", "box.images", "box.list", "workspace.rename",
      "box.session.destroy", "box.select",
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

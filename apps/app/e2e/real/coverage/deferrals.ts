import { approvals } from "./deferrals/approvals"
import { billing } from "./deferrals/billing"
import { box } from "./deferrals/box"
import { branches } from "./deferrals/branches"
import { change } from "./deferrals/change"
import { commits } from "./deferrals/commits"
import { egress } from "./deferrals/egress"
import { files } from "./deferrals/files"
import { findings } from "./deferrals/findings"
import { flow } from "./deferrals/flow"
import { form } from "./deferrals/form"
import { github } from "./deferrals/github"
import { history } from "./deferrals/history"
import { issues } from "./deferrals/issues"
import { plugins } from "./deferrals/plugins"
import { prs } from "./deferrals/prs"
import { repo } from "./deferrals/repo"
import { repos } from "./deferrals/repos"
import { runs } from "./deferrals/runs"
import { search } from "./deferrals/search"
import { secrets } from "./deferrals/secrets"
import { triggers } from "./deferrals/triggers"
import { wiki } from "./deferrals/wiki"

/**
 * The reviewed ledger of built-in actions that have no real scenario.
 *
 * The real E2E gate fails an action with neither a scenario nor an entry here,
 * an entry whose action gained a scenario or left FLOW_NAMES, and an entry for
 * a release-critical action. Delete an entry in the change that adds its
 * scenario.
 */

/** Journeys the release depends on. Only a real scenario can account for them. */
export const RELEASE_CRITICAL_ACTIONS: readonly string[] = [
  "approval.approve", "approval.deny", "change.land", "settings.model-key", "secrets"
]

export type Deferral = "browser" | "diagnostics" | "owed" | "deferred: mvp.md §8/§16"

export const OWED_ACTIONS_BY_FAMILY = {
  approvals,
  box,
  branches,
  change,
  commits,
  egress,
  files,
  findings,
  flow,
  form,
  github,
  history,
  issues,
  plugins,
  prs,
  runs,
  search,
  secrets,
  wiki,
} as const

export const UNSCENARIOED_ACTIONS: Readonly<Record<Deferral, readonly string[]>> = {
  "deferred: mvp.md §8/§16": [...billing, ...repo, ...repos, ...triggers],
  /** Acts only on this browser's UI or storage; no host contract to break. */
  browser: [
    "app.hint.dismiss", "card.history.back", "card.history.forward",
    "chat", "chat.dictate",
    "chat.queue", "chat.queue.edit", "chat.queue.remove", "chat.queue.restore", "chat.reload", "cloud.prompt", "flow.plan.select",
    "flow.plan.tab", "input.mode", "palette.actions", "palette.recent",
     "runs.coding.select", "runs.graph.execution", "runs.graph.follow", "runs.graph.select", "runs.graph.tab",
    "storage.recovery.export", "storage.recovery.reset", "sync.ops.show-more",
    "run.view", "toast.dismiss", "wiki.pane", "wiki.view"
  ],
  /** Developer tooling, not a user journey. */
  diagnostics: [
    "admin.reset", "debug.backend", "debug.errors", "debug.events", "debug.net",
    "debug.reset", "debug.snapshot", "debug.verbose"
  ],
  /** Host-backed; a real scenario is owed. */
  owed: [
    ...Object.values(OWED_ACTIONS_BY_FAMILY).flat(),
    // Frontrun additions: host-backed actions owe real scenarios (#2290).
    "agent",
    "branch.bring-in",
    "branch.discard-foreign",
    "branch.rebase-now",
    "file.compare",
    "file.follow-rename",
    "file.reapply",
    "file.restore-deleted",
    "image.add",
    "learning.accept",
    "learning.dismiss",
    "main.reset-to-github",
    "merge.confirm",
    "model.assign",
    "model.edit",
    "model.list",
    "model.new",
    "model.remove",
    "model.save",
    "model.show",
    "model.test",
    "monitor",
    "order.ok",
    "proposal",
    "settings.daily-admissions",
    "settings.model.set",
    "settings.preapprove-default",
    "todo.preapprove",
    "todo.takeover",
    "todo.unapprove",
    // Current MVP doors still owe real-host scenarios (#2290). These are gaps, never executed coverage.
    "agent.claude",
    "agent.codex",
    "auth.email",
    "background.dismiss",
    "background.retry",
    "branch",
    "branch.add-to-stack",
    "branch.fork",
    "branch.rebase",
    "confirm.cancel",
    // DARK (#3504): activation awaits the T-APP-16 context provider (#3446).
    "context.inspect",
    "debug-api",
    "diff",
    "docs",
    "draft.discard",
    "file",
    "file.restore",
    "files",
    "flow.source",
    "flows",
    "github",
    "github.retry",
    "issue",
    "issue.comment",
    "issue.new",
    "issues",
    "merge",
    // DARK (#3558): activation awaits the T-APP-07 entry provider and synchronous person dispatch.
    "notifications.allow",
    "pr",
    "review",
    "run",
    "run.inspect",
    "runs",
    "settings",
    "settings.address",
    "settings.capacity",
    "settings.obsidian",
    "settings.parallel",
    "ssh",
    "stack",
    "stack.move",
    "terminal.send",
    "todo",
    "todo.amend",
    "todo.answer",
    "todo.drop",
    "todo.from-issue",
    "todo.resume",
    "todo.retry",
    "todo.retry-current-flow",
    "todo.steer",
    "todo.stop",
    "wiki.page",
    "wiki.save",
  ]
}

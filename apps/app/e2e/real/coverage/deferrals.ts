import { approvals } from "./deferrals/approvals"
import { billing } from "./deferrals/billing"
import { box } from "./deferrals/box"
import { branches } from "./deferrals/branches"
import { change } from "./deferrals/change"
import { code } from "./deferrals/code"
import { commits } from "./deferrals/commits"
import { egress } from "./deferrals/egress"
import { env } from "./deferrals/env"
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
  "approval.approve", "approval.deny", "change.land", "secrets.connect", "secrets.connections",
  "secrets.list", "secrets.revoke"
]

export type Deferral = "browser" | "diagnostics" | "owed" | "deferred: mvp.md §8/§16"

export const OWED_ACTIONS_BY_FAMILY = {
  approvals,
  box,
  branches,
  change,
  code,
  commits,
  egress,
  env,
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
    "chat.queue", "chat.queue.edit", "chat.queue.remove", "chat.queue.restore", "chat.queue.resume", "chat.reload", "cloud.prompt", "flow.plan.select",
    "flow.plan.tab", "flow.repo.choose", "input.mode", "palette.actions", "palette.recent",
    "history.view", "runs.coding.select", "runs.graph.execution", "runs.graph.follow", "runs.graph.select", "runs.graph.tab",
    "storage.recovery.export", "storage.recovery.reset", "sync.ops.show-more",
    "toast.dismiss", "wiki.pane", "wiki.view"
  ],
  /** Developer tooling, not a user journey. */
  diagnostics: [
    "admin.reset", "debug.backend", "debug.errors", "debug.events", "debug.net",
    "debug.reset", "debug.seams", "debug.snapshot", "debug.verbose"
  ],
  /** Host-backed; a real scenario is owed. */
  owed: Object.values(OWED_ACTIONS_BY_FAMILY).flat()
}

import { admin } from "./deferrals/admin"
import { agent } from "./deferrals/agent"
import { app } from "./deferrals/app"
import { approvals } from "./deferrals/approvals"
import { billing } from "./deferrals/billing"
import { box } from "./deferrals/box"
import { branches } from "./deferrals/branches"
import { change } from "./deferrals/change"
import { code } from "./deferrals/code"
import { commits } from "./deferrals/commits"
import { connect } from "./deferrals/connect"
import { desktop } from "./deferrals/desktop"
import { egress } from "./deferrals/egress"
import { env } from "./deferrals/env"
import { feature } from "./deferrals/feature"
import { files } from "./deferrals/files"
import { findings } from "./deferrals/findings"
import { flow } from "./deferrals/flow"
import { flows } from "./deferrals/flows"
import { github } from "./deferrals/github"
import { history } from "./deferrals/history"
import { integrations } from "./deferrals/integrations"
import { issues } from "./deferrals/issues"
import { notifications } from "./deferrals/notifications"
import { plugins } from "./deferrals/plugins"
import { prs } from "./deferrals/prs"
import { repo } from "./deferrals/repo"
import { repos } from "./deferrals/repos"
import { review } from "./deferrals/review"
import { runs } from "./deferrals/runs"
import { search } from "./deferrals/search"
import { secrets } from "./deferrals/secrets"
import { setup } from "./deferrals/setup"
import { triggers } from "./deferrals/triggers"
import { wiki } from "./deferrals/wiki"
import { workspace } from "./deferrals/workspace"

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
  "approval.approve", "approval.deny", "change.land", "repository.register", "secrets.connect", "secrets.connections",
  "secrets.list", "secrets.revoke", "setup.configure", "setup.run", "signup.account", "signup.answer",
  "signup.back", "signup.finish", "signup.next", "signup.repo", "signup.set"
]

export type Deferral = "browser" | "diagnostics" | "owed"

export const OWED_ACTIONS_BY_FAMILY = {
  admin,
  agent,
  app,
  approvals,
  billing,
  box,
  branches,
  change,
  code,
  commits,
  connect,
  desktop,
  egress,
  env,
  feature,
  files,
  findings,
  flow,
  flows,
  github,
  history,
  integrations,
  issues,
  notifications,
  plugins,
  prs,
  repo,
  repos,
  review,
  runs,
  search,
  secrets,
  setup,
  triggers,
  wiki,
  workspace,
} as const

export const UNSCENARIOED_ACTIONS: Readonly<Record<Deferral, readonly string[]>> = {
  /** Acts only on this browser's UI or storage; no host contract to break. */
  browser: [
    "app.download.prompt", "app.first-run.dismiss", "app.hint.dismiss",
    "chat", "chat.dictate", "chat.filter", "chat.filter.grep", "chat.filter.reset", "chat.filter.toggle",
    "chat.queue", "chat.queue.edit", "chat.queue.remove", "chat.queue.restore", "chat.queue.resume", "chat.reload", "cloud.prompt", "flow.plan.select",
    "flow.plan.tab", "flow.repo.choose", "input.mode", "palette.actions", "palette.recent",
    "history.view", "runs.coding.select", "runs.graph.execution", "runs.graph.follow", "runs.graph.select", "runs.graph.tab",
    "smithers.who", "storage.recovery.export", "storage.recovery.reset", "sync.ops.show-more",
    "toast.dismiss", "wiki.pane", "wiki.select", "wiki.view", "workspace.rename.edit"
  ],
  /** Developer tooling, not a user journey. */
  diagnostics: [
    "admin.reset", "debug.backend", "debug.errors", "debug.events", "debug.net",
    "debug.reset", "debug.seams", "debug.snapshot", "debug.verbose", "model.fixture"
  ],
  /** Host-backed; a real scenario is owed. */
  owed: Object.values(OWED_ACTIONS_BY_FAMILY).flat()
}

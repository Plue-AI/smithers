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
  "secrets.list", "secrets.revoke", "setup.configure", "setup.run", "signup.account", "signup.answer",
  "signup.back", "signup.finish", "signup.next", "signup.repo", "signup.set"
]

export type Deferral = "browser" | "diagnostics" | "owed"

export const UNSCENARIOED_ACTIONS: Readonly<Record<Deferral, readonly string[]>> = {
  /** Acts only on this browser's UI or storage; no host contract to break. */
  browser: [
    "app.download.prompt", "app.experimental", "app.first-run.dismiss", "app.hint.dismiss",
    "chat", "chat.dictate", "chat.filter", "chat.filter.grep", "chat.filter.reset", "chat.filter.toggle",
    "chat.queue", "chat.queue.edit", "chat.queue.remove", "chat.queue.restore", "chat.queue.resume", "chat.reload", "cloud.prompt", "experimental.set", "flow.plan.select",
    "flow.plan.tab", "flow.repo.choose", "input.mode", "palette.actions", "palette.recent",
    "runs.coding.select", "runs.graph.follow", "runs.graph.select", "runs.graph.tab", "setup.view",
    "smithers.who", "storage.recovery.export", "storage.recovery.reset", "sync.ops.show-more",
    "tab.close.cancel", "tab.menu", "toast.dismiss", "wiki.select", "workspace.rename.edit"
  ],
  /** Developer tooling, not a user journey. */
  diagnostics: [
    "admin.reset", "debug.backend", "debug.errors", "debug.events", "debug.net",
    "debug.reset", "debug.seams", "debug.snapshot", "debug.verbose", "model.fixture"
  ],
  /** Host-backed; a real scenario is owed. */
  owed: [
    "admin.grant.confirm", "admin.queue.approve", "admin.requests", "agent.change", "agent.list",
    "agent.session.list", "agent.session.new", "agent.session.say", "agent.session.stop",
    "agent.session.view", "app.download", "approvals.open", "billing.plans", "billing.portal",
    "billing.upgrade", "branches.list", "change.checks", "change.pins", "change.request", "change.resolve",
    "change.revert", "change.split", "change.split-ready", "chores.setup", "ci.setup", "code.definition",
    "code.diagnostics", "code.hover", "commits.list", "commits.read", "connect", "desktop", "egress.session",
    "env.set", "env.view", "feature.prototype", "feature.setup", "files.list", "files.open-diff",
    /* Threads, tasks and integrations (smithers-ui-DESIGN.md): the chat backend and the task metadata are still landing. */
    "integrations.list", "issues.comment.react", "issues.comment.retry", "issues.fix", "issues.set", "issues.verify",
    "files.read", "findings.not-useful", "findings.please-fix", "flow.plan", "flow.run.retry", "flows",
    "github.app.choose", "github.app.open", "github.mirror-sync", "github.mirror.retry-ref",
    "github.reconcile", "history.bootstrap", "issues",
    /* The app home's doors (PRODUCT.md D-18): the browser spec covers the launch; the real workspace run is owed. */
    "prs.triage", "wiki.ask",
    "issues.setup", "notifications.read-update", "notifications.tag", "plugins", "plugins.install",
    "plugins.list", "plugins.remove", "prs", "repo.choose", "repo.overview", "repo.tree", "repo.update",
    "repos.import.retry", "review.ack", "review.done", "review.reopen", "review.setup", "review.since-mine",
    "review.unrequest", "runs.seat", "runs.signal", "search.boxes", "search.changes", "search.files",
    "search.history", "search.issues", "search.open", "search.runs", "search.secrets", "secrets.connect.codex", "secrets.move",
    "search.targets", "search.wiki", "setup.ask", "setup.discard", "setup.discard.confirm", "setup.guide",
    "setup.retry", "setup.work",
    // History writes/readback still need real-host receipts: https://github.com/smithersai/smithers/issues/1921.
    "history.backfill", "history.parallel", "history.retry", "history.show",
    // Resume reuses the reviewed registration; authenticated host acceptance remains #1939.
    "tab.close.confirm", "triggers.approve", "triggers.pause", "triggers.resume", "triggers.run",
    "box.desktop", "box.desktop.open", "box.desktop.rotate", "box.desktop.stop",
    "box.images", "box.list", "workspace.rename", "box.session.destroy"
  ]
}

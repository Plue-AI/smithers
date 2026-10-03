package services

import "slices"

// SystemFlows is the install-owned catalog (engineering spec §11.1). The
// coding host receives these exact names; a repository cannot replace them.
// Legacy repository responsibility names remain reserved while their machinery
// stays hidden for the maintainer release.
var SystemFlows = []string{
	"stack", "stack.move", "stack.propose",
	// Product Appendix B.2: stack/TODO operations and their retained aliases.
	"history.show", "history.view", "history.parallel", "history.bootstrap", "history.backfill",
	"todo.new", "todo.from-issue", "todo.answer", "todo.steer", "todo.amend", "todo.stop", "todo.resume", "todo.retry", "todo.drop", "todo.takeover",
	"issue.implement", "runs.steer", "history.retry",
	"branch.fork", "branch.add-to-stack", "branch.rebase",
	// B.2: merge, members, settings/model access, and repository secrets.
	"merge", "history.land", "prs.land", "change.land",
	"members", "members.add", "members.role", "members.remove",
	"settings", "secrets.connect", "secrets.connect.codex", "secrets.connections", "secrets.move", "secrets.revoke",
	"secrets", "secrets.list", "secrets.set", "secrets.delete", "secrets.scope", "secrets.bind",
	// B.2: admission/approvals, sync/mirrors, and install/GitHub setup.
	"admission", "approvals.list", "approvals.open", "runs.attention", "approval.approve", "approval.deny",
	"sync", "github.reconcile", "github.mirror-sync", "github.mirror.retry-ref", "sync.ops.show-more",
	"setup", "github.app", "github.app.choose", "github.app.open", "repos.import", "repos.import.retry",
	"flow-load", "summarizer",
	"repository/setup", "repository/trigger",
	"repository-jobs/issues", "repository-jobs/review", "repository-jobs/ci", "repository-jobs/feature", "repository-jobs/chores",
	// Packaged execution delegates remain install-owned until the TODO
	// composition replaces their separately dispatched runs (T-FLW-11).
	// Reservation is unconditional: missing optional project configuration
	// disables a packaged route; it never transfers its name to repository code.
	"coding", "coding/dispatch", "coding/implementation", "coding/request", "coding/vibe", "coding/verify", "coding/wiki",
}

// Overridable reports whether a flow name belongs to repository code. Matching
// is exact: reserving merge never reserves merge/x or Merge. Name validity is
// the flow loader's responsibility.
func Overridable(name string) bool { return !slices.Contains(SystemFlows, name) }

// BuiltinFlowDefaults names the packaged defaults for overridable product
// flows. The TODO composition ships in T-FLW-11; learning ships in T-FLW-06
// (stage 3). These are path declarations required by T-FLW-01, not executable
// entries; activation and consumption belong to T-FLW-03.
var BuiltinFlowDefaults = map[string]string{
	"todo":     "flows/todo/flow.ts",
	"learning": "flows/learning/flow.ts",
	"review":   "flows/review/flow.ts",
}

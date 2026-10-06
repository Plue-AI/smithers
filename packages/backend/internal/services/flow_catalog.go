package services

import (
	_ "embed"
	"maps"
	"slices"
)

// SystemFlows is the install-owned catalog (engineering spec §11.1). The
// coding host receives these exact names; a repository cannot replace them.
// Legacy repository responsibility names remain reserved while their machinery
// stays hidden for the maintainer release.
var SystemFlows = []string{
	"stack", "stack.move", "stack.candidate", "stack.propose",
	// Product Appendix B.2: stack/TODO operations and their retained aliases.
	"history.show", "history.view", "history.parallel", "history.bootstrap", "history.backfill",
	"todo.new", "todo.from-issue", "todo.answer", "todo.steer", "todo.amend", "todo.stop", "todo.resume", "todo.retry", "todo.retry-current-flow", "todo.drop", "todo.takeover",
	"todo.preapprove", "todo.unapprove",
	"history.todo", "issue.implement", "runs.steer", "history.retry",
	"branch.fork", "branch.add-to-stack", "branch.rebase",
	// B.4: foreign-push answers stay install-owned even before their
	// confirmation and checkpoint providers become available.
	"branch.bring-in", "branch.discard-foreign",
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

// FlowCard is one flow as GET /api/flows serves it: the Flow card's model
// (FlowCardSchema in packages/rpc/src/FlowCard.ts). System is separate from
// Source: a built-in flow is overridable unless it is a system flow, and only
// a system flow refuses Edit (§11.1).
type FlowCard struct {
	Name     string        `json:"name"`
	Source   FlowSource    `json:"source"`
	System   bool          `json:"system"`
	Versions []FlowVersion `json:"versions"`
}

// FlowSource is where a flow's Active version comes from: the install
// ({"builtin": true}) or the repository's file ({"path": ...}).
type FlowSource struct {
	Builtin bool   `json:"builtin,omitempty"`
	Path    string `json:"path,omitempty"`
}

// FlowVersion is one version of a flow (§4.3). Its ID is the version's digest.
type FlowVersion struct {
	ID    string     `json:"id"`
	State string     `json:"state"`
	Todo  int64      `json:"todo,omitempty"`
	Error string     `json:"error,omitempty"`
	Steps []FlowStep `json:"steps"`
}

// FlowStep is one step of a version, or the TODO flow's trailing wait for
// merge (ID "merge", Wait) with the signals that resume it.
type FlowStep struct {
	ID      string       `json:"id"`
	Label   string       `json:"label,omitempty"`
	Wait    bool         `json:"wait,omitempty"`
	Signals []FlowSignal `json:"signals,omitempty"`
}

// FlowSignal sends the merge wait back to a step: a clean rebase to Verify,
// a steer to Implement (§10.4.1).
type FlowSignal struct {
	On string `json:"on"`
	To string `json:"to"`
}

// builtinFlowsJSON holds the digest of each built-in version the install
// ships: the composition's content digest, as the flow registry measures the
// descriptor Executable.catalog binds. flows/test/coding-builtin-routes.test.ts
// fails when a built-in composition changes without this file.
//
//go:embed builtin_flows.json
var builtinFlowsJSON []byte

// builtinFlowSteps are the steps of each built-in version the Flow card
// shows, in order (mvp.md J5.2: plan, implement, verify, review, propose,
// then wait for merge).
var builtinFlowSteps = map[string][]FlowStep{
	"todo": {
		{ID: "plan", Label: "Plan"},
		{ID: "implement", Label: "Implement"},
		{ID: "verify", Label: "Verify"},
		{ID: "review", Label: "Review"},
		{ID: "propose", Label: "Propose"},
		{ID: "merge", Wait: true, Signals: []FlowSignal{{On: "rebase", To: "Verify"}, {On: "steer", To: "Implement"}}},
	},
}

// FlowCatalog is the install's flow catalog before a repository is bound
// (GET /api/flows): each overridable flow the install ships, with its
// built-in version Active. No system flow is listed. A repository's catalog,
// with the versions flow-load recorded, is RepositoryFlowCatalog.
func FlowCatalog() ([]FlowCard, error) {
	digests, err := builtinFlowDigests()
	if err != nil {
		return nil, err
	}
	names := slices.Sorted(maps.Keys(builtinFlowSteps))
	cards := make([]FlowCard, 0, len(names))
	for _, name := range names {
		cards = append(cards, FlowCard{Name: name, Source: FlowSource{Builtin: true},
			Versions: []FlowVersion{{ID: digests[name], State: "active", Steps: builtinFlowSteps[name]}}})
	}
	return cards, nil
}

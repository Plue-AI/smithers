package services

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// TerminalFactory is the stack with a scripted outside world, for the
// terminal walkthrough in package services_test: GitHub is a bare
// repository with recorded issues and pull requests, and the Cloud lanes'
// flow runs are answered by the test. Everything else (the stack service,
// its Postgres rows and notifications) is the real one.
type TerminalFactory struct{ o *mythicalOrchestration }

// NewTerminalFactory is a bootstrapped stack for smithers-canary/smithers
// whose person signed in with GitHub as roninjin10, the policy's maintainer.
func NewTerminalFactory(t *testing.T) *TerminalFactory {
	t.Helper()
	o := signedInMaintainer(t)
	_, err := o.pool.Exec(context.Background(), `UPDATE repositories SET mirror_destination = 'https://github.com/smithersai/smithers' WHERE id = $1`, o.repoID)
	require.NoError(t, err)
	// The person is a member of the install: members make TODOs.
	_, err = o.pool.Exec(context.Background(), `INSERT INTO members (user_id, login, role) VALUES ($1, 'roninjin10', 'owner')`, o.userID)
	require.NoError(t, err)
	return &TerminalFactory{o: o}
}

// Service is the real stack service the routes serve.
func (f *TerminalFactory) Service() *MythicalService { return f.o.service }

// Pool is the stack's Postgres pool, for the event broker and auth rows.
func (f *TerminalFactory) Pool() *pgxpool.Pool { return f.o.pool.(*pgxpool.Pool) }

// RepositoryID and UserID name the repository and its owner.
func (f *TerminalFactory) RepositoryID() int64 { return f.o.repoID }
func (f *TerminalFactory) UserID() int64       { return f.o.userID }

// Wake runs one claim of the stack worker with every item due.
func (f *TerminalFactory) Wake() { f.o.wake() }

// item is TODO T<n>'s work record.
func (f *TerminalFactory) item(n int64) db.MythicalItem {
	f.o.t.Helper()
	item, err := db.New(f.o.pool).GetMythicalItemByTodo(context.Background(), f.o.repoID, n)
	require.NoError(f.o.t, err)
	return item
}

// State is TODO T<n>'s item state and reason, as the stack stored them.
func (f *TerminalFactory) State(n int64) (string, string) {
	item := f.item(n)
	return item.State, item.Reason
}

// TodoState is TODO T<n>'s state.
func (f *TerminalFactory) TodoState(n int64) string {
	f.o.t.Helper()
	todo, err := db.New(f.o.pool).GetTodoByNumber(context.Background(), db.GetTodoByNumberParams{RepositoryID: f.o.repoID, Number: n})
	require.NoError(f.o.t, err)
	return todo.State
}

// Launches counts the flow runs the stack launched for flowID.
func (f *TerminalFactory) Launches(flowID string) int { return len(f.o.launcher.byFlow(flowID)) }

// Implement answers T<n>'s running coding/request as a validated change
// whose two checks passed on the candidate, and hands the lane's candidate
// commit over, as the Cloud lane does. It returns the candidate.
func (f *TerminalFactory) Implement(n int64, file string) string {
	o := f.o
	o.t.Helper()
	item := f.item(n)
	require.Equal(o.t, "running", item.State, item.Reason)
	stack, err := db.New(o.pool).GetMythicalStack(context.Background(), o.repoID)
	require.NoError(o.t, err)
	summary := "📝 docs: add " + file
	candidate := o.laneResult(item.WorkspaceID, stack.TipCommit, map[string]string{file: "x\n"}, summary)
	runID := fmt.Sprintf("run-request-T%d-%d", n, item.Attempt)
	output := `{"plan":{"changes":[{"title":"Docs","atoms":[{"changeId":null,"message":"` + summary + `"}],` +
		`"checks":[{"id":"affected-lint","target":".","flow":"checks/affected-lint","flowDigest":"f","tier":"fast","required":true},` +
		`{"id":"affected-test","target":".","flow":"checks/affected-test","flowDigest":"s","tier":"slow","required":true}]}]},` +
		`"outcome":{"status":"validated","rounds":1,"blocked":null,"result":{"status":"validated","findings":[],"changes":[{"implementation":{},"receipts":[` +
		flowReceipt("affected-lint", "fast", "passed", candidate) + `,` + flowReceipt("affected-test", "slow", "passed", candidate) + `]}]}}}`
	o.project(o.launcher.last("coding/request"), jobs.StateCompleted, runID, output)
	o.wake()
	_, err = o.service.SubmitLane(context.Background(), o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: item.WorkspaceID,
		Base: stack.TipCommit, Source: candidate, RequestRunID: runID, Summary: summary})
	require.NoError(o.t, err)
	return candidate
}

// Stop fails T<n>'s running coding/request with a typed fault, as a Cloud
// run that could not go on reports it.
func (f *TerminalFactory) Stop(n int64, fault, tag string) {
	o := f.o
	o.t.Helper()
	item := f.item(n)
	require.Equal(o.t, "running", item.State, item.Reason)
	o.fail(o.launcher.last("coding/request"), fmt.Sprintf("run-request-T%d-%d", n, item.Attempt), fault, tag, "")
}

// MergeOnGitHub is a maintainer merging T<n>'s open pull request on GitHub
// (M-22: a merge on GitHub counts); the stack sees it on its next pass.
func (f *TerminalFactory) MergeOnGitHub(n int64) {
	o := f.o
	o.t.Helper()
	item := f.item(n)
	_, err := o.github.Merge(context.Background(), mythicalGitHubRepo{}, item.PRNumber.Int64, item.PRHead)
	require.NoError(o.t, err)
	// A reported merge must exist on real GitHub main (§4.1). The generic
	// fake receipt alone is intentionally insufficient reachability evidence.
	o.git(o.work, "pull", "-q", "--ff-only", o.github.dir, "main")
	o.git(o.work, "fetch", "-q", o.github.dir, item.PRHead)
	o.git(o.work, "merge", "-q", "--squash", item.PRHead)
	o.git(o.work, "commit", "-q", "-m", item.IssueTitle)
	merged := o.git(o.work, "rev-parse", "HEAD")
	o.github.merge(item.PRNumber.Int64, merged)
	o.git(o.work, "push", "-q", o.github.dir, "main:refs/heads/main")
}

// Review answers every launched review with verdict, as coding/review does.
func (f *TerminalFactory) Review(verdict string) { f.o.answerReviews(verdict) }

// Merged is the head GitHub merged for T<n>'s pull request, if any.
func (f *TerminalFactory) Merged(n int64) string {
	item := f.item(n)
	f.o.github.mu.Lock()
	defer f.o.github.mu.Unlock()
	return f.o.github.merges[item.PRNumber.Int64]
}

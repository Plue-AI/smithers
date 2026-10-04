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
	o := filingTodos(t)
	_, err := o.pool.Exec(context.Background(), `UPDATE repositories SET mirror_destination = 'https://github.com/smithersai/smithers' WHERE id = $1`, o.repoID)
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

// State is an item's state and reason, as the stack stored them.
func (f *TerminalFactory) State(number int64) (string, string) {
	item := f.o.item(number)
	return item.State, item.Reason
}

// Launches counts the flow runs the stack launched for flowID.
func (f *TerminalFactory) Launches(flowID string) int { return len(f.o.launcher.byFlow(flowID)) }

// Implement answers the running item's coding/request as a validated
// change whose two checks passed on the candidate, and hands the lane's
// candidate commit over, as the Cloud lane does. It returns the candidate.
func (f *TerminalFactory) Implement(number int64, file string) string {
	o := f.o
	o.t.Helper()
	item := o.item(number)
	require.Equal(o.t, "running", item.State, item.Reason)
	stack, err := db.New(o.pool).GetMythicalStack(context.Background(), o.repoID)
	require.NoError(o.t, err)
	summary := "📝 docs: add " + file
	candidate := o.laneResult(item.WorkspaceID, stack.TipCommit, map[string]string{file: "x\n"}, summary)
	runID := fmt.Sprintf("run-request-%d-%d", number, item.Attempt)
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

// Stop fails the running item's coding/request with a typed fault, as a
// Cloud run that could not go on reports it.
func (f *TerminalFactory) Stop(number int64, fault, tag string) {
	o := f.o
	o.t.Helper()
	item := o.item(number)
	require.Equal(o.t, "running", item.State, item.Reason)
	o.fail(o.launcher.last("coding/request"), fmt.Sprintf("run-request-%d-%d", number, item.Attempt), fault, tag, "")
}

// Automerge is the maintainer labeling the filed issue automerge on GitHub.
func (f *TerminalFactory) Automerge(number int64) {
	o := f.o
	o.t.Helper()
	o.github.mu.Lock()
	var issue mythicalIssue
	for i := range o.github.issues {
		if o.github.issues[i].Number == number {
			o.github.issues[i].Labels = []string{todoLabel, automergeLabel}
			issue = o.github.issues[i]
		}
	}
	o.github.mu.Unlock()
	require.Equal(o.t, number, issue.Number, "#%d was not filed", number)
	o.github.recordLabel(number, todoLabel, "roninjin10")
	o.github.recordLabel(number, automergeLabel, "roninjin10")
	require.NoError(o.t, seedMythicalIssue(o.service, context.Background(), o.repoID, issue,
		gitHubLabelApplication{Label: automergeLabel, ByMaintainer: true}))
}

// Review answers every launched review with verdict, as coding/review does.
func (f *TerminalFactory) Review(verdict string) { f.o.answerReviews(verdict) }

// Merged is the head GitHub merged for the item's pull request, if any.
func (f *TerminalFactory) Merged(number int64) string {
	item := f.o.item(number)
	f.o.github.mu.Lock()
	defer f.o.github.mu.Unlock()
	return f.o.github.merges[item.PRNumber.Int64]
}

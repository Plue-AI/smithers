package product

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"
)

// The TODO migration (T-STK-01) backfills one TODO per item that passed
// admission, with the state spec §4.1.0 projects (written out by hand here),
// revision 1, one imported event, and an item branch. An item whose pull
// request is open keeps its GitHub branch, so it never opens a second PR.
func TestTodosMigrationBackfillsOneTodoPerAdmittedItem(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	registered, err := registeredMigrations()
	if err != nil {
		t.Fatal(err)
	}
	version := 0
	for _, spec := range migrationRegistry {
		if strings.HasSuffix(spec.path, "_todos.sql") {
			version = spec.version
		}
	}
	var todos migration
	for _, m := range registered {
		if m.version == version {
			todos = m
			break
		}
		if _, err := pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol); err != nil {
			t.Fatalf("migration %d: %v", m.version, err)
		}
	}
	if todos.sql == "" {
		t.Fatal("the TODO migration is not registered")
	}
	type fixture struct {
		issue      int64
		source     string
		state      string
		title      string
		approved   bool
		runID      string
		pr         int64
		prState    string
		round      int
		pendingOp  string
		checks     string
		wantState  string // "" when the item is no TODO
		wantName   string
		wantGitHub string
	}
	fixtures := []fixture{
		{issue: 1, state: "queued", title: "Fix the login", approved: true, wantState: "queued", wantName: "smithers/fix-the-login"},
		{issue: 2, state: "skipped", title: "Just a question"},
		{issue: 3, state: "declined", title: "Already done", approved: true, wantState: "dropped"},
		{issue: 4, state: "cancelled", title: "Closed while queued", approved: true, wantState: "dropped"},
		{issue: 5, state: "cancelled", title: "Closed, never a TODO"},
		{issue: 6, state: "running", title: "Launching", approved: true, wantState: "starting"},
		{issue: 7, state: "running", title: "Implementing", approved: true, runID: "run-7", wantState: "starting"},
		{issue: 8, state: "delivering", title: "Delivering", approved: true, runID: "run-8", wantState: "working"},
		{issue: 9, state: "integrating", title: "Integrating", approved: true, runID: "run-9", wantState: "working"},
		{issue: 10, state: "verifying", title: "Verifying", approved: true, runID: "run-10", wantState: "working"},
		{issue: 11, state: "proposing", title: "Proposing", approved: true, runID: "run-11", wantState: "working"},
		{issue: 12, state: "waiting", title: "Waiting", approved: true, runID: "run-12", wantState: "working"},
		{issue: 13, state: "retrying", title: "Retrying", approved: true, runID: "run-13", wantState: "starting"},
		{issue: 14, state: "proposed", title: "In review", approved: true, pr: 5, prState: "open", round: 1, wantState: "in_review",
			wantName: "smithers/issue-14-r1", wantGitHub: "smithers/issue-14-r1"},
		{issue: 15, state: "landed", title: "Merged", approved: true, pr: 6, prState: "merged", wantState: "merged"},
		{issue: 16, state: "rejected", title: "Closed PR", approved: true, pr: 7, prState: "closed", wantState: "dropped"},
		{issue: 17, state: "blocked", title: "Stopped", approved: true, checks: `{"fault":{"class":"policy","tag":"launch_bound","kind":"stopped"}}`,
			wantState: "failed"},
		{issue: 18, state: "blocked", title: "Blocked rebuild", approved: true, pr: 8, prState: "open", wantState: "failed"},
		{issue: 19, state: "integrating", title: "Rebuilding", approved: true, pr: 9, prState: "open", wantState: "working"},
		{issue: 20, state: "proposing", title: "Pushed, no PR yet", approved: true, round: 3, pendingOp: `{"branch":"smithers/old-head-20-r3","expected":"","head":"abc"}`,
			wantState: "working", wantName: "smithers/old-head-20-r3", wantGitHub: "smithers/old-head-20-r3"},
		// Its slug is another item's PR branch: the PR branch keeps its name.
		{issue: 21, state: "queued", title: "Issue 14 r1", approved: true, wantState: "queued", wantName: "smithers/issue-14-r1-2"},
		// §4.1.0: a current-generation first step, not a run ID, establishes work.
		{issue: 22, state: "running", title: "Started", approved: true, checks: `{"firstStep":{"generation":0}}`, wantState: "working"},
		{issue: 23, state: "running", title: "Old step", approved: true, checks: `{"firstStep":{"generation":9}}`, wantState: "starting"},
		{issue: 24, state: "running", title: "PR launching", approved: true, pr: 24, prState: "open", wantState: "starting"},
		{issue: 25, state: "retrying", title: "PR retrying", approved: true, pr: 25, prState: "open", wantState: "starting"},
		{issue: 26, state: "queued", title: "PR queued", approved: true, pr: 26, prState: "open", wantState: "in_review"},
		{source: "chat", state: "integrating", title: "A chat result", runID: "run-c", wantState: "working", wantName: "smithers/a-chat-result"},
	}
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, username, lower_username) VALUES (1, 'ben', 'ben');
		INSERT INTO repositories (id, user_id, name, lower_name) VALUES (1, 1, 'repo', 'repo')`, pgx.QueryExecModeSimpleProtocol); err != nil {
		t.Fatal(err)
	}
	for i, f := range fixtures {
		source := f.source
		if source == "" {
			source = "issue"
		}
		approved := ""
		if f.approved {
			approved = "digest"
		}
		var issue, pr any
		if f.issue != 0 {
			issue = f.issue
		}
		if f.pr != 0 {
			pr = f.pr
		}
		var pending, checks any
		if f.pendingOp != "" {
			pending = f.pendingOp
		}
		if f.checks != "" {
			checks = f.checks
		}
		candidate := ""
		if source == "chat" {
			candidate = strings.Repeat("a", 40)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO mythical_items (repository_id, issue_number, issue_title, issue_body, issue_digest, approved_digest,
			source, state, reason, request_run_id, pr_number, pr_state, proposal_round, pending_op, checks, summary, candidate_head, created_at, updated_at)
			VALUES (1, $1, $2, $3, 'digest', $4, $5, $6, 'why', $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14,
			        now() - make_interval(mins => $15), now() - make_interval(mins => $15))`,
			issue, f.title, "body of "+f.title, approved, source, f.state, f.runID, pr, f.prState, f.round, pending, checks,
			"summary of "+f.title, candidate, 100-i); err != nil {
			t.Fatalf("item %d: %v", i, err)
		}
	}
	// Each repository numbers independently, including the backfill. The
	// same admitted issue/title in another repository starts at T1 again.
	if _, err := pool.Exec(ctx, `INSERT INTO repositories (id, user_id, name, lower_name) VALUES (2, 1, 'second', 'second');
		INSERT INTO mythical_items (repository_id, issue_number, issue_title, issue_body, issue_digest, approved_digest, source, state)
		VALUES (2, 1, 'Fix the login', 'second body', 'd', 'd', 'issue', 'queued')`, pgx.QueryExecModeSimpleProtocol); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, todos.sql, pgx.QueryExecModeSimpleProtocol); err != nil {
		t.Fatalf("TODO migration: %v", err)
	}

	number := int64(0)
	for i, f := range fixtures {
		name := fmt.Sprintf("fixture %d (%s %s)", i, f.state, f.title)
		var todoID *string
		if err := pool.QueryRow(ctx, `SELECT todo_id::text FROM mythical_items WHERE repository_id = 1 AND issue_title = $1`, f.title).Scan(&todoID); err != nil {
			t.Fatal(err)
		}
		if f.wantState == "" {
			if todoID != nil {
				t.Errorf("%s: never admitted, yet has a TODO", name)
			}
			continue
		}
		if todoID == nil {
			t.Fatalf("%s: no TODO", name)
		}
		number++
		var state, title, branchName, prompt, reason, kind, toState string
		var github *string
		var n, events int64
		var fixes bool
		var issueNumber *int64
		var failure *string
		if err := pool.QueryRow(ctx, `SELECT t.number, t.state, t.title, t.fixes_issue, t.issue_number, t.failure::text, t.branch_name, t.github_branch,
				r.prompt, r.reason, e.kind, e.to_state, (SELECT count(*) FROM todo_events WHERE todo_id = t.id)
			FROM todos t
			JOIN todo_revisions r ON r.todo_id = t.id AND r.rev = 1
			JOIN todo_events e ON e.todo_id = t.id AND e.seq = 1
			WHERE t.id = $1`, *todoID).Scan(&n, &state, &title, &fixes, &issueNumber, &failure, &branchName, &github, &prompt, &reason, &kind, &toState, &events); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if n != number {
			t.Errorf("%s: number %d, want %d (sequential by creation)", name, n, number)
		}
		var itemID pgtype.UUID
		require.NoError(t, pool.QueryRow(ctx, "SELECT id FROM mythical_items WHERE todo_id = $1", *todoID).Scan(&itemID))
		item, err := db.New(pool).GetMythicalItem(ctx, itemID)
		if err != nil {
			t.Fatal(err)
		}
		projected := services.ProjectItemState(item, db.Todo{})
		if state != string(projected) {
			t.Errorf("%s: backfill %s differs from Go %s (checks %s)", name, state, projected, json.RawMessage(item.Checks))
		}
		if state != f.wantState || toState != f.wantState || kind != "backfill" || events != 1 {
			t.Errorf("%s: state %s, event %s→%s (%d events), want %s with one backfill event", name, state, kind, toState, events, f.wantState)
		}
		if title != f.title {
			t.Errorf("%s: title %q", name, title)
		}
		wantName := f.wantName
		switch {
		case wantName != "":
		case f.pr != 0:
			// An item with a PR keeps its GitHub branch as its name.
			wantName = fmt.Sprintf("smithers/issue-%d", f.issue)
			if f.round > 0 {
				wantName += fmt.Sprintf("-r%d", f.round)
			}
		default:
			wantName = "smithers/" + strings.ToLower(strings.ReplaceAll(f.title, " ", "-"))
		}
		if branchName != wantName {
			t.Errorf("%s: branch %q, want %q", name, branchName, wantName)
		}
		wantGitHub := f.wantGitHub
		if wantGitHub == "" {
			wantGitHub = wantName
		}
		if github == nil || *github != wantGitHub {
			t.Errorf("%s: GitHub branch %v, want %q", name, github, wantGitHub)
		}
		if f.source == "chat" {
			if prompt != "summary of "+f.title || reason != "create" || fixes || issueNumber != nil {
				t.Errorf("%s: chat revision %q %s fixes=%v issue=%v", name, prompt, reason, fixes, issueNumber)
			}
		} else if prompt != "body of "+f.title || reason != "from-issue" || !fixes || issueNumber == nil || *issueNumber != f.issue {
			t.Errorf("%s: issue revision %q %s fixes=%v issue=%v", name, prompt, reason, fixes, issueNumber)
		}
		if (state == "failed") != (failure != nil) {
			t.Errorf("%s: failure %v for state %s", name, failure, state)
		}
		if f.issue == 17 && (failure == nil || !strings.Contains(*failure, `"class": "policy"`)) {
			t.Errorf("%s: failure %v, want the policy fault", name, failure)
		}
	}
	var secondNumber int64
	var secondBranch string
	if err := pool.QueryRow(ctx, `SELECT t.number, t.branch_name FROM todos t WHERE t.repository_id = 2`).Scan(&secondNumber, &secondBranch); err != nil {
		t.Fatal(err)
	}
	if secondNumber != 1 || secondBranch != "smithers/fix-the-login" {
		t.Errorf("second repository: T%d branch %q, want T1 smithers/fix-the-login", secondNumber, secondBranch)
	}
	var stray int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM todos t WHERE NOT EXISTS (SELECT 1 FROM mythical_items i WHERE i.todo_id = t.id)`).Scan(&stray); err != nil {
		t.Fatal(err)
	}
	if stray != 0 {
		t.Errorf("%d TODOs have no item", stray)
	}
}

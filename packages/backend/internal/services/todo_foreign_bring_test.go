package services

import (
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

func TestForeignBringNativeUsesStackWorkerAndSamePR(t *testing.T) { testForeignBring(t, false) }
func TestForeignBringConflictRetainsHeadAndBudget(t *testing.T)   { testForeignBring(t, true) }

func testForeignBring(t *testing.T, conflicting bool) {
	f := newRebaseFixture(t)
	item := f.candidate("Bring", f.main, "OWN.md", "own\n")
	f.wake()
	item = f.item(item.Number.Int64)
	branch := mythicalChecksOf(item).Branch
	files := map[string]string{"alice.md": "alice bytes\n"}
	if conflicting {
		files["OWN.md"] = "Alice replaces this line\n"
	}
	foreign, err := f.fake.PushAs("rehearsal-owner/app", branch, 202, "alice", "Alice's addition", files)
	require.NoError(t, err)
	// Inbound sync's retained objects and wait are tested independently by the
	// real sync suites. This test starts at that durable production boundary.
	f.git(f.work, "fetch", "-q", f.github, foreign)
	f.git(f.work, "push", "-q", f.hostDir, foreign+":"+repohost.KeptCommitRefPrefix+foreign)
	checks := mythicalChecksOf(item)
	checks.ForeignHead = foreign
	checks.Waits = append(checks.Waits, TodoWait{ID: "foreign-wait", Kind: "foreign_push", SHA: foreign, Since: time.Now().UTC(), By: json.RawMessage(`{"kind":"github","login":"alice"}`)})
	retained, err := db.New(f.pool).CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.userID, TargetBookmark: branch, Status: "running"})
	require.NoError(t, err)
	_, _, err = db.New(f.pool).BindMythicalLane(t.Context(), db.MythicalLane{WorkspaceID: retained.ID, RepositoryID: f.repoID, ItemID: item.ID, Name: "TODO 1 coding"})
	require.NoError(t, err)
	item.WorkspaceID = retained.ID
	item.Checks = checks.encode()
	item, err = db.New(f.pool).SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	f.service.SetOrchestration(f.service.github, f.launcher, &fakeMythicalLanes{})
	owner, err := db.New(f.pool).GetUserByID(t.Context(), f.userID)
	require.NoError(t, err)
	session := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &owner, SessionHash: "owner-session"})
	input := TodoControlInput{Op: "bring-in", Repository: f.repoID, Actor: f.userID, Request: "bring-press", Wait: "foreign-wait", Revision: foreign}
	_, err = f.pool.Exec(t.Context(), `CREATE FUNCTION refuse_bring_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='todo.foreign_bring-in' THEN RAISE EXCEPTION 'injected bring fact failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_bring_fact BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION refuse_bring_fact()`)
	require.NoError(t, err)
	_, err = f.service.AnswerBranch(session, branch, input)
	require.ErrorContains(t, err, "injected bring fact failure")
	require.Nil(t, mythicalChecksOf(f.item(item.Number.Int64)).ForeignBring)
	_, err = f.pool.Exec(t.Context(), `DROP TRIGGER refuse_bring_fact ON product_job_events; DROP FUNCTION refuse_bring_fact()`)
	require.NoError(t, err)
	receipt, err := f.service.AnswerBranch(session, branch, input)
	require.NoError(t, err)
	replay, err := f.service.AnswerBranch(session, branch, input)
	require.NoError(t, err)
	require.Equal(t, receipt, replay)
	secondPress := input
	secondPress.Request = "different-bring-press"
	_, err = f.service.AnswerBranch(session, branch, secondPress)
	var already *TodoControlError
	require.ErrorAs(t, err, &already)
	require.Equal(t, "conflict", already.Class)
	require.Equal(t, item.CandidateHead, f.item(item.Number.Int64).CandidateHead, "HTTP admission does not execute Git work")
	admitted := f.item(item.Number.Int64)
	for _, field := range []string{"head", "generation", "onto", "sha", "occupied"} {
		t.Run(field, func(t *testing.T) {
			changed := admitted
			binding := mythicalChecksOf(changed)
			switch field {
			case "head":
				changed.CandidateHead = "changed"
			case "generation":
				changed.Generation++
			case "onto":
				binding.ForeignBring.Onto = "changed"
			case "sha":
				binding.ForeignBring.SHA = "changed"
			case "occupied":
				changed.WorkspaceID = "occupied"
			}
			changed.Checks = binding.encode()
			step := mythicalItemStep{s: f.service, r: &mythicalRun{mainTip: f.main}, items: []db.MythicalItem{changed}}
			next, saved, err := step.consumeForeignBring(t.Context(), changed)
			require.NoError(t, err)
			require.Nil(t, next)
			require.False(t, saved, "refuse before any Git effect")
		})
	}
	_, err = f.pool.Exec(t.Context(), `UPDATE auth_sessions SET expires_at=NOW()-interval '1 hour' WHERE session_key='owner-session'`)
	require.NoError(t, err)
	f.wake()
	require.Equal(t, item.CandidateHead, f.item(item.Number.Int64).CandidateHead)
	require.Zero(t, f.verifies(item))
	_, err = f.pool.Exec(t.Context(), `UPDATE auth_sessions SET expires_at=NOW()+interval '1 hour' WHERE session_key='owner-session'`)
	require.NoError(t, err)
	// The guest result is independent of the implementation under test.
	nativeHead := f.git(f.hostDir, "commit-tree", f.hostTree(foreign), "-p", foreign, "-m", "native Bring in")
	paths := []string(nil)
	if conflicting {
		paths = []string{"OWN.md"}
	}
	f.git(f.hostDir, "update-ref", "refs/smithers/branches/"+retained.ID+"/captures/"+nativeHead, nativeHead)
	f.service.SetBranchRebaseExecutor(&rebaseExecutionFixture{f: f, result: machined.RewriteResult{Head: nativeHead, Inspected: true, Paths: paths}})
	f.wake()
	f.wake()
	verified := f.item(item.Number.Int64)
	if conflicting {
		require.Equal(t, "rebase_conflict_pending", verified.Reason)
		require.Equal(t, item.CandidateHead, verified.CandidateHead)
		require.Contains(t, string(verified.Integration), "OWN.md")
		require.Contains(t, string(verified.Integration), foreign)
		reservation := mythicalChecksOf(verified).ConflictReservation
		require.NotNil(t, reservation)
		for range 3 {
			f.wake()
		}
		require.Equal(t, item.Attempt, f.item(item.Number.Int64).Attempt)
		require.Equal(t, reservation, mythicalChecksOf(f.item(item.Number.Int64)).ConflictReservation)
		require.Zero(t, f.verifies(item))
		input.Request = "another-press"
		_, err := f.service.AnswerBranch(session, branch, input)
		var refusal *TodoControlError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, "rebase_conflict_pending", refusal.Code)
		return
	}
	require.Equal(t, "verifying", verified.State, verified.Reason)
	require.Equal(t, item.Attempt, verified.Attempt)
	require.Equal(t, item.Generation+1, verified.Generation)
	require.Equal(t, f.main, verified.CandidateBase)
	require.Empty(t, mythicalChecksOf(verified).ForeignHead)
	require.Empty(t, todoOpenWaits(verified))
	require.Equal(t, "alice bytes", f.git(f.hostDir, "show", verified.CandidateHead+":alice.md"))
	require.Equal(t, "own", f.git(f.hostDir, "show", verified.CandidateHead+":OWN.md"))
	require.Equal(t, foreign, verified.PRHead, "publication leases against the accepted foreign push")
	f.verify(verified)
	for range 4 {
		f.wake()
		if f.item(item.Number.Int64).State == "proposed" {
			break
		}
	}
	published := f.item(item.Number.Int64)
	require.Equal(t, "proposed", published.State, published.Reason)
	require.Equal(t, item.PRNumber, published.PRNumber)
	require.Equal(t, published.PRHead, f.githubRef(branch))
	f.git(f.github, "merge-base", "--is-ancestor", foreign, published.PRHead)
	require.Equal(t, "alice bytes", f.git(f.github, "show", published.PRHead+":alice.md"))
	require.Equal(t, 1, f.verifies(published))
	var count int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_brought-in'`).Scan(&count))
	require.Equal(t, 1, count)
	replay, err = f.service.AnswerBranch(session, branch, input)
	require.NoError(t, err)
	require.Equal(t, receipt, replay)
}

func TestForeignBringOccupiedCheckpointRecovery(t *testing.T) { testForeignBringRecovery(t, false) }
func TestForeignBringPlanningQuestionCheckpointRecovery(t *testing.T) {
	testForeignBringRecovery(t, true)
}
func testForeignBringRecovery(t *testing.T, planning bool) {
	f := newRebaseFixture(t)
	item := f.candidate("Bring", f.main, "OWN.md", "own\n")
	f.wake()
	item = f.item(item.Number.Int64)
	branch := mythicalChecksOf(item).Branch
	foreign, err := f.fake.PushAs("rehearsal-owner/app", branch, 202, "alice", "Alice's addition", map[string]string{"alice.md": "alice bytes\n"})
	require.NoError(t, err)
	f.git(f.work, "fetch", "-q", f.github, foreign)
	f.git(f.work, "push", "-q", f.hostDir, foreign+":"+repohost.KeptCommitRefPrefix+foreign)
	q := db.New(f.pool)
	workspace, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.userID, TargetBookmark: branch, Kind: "vm", Status: "running"})
	require.NoError(t, err)
	_, _, err = q.BindMythicalLane(t.Context(), db.MythicalLane{WorkspaceID: workspace.ID, RepositoryID: f.repoID, ItemID: item.ID, Name: "coding"})
	require.NoError(t, err)
	checks := mythicalChecksOf(item)
	checks.ForeignHead = foreign
	checks.Waits = append(checks.Waits, TodoWait{ID: "foreign-wait", Kind: "foreign_push", SHA: foreign, Since: time.Now().UTC(), By: json.RawMessage(`{"kind":"github","login":"alice"}`)})
	openWaits := 1
	if planning {
		// A reopened TODO still carries the previous attempt's candidate while planning.
		item.State, item.RequestOutcome, item.Plan = "running", "", nil
		checks.Waits = append(checks.Waits, TodoWait{ID: "independent-question", Kind: "question", Since: time.Now().UTC(), Prompt: "Which greeting?"})
		openWaits++
	}
	item.WorkspaceID, item.Checks = workspace.ID, checks.encode()
	item, err = q.SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	f.service.SetOrchestration(f.service.github, f.launcher, &fakeMythicalLanes{})
	owner, err := q.GetUserByID(t.Context(), f.userID)
	require.NoError(t, err)
	session := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &owner, SessionHash: "owner-session"})
	_, err = f.service.AnswerBranch(session, branch, TodoControlInput{Op: "bring-in", Repository: f.repoID, Actor: f.userID, Request: "occupied-bring", Wait: "foreign-wait", Revision: foreign})
	require.NoError(t, err)
	// Missing provider retains the admitted answer and publication hold.
	f.wake()
	require.Equal(t, item.CandidateHead, f.item(item.Number.Int64).CandidateHead)
	require.Len(t, todoOpenWaits(f.item(item.Number.Int64)), openWaits)
	// Literal independently created native result, parented on Alice's push.
	f.git(f.work, "checkout", "--detach", foreign)
	f.git(f.work, "commit", "--allow-empty", "-m", "Native checkpoint")
	head := f.git(f.work, "rev-parse", "HEAD")
	f.git(f.work, "push", "-q", f.hostDir, head+":refs/smithers/mythical/keep/"+head)
	executor := &rebaseExecutionFixture{f: f, result: machined.RewriteResult{Head: head, Inspected: true}, failCapture: true}
	f.service.SetBranchRebaseExecutor(executor)
	f.wake()
	require.Equal(t, 1, executor.calls, "item=%+v checks=%s", f.item(item.Number.Int64), f.item(item.Number.Int64).Checks)
	require.NotNil(t, mythicalChecksOf(f.item(item.Number.Int64)).ForeignBring.Native)
	// A new worker pass after failed capture does not repeat the rewrite.
	f.wake()
	require.Equal(t, 1, executor.calls)
	executor.failCapture = false
	f.wake()
	next := f.item(item.Number.Int64)
	if planning {
		require.Equal(t, "running", next.State, next.Reason)
		require.Empty(t, next.CandidateHead, "the current pinned composition still delivers its candidate")
		require.Len(t, todoOpenWaits(next), 1)
		require.Equal(t, "independent-question", todoOpenWaits(next)[0].ID)
		require.Equal(t, item.RequestRunID, next.RequestRunID)
	} else {
		require.Equal(t, "verifying", next.State, next.Reason)
		require.Equal(t, head, next.CandidateHead)
		require.Empty(t, todoOpenWaits(next))
	}
	require.Equal(t, foreign, next.PRHead)
	var actor string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT data->'actor'->>'login' FROM product_job_events WHERE event_type='todo.foreign_brought-in'`).Scan(&actor))
	require.Equal(t, "alice", actor)
	var pendingCapture []byte
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT capture_pending FROM workspaces WHERE id=$1`, workspace.ID).Scan(&pendingCapture))
	require.Empty(t, pendingCapture)
	require.Equal(t, 1, executor.calls)
	var count int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_brought-in'`).Scan(&count))
	require.Equal(t, 1, count)
}

package services

import (
	"context"
	"encoding/json"
	"fmt"

	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Capture is the unavailable S2 dependency's contract; fixed committed bytes
// and the real PostgreSQL/Git writer independently verify adoption, not VM capture.
type addCaptureFixture struct {
	mythicalLanes
	head string
}

func (c addCaptureFixture) CapturedHead(context.Context, string, int64, int64) (string, error) {
	return c.head, nil
}

func TestBranchAddAdoptsScratchAndReplays(t *testing.T) {
	f := newMythicalServiceFixture(t)
	pool := f.pool.(*pgxpool.Pool)
	q := db.New(pool)
	installBranchOwner(t, pool, f.userID)
	f.commit("Main", "base.txt", "main\n")
	base := f.publish()
	f.commit("Scratch edit", "scratch.txt", "scratch bytes\n")
	head := f.publish()
	person, err := q.GetUserByID(t.Context(), f.userID)
	require.NoError(t, err)
	ctx := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &person, SessionHash: "add-session"})
	ctx = registerTestInstallCredential(t, pool, ctx, f.repoID)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state,landed_main) VALUES($1,$2,'active',$3)`, f.repoID, f.userID, base)
	require.NoError(t, err)
	ws, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.userID, TargetBookmark: "scratch/ben/test", Status: "stopped"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET is_fork=true,forked_from_base=$1,source_commit=$1,head_commit_id=$2 WHERE id=$3`, base, head, ws.ID)
	require.NoError(t, err)
	f.service.lanes = addCaptureFixture{head: head}
	input := BranchAddInput{Text: "Keep scratch", Request: "add-one"}

	// Fail after ref rename but before SQL commit: the same workspace-derived
	// branch/seed must be recovered without creating a second TODO or activity.
	_, err = pool.Exec(ctx, `CREATE FUNCTION fail_add_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='branch.added-to-stack' THEN RAISE EXCEPTION 'injected activity failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_add_activity BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION fail_add_activity()`)
	require.NoError(t, err)
	_, err = f.service.AddBranchToStack(ctx, f.repoID, f.userID, ws.TargetBookmark, input)
	require.ErrorContains(t, err, "injected activity failure")
	var rolledBack int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&rolledBack))
	require.Zero(t, rolledBack)
	rowBefore, err := q.GetWorkspace(ctx, ws.ID)
	require.NoError(t, err)
	require.Equal(t, ws.TargetBookmark, rowBefore.TargetBookmark)
	_, err = pool.Exec(ctx, `DROP TRIGGER fail_add_activity ON product_job_events; DROP FUNCTION fail_add_activity()`)
	require.NoError(t, err)
	got, err := f.service.AddBranchToStack(ctx, f.repoID, f.userID, ws.TargetBookmark, input)
	require.NoError(t, err)
	item, err := q.GetMythicalItemByNumber(ctx, f.repoID, got.Number)
	require.NoError(t, err)
	require.Equal(t, ws.ID, item.WorkspaceID)
	seed := mythicalChecksOf(item).Seed
	require.NotNil(t, seed)
	require.Equal(t, base, seed.Base)
	require.Equal(t, head, seed.Captured)
	require.Contains(t, seed.Diff, "+scratch bytes")
	require.Equal(t, "scratch bytes", f.git(f.hostDir, "show", seed.Head+":scratch.txt"))
	require.Equal(t, base, f.git(f.hostDir, "rev-parse", seed.Head+"^"))
	row, err := q.GetWorkspace(ctx, ws.ID)
	require.NoError(t, err)
	require.Equal(t, "smithers/test-"+ws.ID, row.TargetBookmark)
	replay, err := f.service.AddBranchToStack(ctx, f.repoID, f.userID, ws.TargetBookmark, input)
	require.NoError(t, err)
	require.Equal(t, got.Number, replay.Number)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces`).Scan(&count))
	require.Equal(t, 1, count)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.added-to-stack'`).Scan(&count))
	require.Equal(t, 1, count)
	input.Text = "Different"
	_, err = f.service.AddBranchToStack(ctx, f.repoID, f.userID, ws.TargetBookmark, input)
	require.ErrorContains(t, err, "Idempotency-Key")
	input = BranchAddInput{Text: "No", Request: "both", After: ptrAdd(1), Before: ptrAdd(2)}
	_, err = f.service.AddBranchToStack(ctx, f.repoID, f.userID, ws.TargetBookmark, input)
	require.Error(t, err)
	second, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.userID, TargetBookmark: "scratch/ben/explicit", Status: "stopped"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET is_fork=true,forked_from_base=$1,source_commit=$1,head_commit_id=$2 WHERE id=$3`, base, head, second.ID)
	require.NoError(t, err)
	after, err := f.service.AddBranchToStack(ctx, f.repoID, f.userID, second.ID, BranchAddInput{Text: "After first", Request: "explicit-after", After: ptrAdd(got.Number)})
	require.NoError(t, err)
	afterItem, err := q.GetMythicalItemByNumber(ctx, f.repoID, after.Number)
	require.NoError(t, err)
	require.EqualValues(t, 2, afterItem.StackPosition.Int64)
	require.Equal(t, second.ID, afterItem.WorkspaceID)

}
func ptrAdd(n int64) *int64 { return &n }

func TestDropFoldsSourceIntoAdoptedScratch(t *testing.T) {
	for _, scenario := range []string{"unchanged", "steered", "moved-before", "captured-after-steer"} {
		t.Run(scenario, func(t *testing.T) {
			f := newMythicalServiceFixture(t)
			pool := f.pool.(*pgxpool.Pool)
			q := db.New(pool)
			installBranchOwner(t, pool, f.userID)
			f.commit("Main", "base.txt", "main\n")
			base := f.publish()
			person, err := q.GetUserByID(t.Context(), f.userID)
			require.NoError(t, err)
			ctx := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &person, SessionHash: "fold-session"})
			ctx = registerTestInstallCredential(t, pool, ctx, f.repoID)
			_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state,landed_main) VALUES($1,$2,'active',$3)`, f.repoID, f.userID, base)
			require.NoError(t, err)
			sourceView, err := f.service.FileTodo(ctx, f.repoID, f.userID, MythicalTodoInput{Prompt: "Source", Title: "Source", Request: "source"})
			require.NoError(t, err)
			f.commit("Source", "source.txt", "source original\n")
			original := f.publish()
			source, err := q.GetMythicalItemByNumber(ctx, f.repoID, sourceView.Number)
			require.NoError(t, err)
			source.CandidateBase, source.CandidateHead, source.CandidateVerified, source.State = base, original, true, "proposed"
			source, err = q.SaveMythicalItem(ctx, source)
			require.NoError(t, err)
			f.commit("Scratch", "scratch.txt", "scratch bytes\n")
			head := f.publish()
			// Keep the mirror at main and advertise the verified source and
			// scratch heads on their own branches, as production publication does.
			f.git(f.hostDir, "update-ref", "refs/heads/main", base)
			f.git(f.hostDir, "update-ref", "refs/heads/smithers/source", original)
			f.git(f.hostDir, "update-ref", "refs/heads/scratch/ben/fold", head)
			require.NoError(t, f.host.ImportRefs(ctx, "", ""))
			workspace, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.userID, TargetBookmark: "scratch/ben/fold", Status: "stopped"})
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE workspaces SET is_fork=true,forked_from_item=$1,forked_from_base=$2,source_commit=$3,head_commit_id=$4 WHERE id=$5`, source.ID, base, original, head, workspace.ID)
			require.NoError(t, err)
			f.service.lanes = addCaptureFixture{head: head}
			input := BranchAddInput{Text: "Keep scratch", Request: "adopt"}
			if scenario == "moved-before" {
				input.Before = ptrAdd(source.Number.Int64)
			}
			added, err := f.service.AddBranchToStack(ctx, f.repoID, f.userID, workspace.TargetBookmark, input)
			require.NoError(t, err)
			child, err := q.GetMythicalItemByNumber(ctx, f.repoID, added.Number)
			require.NoError(t, err)
			// Adoption replaces the scratch revision with its one-change seed.
			// Capture must answer that retained head after the branch rename.
			f.service.lanes = addCaptureFixture{head: mythicalChecksOf(child).Seed.Head}
			if scenario == "moved-before" {
				require.EqualValues(t, 1, child.StackPosition.Int64)
			} else {
				require.EqualValues(t, 2, child.StackPosition.Int64)
			}
			if scenario == "steered" {
				f.commit("Steer", "source.txt", "source latest\n")
				latest := f.publish()
				source, err = q.GetMythicalItem(ctx, source.ID)
				require.NoError(t, err)
				source.CandidateHead = latest
				source, err = q.SaveMythicalItem(ctx, source)
				require.NoError(t, err)
			}
			if scenario == "captured-after-steer" {
				f.commit("Final capture", "source.txt", "source latest\n")
				latest := f.publish()
				captured, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.userID, TargetBookmark: "smithers/source", Status: "running"})
				require.NoError(t, err)
				_, err = pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$1 WHERE id=$2`, latest, captured.ID)
				require.NoError(t, err)
				pending := source
				pending.WorkspaceID, pending.BaseCommit = captured.ID, base
				pending.CandidateHead, pending.CandidateBase = "", ""
				checks := mythicalChecksOf(pending)
				checks.DropRequested = &todoDrop{Request: "drop-source", By: person.Username}
				pending.Checks = checks.encode()
				stack, err := q.GetMythicalStack(ctx, f.repoID)
				require.NoError(t, err)
				fold := func() error {
					return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error { return f.service.FoldIntoForks(ctx, tx, stack, pending) })
				}
				require.Equal(t, todoControlUnavailable(), fold(), "a still-running source cannot supply final capture")
				unchanged, err := q.GetMythicalItem(ctx, child.ID)
				require.NoError(t, err)
				require.Equal(t, child, unchanged)
				_, err = pool.Exec(ctx, `UPDATE workspaces SET status='suspended' WHERE id=$1`, captured.ID)
				require.NoError(t, err)
				require.NoError(t, fold())
			}
			// Drive the real Drop control, including its placement removal, transaction,
			// cancellation guard and fold hook; the capture contract is test-only.
			_, err = f.service.ControlTodo(ctx, source.Number.Int64, TodoControlInput{Op: "drop", Repository: f.repoID, Actor: f.userID, Request: "drop-source"})
			require.NoError(t, err)
			child, err = q.GetMythicalItem(ctx, child.ID)
			require.NoError(t, err)
			seed := mythicalChecksOf(child).Seed
			require.NotNil(t, seed)
			wantSource := "source original"
			if scenario == "steered" || scenario == "captured-after-steer" {
				wantSource = "source latest"
			}
			require.Equal(t, wantSource, f.git(f.hostDir, "show", seed.Head+":source.txt"))
			require.Equal(t, "scratch bytes", f.git(f.hostDir, "show", seed.Head+":scratch.txt"))
			require.Contains(t, seed.Diff, "+"+wantSource)
			require.EqualValues(t, 1, child.StackPosition.Int64)
			require.Equal(t, workspace.ID, child.WorkspaceID)
			// A replay does not fold a second time or change the retained seed.
			_, err = f.service.ControlTodo(ctx, source.Number.Int64, TodoControlInput{Op: "drop", Repository: f.repoID, Actor: f.userID, Request: "drop-source"})
			require.NoError(t, err)
			again, err := q.GetMythicalItem(ctx, child.ID)
			require.NoError(t, err)
			require.Equal(t, seed.Head, mythicalChecksOf(again).Seed.Head)
		})
	}
}

func (c addCaptureFixture) AdmitScratch(context.Context, pgx.Tx, int64, int64, db.Workspace) error {
	return nil
}

func TestAdoptedScratchAdmissionAndDeliveryKeepWholeDiff(t *testing.T) {
	for _, pinned := range []bool{false, true} {
		t.Run(fmt.Sprint(pinned), func(t *testing.T) {
			o, session := newTodoAdmission(t)
			if pinned {
				o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
			}
			base := o.hostRef("refs/heads/main")
			o.commit("Scratch", "scratch.txt", "retained scratch\n")
			head := o.publish()
			q := db.New(o.pool)
			ws, err := q.CreateWorkspace(session, db.CreateWorkspaceParams{RepositoryID: o.repoID, UserID: o.userID, TargetBookmark: "scratch/ben/admission", Status: "stopped"})
			require.NoError(t, err)
			_, err = o.pool.Exec(session, `UPDATE workspaces SET is_fork=true,forked_from_base=$1,source_commit=$1,head_commit_id=$2 WHERE id=$3`, base, head, ws.ID)
			require.NoError(t, err)
			o.service.lanes = addCaptureFixture{mythicalLanes: o.lanes, head: head}
			view, err := o.service.AddBranchToStack(session, o.repoID, o.userID, ws.TargetBookmark, BranchAddInput{Text: "Finish scratch", Request: "admission"})
			require.NoError(t, err)
			o.wake()
			item, err := q.GetMythicalItemByNumber(session, o.repoID, view.Number)
			require.NoError(t, err)
			require.Equal(t, "running", item.State, item.Reason)
			require.Equal(t, ws.ID, item.WorkspaceID)
			require.Empty(t, o.lanes.created, "admission must reuse the adopted machine")
			seed := mythicalChecksOf(item).Seed
			require.Equal(t, seed.Head, item.BaseCommit)
			flow := "coding/request"
			if pinned {
				flow = "todo"
			}
			launches := o.launcher.byFlow(flow)
			require.Len(t, launches, 1)
			payload := decodeJSON(t, launches[0].Payload)
			require.Equal(t, map[string]any{"commitId": seed.Head, "ref": repohost.WorkspaceSourceRef(ws.ID, seed.Head)}, payload["base"])
			require.Contains(t, payload["prompt"], "+retained scratch")
			if pinned {
				o.projectTodo(launches[0], jobs.StateRunning, "adopted-run", todoPinOne, "")
			} else {
				item.RequestRunID = "adopted-run"
				item.RequestOutcome = "validated"
				item.State = "delivering"
				_, err = q.SaveMythicalItem(session, item)
				require.NoError(t, err)
			}
			candidate := o.laneResult(ws.ID, seed.Head, map[string]string{"agent.txt": "agent edit\n"}, "Finish")
			_, err = o.service.SubmitLane(session, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: ws.ID, Base: seed.Head, Source: candidate, RequestRunID: "adopted-run", Summary: "Finish", Plan: json.RawMessage(`{"changes":[{"title":"Finish","atoms":[{"changeId":null,"message":"Finish"}],"checks":[]}]}`)})
			require.NoError(t, err)
			item, err = q.GetMythicalItemByNumber(session, o.repoID, view.Number)
			require.NoError(t, err)
			require.Equal(t, base, item.CandidateBase, "delivery transplants the scratch seed as part of the TODO")
			require.Equal(t, "retained scratch", o.git(o.hostDir, "show", item.CandidateHead+":scratch.txt"))
			require.Equal(t, "agent edit", o.git(o.hostDir, "show", item.CandidateHead+":agent.txt"))
		})
	}
}

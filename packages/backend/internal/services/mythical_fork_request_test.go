package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

// Real PostgreSQL and git transfer, with the production workspace adapter.
// The fixture refuses actual VM execution; no machine qualification is implied.
func TestForkRequestReplaysAfterMainMoves(t *testing.T) {
	f := newMythicalServiceFixture(t)
	pool := f.pool.(*pgxpool.Pool)
	installBranchOwner(t, pool, f.userID)
	f.commit("First revision", "retry.ts", "export const retry = 2;\n")
	head := f.publish()
	ws := installLaneService(t, pool, f.userID)
	f.service.lanes = NewWorkspaceMythicalLanes(ws)
	person, err := db.New(pool).GetUserByID(t.Context(), f.userID)
	require.NoError(t, err)
	ctx := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &person, SessionHash: "fork-person-session"})
	ctx = registerTestInstallCredential(t, pool, ctx, f.repoID)
	input := BranchForkInput{From: "main", Name: "request-retry", Request: "same-fork"}
	first, err := f.service.ForkBranch(ctx, f.repoID, f.userID, input)
	require.NoError(t, err)
	require.Equal(t, head, first.Head)
	f.commit("Main moved", "retry.ts", "export const retry = 99;\n")
	require.NotEqual(t, head, f.publish())
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := f.service.ForkBranch(ctx, f.repoID, f.userID, input)
			if err != nil {
				t.Error(err)
				return
			}
			if got.Machine.ID != first.Machine.ID || got.Head != head {
				t.Error("retry changed the fork")
			}
		}()
	}
	wg.Wait()
	input.Name = "another-fork"
	_, err = f.service.ForkBranch(ctx, f.repoID, f.userID, input)
	var refused *BranchError
	require.ErrorAs(t, err, &refused)
	require.Equal(t, 409, refused.Status)
	var branches, activity, receipts int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1`, f.repoID).Scan(&branches))
	require.Equal(t, 1, branches)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.forked'`).Scan(&activity))
	require.Equal(t, 1, activity)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.fork.completed'`).Scan(&receipts))
	require.Equal(t, 1, receipts)
	require.Equal(t, head, f.hostRef("refs/heads/"+first.Name))
	_, err = f.service.ForkBranch(context.Background(), f.repoID, f.userID, BranchForkInput{From: "main", Request: "same-fork"})
	require.Error(t, err, fmt.Sprint("receipt requires the original person's authority"))
	_, err = pool.Exec(ctx, `DELETE FROM auth_sessions WHERE session_key=$1`, middleware.AuthInfoFromContext(ctx).SessionHash)
	require.NoError(t, err)
	input.Name = "request-retry"
	_, err = f.service.ForkBranch(ctx, f.repoID, f.userID, input)
	var dead *AccessError
	require.ErrorAs(t, err, &dead)
	require.Equal(t, 401, dead.Status)
	require.Equal(t, "unauthenticated", dead.Code)

}

func TestRetainedWorkspaceForkUsesRevisionWriter(t *testing.T) {
	f := newMythicalServiceFixture(t)
	pool := f.pool.(*pgxpool.Pool)
	installBranchOwner(t, pool, f.userID)
	f.commit("Source revision", "retry.ts", "export const retry = 2;\n")
	head := f.publish()
	ws := installLaneService(t, pool, f.userID)
	f.service.SetOrchestration(f.service.github, f.service.launcher, NewWorkspaceMythicalLanes(ws))
	q := db.New(pool)
	person, err := q.GetUserByID(t.Context(), f.userID)
	require.NoError(t, err)
	ctx := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &person, SessionHash: "retained-workspace-session"})
	ctx = registerTestInstallCredential(t, pool, ctx, f.repoID)
	source, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.userID, Name: "main", TargetBookmark: "main", Status: "running"})
	require.NoError(t, err)
	input := ForkWorkspaceInput{RepositoryID: f.repoID, UserID: f.userID, WorkspaceID: source.ID, Name: "retained-door", Request: "retained-fork"}
	first, err := ws.ForkWorkspace(ctx, input)
	require.NoError(t, err)
	require.Equal(t, head, first.SourceCommit)
	require.Equal(t, "scratch/"+strings.ToLower(person.Username)+"/retained-door", first.TargetBookmark)
	f.commit("Main advanced", "retry.ts", "export const retry = 99;\n")
	require.NotEqual(t, head, f.publish())
	replayed, err := ws.ForkWorkspace(ctx, input)
	require.NoError(t, err)
	require.Equal(t, first.ID, replayed.ID)
	require.Equal(t, head, replayed.SourceCommit)
	retained, err := q.GetWorkspace(ctx, source.ID)
	require.NoError(t, err)
	require.Equal(t, "running", retained.Status)
	itemSource, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.userID, Name: "item", TargetBookmark: "smithers/retries", Status: "running"})
	require.NoError(t, err)
	item, err := q.InsertMythicalTodo(ctx, f.repoID, f.userID, "Retries", "Retry twice", []byte(`[{"text":"Retry twice"}]`), []byte(`{"todo":true}`))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET workspace_id=$2,candidate_head=$3,candidate_base=$3,candidate_verified=true WHERE id=$1`, item.ID, itemSource.ID, head)
	require.NoError(t, err)
	f.git(f.hostDir, "update-ref", "refs/smithers/mythical/keep/"+head, head)
	require.NoError(t, f.host.ImportRefs(ctx, "", ""))
	_, err = ws.ForkWorkspace(ctx, ForkWorkspaceInput{RepositoryID: f.repoID, UserID: f.userID, WorkspaceID: itemSource.ID, Name: "awake-refused", Request: "awake-refused"})
	require.ErrorContains(t, err, "Capture unavailable")
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status='stopped' WHERE id=$1`, itemSource.ID)
	require.NoError(t, err)
	itemFork, err := ws.ForkWorkspace(ctx, ForkWorkspaceInput{RepositoryID: f.repoID, UserID: f.userID, WorkspaceID: itemSource.ID, Name: "item-door", Request: "item-fork"})
	require.NoError(t, err)
	require.Equal(t, head, itemFork.SourceCommit, "an asleep item uses its verified head, not the advanced main")
	itemRetained, err := q.GetWorkspace(ctx, itemSource.ID)
	require.NoError(t, err)
	require.Equal(t, "stopped", itemRetained.Status)
	// A scratch source cannot reach the legacy disk fork even without a runtime.
	input.WorkspaceID, input.Request, input.Name = first.ID, "scratch-refusal", "scratch-refusal"
	_, err = ws.ForkWorkspace(ctx, input)
	require.ErrorContains(t, err, "Capture unavailable")
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1`, f.repoID).Scan(&count))
	require.Equal(t, 4, count)
	require.NoError(t, ws.WaitForProvisioning(ctx))
}

// Fail after the workspace and published ref exist, before completion commits.
// This models a process interruption using real workspace and Git boundaries.
type interruptedScratchFork struct {
	mythicalLanes
	forks     mythicalScratchForks
	interrupt bool
}

func (f *interruptedScratchFork) CheckScratchFork(ctx context.Context, repository, actor int64, branch string) error {
	return f.forks.CheckScratchFork(ctx, repository, actor, branch)
}

func (f *interruptedScratchFork) ForkScratch(ctx context.Context, input ScratchFork) (BranchMachineResponse, error) {
	branch, err := f.forks.ForkScratch(ctx, input)
	if err == nil && f.interrupt {
		f.interrupt = false
		return BranchMachineResponse{}, errors.New("interrupted after workspace creation")
	}
	return branch, err
}
func TestInterruptedForkRetainsOriginalRevision(t *testing.T) {
	f := newMythicalServiceFixture(t)
	pool := f.pool.(*pgxpool.Pool)
	installBranchOwner(t, pool, f.userID)
	f.commit("First revision", "retry.ts", "export const retry = 2;\n")
	head := f.publish()
	ws := installLaneService(t, pool, f.userID)
	lanes := NewWorkspaceMythicalLanes(ws)
	f.service.lanes = &interruptedScratchFork{mythicalLanes: lanes, forks: lanes, interrupt: true}
	person, err := db.New(pool).GetUserByID(t.Context(), f.userID)
	require.NoError(t, err)
	ctx := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &person, SessionHash: "interrupted-fork-session"})
	ctx = registerTestInstallCredential(t, pool, ctx, f.repoID)
	input := BranchForkInput{From: "main", Name: "interrupted-retry", Request: "interrupted-fork"}
	_, err = f.service.ForkBranch(ctx, f.repoID, f.userID, input)
	require.EqualError(t, err, "interrupted after workspace creation")
	var original string
	require.NoError(t, pool.QueryRow(ctx, `SELECT id::text FROM workspaces WHERE repository_id=$1`, f.repoID).Scan(&original))
	f.commit("Main moved", "retry.ts", "export const retry = 99;\n")
	require.NotEqual(t, head, f.publish())
	changed := input
	changed.From = "T2"
	_, err = f.service.ForkBranch(ctx, f.repoID, f.userID, changed)
	var refused *BranchError
	require.ErrorAs(t, err, &refused)
	require.Equal(t, 409, refused.Status)
	// A workspace found by name must still be the intended fork.
	require.NoError(t, ws.WaitForProvisioning(ctx))
	_, err = pool.Exec(ctx, `UPDATE workspaces SET source_commit=$2 WHERE id=$1`, original, strings.Repeat("f", 40))
	require.NoError(t, err)
	_, err = f.service.ForkBranch(ctx, f.repoID, f.userID, input)
	require.ErrorContains(t, err, "different machine source")
	_, err = pool.Exec(ctx, `UPDATE workspaces SET source_commit=$2 WHERE id=$1`, original, head)
	require.NoError(t, err)
	recovered, err := f.service.ForkBranch(ctx, f.repoID, f.userID, input)
	require.NoError(t, err)
	require.Equal(t, "failed", recovered.State, "replay reports the retained machine honestly without re-provisioning it")
	require.Equal(t, original, recovered.Machine.ID)
	require.Equal(t, head, recovered.Head)
	require.Equal(t, head, recovered.ForkedFrom.Commit)
	require.Equal(t, head, f.hostRef("refs/heads/"+recovered.Name))
	for _, event := range []string{"branch.fork.intended", "branch.forked", "branch.fork.completed"} {
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type=$1`, event).Scan(&count))
		require.Equal(t, 1, count, event)
	}
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1`, f.repoID).Scan(&count))
	require.Equal(t, 1, count)
}

func TestForkActivityFailureDoesNotCompleteRequest(t *testing.T) {
	f := newMythicalServiceFixture(t)
	pool := f.pool.(*pgxpool.Pool)
	installBranchOwner(t, pool, f.userID)
	f.commit("Fixed revision", "retry.ts", "export const retry = 2;\n")
	head := f.publish()
	ws := installLaneService(t, pool, f.userID)
	f.service.lanes = NewWorkspaceMythicalLanes(ws)
	person, err := db.New(pool).GetUserByID(t.Context(), f.userID)
	require.NoError(t, err)
	ctx := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &person, SessionHash: "activity-fork-session"})
	ctx = registerTestInstallCredential(t, pool, ctx, f.repoID)
	_, err = pool.Exec(ctx, `CREATE FUNCTION refuse_fork_activity() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.event_type='branch.forked' THEN RAISE EXCEPTION 'activity storage unavailable'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER refuse_fork_activity BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION refuse_fork_activity()`)
	require.NoError(t, err)
	input := BranchForkInput{From: "main", Name: "activity-retry", Request: "activity-fork"}
	_, err = f.service.ForkBranch(ctx, f.repoID, f.userID, input)
	require.ErrorContains(t, err, "activity storage unavailable")
	var original string
	require.NoError(t, pool.QueryRow(ctx, `SELECT id::text FROM workspaces WHERE repository_id=$1`, f.repoID).Scan(&original))
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.fork.completed'`).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, ws.WaitForProvisioning(ctx))
	_, err = pool.Exec(ctx, `DROP TRIGGER refuse_fork_activity ON product_job_events; DROP FUNCTION refuse_fork_activity()`)
	require.NoError(t, err)
	for range 2 {
		branch, err := f.service.ForkBranch(ctx, f.repoID, f.userID, input)
		require.NoError(t, err)
		require.Equal(t, original, branch.Machine.ID)
		require.Equal(t, head, branch.Head)
	}
	for _, event := range []string{"branch.fork.intended", "branch.forked", "branch.fork.completed"} {
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type=$1`, event).Scan(&count))
		require.Equal(t, 1, count, event)
	}
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1`, f.repoID).Scan(&count))
	require.Equal(t, 1, count)
}

func TestForkUnavailableStoreRefuses(t *testing.T) {
	for _, service := range []*MythicalService{nil, {}} {
		_, err := service.ForkBranch(t.Context(), 1, 1, BranchForkInput{From: "main"})
		var refusal *BranchError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, 503, refusal.Status)
		require.Equal(t, "infra", refusal.Class)
	}
}

func TestFreshForkRefusesMissingProvidersBeforeRetention(t *testing.T) {
	f := newMythicalServiceFixture(t)
	pool := f.pool.(*pgxpool.Pool)
	installBranchOwner(t, pool, f.userID)
	f.commit("Fixed revision", "retry.ts", "export const retry = 2;\n")
	head := f.publish()
	ws := installLaneService(t, pool, f.userID)
	f.service.lanes = NewWorkspaceMythicalLanes(ws)
	person, err := db.New(pool).GetUserByID(t.Context(), f.userID)
	require.NoError(t, err)
	ctx := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &person, SessionHash: "provider-fork-session"})
	ctx = registerTestInstallCredential(t, pool, ctx, f.repoID)
	complete := ws.branchMachineProviders
	transactions := ws.transactions
	for _, missing := range []string{"membership", "authorization", "lane", "microvm", "identity", "transaction", "runtime-refusal"} {
		t.Run(missing, func(t *testing.T) {
			ws.branchMachineProviders, ws.transactions = complete, transactions
			switch missing {
			case "membership":
				ws.branchMachineProviders.Membership = nil
			case "authorization":
				ws.branchMachineProviders.Authorize = nil
			case "lane":
				ws.branchMachineProviders.LaneBinding = nil
			case "microvm":
				ws.branchMachineProviders.MicroVM = nil
			case "identity":
				ws.branchMachineProviders.SessionIdentity = nil
			case "transaction":
				ws.transactions = nil
			case "runtime-refusal":
				ws.branchMachineProviders.MicroVM = func(context.Context) error { return branchForkUnavailable("runtime not qualified") }
			}
			_, err := f.service.ForkBranch(ctx, f.repoID, f.userID, BranchForkInput{From: "main", Name: "refusal", Request: "missing-" + missing})
			require.Error(t, err)
			var count int
			for _, table := range []string{"workspaces", "product_job_events"} {
				require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
				require.Zero(t, count, table)
			}
			require.Empty(t, f.hostRef("refs/heads/scratch/"+strings.ToLower(person.Username)+"/refusal"))
			require.Empty(t, f.hostRef("refs/smithers/keep/"+head))
		})
	}
	ws.branchMachineProviders, ws.transactions = complete, transactions
}

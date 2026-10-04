package services

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

// These fixtures exercise real PostgreSQL transactions, source exclusion,
// ownership, share locks and many-session attachment independently of a VM.
// Runtime/provider certification remains the reference-host C-MCH-01 check.
func branchMachineTestProviders() BranchMachineProviders {
	return BranchMachineProviders{
		Membership: func(ctx context.Context, tx pgx.Tx, repo, actor int64) error {
			var id int64
			err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 AND is_active AND deleted_at IS NULL AND NOT prohibit_login FOR SHARE`, actor).Scan(&id)
			if err != nil {
				return pkgerrors.Unauthorized("member unavailable")
			}
			return nil
		},
		Authorize:   func(context.Context, pgx.Tx, string, int64, string, int64) error { return nil },
		LaneBinding: func(context.Context, pgx.Tx, int64, string) error { return nil },
		MicroVM:     func(context.Context) error { return nil }, SessionIdentity: func(context.Context) error { return nil },
	}
}

func TestCreateWorkspaceConcurrentNamedIdentity(t *testing.T) {
	pool := newProductTestPool(t)
	alice, repo := setupTestUserAndRepo(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	var ben int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('ben-branch','ben-branch') RETURNING id`).Scan(&ben))
	svc := NewWorkspaceService(db.New(pool), WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()))
	rows := make([]db.Workspace, 60)
	errs := make([]error, 60)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range rows {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			actor := alice
			if i%3 == 1 {
				actor = ben
			}
			rows[i], errs[i] = svc.createWorkspaceRow(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: actor, Name: fmt.Sprintf("name-%d", i), Kind: []string{"container", "vm", "agent"}[i%3], TargetBookmark: "scratch/alice/shared", Status: "starting"})
		}(i)
	}
	close(start)
	wg.Wait()
	for i, err := range errs {
		require.NoError(t, err)
		require.Equal(t, rows[0].ID, rows[i].ID)
	}
	var count, owner int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*),min(user_id) FROM workspaces WHERE repository_id=$1 AND target_bookmark='scratch/alice/shared'`, repo).Scan(&count, &owner))
	require.EqualValues(t, 1, count)
	require.NotEqual(t, alice, owner)
	require.NotEqual(t, ben, owner)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_shares WHERE workspace_id=$1 AND level='write'`, rows[0].ID).Scan(&count))
	require.EqualValues(t, 2, count)
	for _, id := range []string{"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"} {
		_, err := db.New(pool).CreateAgentSession(ctx, db.CreateAgentSessionParams{ID: id, RepositoryID: repo, UserID: alice, Status: "active"})
		require.NoError(t, err)
		require.NoError(t, svc.attachBranchMachineSession(ctx, rows[0].ID, CreateAgentWorkspaceInput{RepositoryID: repo, UserID: alice, SessionID: id}))
	}
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM agent_sessions WHERE workspace_id=$1`, rows[0].ID).Scan(&count))
	require.EqualValues(t, 2, count)
	// Erasure query must not select a non-owner joiner's branch machine.
	erased, err := db.New(pool).AdminListErasureWorkspaces(ctx, ben)
	require.NoError(t, err)
	require.Empty(t, erased)
}

func TestBranchMachineProvisioningPaths(t *testing.T) {
	pool := newProductTestPool(t)
	actor, repo := setupTestUserAndRepo(t, pool)
	ctx := t.Context()
	svc := NewWorkspaceService(db.New(pool), WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()))
	base, err := svc.createWorkspaceRow(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: actor, TargetBookmark: "scratch/alice/base", Kind: "container", Status: "starting"})
	require.NoError(t, err)
	snapshot, err := db.New(pool).CreateWorkspaceSnapshot(ctx, db.CreateWorkspaceSnapshotParams{RepositoryID: repo, UserID: actor, WorkspaceID: base.ID, Name: "saved", SnapshotID: "test-snapshot"})
	require.NoError(t, err)
	for _, source := range []string{"named", "pushed-ref", "fork", "snapshot", "agent", "failed retained"} {
		t.Run(source, func(t *testing.T) {
			branch := "scratch/alice/" + source
			arg := db.CreateWorkspaceParams{RepositoryID: repo, UserID: actor, TargetBookmark: branch, Kind: "container", Status: "starting"}
			if source == "fork" {
				arg.ParentWorkspaceID = pgUUIDFromString(base.ID)
			}
			if source == "snapshot" {
				arg.SourceSnapshotID = pgUUIDFromString(snapshot.ID)
			}
			if source == "pushed-ref" {
				arg.SourceCommit = "0123456789abcdef0123456789abcdef01234567"
			}
			// Index-exempt legacy agent rows are reused after the migration;
			// new attachment never inserts an agent_session_id association.
			row, err := svc.createWorkspaceRow(ctx, arg)
			require.NoError(t, err)
			if source == "failed retained" {
				_, err = pool.Exec(ctx, `UPDATE workspaces SET status='failed',vm_id='retained-vm' WHERE id=$1`, row.ID)
				require.NoError(t, err)
			}
			reuse := arg
			reuse.Name = "different name"
			reuse.Kind = "vm"
			got, err := svc.createWorkspaceRow(ctx, reuse)
			if source == "failed retained" {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
				require.Equal(t, row.ID, got.ID)
			}
			conflict := arg
			conflict.SourceCommit = "abcdef0123456789abcdef0123456789abcdef01"
			_, err = svc.createWorkspaceRow(ctx, conflict)
			require.Error(t, err)
			var count int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1 AND target_bookmark=$2`, repo, branch).Scan(&count))
			require.Equal(t, 1, count)
		})
	}
}

func TestBranchMachineRevocation(t *testing.T) {
	pool := newProductTestPool(t)
	actor, repo := setupTestUserAndRepo(t, pool)
	ctx := t.Context()
	svc := NewWorkspaceService(db.New(pool), WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()))
	row, err := svc.createWorkspaceRow(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: actor, TargetBookmark: "scratch/alice/revoke", Kind: "container", Status: "running"})
	require.NoError(t, err)
	countEvents := func() int {
		var n int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM revocation_events WHERE kind='workspace_share_removed' AND workspace_id=$1`, row.ID).Scan(&n))
		return n
	}
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	require.NoError(t, svc.RevokeBranchMachineShare(ctx, tx, row.ID, actor))
	require.Equal(t, 0, countEvents())
	require.NoError(t, tx.Rollback(ctx))
	require.Equal(t, 0, countEvents())
	_, err = db.New(pool).GetWorkspaceShare(ctx, db.GetWorkspaceShareParams{WorkspaceID: row.ID, GranteeUserID: actor})
	require.NoError(t, err)
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	require.NoError(t, svc.RevokeBranchMachineShare(ctx, tx, row.ID, actor))
	require.NoError(t, tx.Commit(ctx))
	require.Equal(t, 1, countEvents())
	// A stale request can still have live membership but no mutation grant.
	err = svc.withWorkspaceMutationAuthority(ctx, row, actor, func(context.Context) error { t.Fatal("revoked grant must not write"); return nil })
	require.Error(t, err)
}

func TestBranchMachineMutationRechecksCurrentMember(t *testing.T) {
	pool := newProductTestPool(t)
	actor, repo := setupTestUserAndRepo(t, pool)
	ctx := t.Context()
	svc := NewWorkspaceService(db.New(pool), WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()))
	row, err := svc.createWorkspaceRow(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: actor, TargetBookmark: "scratch/alice/stale", Kind: "container", Status: "starting"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=false WHERE id=$1`, actor)
	require.NoError(t, err)
	// A persisted write grant cannot stand in for current membership.
	err = svc.withWorkspaceMutationAuthority(ctx, row, actor, func(context.Context) error { t.Fatal("removed member must write nothing"); return nil })
	require.ErrorIs(t, err, errBranchMachineAdmission)
	var status string
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM workspaces WHERE id=$1`, row.ID).Scan(&status))
	require.Equal(t, "starting", status)
}

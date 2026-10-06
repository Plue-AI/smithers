package services

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/cleanup"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/productstore"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// hostedLeaseWorkspaceStore matches private adapters that extend the public
// product contract. Lease capabilities must survive that interface boundary.
type hostedLeaseWorkspaceStore struct{ productstore.Product }

// A legacy nonbranch workspace is deleted after the configured lease age;
// before then, unavailable capture retains it awake. Renewed and leaseless
// workspaces are kept. Branch machines are covered separately below.
// Real PostgreSQL holds the rows and leases; only the VM is a test double.
func TestAbandonReaperReclaimsOnlyLapsedLeases(t *testing.T) {
	pool := newProductTestPool(t)
	user, repo := setupTestUserAndRepo(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	queries := db.New(pool)
	var mu sync.Mutex
	var suspended, deleted []string
	client := &mockWorkspaceSandboxVMClient{
		suspendVMFn: func(_ context.Context, vmID string) (sandbox.SuspendResult, error) {
			mu.Lock()
			suspended = append(suspended, vmID)
			mu.Unlock()
			return sandbox.SuspendResult{ID: vmID}, nil
		},
		deleteVMFn: func(_ context.Context, vmID string) error {
			mu.Lock()
			deleted = append(deleted, vmID)
			mu.Unlock()
			return nil
		},
	}
	svc := NewWorkspaceService(hostedLeaseWorkspaceStore{productstore.New(pool)}, WithWorkspaceSandboxClient(client), WithWorkspaceLeaseDeleteAfter(time.Hour))
	create := func(name string, lease int32, lapsedFor time.Duration) db.Workspace {
		t.Helper()
		row, err := queries.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: user, Name: name,
			TargetBookmark: "main", Kind: "container", EnvironmentSource: defaultWorkspaceEnvironmentSource, Status: "running"})
		require.NoError(t, err)
		row, err = queries.UpdateWorkspaceExecutionInfo(ctx, db.UpdateWorkspaceExecutionInfoParams{ID: row.ID, VmID: "vm-" + name, Status: "running"})
		require.NoError(t, err)
		if lease > 0 {
			row, err = svc.applyWorkspaceClientLease(ctx, row, lease)
			require.NoError(t, err)
			require.True(t, row.ClientLeaseExpiresAt.Valid)
		}
		if lapsedFor > 0 {
			_, err = pool.Exec(ctx, `UPDATE workspaces SET client_lease_expires_at = NOW() - make_interval(secs => $2) WHERE id = $1`, row.ID, lapsedFor.Seconds())
			require.NoError(t, err)
		}
		return row
	}
	lapsed := create("lapsed", 60, time.Minute)
	expired := create("expired", 60, 2*time.Hour)
	renewed := create("renewed", 60, time.Minute)
	leaseless := create("leaseless", 0, 0)

	resp, err := svc.RenewWorkspaceLease(ctx, renewed.ID, repo, user)
	require.NoError(t, err)
	require.NotNil(t, resp.ClientLeaseExpiresAt)
	require.True(t, resp.ClientLeaseExpiresAt.After(time.Now().Add(50*time.Second)), "a renew extends by the lease length")

	require.ErrorContains(t, svc.CleanupAbandonedWorkspaces(ctx), "branch sleep requires verified capture")
	get := func(id string) db.Workspace {
		row, err := queries.GetWorkspaceIncludingDeleted(ctx, id)
		require.NoError(t, err)
		return row
	}
	require.Equal(t, "running", get(lapsed.ID).Status)
	require.False(t, get(lapsed.ID).DeletedAt.Valid)
	require.True(t, get(expired.ID).DeletedAt.Valid, "a lease lapsed past the delete age is deleted")
	require.Equal(t, "running", get(renewed.ID).Status)
	require.Equal(t, "running", get(leaseless.ID).Status)
	require.False(t, get(leaseless.ID).DeletedAt.Valid)
	require.Empty(t, suspended, "missing capture must not suspend")
	require.Equal(t, []string{"vm-expired"}, deleted)

	// The legacy nonbranch consumer still deletes once its lease age passes.
	_, err = pool.Exec(ctx, `UPDATE workspaces SET client_lease_expires_at = NOW() - interval '2 hours' WHERE id = $1`, lapsed.ID)
	require.NoError(t, err)
	require.NoError(t, svc.CleanupAbandonedWorkspaces(ctx))
	require.True(t, get(lapsed.ID).DeletedAt.Valid)
	require.Equal(t, "running", get(renewed.ID).Status)
	require.Equal(t, "running", get(leaseless.ID).Status)

	// A workspace without a lease has nothing to renew.
	_, err = svc.RenewWorkspaceLease(ctx, leaseless.ID, repo, user)
	require.Equal(t, http.StatusConflict, apiErrorOf(t, err).Status)
}

func TestWorkspaceClientLeaseBounds(t *testing.T) {
	for _, seconds := range []int32{0, minWorkspaceClientLeaseSeconds, maxWorkspaceClientLeaseSeconds} {
		require.NoError(t, validateWorkspaceClientLease(seconds), seconds)
	}
	for _, seconds := range []int32{-1, minWorkspaceClientLeaseSeconds - 1, maxWorkspaceClientLeaseSeconds + 1} {
		require.Equal(t, http.StatusBadRequest, apiErrorOf(t, validateWorkspaceClientLease(seconds)).Status, seconds)
	}
	err := validateWorkspaceCreateMetadata(CreateWorkspaceInput{ClientLeaseSeconds: 30})
	require.Equal(t, http.StatusBadRequest, apiErrorOf(t, err).Status)
}

func TestAbandonReaperRetainsBranchMachineRegardlessOfLeaseAge(t *testing.T) {
	pool := newProductTestPool(t)
	_, repo := setupTestUserAndRepo(t, pool)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	svc := NewWorkspaceService(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		suspendVMFn: func(context.Context, string) (sandbox.SuspendResult, error) {
			t.Fatal("branch lease lapse suspended uncaptured work")
			return sandbox.SuspendResult{}, nil
		},
		deleteVMFn: func(context.Context, string) error {
			t.Fatal("branch lease lapse deleted retained work")
			return nil
		},
	}))
	for _, age := range []time.Duration{time.Minute, 30 * 24 * time.Hour} {
		row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner,
			Name: age.String(), TargetBookmark: age.String(), Kind: "vm", EnvironmentSource: defaultWorkspaceEnvironmentSource, Status: "running"})
		require.NoError(t, err)
		_, err = q.UpdateWorkspaceExecutionInfo(ctx, db.UpdateWorkspaceExecutionInfoParams{ID: row.ID, VmID: "vm-" + row.ID, Status: "running"})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE workspaces SET client_lease_secs=60, client_lease_expires_at=NOW()-make_interval(secs=>$2) WHERE id=$1`, row.ID, age.Seconds())
		require.NoError(t, err)
		store := &branchLeaseCleanupStore{darkCleanupStore{WorkspaceService: svc, tick: make(chan struct{}, 1)}}
		cleaner := cleanup.NewWorkspaceCleaner(store, time.Millisecond)
		cleaner.Start(t.Context())
		select {
		case <-store.tick:
		case <-time.After(time.Second):
			cleaner.Stop()
			t.Fatal("branch lease cleanup never completed a tick")
		}
		cleaner.Stop()
		retained, err := q.GetWorkspaceIncludingDeleted(ctx, row.ID)
		require.NoError(t, err)
		require.Equal(t, "running", retained.Status)
		require.False(t, retained.DeletedAt.Valid)
	}
}

// Other steps are isolated; the production cleaner calls the actual branch
// lease guard through WorkspaceService on each tick.
type branchLeaseCleanupStore struct{ darkCleanupStore }

func (s *branchLeaseCleanupStore) CleanupAbandonedWorkspaces(ctx context.Context) error {
	return s.WorkspaceService.CleanupAbandonedWorkspaces(ctx)
}

// A create without a lease clears one a reused row still carries, so a
// workspace another caller now depends on is never reaped for the old client.
func TestApplyWorkspaceClientLeaseClearsAReusedLease(t *testing.T) {
	pool := newProductTestPool(t)
	user, repo := setupTestUserAndRepo(t, pool)
	ctx := context.Background()
	queries := db.New(pool)
	svc := NewWorkspaceService(hostedLeaseWorkspaceStore{productstore.New(pool)})
	row, err := queries.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: user, Name: "reused",
		TargetBookmark: "main", Kind: "container", EnvironmentSource: defaultWorkspaceEnvironmentSource, Status: "running"})
	require.NoError(t, err)
	unchanged, err := svc.applyWorkspaceClientLease(ctx, row, 0)
	require.NoError(t, err)
	require.Equal(t, row, unchanged, "no lease requested and none held: no write")
	leased, err := svc.applyWorkspaceClientLease(ctx, row, 120)
	require.NoError(t, err)
	require.Equal(t, pgtype.Int4{Int32: 120, Valid: true}, leased.ClientLeaseSecs)
	cleared, err := svc.applyWorkspaceClientLease(ctx, leased, 0)
	require.NoError(t, err)
	require.False(t, cleared.ClientLeaseSecs.Valid)
	require.False(t, cleared.ClientLeaseExpiresAt.Valid)
}

package services

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// A workspace whose client lease lapsed is suspended, then deleted after the
// configured age; a renewed lease and a workspace without a lease are kept.
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
	svc := NewWorkspaceService(queries, WithWorkspaceSandboxClient(client), WithWorkspaceLeaseDeleteAfter(time.Hour))
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

	require.NoError(t, svc.CleanupAbandonedWorkspaces(ctx))
	get := func(id string) db.Workspace {
		row, err := queries.GetWorkspaceIncludingDeleted(ctx, id)
		require.NoError(t, err)
		return row
	}
	require.Equal(t, "suspended", get(lapsed.ID).Status)
	require.False(t, get(lapsed.ID).DeletedAt.Valid)
	require.True(t, get(expired.ID).DeletedAt.Valid, "a lease lapsed past the delete age is deleted")
	require.Equal(t, "running", get(renewed.ID).Status)
	require.Equal(t, "running", get(leaseless.ID).Status)
	require.False(t, get(leaseless.ID).DeletedAt.Valid)
	require.Equal(t, []string{"vm-lapsed"}, suspended)
	require.Equal(t, []string{"vm-expired"}, deleted)

	// Once the suspended workspace also passes the delete age it is deleted.
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

// A create without a lease clears one a reused row still carries, so a
// workspace another caller now depends on is never reaped for the old client.
func TestApplyWorkspaceClientLeaseClearsAReusedLease(t *testing.T) {
	pool := newProductTestPool(t)
	user, repo := setupTestUserAndRepo(t, pool)
	ctx := context.Background()
	queries := db.New(pool)
	svc := NewWorkspaceService(queries)
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

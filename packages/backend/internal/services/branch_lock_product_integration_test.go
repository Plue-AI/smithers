package services

import (
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// The full join flow runs against the migrated product schema: ask, approve,
// share, and after a release/reacquire the old approval no longer counts.
func TestBranchLockJoinOnMigratedProductDatabase(t *testing.T) {
	p := newProductTestPool(t)
	ctx := t.Context()
	_, err := p.Exec(ctx, `INSERT INTO users(id,username,lower_username) VALUES (1,'alice','alice'),(2,'bob','bob')`)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, p.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES (1,'review','review') RETURNING id`).Scan(&repo))
	q := db.New(p)
	s := NewBranchLockService(q)
	_, err = s.AcquireBranchLock(ctx, AcquireBranchLockInput{RepositoryID: repo, Branch: "main", UserID: 1})
	require.NoError(t, err)
	request, err := s.RequestBranchLockJoin(ctx, RequestBranchLockJoinInput{RepositoryID: repo, Branch: "main", UserID: 2, Username: "bob"})
	require.NoError(t, err)
	require.Equal(t, "pending", request.Status)
	_, err = s.DecideBranchLockJoin(ctx, DecideBranchLockJoinInput{RepositoryID: repo, JoinRequestID: request.ID, ResolverID: 1, Approve: true})
	require.NoError(t, err)
	shared, err := s.AcquireBranchLock(ctx, AcquireBranchLockInput{RepositoryID: repo, Branch: "main", UserID: 2})
	require.NoError(t, err)
	require.True(t, shared.Shared)
	require.NoError(t, s.ReleaseBranchLock(ctx, AcquireBranchLockInput{RepositoryID: repo, Branch: "main", UserID: 1}))
	_, err = s.AcquireBranchLock(ctx, AcquireBranchLockInput{RepositoryID: repo, Branch: "main", UserID: 1})
	require.NoError(t, err)
	_, err = s.AcquireBranchLock(ctx, AcquireBranchLockInput{RepositoryID: repo, Branch: "main", UserID: 2})
	require.Error(t, err)
	fresh, err := s.RequestBranchLockJoin(ctx, RequestBranchLockJoinInput{RepositoryID: repo, Branch: "main", UserID: 2, Username: "bob"})
	require.NoError(t, err)
	require.NotEqual(t, request.ID, fresh.ID)
}

package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestDecideBranchLockJoin_RefusesRequestFromAnotherRepository(t *testing.T) {
	for _, approve := range []bool{true, false} {
		name := "deny"
		if approve {
			name = "approve"
		}
		t.Run(name, func(t *testing.T) {
			lockLoaded := false
			resolved := false
			q := &mockBranchLockQuerier{
				getJoinFn: func(ctx context.Context, id int64) (db.BranchLockJoinRequest, error) {
					require.Equal(t, int64(5), id)
					return db.BranchLockJoinRequest{ID: id, RepositoryID: 1, Branch: "landing/app/main", RequesterID: 7, Status: "pending", LockGeneration: testLockGeneration}, nil
				},
				getLockFn: func(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error) {
					lockLoaded = true
					return liveLock(9), nil
				},
				resolveJoinFn: func(ctx context.Context, arg db.ResolveBranchLockJoinRequestParams) (db.BranchLockJoinRequest, error) {
					resolved = true
					return db.BranchLockJoinRequest{ID: arg.ID, RepositoryID: 1, Branch: "landing/app/main", RequesterID: 7, Status: arg.Status, LockGeneration: testLockGeneration}, nil
				},
			}
			notifier := &mockBranchLockNotifier{}
			svc := NewBranchLockService(q, WithBranchLockNotifier(notifier))
			input := DecideBranchLockJoinInput{RepositoryID: 2, JoinRequestID: 5, ResolverID: 9, Approve: approve}
			_, err := svc.DecideBranchLockJoin(context.Background(), input)
			apiErr, ok := err.(*pkgerrors.APIError)
			require.True(t, ok, "a request in repository 1 must not be decided via repository 2")
			require.Equal(t, 404, apiErr.Status)
			require.False(t, lockLoaded, "foreign repository lock must not be inspected")
			require.False(t, resolved, "pending request must not be mutated")
			require.Empty(t, notifier.created, "foreign requester must not be notified")
		})
	}
}

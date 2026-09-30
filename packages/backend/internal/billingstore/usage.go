package billingstore

import (
	"context"
	"errors"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Usage reports complete metered values, not deltas added to another query.
// A private implementation may embed ProductUsage and override only the facts
// affected by private reservations and retained physical allocations.
type Usage interface {
	CountPrivateReposByOwner(context.Context, db.CountPrivateReposByOwnerParams) (int64, error)
	CountReposByOwner(context.Context, db.CountReposByOwnerParams) (int64, error)
	SumStorageBytesByOwner(context.Context, db.SumStorageBytesByOwnerParams) (int64, error)
	SumStorageBytesByRepository(context.Context, int64) (int64, error)
	CountActiveSandboxesForUser(context.Context, int64) (int, error)
	CountActiveAgentSessionVMsForUser(context.Context, int64) (int64, error)
	SumSandboxAwakeSecondsForUserSince(context.Context, int64, time.Time) (int64, error)
	CountOtherActiveSandboxesForWorkspaceResume(context.Context, db.CountOtherActiveSandboxesForWorkspaceResumeParams) (db.CountOtherActiveSandboxesForWorkspaceResumeRow, error)
}

// UsageFactory must bind every query to the supplied handle. It is called for
// the original pool and again for each transaction, including a caller-owned
// transaction. It must not open its own connection or replace the handle.
type UsageFactory func(db.DBTX) (Usage, error)

type Queries struct {
	*db.Queries
	usage Usage
	bind  UsageFactory
}

func Bind(conn db.DBTX, factory UsageFactory) (*Queries, error) {
	usage, err := factory(conn)
	if err != nil {
		return nil, err
	}
	if usage == nil {
		return nil, errors.New("admission: usage factory returned no authority")
	}
	return &Queries{Queries: db.New(conn), usage: usage, bind: factory}, nil
}

func (q *Queries) RebindBillingQueries(conn db.DBTX) (Querier, error) {
	return Bind(conn, q.bind)
}

func (q *Queries) CountPrivateReposByOwner(ctx context.Context, owner db.CountPrivateReposByOwnerParams) (int64, error) {
	return q.usage.CountPrivateReposByOwner(ctx, owner)
}
func (q *Queries) CountReposByOwner(ctx context.Context, owner db.CountReposByOwnerParams) (int64, error) {
	return q.usage.CountReposByOwner(ctx, owner)
}
func (q *Queries) SumStorageBytesByOwner(ctx context.Context, owner db.SumStorageBytesByOwnerParams) (int64, error) {
	return q.usage.SumStorageBytesByOwner(ctx, owner)
}
func (q *Queries) SumStorageBytesByRepository(ctx context.Context, repositoryID int64) (int64, error) {
	return q.usage.SumStorageBytesByRepository(ctx, repositoryID)
}
func (q *Queries) CountActiveSandboxesForUser(ctx context.Context, userID int64) (int, error) {
	return q.usage.CountActiveSandboxesForUser(ctx, userID)
}
func (q *Queries) CountActiveAgentSessionVMsForUser(ctx context.Context, userID int64) (int64, error) {
	return q.usage.CountActiveAgentSessionVMsForUser(ctx, userID)
}
func (q *Queries) SumSandboxAwakeSecondsForUserSince(ctx context.Context, userID int64, since time.Time) (int64, error) {
	return q.usage.SumSandboxAwakeSecondsForUserSince(ctx, userID, since)
}
func (q *Queries) CountOtherActiveSandboxesForWorkspaceResume(ctx context.Context, request db.CountOtherActiveSandboxesForWorkspaceResumeParams) (db.CountOtherActiveSandboxesForWorkspaceResumeRow, error) {
	return q.usage.CountOtherActiveSandboxesForWorkspaceResume(ctx, request)
}

var _ Querier = (*Queries)(nil)
var _ Rebinder = (*Queries)(nil)

package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Component evidence only: production dispatcher and process-kill acceptance
// remain pending until the dependency lanes supply their install composition.
func TestMythicalOutboundLeaseAndLostResponse(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	var userID, repoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES ('outbound','outbound') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'outbound','outbound') RETURNING id`, userID).Scan(&repoID))
	_, err := q.RequestMythicalBootstrap(ctx, repoID, userID, 100, false)
	require.NoError(t, err)
	claims, err := q.ClaimMythicalStacks(ctx, 1, 600)
	require.NoError(t, err)
	require.Len(t, claims, 1)
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repoID, IssueNumber: pgtype.Int8{Int64: 1, Valid: true}, State: "proposing"})
	require.NoError(t, err)
	item.PendingOp = json.RawMessage(`{"kind":"push","target":"smithers/issue-1","desired":"new","precondition":"old","state":"intended"}`)
	_, err = q.SaveMythicalItemUnderLease(ctx, item, claims[0].Claim+1)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.ErrorIs(t, err, db.ErrMythicalLeaseLost)
	item, err = q.SaveMythicalItemUnderLease(ctx, item, claims[0].Claim)
	require.NoError(t, err)
	_, err = q.SaveMythicalItemUnderLease(ctx, item, claims[0].Claim+1)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.ErrorIs(t, err, db.ErrMythicalLeaseLost)
	pending, err := q.ListMythicalPendingOperations(ctx, repoID)
	require.NoError(t, err)
	require.Len(t, pending, 1, "a dropped obligation remains visible")
	allow := func(context.Context, db.MythicalItem, string) error { return nil }
	s := &MythicalService{outbound: MythicalOutboundProviders{CanonicalApp: allow, StackLease: allow, Budget: allow, Membership: allow, Authorization: allow, AcceptedGeneration: allow}}
	observed, sends := "old", 0
	s.outbound.Lookup = func(*mythicalItemStep, context.Context, db.MythicalItem, MythicalOutboundOp) (string, bool, error) {
		return observed, false, nil
	}
	s.outbound.Send = func(_ *mythicalItemStep, ctx context.Context, sent db.MythicalItem, op MythicalOutboundOp) error {
		persisted, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		require.JSONEq(t, `{"kind":"push","target":"smithers/issue-1","desired":"new","precondition":"old","state":"unknown"}`, string(persisted.PendingOp))
		sends++
		observed = "new"
		return errors.New("response lost")
	}
	st := mythicalItemStep{s: s, q: q, r: &mythicalRun{row: claims[0]}}
	_, err = st.recoverOutbound(ctx, item)
	require.ErrorContains(t, err, "response lost")
	reloaded, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	reloaded.State = "cancelled"
	reloaded, err = q.SaveMythicalItemUnderLease(ctx, reloaded, claims[0].Claim)
	require.NoError(t, err)
	// A new worker on the same durable rows looks up before attempting a repeat.
	restarted := mythicalItemStep{s: &MythicalService{outbound: s.outbound}, q: db.New(pool), r: &mythicalRun{row: claims[0]}}
	settled, err := restarted.recoverOutbound(ctx, reloaded)
	require.NoError(t, err)
	require.Equal(t, "new", settled.PRHead)
	require.Empty(t, settled.PendingOp)
	require.Equal(t, "cancelled", settled.State, "recovery never resurrects a dropped item")
	require.Equal(t, 1, sends)
	_, err = q.SaveMythicalItemUnderLease(ctx, reloaded, claims[0].Claim)
	require.ErrorIs(t, err, pgx.ErrNoRows, "stale version cannot replace settlement")
	require.ErrorIs(t, err, db.ErrMythicalItemMoved)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET lease_expires_at = NOW() - interval '1 second' WHERE repository_id = $1`, repoID)
	require.NoError(t, err)
	_, err = q.SaveMythicalItemUnderLease(ctx, *settled, claims[0].Claim)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.ErrorIs(t, err, db.ErrMythicalLeaseLost)
}

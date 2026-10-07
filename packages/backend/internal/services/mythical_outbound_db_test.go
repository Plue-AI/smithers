package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
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

// The remote effect is already confirmed. PostgreSQL must publish its card
// transition and durable live event together, even when a worker recovers it.
func TestMythicalOutboundSettlementPublishesAtomically(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := t.Context()
	q := db.New(pool)
	var userID, repoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES ('settlement','settlement') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'settlement','settlement') RETURNING id`, userID).Scan(&repoID))
	_, err := q.RequestMythicalBootstrap(ctx, repoID, userID, 100, false)
	require.NoError(t, err)
	claims, err := q.ClaimMythicalStacks(ctx, 1, 600)
	require.NoError(t, err)
	require.Len(t, claims, 1)
	item, err := q.InsertMythicalTodo(ctx, repoID, userID, "Merge", "Merge the reviewed change", json.RawMessage(`[]`), json.RawMessage(`{"todo":true}`))
	require.NoError(t, err)
	require.True(t, item.Number.Valid)
	item.State = "proposed"
	item.PRState = "open"
	item.PendingOp = json.RawMessage(`{"kind":"merge","target":"1","desired":"merged","precondition":"open","state":"done"}`)
	item, err = q.SaveMythicalItemUnderLease(ctx, item, claims[0].Claim)
	require.NoError(t, err)
	// A confirmed GitHub result is supplied at the provider boundary; database
	// leasing, CAS, state persistence and event replay all use real PostgreSQL.
	s := &MythicalService{store: pool, outbound: MythicalOutboundProviders{Settle: func(_ *mythicalItemStep, _ context.Context, next db.MythicalItem, _ MythicalOutboundOp) (db.MythicalItem, error) {
		next.State = "landed"
		next.PRState = "merged"
		next.PRMergeCommit = "confirmed-squash"
		return next, nil
	}}}
	st := mythicalItemStep{s: s, q: q, r: &mythicalRun{row: claims[0]}}
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	assertUnsettled := func() {
		t.Helper()
		current, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		require.Equal(t, item.Version, current.Version)
		require.Equal(t, "proposed", current.State)
		require.JSONEq(t, string(item.PendingOp), string(current.PendingOp))
		events, err := store.Replay(ctx, todoOperationScope(item), 0, 100)
		require.NoError(t, err)
		require.Empty(t, events.Events)
	}
	_, err = pool.Exec(ctx, `CREATE FUNCTION reject_settlement_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected settlement event failure'; END $$;
 CREATE TRIGGER reject_settlement_event BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION reject_settlement_event()`)
	require.NoError(t, err)
	_, err = st.recoverOutbound(ctx, item)
	require.ErrorContains(t, err, "injected settlement event failure")
	assertUnsettled()
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_settlement_event ON product_job_events; DROP FUNCTION reject_settlement_event()`)
	require.NoError(t, err)
	// Event publication can wait on another stream writer long enough to lose
	// the lease. Inject that boundary and require the entire settlement to roll back.
	_, err = pool.Exec(ctx, `CREATE FUNCTION expire_settlement_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE mythical_stacks SET lease_expires_at=clock_timestamp()-interval '1 second'; RETURN NEW; END $$;
    CREATE TRIGGER expire_settlement_lease BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION expire_settlement_lease()`)
	require.NoError(t, err)
	_, err = st.recoverOutbound(ctx, item)
	require.ErrorIs(t, err, db.ErrMythicalLeaseLost)
	assertUnsettled()
	_, err = pool.Exec(ctx, `DROP TRIGGER expire_settlement_lease ON product_job_events; DROP FUNCTION expire_settlement_lease()`)
	require.NoError(t, err)
	stale := item
	stale.Version--
	_, err = st.recoverOutbound(ctx, stale)
	require.ErrorIs(t, err, db.ErrMythicalItemMoved)
	assertUnsettled()
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET lease_expires_at=NOW()-interval '1 second' WHERE repository_id=$1`, repoID)
	require.NoError(t, err)
	_, err = st.recoverOutbound(ctx, item)
	require.ErrorIs(t, err, db.ErrMythicalLeaseLost)
	assertUnsettled()
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET lease_expires_at=NOW()+interval '10 minutes' WHERE repository_id=$1`, repoID)
	require.NoError(t, err)
	settled, err := st.recoverOutbound(ctx, item)
	require.NoError(t, err)
	require.Equal(t, "landed", settled.State)
	require.Empty(t, settled.PendingOp)
	require.Equal(t, item.Version+1, settled.Version)
	events, err := store.Replay(ctx, todoOperationScope(item), 0, 100)
	require.NoError(t, err)
	require.Len(t, events.Events, 1)
	require.Equal(t, "todo.github_operation_settled", events.Events[0].Type)
	var fact map[string]any
	require.NoError(t, json.Unmarshal(events.Events[0].Data, &fact))
	require.Equal(t, "merged", fact["to"])
	require.Equal(t, "in_review", fact["from"])
	require.Equal(t, "confirmed-squash", fact["merge_commit"])
	require.Equal(t, float64(item.Number.Int64), fact["n"])
	// Replaying a stale worker's confirmed intent cannot publish twice.
	_, err = st.recoverOutbound(ctx, item)
	require.ErrorIs(t, err, db.ErrMythicalItemMoved)
	replay, err := store.Replay(ctx, todoOperationScope(item), 0, 100)
	require.NoError(t, err)
	require.Len(t, replay.Events, 1)
	require.Equal(t, events.Events[0].Sequence, replay.Events[0].Sequence)
}

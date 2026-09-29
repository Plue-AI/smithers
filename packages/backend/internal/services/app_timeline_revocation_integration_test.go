package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Gate the first real PostgreSQL transaction before or just after its advisory lock.
type timelinePGGate struct {
	pool             *pgxpool.Pool
	at               string
	entered, release chan struct{}
	attempted        chan struct{}
	once             sync.Once
}

func (g *timelinePGGate) Begin(ctx context.Context) (pgx.Tx, error) {
	first := false
	g.once.Do(func() { first = true })
	if first && g.at == "begin" {
		close(g.entered)
		select {
		case <-g.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	tx, err := g.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if first && g.at == "lock" {
		return &timelinePGTx{Tx: tx, entered: g.entered, release: g.release}, nil
	}
	if !first && g.at == "lock" {
		return &timelinePGAttemptTx{Tx: tx, attempted: g.attempted}, nil
	}
	return tx, nil
}

type timelinePGAttemptTx struct {
	pgx.Tx
	attempted chan struct{}
	once      sync.Once
}

func (x *timelinePGAttemptTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if strings.Contains(sql, "pg_advisory_xact_lock") {
		x.once.Do(func() { close(x.attempted) })
	}
	return x.Tx.Exec(ctx, sql, args...)
}

type timelinePGTx struct {
	pgx.Tx
	entered, release chan struct{}
	once             sync.Once
}

func (x *timelinePGTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tag, err := x.Tx.Exec(ctx, sql, args...)
	if err != nil {
		return tag, err
	}
	var waitErr error
	if !strings.Contains(sql, "pg_advisory_xact_lock") {
		return tag, nil
	}
	x.once.Do(func() {
		close(x.entered)
		select {
		case <-x.release:
		case <-ctx.Done():
			waitErr = ctx.Err()
		}
	})
	return tag, waitErr
}
func seedTimelinePG(t *testing.T, p *pgxpool.Pool) (string, int64, int64, string) {
	t.Helper()
	ctx := t.Context()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	names := []string{"tl_owner_" + suffix, "tl_editor_" + suffix}
	var ids [2]int64
	for i, name := range names {
		require.NoError(t, p.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES($1,$1) RETURNING id`, name).Scan(&ids[i]))
	}
	id := uuid.NewString()
	_, err := p.Exec(ctx, `INSERT INTO app_timelines(id,owner_user_id,head_seq) VALUES($1,$2,1)`, id, ids[0])
	require.NoError(t, err)
	_, err = p.Exec(ctx, `INSERT INTO app_timeline_members(timeline_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'editor')`, id, ids[0], ids[1])
	require.NoError(t, err)
	_, err = p.Exec(ctx, `INSERT INTO app_timeline_events(timeline_id,seq,payload) VALUES($1,0,'{"original":true}')`, id)
	require.NoError(t, err)
	_, err = p.Exec(ctx, `INSERT INTO app_timeline_snapshots(timeline_id,seq,state) VALUES($1,1,'{"original":true}')`, id)
	require.NoError(t, err)
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = p.Exec(c, `DELETE FROM users WHERE id=ANY($1::bigint[])`, ids[:])
	})
	return id, ids[0], ids[1], names[1]
}
func timelinePGState(t *testing.T, p *pgxpool.Pool, id string) (int64, string, string) {
	t.Helper()
	ctx := t.Context()
	var head int64
	var event, snapshot string
	var ec, sc int64
	require.NoError(t, p.QueryRow(ctx, `SELECT head_seq FROM app_timelines WHERE id=$1`, id).Scan(&head))
	require.NoError(t, p.QueryRow(ctx, `SELECT count(*),coalesce(min(payload::text),'') FROM app_timeline_events WHERE timeline_id=$1`, id).Scan(&ec, &event))
	require.NoError(t, p.QueryRow(ctx, `SELECT count(*),coalesce(min(state::text),'') FROM app_timeline_snapshots WHERE timeline_id=$1`, id).Scan(&sc, &snapshot))
	require.EqualValues(t, 1, ec)
	return head, event, snapshot
}
func requireOriginalTimelinePG(t *testing.T, p *pgxpool.Pool, id string) {
	t.Helper()
	head, event, snapshot := timelinePGState(t, p, id)
	require.EqualValues(t, 1, head)
	require.JSONEq(t, `{"original":true}`, event)
	require.JSONEq(t, `{"original":true}`, snapshot)
	var snapshotCount int64
	require.NoError(t, p.QueryRow(t.Context(), `SELECT count(*) FROM app_timeline_snapshots WHERE timeline_id=$1`, id).Scan(&snapshotCount))
	require.EqualValues(t, 1, snapshotCount)
}
func TestAppTimeline_PostgresMembershipLockOrder(t *testing.T) {
	if testing.Short() {
		t.Skip("PostgreSQL integration")
	}
	p := setupTestPool(t)
	for _, order := range []string{"owner-first", "writer-first"} {
		for _, change := range []string{"remove", "demote"} {
			for _, write := range []string{"append", "rewrite", "snapshot"} {
				if order == "writer-first" && write != "append" {
					continue
				}
				t.Run(order+"/"+change+"/"+write, func(t *testing.T) {
					id, owner, editor, name := seedTimelinePG(t, p)
					ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
					defer cancel()
					gate := &timelinePGGate{pool: p, at: "begin", entered: make(chan struct{}), release: make(chan struct{}), attempted: make(chan struct{})}
					if order == "writer-first" {
						gate.at = "lock"
					}
					s := NewAppTimelineService(db.New(p), WithAppTimelineTxBeginner(gate))
					writes := make(chan error, 1)
					go func() {
						switch write {
						case "append":
							writes <- s.AppendEvents(ctx, editor, id, []AppTimelineEventWrite{{Seq: 0, Payload: json.RawMessage(`{"new":true}`)}})
						case "rewrite":
							writes <- s.Rewrite(ctx, editor, id, AppTimelineDump{Version: 1, Events: []json.RawMessage{json.RawMessage(`{"new":true}`)}})
						case "snapshot":
							writes <- s.PutSnapshot(ctx, editor, id, 1, json.RawMessage(`{"new":true}`))
						}
					}()
					select {
					case <-gate.entered:
					case <-ctx.Done():
						t.Fatal("writer never reached lock gate")
					}
					changeMember := func() error {
						if change == "remove" {
							return s.RemoveMember(ctx, owner, id, editor)
						}
						_, err := s.AddMember(ctx, owner, id, name, AppTimelineRoleViewer)
						return err
					}
					if order == "owner-first" {
						require.NoError(t, changeMember())
						close(gate.release)
						select {
						case err := <-writes:
							if change == "remove" {
								wantStatus(t, err, http.StatusNotFound)
							} else {
								wantStatus(t, err, http.StatusForbidden)
							}
						case <-ctx.Done():
							t.Fatal("writer stalled")
						}
						requireOriginalTimelinePG(t, p, id)
					} else {
						changes := make(chan error, 1)
						go func() { changes <- changeMember() }()
						select {
						case <-gate.attempted:
						case <-ctx.Done():
							t.Fatal("membership change never attempted lock")
						}
						select {
						case err := <-changes:
							t.Fatalf("membership changed while writer held lock: %v", err)
						case <-time.After(100 * time.Millisecond):
						}
						close(gate.release)
						select {
						case err := <-writes:
							require.NoError(t, err)
						case <-ctx.Done():
							t.Fatal("writer stalled")
						}
						select {
						case err := <-changes:
							require.NoError(t, err)
						case <-ctx.Done():
							t.Fatal("membership change stalled")
						}
						head, event, _ := timelinePGState(t, p, id)
						require.EqualValues(t, 1, head)
						require.JSONEq(t, `{"new":true}`, event)
						var snapshotCount int64
						require.NoError(t, p.QueryRow(ctx, `SELECT count(*) FROM app_timeline_snapshots WHERE timeline_id=$1`, id).Scan(&snapshotCount))
						require.Zero(t, snapshotCount)
					}
				})
			}
		}
	}
}

func TestAppTimeline_PostgresRewriteFailureRollsBack(t *testing.T) {
	if testing.Short() {
		t.Skip("PostgreSQL integration")
	}
	p := setupTestPool(t)
	id, _, editor, _ := seedTimelinePG(t, p)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	fn := "timeline_reject_" + suffix
	tr := "timeline_trigger_" + suffix
	ctx := t.Context()
	_, err := p.Exec(ctx, fmt.Sprintf(`CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected timeline insert failure'; END $$`, fn))
	require.NoError(t, err)
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = p.Exec(c, fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON app_timeline_events`, tr))
		_, _ = p.Exec(c, fmt.Sprintf(`DROP FUNCTION IF EXISTS %s()`, fn))
	})
	_, err = p.Exec(ctx, fmt.Sprintf(`CREATE TRIGGER %s BEFORE INSERT ON app_timeline_events FOR EACH ROW WHEN (NEW.timeline_id = '%s'::uuid) EXECUTE FUNCTION %s()`, tr, id, fn))
	require.NoError(t, err)
	s := NewAppTimelineService(db.New(p), WithAppTimelineTxBeginner(p))
	err = s.Rewrite(ctx, editor, id, AppTimelineDump{Version: 1, Events: []json.RawMessage{json.RawMessage(`{"new":true}`)}})
	require.Error(t, err)
	requireOriginalTimelinePG(t, p, id)
}

func TestAppTimeline_PostgresCancelledLockWaitPreservesState(t *testing.T) {
	if testing.Short() {
		t.Skip("PostgreSQL integration")
	}
	p := setupTestPool(t)
	id, _, editor, _ := seedTimelinePG(t, p)
	ctx := t.Context()
	tx, err := p.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "app-timeline:"+id)
	require.NoError(t, err)
	waitCtx, cancel := context.WithTimeout(ctx, 120*time.Millisecond)
	defer cancel()
	s := NewAppTimelineService(db.New(p), WithAppTimelineTxBeginner(p))
	err = s.AppendEvents(waitCtx, editor, id, []AppTimelineEventWrite{{Seq: 0, Payload: json.RawMessage(`{"new":true}`)}})
	require.Error(t, err)
	require.ErrorContains(t, err, "lock app timeline mutation")
	require.ErrorIs(t, waitCtx.Err(), context.DeadlineExceeded)
	require.NoError(t, tx.Rollback(ctx))
	requireOriginalTimelinePG(t, p, id)
}

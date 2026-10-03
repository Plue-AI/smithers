package services

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func publishOne(ctx context.Context, tx pgx.Tx, topic string, payload any) (int64, error) {
	seqs, err := Publish(ctx, tx, Projection{Topic: topic, Payload: payload})
	if err != nil {
		return 0, err
	}
	return seqs[0], nil
}

// Twenty writers publish to one topic at once, some rolling back: the seqs
// that commit are exactly 1..n with no gap, each payload once.
func TestProjectionSeqIsGapFreeUnderConcurrentWriters(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	var mu sync.Mutex
	committed := map[int64]int{}
	errs := make(chan error, 20)
	for i := range 20 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			tx, err := pool.Begin(ctx)
			if err != nil {
				errs <- err
				return
			}
			seq, err := publishOne(ctx, tx, "todo:7", map[string]int{"writer": i})
			if err != nil {
				_ = tx.Rollback(ctx)
				errs <- err
				return
			}
			if i%4 == 0 {
				errs <- tx.Rollback(ctx)
				return
			}
			if err := tx.Commit(ctx); err != nil {
				errs <- err
				return
			}
			mu.Lock()
			committed[seq] = i
			mu.Unlock()
			errs <- nil
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	rows, err := db.New(pool).ListProjectionEvents(ctx, db.ListProjectionEventsParams{Topic: "todo:7", RowLimit: 100})
	require.NoError(t, err)
	require.Len(t, rows, 15, "the five rolled-back writers left no row")
	writers := map[int]bool{}
	for i, row := range rows {
		assert.Equal(t, int64(i+1), row.Seq, "seq is gap-free")
		var payload map[string]int
		require.NoError(t, json.Unmarshal(row.Payload, &payload))
		assert.Equal(t, committed[row.Seq], payload["writer"])
		assert.False(t, writers[payload["writer"]], "each payload once")
		writers[payload["writer"]] = true
	}
}

// A topic's next seq waits for the writer holding the previous one, so seq
// order is commit order: a reader never sees seq n+1 before seq n commits.
func TestProjectionSeqOrderIsCommitOrder(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	first, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = first.Rollback(ctx) }()
	seq, err := publishOne(ctx, first, "home", "first")
	require.NoError(t, err)
	assert.Equal(t, int64(1), seq)

	second := make(chan int64, 1)
	go func() {
		tx, err := pool.Begin(ctx)
		if err != nil {
			second <- -1
			return
		}
		seq, err := publishOne(ctx, tx, "home", "second")
		if err != nil || tx.Commit(ctx) != nil {
			second <- -1
			return
		}
		second <- seq
	}()
	require.Eventually(t, func() bool {
		var waiting int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE NOT granted`).Scan(&waiting))
		return waiting > 0
	}, 10*time.Second, 10*time.Millisecond)
	select {
	case got := <-second:
		t.Fatalf("the second writer got seq %d before the first committed", got)
	default:
	}
	rows, err := db.New(pool).ListProjectionEvents(ctx, db.ListProjectionEventsParams{Topic: "home", RowLimit: 10})
	require.NoError(t, err)
	assert.Empty(t, rows, "nothing is visible before its commit")
	require.NoError(t, first.Commit(ctx))
	assert.Equal(t, int64(2), <-second)
}

// NOTIFY live reaches a listener only when the publishing transaction
// commits; a rolled-back one leaves no row and sends nothing.
func TestProjectionNotifiesOnlyOnCommit(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	listener, err := pool.Acquire(ctx)
	require.NoError(t, err)
	defer listener.Release()
	_, err = listener.Exec(ctx, "LISTEN live")
	require.NoError(t, err)

	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	_, err = publishOne(ctx, tx, "todo:3", "rolled back")
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))
	quiet, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	_, err = listener.Conn().WaitForNotification(quiet)
	cancel()
	require.Error(t, err, "a rolled-back publish sends no notification")
	rows, err := db.New(pool).ListProjectionEvents(ctx, db.ListProjectionEventsParams{Topic: "todo:3", RowLimit: 10})
	require.NoError(t, err)
	assert.Empty(t, rows)

	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	_, err = Publish(ctx, tx, Projection{Topic: "todo:3", Payload: "kept"}, Projection{Topic: "home", Payload: "kept"})
	require.NoError(t, err)
	early, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	_, err = listener.Conn().WaitForNotification(early)
	cancel()
	require.Error(t, err, "nothing is sent before the commit")
	require.NoError(t, tx.Commit(ctx))
	var topics []string
	for range 2 {
		waited, cancel := context.WithTimeout(ctx, 5*time.Second)
		notification, err := listener.Conn().WaitForNotification(waited)
		cancel()
		require.NoError(t, err)
		assert.Equal(t, "live", notification.Channel)
		var hint struct {
			RepositoryID int64  `json:"repository_id"`
			Topic        string `json:"topic"`
		}
		require.NoError(t, json.Unmarshal([]byte(notification.Payload), &hint))
		assert.Zero(t, hint.RepositoryID)
		topics = append(topics, hint.Topic)
	}
	sort.Strings(topics)
	assert.Equal(t, []string{"home", "todo:3"}, topics)
	rows, err = db.New(pool).ListProjectionEvents(ctx, db.ListProjectionEventsParams{Topic: "todo:3", RowLimit: 10})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, int64(1), rows[0].Seq, "the rolled-back seq was given back")
}

// Retention keeps the larger of 24 hours and 10,000 rows per topic.
func TestProjectionRetentionKeepsTheLargerWindow(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	old, fresh := now.Add(-ProjectionRetentionAge-time.Minute), now.Add(-time.Hour)
	seed := func(topic string, rows int, oldRows int) {
		t.Helper()
		_, err := pool.Exec(ctx, `INSERT INTO projection_events (topic, seq, at, payload)
			SELECT $1, s, CASE WHEN s <= $3 THEN $4::timestamptz ELSE $5::timestamptz END, '{}'::jsonb FROM generate_series(1, $2) s`,
			topic, rows, oldRows, old, fresh)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO projection_topics (topic, last_seq) VALUES ($1, $2)`, topic, rows)
		require.NoError(t, err)
	}
	// 10,010 rows, the first 20 older than a day: 10 of the old ones fall
	// outside the newest 10,000 and go; the other 10 stay.
	seed("home", ProjectionRetentionRows+10, 20)
	// Few rows, all older than a day: the newest 10,000 keep them all.
	seed("todo:1", 5, 5)
	// Many rows, none older than a day: the day keeps them all.
	seed("todo:2", ProjectionRetentionRows+50, 0)
	// Same topic in another repository has its own retention boundary (§3).
	_, err := pool.Exec(ctx, `INSERT INTO projection_topics(repository_id,topic,last_seq) VALUES (22,'home',5);
        INSERT INTO projection_events(repository_id,topic,seq,at,payload)
        SELECT 22,'home',s,$1,'{}'::jsonb FROM generate_series(1,5) s`, pgx.QueryExecModeSimpleProtocol, old)
	require.NoError(t, err)
	deleted, err := NewProjectionRetention(pool).Prune(ctx, now)
	require.NoError(t, err)
	assert.Equal(t, int64(10), deleted)
	var kept int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM projection_events WHERE repository_id=22 AND topic='home'`).Scan(&kept))
	require.Equal(t, 5, kept)
	count := func(topic string) (int, int64) {
		var n int
		var first int64
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*), COALESCE(min(seq), 0) FROM projection_events WHERE repository_id = 0 AND topic = $1`, topic).Scan(&n, &first))
		return n, first
	}
	n, first := count("home")
	assert.Equal(t, ProjectionRetentionRows, n)
	assert.Equal(t, int64(11), first)
	n, _ = count("todo:1")
	assert.Equal(t, 5, n)
	n, _ = count("todo:2")
	assert.Equal(t, ProjectionRetentionRows+50, n)
	again, err := NewProjectionRetention(pool).Prune(ctx, now)
	require.NoError(t, err)
	assert.Zero(t, again)
	// The next row of a pruned topic continues its seq.
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	seq, err := publishOne(ctx, tx, "home", "next")
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	assert.Equal(t, int64(ProjectionRetentionRows+11), seq)
}

func TestPublishRefusesAnEmptyTopic(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		_, err := Publish(ctx, tx, Projection{Topic: "", Payload: 1})
		return err
	})
	require.Error(t, err)
	err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		_, err := Publish(ctx, tx, Projection{Topic: "home", Payload: func() {}})
		return err
	})
	require.ErrorContains(t, err, fmt.Sprintf("publish %s", "home"))
}

// Integration contract for callers such as GitHub App setup (T-GH-12):
// credentials/configuration and the install projection commit or vanish together.
func TestProjectionCallerTransactionRollbackIsSilent(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	listener, err := pool.Acquire(ctx)
	require.NoError(t, err)
	defer listener.Release()
	_, err = listener.Exec(ctx, "LISTEN live")
	require.NoError(t, err)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO install_settings(key,value,sealed) VALUES ('setup.completed','true',false)`)
	require.NoError(t, err)
	_, err = Publish(ctx, tx, Projection{Topic: "install", Payload: map[string]bool{"completed": true}})
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='setup.completed'`).Scan(&count))
	require.Zero(t, count)
	rows, err := db.New(pool).ListProjectionEvents(ctx, db.ListProjectionEventsParams{Topic: "install", RowLimit: 10})
	require.NoError(t, err)
	require.Empty(t, rows)
	quiet, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()
	_, err = listener.Conn().WaitForNotification(quiet)
	require.Error(t, err)
}

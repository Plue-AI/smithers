package services_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture/seed"
	"github.com/stretchr/testify/require"
)

func TestConversationSummariesDurabilityAndStaleResult(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	owner, err := seed.CreateUser(ctx, pool, "summary-owner")
	require.NoError(t, err)
	repo, err := db.New(pool).CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner, Valid: true}, Name: "summary", LowerName: "summary", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin');`, repo.ID, owner)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner)
	require.NoError(t, err)
	q := db.New(pool)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: json.RawMessage(fmt.Sprintf(`{"repository_id":%d,"owner_login":"summary-owner","repository_name":"summary"}`, repo.ID))}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "agent:coding", Value: json.RawMessage(`{"protocol":"openai-chat","modelId":"test-fast","credential":"TEST_KEY"}`)}))
	store, err := chat.NewStore(pool)
	require.NoError(t, err)
	jobStore, err := jobs.NewStore(pool)
	require.NoError(t, err)
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	summaries := &services.ConversationSummaries{Pool: pool, Jobs: jobStore, Model: func(callCtx context.Context, user, repository int64, body json.RawMessage) (io.ReadCloser, error) {
		require.Equal(t, owner, user)
		require.Equal(t, repo.ID, repository)
		var request map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(body, &request))
		require.JSONEq(t, `[]`, string(request["tools"]))
		require.NotContains(t, string(body), "private-canary")
		entered <- struct{}{}
		select {
		case <-release:
		case <-callCtx.Done():
			return nil, callCtx.Err()
		}
		return io.NopCloser(strings.NewReader("{\"type\":\"delta\",\"kind\":\"text\",\"text\":\"rm -rf /; import repo/flow.ts; call tool()\"}\n{\"type\":\"done\"}\n")), nil
	}}
	scope := chat.Scope{RepositoryID: repo.ID, UserID: owner, Owner: "summary-owner"}
	admitted, err := store.Admit(ctx, chat.AdmitInput{Scope: scope, RunID: "summary-run", Journal: chat.JournalRequest{Version: 1, LegID: "summary-leg", Token: strings.Repeat("a", 64)}, Request: json.RawMessage(`{"sharedConversation":true,"conversationId":"main","runId":"summary-run","instructions":"private-canary","messages":[{"role":"user","content":"Do work"}]}`)})
	require.NoError(t, err)
	grant, err := store.Claim(ctx, scope, admitted.TurnID, time.Minute)
	require.NoError(t, err)
	store.OnSharedCommit = func(ctx context.Context, tx pgx.Tx, change chat.SharedCommit) error {
		return summaries.Admit(ctx, tx, change.TurnID, string(change.Previous))
	}
	// The production admission hook rolls back with its subject transaction.
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	require.NoError(t, summaries.Admit(ctx, tx, admitted.TurnID, "queued"))
	require.NoError(t, tx.Rollback(ctx))
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation=$1`, services.ConversationSummaryOperation).Scan(&count))
	require.Zero(t, count)
	commit := func(cursor chat.Cursor, frames ...json.RawMessage) chat.Cursor {
		result, e := store.Commit(ctx, chat.CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: cursor, Frames: frames})
		require.NoError(t, e)
		return result.Cursor
	}
	// A committed job remains in SQL before any worker exists.
	cursor := commit(grant.Cursor, json.RawMessage(`{"runId":"summary-run","type":"delta","kind":"text","text":"First output"}`))
	// Running -> running has no extra call without the timeline lease.
	cursor = commit(cursor, json.RawMessage(`{"runId":"summary-run","type":"delta","kind":"text","text":"Second output"}`))
	cursor = commit(cursor, json.RawMessage(`{"runId":"summary-run","type":"done","reason":"stop"}`))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation=$1`, services.ConversationSummaryOperation).Scan(&count))
	require.Equal(t, 1, count)
	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	completed := make(chan error, 1)
	// Re-open Store to exercise restart rather than an in-memory dispatch queue.
	restarted, err := jobs.NewStore(pool)
	require.NoError(t, err)
	go func() {
		completed <- restarted.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "summary-restart", Capacity: 1, Lease: time.Minute, PollInterval: time.Millisecond, Operations: []string{services.ConversationSummaryOperation}}, summaries.Handle)
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("summary not dispatched")
	}
	// Changing the source revision while the model is blocked fences its result.
	_, err = pool.Exec(ctx, `UPDATE chat_turns SET head_position=head_position+1,summary='literal prior summary',summary_rev=1 WHERE id=$1`, admitted.TurnID)
	require.NoError(t, err)
	close(release)
	require.Eventually(t, func() bool {
		var n int
		return pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation=$1 AND state='completed'`, services.ConversationSummaryOperation).Scan(&n) == nil && n == 1
	}, 5*time.Second, 10*time.Millisecond)
	cancel()
	require.NoError(t, <-completed)
	var summary string
	var rev int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT summary,summary_rev FROM chat_turns WHERE id=$1`, admitted.TurnID).Scan(&summary, &rev))
	require.Equal(t, "literal prior summary", summary)
	require.Equal(t, int64(1), rev)
	// Model failure and absent access leave the prior literal bytes alone.
	summaries.Model = func(context.Context, int64, int64, json.RawMessage) (io.ReadCloser, error) {
		return nil, errors.New("no model")
	}
	_, err = pool.Exec(ctx, `DELETE FROM install_settings WHERE key IN ('agent:fast','agent:coding');DELETE FROM owner_model_defaults`)
	require.NoError(t, err)
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	require.NoError(t, summaries.Admit(ctx, tx, admitted.TurnID, "running"))
	require.NoError(t, tx.Commit(ctx))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation=$1`, services.ConversationSummaryOperation).Scan(&count))
	require.Equal(t, 1, count)
	// An active timeline uses the persisted five-second quiet deadline and
	// thirty-second starvation bound. These are real PostgreSQL deadlines.
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "agent:coding", Value: json.RawMessage(`{"protocol":"openai-chat","modelId":"test-fast","credential":"TEST_KEY"}`)}))
	_, err = pool.Exec(ctx, `UPDATE chat_turns SET state='running',head_position=head_position+1,summary_pending_since=NULL WHERE id=$1`, admitted.TurnID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE collaborators SET view_state=jsonb_build_object('main',jsonb_build_object('timeline_visible_until',$3::text)) WHERE repository_id=$1 AND user_id=$2`, repo.ID, owner, time.Now().Add(30*time.Second).UTC().Format("2006-01-02T15:04:05.000Z"))
	require.NoError(t, err)
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	require.NoError(t, summaries.Admit(ctx, tx, admitted.TurnID, "completed"))
	require.NoError(t, tx.Commit(ctx))
	var quietDelay float64
	require.NoError(t, pool.QueryRow(ctx, `SELECT extract(epoch FROM d.next_attempt_at-clock_timestamp())::float8 FROM product_job_dispatches d JOIN product_job_requests r ON r.id=d.operation_id WHERE r.operation=$1 ORDER BY r.created_at DESC LIMIT 1`, services.ConversationSummaryOperation).Scan(&quietDelay))
	require.Greater(t, quietDelay, 4.0)
	require.LessOrEqual(t, quietDelay, 5.0)
	_, err = pool.Exec(ctx, `UPDATE chat_turns SET head_position=head_position+1,summary_pending_since=clock_timestamp()-interval '29 seconds' WHERE id=$1`, admitted.TurnID)
	require.NoError(t, err)
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	require.NoError(t, summaries.Admit(ctx, tx, admitted.TurnID, "running"))
	require.NoError(t, tx.Commit(ctx))
	require.NoError(t, pool.QueryRow(ctx, `SELECT extract(epoch FROM d.next_attempt_at-clock_timestamp())::float8 FROM product_job_dispatches d JOIN product_job_requests r ON r.id=d.operation_id WHERE r.operation=$1 ORDER BY r.created_at DESC LIMIT 1`, services.ConversationSummaryOperation).Scan(&quietDelay))
	require.Greater(t, quietDelay, 0.0)
	require.LessOrEqual(t, quietDelay, 1.0)

	t.Run("sixty live events retain bounded cadence", func(t *testing.T) {
		_, err = pool.Exec(ctx, `UPDATE chat_turns SET state='completed' WHERE id=$1`, admitted.TurnID)
		require.NoError(t, err)
		var calls atomic.Int64
		summaries.Model = func(_ context.Context, _, _ int64, body json.RawMessage) (io.ReadCloser, error) {
			if strings.Contains(string(body), "Cadence") {
				calls.Add(1)
			}
			return io.NopCloser(strings.NewReader("{\"type\":\"delta\",\"kind\":\"text\",\"text\":\"Events summarized\"}\n{\"type\":\"done\"}\n")), nil
		}
		renew := func() {
			_, e := pool.Exec(ctx, `UPDATE collaborators SET view_state=jsonb_build_object('main',jsonb_build_object('timeline_visible_until',$3::text)) WHERE repository_id=$1 AND user_id=$2`, repo.ID, owner, time.Now().Add(30*time.Second).UTC().Format("2006-01-02T15:04:05.000Z"))
			require.NoError(t, e)
		}
		renew()
		accepted, e := store.Admit(ctx, chat.AdmitInput{Scope: scope, RunID: "cadence-run", Journal: chat.JournalRequest{Version: 1, LegID: "cadence-leg", Token: strings.Repeat("b", 64)}, Request: json.RawMessage(`{"sharedConversation":true,"conversationId":"main","runId":"cadence-run","messages":[{"role":"user","content":"Cadence"}]}`)})
		require.NoError(t, e)
		running, e := store.Claim(ctx, scope, accepted.TurnID, 5*time.Minute)
		require.NoError(t, e)
		active, stop := context.WithCancel(ctx)
		workerDone := make(chan error, 1)
		go func() {
			workerDone <- jobStore.RunWorker(active, jobs.WorkerConfig{WorkerID: "summary-cadence", Capacity: 1, Lease: time.Minute, PollInterval: 10 * time.Millisecond, Operations: []string{services.ConversationSummaryOperation}}, summaries.Handle)
		}()
		defer func() { stop(); require.NoError(t, <-workerDone) }()
		cursor := running.Cursor
		first := time.Now()
		for n := 1; n <= 60; n++ {
			if n%15 == 0 {
				renew()
			}
			result, e := store.Commit(ctx, chat.CommitInput{TurnID: running.TurnID, Generation: running.Generation, Token: running.Token, Expected: cursor, Frames: []json.RawMessage{json.RawMessage(fmt.Sprintf(`{"runId":"cadence-run","type":"delta","kind":"text","text":"event %d"}`, n))}})
			require.NoError(t, e)
			cursor = result.Cursor
			// Continuous arrivals cannot starve the first thirty-second window.
			if time.Since(first) > 32*time.Second {
				require.Positive(t, calls.Load())
			}
			time.Sleep(time.Second)
		}
		last := time.Now()
		require.Eventually(t, func() bool {
			var revision int64
			return pool.QueryRow(ctx, `SELECT summary_rev FROM chat_turns WHERE id=$1`, accepted.TurnID).Scan(&revision) == nil && revision == cursor.Position+1
		}, 7*time.Second, 20*time.Millisecond)
		require.Less(t, time.Since(last), 8*time.Second)
		require.GreaterOrEqual(t, calls.Load(), int64(2))
		require.LessOrEqual(t, calls.Load(), int64(4))
	})

}

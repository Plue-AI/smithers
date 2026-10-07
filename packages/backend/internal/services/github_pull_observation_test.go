package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestGitHubPullObservationsRetainReturningPayloadAndOrder(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	allowFetched(s)
	ctx := context.Background()
	var body atomic.Value
	body.Store(fetchedPullDetail)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/repos/factory/app/pulls/7", r.URL.Path)
		current := body.Load().(string)
		etag := `"open"`
		if strings.Contains(current, `"state":"closed"`) {
			etag = `"closed"`
		}
		w.Header().Set("ETag", etag)
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_, _ = w.Write([]byte(current))
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	client := NewGitHubUserReposService(db.New(pool), nil)
	factory := client.SyncedRepoConditionalFetcherFactory(&recordingMinter{})
	s.SetConditionalFetcherFactory(factory)
	require.NoError(t, s.pollInstallPull(ctx, row, 7))
	require.NoError(t, s.pollInstallPull(ctx, row, 7))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	// Keep exactly the same source timestamp: GitHub timestamps have second
	// precision, and a rapid close/reopen can reproduce the original payload.
	body.Store(strings.Replace(fetchedPullDetail, `"state":"open"`, `"state":"closed"`, 1))
	require.NoError(t, s.pollInstallPull(ctx, row, 7))
	body.Store(fetchedPullDetail)
	require.NoError(t, s.pollInstallPull(ctx, row, 7))
	require.Equal(t, 3, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(DISTINCT payload->>'version') FROM product_job_requests`))

	fresh := NewGitHubSyncedRepoService(db.New(pool))
	require.NoError(t, fresh.ConfigureInstallSync(pool))
	allowFetched(fresh)
	fresh.SetConditionalFetcherFactory(factory)
	require.NoError(t, fresh.pollInstallPull(ctx, row, 7))
	require.NoError(t, fresh.pollInstallPull(ctx, row, 7))
	require.Equal(t, 3, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`), "restart and 304 must not duplicate the latest observation")
	_, err := pool.Exec(ctx, `CREATE TABLE observed_pull_delivery (ordinal bigserial PRIMARY KEY, observation bigint NOT NULL, state text NOT NULL)`)
	require.NoError(t, err)
	fresh.install.consumers[GitHubRepoMetadataPulls] = func(ctx context.Context, tx pgx.Tx, fact gitHubFetchedObject) (json.RawMessage, error) {
		var pull struct {
			State string `json:"state"`
		}
		if err := json.Unmarshal(fact.Object, &pull); err != nil {
			return nil, err
		}
		_, err := tx.Exec(ctx, `INSERT INTO observed_pull_delivery(observation,state) VALUES ($1,$2)`, fact.PullObservation, pull.State)
		return json.RawMessage(`{}`), err
	}
	// Deliberately reverse wall-clock ordering and dispatch priority. The
	// persisted observation order must still govern delivery after restart.
	_, err = pool.Exec(ctx, `UPDATE product_job_requests SET created_at=now()-(payload->>'pull_observation')::int * interval '1 second'`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE product_job_dispatches d SET next_attempt_at=r.created_at FROM product_job_requests r WHERE r.id=d.operation_id`)
	require.NoError(t, err)
	defer runFetchedFixture(t, fresh)()
	require.Eventually(t, func() bool { return fetchedCount(t, pool, `SELECT count(*) FROM observed_pull_delivery`) == 3 }, 5*time.Second, 10*time.Millisecond)
	rows, err := pool.Query(ctx, `SELECT observation,state FROM observed_pull_delivery ORDER BY ordinal`)
	require.NoError(t, err)
	defer rows.Close()
	var order []int64
	var states []string
	for rows.Next() {
		var n int64
		var state string
		require.NoError(t, rows.Scan(&n, &state))
		order = append(order, n)
		states = append(states, state)
	}
	require.NoError(t, rows.Err())
	require.Equal(t, []int64{1, 2, 3}, order)
	require.Equal(t, []string{"open", "closed", "open"}, states)
}

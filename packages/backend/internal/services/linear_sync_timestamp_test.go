package services

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type linearTimestampErrorQuerier struct{ *linearSyncCovQuerier }

func (*linearTimestampErrorQuerier) UpdateLinearIntegrationLastSync(context.Context, int64) error {
	return errors.New("timestamp write failed")
}

func TestLinearInitialSyncPropagatesTimestampPersistenceFailure(t *testing.T) {
	integration, integrationSvc := linearSyncCovIntegration(t)
	query := &linearTimestampErrorQuerier{linearSyncCovQuerier: &linearSyncCovQuerier{integration: integration}}
	svc := NewLinearSyncService(query, integrationSvc)
	svc.httpClient = linearSyncCovHTTPClient(t, nil, func(string) (int, string, error) {
		return http.StatusOK, `{"data":{"issues":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}`, nil
	})
	require.ErrorContains(t, svc.runInitialSync(context.Background(), integration, 0), "timestamp write failed")
}

func TestLinearInitialSyncFailedImportKeepsLastSuccessAndRetryDoesNotDuplicate(t *testing.T) {
	pool := setupTestPool(t)
	queries := db.New(pool)
	ctx := context.Background()
	_, _, integration := createLinearSyncTestIntegration(t, queries, pool)
	previous := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	_, err := pool.Exec(ctx, `UPDATE linear_integrations SET last_sync_at = $1 WHERE id = $2`, previous, integration.ID)
	require.NoError(t, err)

	firstPage := `{"data":{"issues":{"nodes":[{"id":"lin-good","identifier":"PLT-1","title":"Good","description":""}],"pageInfo":{"hasNextPage":true,"endCursor":"cursor-1"}}}}`
	secondPage := fmt.Sprintf(`{"data":{"issues":{"nodes":[{"id":"lin-bad","identifier":"PLT-2","title":%q,"description":""}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}`, strings.Repeat("x", 256))
	svc := newLinearSyncTestService(t, queries, integration, "linear-sync-test-secret", "")
	svc.issueImportTxManager = &pgxLinearIssueImportTxManager{pool: pool}
	// Use a controlled Linear response for both runs; only the invalid title changes.
	svc.httpClient = &http.Client{Transport: linearSyncRoundTripper(func(req *http.Request) (*http.Response, error) {
		request, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		page := firstPage
		if strings.Contains(string(request), `"after":"cursor-1"`) {
			page = secondPage
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(page)), Header: make(http.Header)}, nil
	})}

	awaitRun := func() db.LinearSyncRun {
		t.Helper()
		runID, err := svc.StartInitialSyncRun(ctx, integration.UserID, integration.ID)
		require.NoError(t, err)
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			run, err := queries.GetLinearSyncRun(ctx, db.GetLinearSyncRunParams{ID: runID, IntegrationID: integration.ID})
			require.NoError(t, err)
			if run.State == "failed" || run.State == "completed" {
				for time.Now().Before(deadline) {
					if _, running := svc.initialSyncInFlight.Load(integration.ID); !running {
						return run
					}
					time.Sleep(time.Millisecond)
				}
				t.Fatal("Linear sync stayed in flight after finishing")
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("Linear sync run did not finish")
		return db.LinearSyncRun{}
	}

	failed := awaitRun()
	require.Equal(t, "failed", failed.State)
	require.Equal(t, int32(2), failed.IssuesTotal)
	require.Equal(t, int32(1), failed.IssuesDone)
	require.Equal(t, int32(1), failed.IssuesFailed)
	stored, err := queries.GetLinearIntegration(ctx, integration.ID)
	require.NoError(t, err)
	require.True(t, stored.LastSyncAt.Time.Equal(previous))

	secondPage = `{"data":{"issues":{"nodes":[{"id":"lin-bad","identifier":"PLT-2","title":"Recovered","description":""}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}`
	completed := awaitRun()
	require.Equal(t, "completed", completed.State)
	require.Equal(t, int32(2), completed.IssuesDone)
	require.Zero(t, completed.IssuesFailed)
	stored, err = queries.GetLinearIntegration(ctx, integration.ID)
	require.NoError(t, err)
	require.True(t, stored.LastSyncAt.Time.After(previous))
	var issues, mappings int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issues WHERE repository_id = $1`, integration.JjhubRepoID).Scan(&issues))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM linear_issue_map WHERE integration_id = $1`, integration.ID).Scan(&mappings))
	require.Equal(t, 2, issues)
	require.Equal(t, 2, mappings)
}

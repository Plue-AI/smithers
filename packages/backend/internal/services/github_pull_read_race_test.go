package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestGitHubPullDelayedEqualTimestampResponse(t *testing.T) {
	for _, mode := range []string{"conflict", "identical", "other PR", "newer source timestamp"} {
		for _, pair := range []struct{ old, newer string }{{"detail", "detail"}, {"list", "detail"}, {"detail", "list"}, {"list", "list"}} {
			t.Run(mode+"/"+pair.old+" after "+pair.newer, func(t *testing.T) {
				old, pool, row := newFetchedFixture(t)
				allowFetched(old)
				newer := NewGitHubSyncedRepoService(db.New(pool))
				require.NoError(t, newer.ConfigureInstallSync(pool))
				allowFetched(newer)
				began := make(chan struct{})
				release := make(chan struct{})
				var once sync.Once
				unblock := func() { once.Do(func() { close(release) }) }
				var requests atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					current := strings.Replace(fetchedPullDetail, `"state":"open"`, `"state":"closed"`, 1)
					etag := `"closed"`
					if requests.Add(1) == 1 {
						close(began)
						select {
						case <-release:
						case <-r.Context().Done():
							return
						}
						current, etag = fetchedPullDetail, `"old-open"`
						if mode == "newer source timestamp" {
							current = strings.Replace(current, "10:00:00Z", "10:00:01Z", 1)
						}
					} else if mode == "identical" {
						current = fetchedPullDetail
					} else if mode == "other PR" {
						current = strings.NewReplacer(`"id":707`, `"id":708`, `"number":7`, `"number":8`).Replace(current)
					}
					w.Header().Set("ETag", etag)
					if strings.HasSuffix(r.URL.Path, "/pulls") {
						current = "[" + current + "]"
					} else {
						require.True(t, strings.HasSuffix(r.URL.Path, "/pulls/7") || strings.HasSuffix(r.URL.Path, "/pulls/8"))
					}
					_, _ = w.Write([]byte(current))
				}))
				defer server.Close()
				defer unblock()
				t.Setenv(envGitHubAppAPIBaseURL, server.URL)
				for _, s := range []*GitHubSyncedRepoService{old, newer} {
					client := NewGitHubUserReposService(db.New(pool), nil)
					s.SetConditionalFetcherFactory(client.SyncedRepoConditionalFetcherFactory(&recordingMinter{}))
				}
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				read := func(s *GitHubSyncedRepoService, kind string) error {
					if kind == "list" {
						return s.backfillResource(ctx, row, GitHubRepoMetadataPulls, nil)
					}
					number := int64(7)
					if mode == "other PR" && s == newer {
						number = 8
					}
					return s.pollInstallPull(ctx, row, number)
				}
				done := make(chan error, 1)
				go func() { done <- read(old, pair.old) }()
				select {
				case <-began:
				case <-time.After(5 * time.Second):
					t.Fatal("first read did not start")
				}
				require.NoError(t, read(newer, pair.newer))
				unblock()
				var oldErr error
				select {
				case oldErr = <-done:
				case <-time.After(5 * time.Second):
					t.Fatal("delayed read did not finish")
				}
				var state string
				require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM github_synced_issues WHERE resource='pulls' AND number=7`).Scan(&state))
				if mode != "conflict" {
					require.NoError(t, oldErr)
					require.Equal(t, "open", state)
					expected := 2
					if mode == "identical" {
						expected = 1
					}
					require.Equal(t, expected, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
					return
				}
				require.Equal(t, "closed", state, "a later response must not overwrite newer committed evidence at the same source timestamp")
				require.Error(t, oldErr, "discarded ambiguous reads must be retryable")
				require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`), "stale data must not enter durable delivery")
				require.Empty(t, old.install.etags, "a refused read cannot install a validator")
				if pair.old == "list" {
					require.True(t, old.fetchedUpdatedCursor(row, GitHubRepoMetadataPulls).IsZero(), "failed walk must not advance its cursor")
				}
				require.NoError(t, read(old, pair.old), "retry from the current state succeeds")
				require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
			})
		}
	}
}

package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestGitHubRelatedFactsConditionalPagingAndRestart(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	allowFetched(s)
	head := strings.Repeat("a", 40)
	pull := json.RawMessage(strings.Replace(fetchedPullDetail, "head-1", head, 1))
	require.NoError(t, commitRelatedPull(t, s, row, pull))
	var mu sync.Mutex
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests = append(requests, r.URL.Path+"?"+r.URL.RawQuery+" "+r.Header.Get("If-None-Match"))
		mu.Unlock()
		w.Header().Set("ETag", `"page-`+r.URL.Query().Get("page")+`"`)
		if r.Header.Get("If-None-Match") == w.Header().Get("ETag") {
			w.WriteHeader(304)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/statuses") || strings.HasSuffix(r.URL.Path, "/comments") {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		objects := []map[string]any{}
		if r.URL.Query().Get("page") == "1" {
			for i := 0; i < 100; i++ {
				objects = append(objects, map[string]any{"id": i + 1, "name": fmt.Sprint(i), "state": "APPROVED", "status": "completed", "conclusion": "success", "submitted_at": "2026-10-01T00:00:00Z", "user": map[string]any{"id": 7}})
			}
		} else {
			objects = append(objects, map[string]any{"id": 101, "name": "last", "state": "CHANGES_REQUESTED", "status": "completed", "conclusion": "failure", "submitted_at": "2026-10-01T00:00:00Z", "user": map[string]any{"id": 7}})
		}
		if strings.HasSuffix(r.URL.Path, "/check-runs") {
			_ = json.NewEncoder(w).Encode(map[string]any{"check_runs": objects, "total_count": 101})
		} else {
			_ = json.NewEncoder(w).Encode(objects)
		}
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	minter := &recordingMinter{}
	client := NewGitHubUserReposService(db.New(pool), nil, WithGitHubUserReposHTTPClient(s.budget.WrapClient(server.Client())))
	s.SetConditionalFetcherFactory(client.SyncedRepoConditionalFetcherFactory(minter))
	require.NoError(t, s.pollInstallPullFacts(t.Context(), row, 7))
	require.NoError(t, s.pollInstallPullFacts(t.Context(), row, 7))
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id IN ('checks','reviews')`))
	require.Equal(t, 101, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='pulls/reviews'`), "submitted reviews reach the registered durable owner once")
	var checks, reviews []byte
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT related_facts->'checks',related_facts->'reviews' FROM github_synced_issues WHERE resource='pulls' AND number=7`).Scan(&checks, &reviews))
	require.Contains(t, string(checks), `"name": "last"`)
	require.Contains(t, string(reviews), "CHANGES_REQUESTED")
	mu.Lock()
	require.Len(t, requests, 14)
	for _, request := range requests[7:] {
		require.Contains(t, request, `"page-`)
	}
	mu.Unlock()
	fresh := NewGitHubSyncedRepoService(db.New(pool))
	require.NoError(t, fresh.ConfigureInstallSync(pool))
	allowFetched(fresh)
	fresh.SetConditionalFetcherFactory(client.SyncedRepoConditionalFetcherFactory(minter))
	require.NoError(t, fresh.pollInstallPullFacts(t.Context(), row, 7))
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id IN ('checks','reviews')`))
	mu.Lock()
	for _, request := range requests[14:] {
		require.True(t, strings.HasSuffix(request, " "), request)
	}
	mu.Unlock()
}

func TestGitHubRelatedFactsFailureIsAtomicAndHeadBound(t *testing.T) {
	for _, failure := range []string{"page", "commit", "head", "revoked", "invalid", "unsolicited304"} {
		t.Run(failure, func(t *testing.T) {
			s, pool, row := newFetchedFixture(t)
			allowFetched(s)
			head := strings.Repeat("a", 40)
			pull := json.RawMessage(strings.Replace(fetchedPullDetail, "head-1", head, 1))
			require.NoError(t, commitRelatedPull(t, s, row, pull))
			s.SetConditionalFetcherFactory(func(db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
				return func(ctx context.Context, resource string, query url.Values, etag string) (GitHubSyncedRepoConditionalPage, error) {
					if failure == "page" {
						return GitHubSyncedRepoConditionalPage{}, errors.New("read failed")
					}
					if failure == "revoked" {
						s.install.authorize = func(context.Context, db.GithubSyncedRepo) error { return errors.New("revoked") }
					}
					if failure == "head" {
						_, err := pool.Exec(ctx, `UPDATE github_synced_issues SET payload=jsonb_set(payload,'{head,sha}','"another"')`)
						require.NoError(t, err)
					}
					if failure == "invalid" {
						return GitHubSyncedRepoConditionalPage{Body: json.RawMessage(`null`)}, nil
					}
					if failure == "unsolicited304" {
						return GitHubSyncedRepoConditionalPage{NotModified: true}, nil
					}
					return GitHubSyncedRepoConditionalPage{Body: json.RawMessage(`[]`), ETag: `"reviews"`}, nil
				}
			})
			if failure == "commit" {
				_, err := pool.Exec(t.Context(), `CREATE FUNCTION refuse_related() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.principal_id='reviews' THEN RAISE EXCEPTION 'delivery refused'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_related BEFORE INSERT ON product_job_requests FOR EACH ROW EXECUTE FUNCTION refuse_related()`)
				require.NoError(t, err)
			}
			require.Error(t, s.pollInstallRelated(t.Context(), row, 7, head, "reviews", []string{"pulls/7/reviews"}))
			require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issues WHERE related_facts<>'{}'::jsonb`))
			require.Zero(t, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='reviews'`))
			require.Empty(t, s.install.etags)
		})
	}
}

func TestGitHubReviewCommentIdentityDoesNotCollideWithConversation(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	allowFetched(s)
	conversation := json.RawMessage(`{"id":19,"body":"chat","issue_url":"https://api.github.com/repos/factory/app/issues/7","created_at":"2026-10-05T10:00:00Z","updated_at":"2026-10-05T10:00:00Z"}`)
	review := json.RawMessage(`{"id":19,"body":"review","pull_request_url":"https://api.github.com/repos/factory/app/pulls/7","created_at":"2026-10-05T10:00:00Z","updated_at":"2026-10-05T10:00:00Z"}`)
	require.NoError(t, s.commitFetched(t.Context(), row, gitHubConversationComments, nil, []json.RawMessage{conversation}))
	require.NoError(t, s.commitFetched(t.Context(), row, gitHubReviewComments, nil, []json.RawMessage{review}))
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issue_comments WHERE github_id=19`))
	comments, err := db.New(pool).ListGitHubSyncedIssueComments(t.Context(), db.ListGitHubSyncedIssueCommentsParams{SyncedRepoID: row.ID, IssueNumber: 7, RowLimit: 100})
	require.NoError(t, err)
	require.Len(t, comments, 1)
	require.Contains(t, string(comments[0].Payload), "chat")
	require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id IN ('issues/comments','pulls/comments')`))
	require.NoError(t, pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
		return s.commitFetchedConversationSnapshot(t.Context(), tx, row, 7, time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC), nil)
	}))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issue_comments WHERE source='conversation' AND payload->>'deleted'='true'`))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issue_comments WHERE source='review' AND NOT payload ? 'deleted'`))

}

func TestGitHubRelatedResourceRejectsPathInputs(t *testing.T) {
	for _, resource := range []string{"commits/main/check-runs", "commits/../../statuses", "pulls/07/reviews", "pulls/7/merge", "commits/" + strings.Repeat("g", 40) + "/statuses"} {
		require.False(t, gitHubPullFactResource(resource), resource)
	}
	for _, resource := range []string{"commits/" + strings.Repeat("a", 40) + "/check-runs", "commits/" + strings.Repeat("b", 64) + "/statuses", "pulls/7/reviews"} {
		require.True(t, gitHubPullFactResource(resource), resource)
	}
	require.Equal(t, 45*time.Second, metadataStreamCadence(gitHubReviewComments))
}

func TestGitHubRelatedPauseKeepsTheExistingFollowCadence(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	allowFetched(s)
	q := db.New(pool)
	user, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "pause-owner", LowerUsername: "pause-owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(t.Context(), db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `UPDATE repositories SET mirror_destination='factory/app' WHERE id=$1`, repo.ID)
	require.NoError(t, err)
	now := time.Now().UTC().Truncate(time.Second)
	s.now = func() time.Time { return now }
	s.budget = NewGitHubResponseBudgetTracker(s.now)
	s.budget.registerToken("minted-token", 12, now.Add(time.Hour))
	var checks, reviews int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check-runs") {
			checks++
			w.Header().Set("Retry-After", "90")
			w.WriteHeader(429)
			return
		}
		w.Header().Set("ETag", `"read"`)
		if strings.HasSuffix(r.URL.Path, "/comments") {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/reviews") {
			reviews++
			if r.Header.Get("If-None-Match") != "" {
				w.WriteHeader(304)
				return
			}
			_, _ = w.Write([]byte(`[]`))
			return
		}
		if r.Header.Get("If-None-Match") != "" {
			w.WriteHeader(304)
			return
		}
		_, _ = w.Write([]byte(strings.Replace(fetchedPullDetail, "head-1", strings.Repeat("a", 40), 1)))
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	client := NewGitHubUserReposService(q, nil, WithGitHubUserReposHTTPClient(s.budget.WrapClient(server.Client())))
	s.SetConditionalFetcherFactory(client.SyncedRepoConditionalFetcherFactory(&recordingMinter{}))
	stack := NewMythicalService(pool, nil)
	stack.UseInstallGitHubPolling(s)
	step := &mythicalItemStep{s: stack, q: q, now: now}
	// Polling reloads the persisted item after fetched consumers commit.
	item, _, err := q.InsertMythicalItem(t.Context(), db.MythicalItem{RepositoryID: repo.ID, State: "proposed"})
	require.NoError(t, err)
	item.PRNumber = pgtype.Int8{Int64: 7, Valid: true}
	item, err = q.SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	for i := 0; i < 2; i++ {
		next, _, err := step.advance(t.Context(), item)
		require.NoError(t, err)
		require.Equal(t, now.Add(45*time.Second), next.NextAttemptAt.Time)
		require.Equal(t, 1, checks)
		require.Equal(t, i+1, reviews)
		require.NotNil(t, s.syncStreamObservation(row, "checks/7", "checks").RetryAt)
		now = now.Add(45 * time.Second)
		step.now = now
	}
	require.Nil(t, s.syncStreamObservation(row, "checks/7", "checks").RetryAt, "the pause expires at 90 seconds")
	require.NotNil(t, s.syncStreamObservation(row, "reviews/7", "reviews").LastSuccessAt)
}

func TestGitHubRelatedRetrySharesOneOwner(t *testing.T) {
	s, _, _ := newFetchedFixture(t)
	allowFetched(s)
	s.install.pullFacts = true
	s.SetConditionalFetcherFactory(func(db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
		return func(context.Context, string, url.Values, string) (GitHubSyncedRepoConditionalPage, error) {
			t.Fatal("Retry must schedule without fetching")
			return GitHubSyncedRepoConditionalPage{}, nil
		}
	})
	pulls := 0
	s.install.requestPulls = func(context.Context, db.GithubSyncedRepo) error { pulls++; return nil }
	s.install.requiredPulls = func(context.Context, db.GithubSyncedRepo) ([]GitHubSyncStream, error) { return nil, nil }
	s.install.requiredPullFacts = func(context.Context, db.GithubSyncedRepo, string) ([]GitHubSyncStream, error) { return nil, nil }
	streams := requiredGitHubSyncStreams{repository: s, checks: s.PullFactStreams("checks"), reviews: s.PullFactStreams("reviews")}
	require.NoError(t, streams.RetryStreams(t.Context()))
	require.Equal(t, 1, pulls, "one Retry wakes the existing TODO owner once")
	require.Len(t, s.install.requested, 5)
}

func commitRelatedPull(t *testing.T, s *GitHubSyncedRepoService, row db.GithubSyncedRepo, pull json.RawMessage) error {
	t.Helper()
	read, err := s.beginPullRead(t.Context(), row, 7)
	if err != nil {
		return err
	}
	return s.commitFetched(t.Context(), row, "pulls", read, []json.RawMessage{pull})
}

func TestGitHubRelatedMissingTransportStaysUnavailable(t *testing.T) {
	s, _, row := newFetchedFixture(t)
	allowFetched(s)
	head := strings.Repeat("a", 40)
	require.NoError(t, commitRelatedPull(t, s, row, json.RawMessage(strings.Replace(fetchedPullDetail, "head-1", head, 1))))
	require.Error(t, s.ReadInstallPullFacts(t.Context(), row, 7, head, "checks"))
	require.Nil(t, s.syncStreamObservation(row, "checks/7", "checks").LastSuccessAt)
}

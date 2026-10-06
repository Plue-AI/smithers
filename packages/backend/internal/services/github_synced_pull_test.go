package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

const fetchedPullDetail = `{"id":707,"number":7,"title":"Change","state":"open","head":{"sha":"head-1","ref":"smithers/change"},"base":{"ref":"main"},"updated_at":"2026-10-05T10:00:00Z"}`

func TestGitHubIndividualPullHTTPCommitRestartAndCacheReplacement(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	var mu sync.Mutex
	var validators []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		validators = append(validators, r.Header.Get("If-None-Match"))
		mu.Unlock()
		require.Equal(t, "/repos/factory/app/pulls/7", r.URL.Path)
		require.Empty(t, r.URL.RawQuery)
		require.Equal(t, "Bearer minted-token", r.Header.Get("Authorization"))
		w.Header().Set("ETag", `"detail-1"`)
		if r.Header.Get("If-None-Match") == `"detail-1"` {
			w.WriteHeader(304)
			return
		}
		_, _ = w.Write([]byte(fetchedPullDetail))
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	minter := &recordingMinter{}
	client := NewGitHubUserReposService(db.New(pool), nil)
	s.SetConditionalFetcherFactory(client.SyncedRepoConditionalFetcherFactory(minter))
	require.Error(t, s.pollInstallPull(t.Context(), row, 7))
	require.Empty(t, minter.scopes, "unqualified paths cannot mint")
	allowFetched(s)
	require.NoError(t, s.pollInstallPull(t.Context(), row, 7))
	require.NoError(t, s.pollInstallPull(t.Context(), row, 7))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='pulls'`))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issues WHERE resource='pulls' AND number=7`))
	// A list representation replacing detail invalidates the detail validator.
	_, err := pool.Exec(t.Context(), `UPDATE github_synced_issues SET payload=payload-'head' WHERE number=7`)
	require.NoError(t, err)
	require.NoError(t, s.pollInstallPull(t.Context(), row, 7))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='pulls'`))
	fresh := NewGitHubSyncedRepoService(db.New(pool))
	require.NoError(t, fresh.ConfigureInstallSync(pool))
	allowFetched(fresh)
	fresh.SetConditionalFetcherFactory(client.SyncedRepoConditionalFetcherFactory(minter))
	require.NoError(t, fresh.pollInstallPull(t.Context(), row, 7))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE principal_id='pulls'`))
	mu.Lock()
	require.Equal(t, []string{"", `"detail-1"`, "", ""}, validators)
	mu.Unlock()
	for _, scope := range minter.scopes {
		require.Equal(t, []int64{99}, scope.RepositoryIDs)
	}
	// No consumer means durable pending delivery, even after a worker attempt.
	stop := runFetchedFixture(t, fresh)
	require.Eventually(t, func() bool {
		return fetchedCount(t, pool, `SELECT count(*) FROM product_job_dispatches WHERE attempt > 0 AND last_error <> ''`) == 1
	}, 5*time.Second, 10*time.Millisecond)
	stop()
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE state<>'completed'`))
}

func TestGitHubIndividualPullFailuresRetainCacheAndValidator(t *testing.T) {
	for _, failure := range []string{"delivery", "revoked", "rebound", "wrong-number", "missing-head", "invalid-state", "unsolicited-304", "racing-cache", "transport"} {
		t.Run(failure, func(t *testing.T) {
			s, pool, row := newFetchedFixture(t)
			allowFetched(s)
			activeFailure := false
			s.SetConditionalFetcherFactory(func(db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
				return func(ctx context.Context, _ string, _ url.Values, etag string) (GitHubSyncedRepoConditionalPage, error) {
					page := GitHubSyncedRepoConditionalPage{Body: json.RawMessage(fetchedPullDetail), ETag: `"first"`}
					if !activeFailure {
						return page, nil
					}
					require.Equal(t, `"first"`, etag)
					page.Body = json.RawMessage(strings.Replace(fetchedPullDetail, "head-1", "head-2", 1))
					page.ETag = `"second"`
					switch failure {
					case "revoked":
						s.install.authorize = func(context.Context, db.GithubSyncedRepo) error { return errors.New("revoked") }
					case "rebound":
						_, err := pool.Exec(ctx, `UPDATE github_synced_repos SET installation_id=900 WHERE id=$1`, row.ID)
						require.NoError(t, err)
					case "wrong-number":
						page.Body = json.RawMessage(strings.Replace(string(page.Body), `"number":7`, `"number":8`, 1))
					case "missing-head":
						page.Body = json.RawMessage(strings.Replace(string(page.Body), `"sha":"head-2"`, `"sha":""`, 1))
					case "invalid-state":
						page.Body = json.RawMessage(strings.Replace(string(page.Body), `"state":"open"`, `"state":"other"`, 1))
					case "unsolicited-304":
						page.NotModified = true // separately remove the validator below
					case "racing-cache":
						page.NotModified = true
						_, err := pool.Exec(ctx, `UPDATE github_synced_issues SET payload=payload-'head' WHERE number=7`)
						require.NoError(t, err)
					case "transport":
						return page, errors.New("network refused")
					}
					return page, nil
				}
			})
			require.NoError(t, s.pollInstallPull(t.Context(), row, 7))
			if failure == "delivery" {
				_, err := pool.Exec(t.Context(), `CREATE FUNCTION refuse_pull_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'delivery refused'; END $$; CREATE TRIGGER refuse_pull_delivery BEFORE INSERT ON product_job_requests FOR EACH ROW EXECUTE FUNCTION refuse_pull_delivery()`)
				require.NoError(t, err)
			}
			activeFailure = true
			if failure == "unsolicited-304" {
				s.install.etags = nil
				s.SetConditionalFetcherFactory(func(db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
					return func(context.Context, string, url.Values, string) (GitHubSyncedRepoConditionalPage, error) {
						return GitHubSyncedRepoConditionalPage{NotModified: true}, nil
					}
				})
			}
			err := s.pollInstallPull(t.Context(), row, 7)
			require.Error(t, err)
			switch failure {
			case "wrong-number", "missing-head", "invalid-state", "unsolicited-304":
				var apiErr *pkgerrors.APIError
				require.ErrorAs(t, err, &apiErr)
				require.Equal(t, pkgerrors.CodeGitHubUnavailable, apiErr.Code)
			}
			require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
			require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issues`))
			if failure != "racing-cache" {
				var head string
				require.NoError(t, pool.QueryRow(t.Context(), `SELECT payload->'head'->>'sha' FROM github_synced_issues`).Scan(&head))
				require.Equal(t, "head-1", head)
			}
			if failure == "delivery" {
				_, err := pool.Exec(t.Context(), `DROP TRIGGER refuse_pull_delivery ON product_job_requests`)
				require.NoError(t, err)
				require.NoError(t, s.pollInstallPull(t.Context(), row, 7))
				require.Equal(t, 2, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
			}
		})
	}
}

func TestGitHubIndividualPullSharedPauseBeforeMint(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	allowFetched(s)
	tracker := NewGitHubResponseBudgetTracker()
	s.budget = tracker
	now := time.Now().UTC().Truncate(time.Second)
	tracker.now = func() time.Time { return now }
	s.now = tracker.now
	tracker.registerToken("minted-token", 12, now.Add(time.Hour))
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "90")
		w.WriteHeader(429)
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	minter := &recordingMinter{}
	client := NewGitHubUserReposService(db.New(pool), nil, WithGitHubUserReposHTTPClient(tracker.WrapClient(server.Client())))
	s.SetConditionalFetcherFactory(client.SyncedRepoConditionalFetcherFactory(minter))
	for range 2 {
		err := s.pollInstallPull(t.Context(), row, 7)
		var failure *pkgerrors.APIError
		require.ErrorAs(t, err, &failure)
		require.Equal(t, pkgerrors.CodeGitHubRateLimited, failure.Code)
		require.NotNil(t, failure.RetryAt)
		require.WithinDuration(t, now.Add(90*time.Second), *failure.RetryAt, time.Second)
	}
	require.EqualValues(t, 1, calls.Load())
	require.Len(t, minter.scopes, 1, "paused second poll must not mint")
	require.Equal(t, 0, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
}

func TestGitHubIndividualPullUsesExistingFollowWithoutEffects(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	allowFetched(s)
	q := db.New(pool)
	user, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "poll-owner", LowerUsername: "poll-owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(t.Context(), db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `UPDATE repositories SET mirror_destination='factory/app' WHERE id=$1`, repo.ID)
	require.NoError(t, err)
	calls := 0
	s.SetConditionalFetcherFactory(func(db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
		return func(context.Context, string, url.Values, string) (GitHubSyncedRepoConditionalPage, error) {
			calls++
			return GitHubSyncedRepoConditionalPage{Body: json.RawMessage(fetchedPullDetail), ETag: `"pull"`}, nil
		}
	})
	stack := NewMythicalService(pool, nil)
	stack.UseInstallGitHubPolling(s)
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	step := &mythicalItemStep{s: stack, now: now}
	item := db.MythicalItem{RepositoryID: repo.ID, State: "proposed", PRNumber: pgtype.Int8{Int64: 7, Valid: true}, PRHead: "original", Checks: json.RawMessage(`{"foreignHead":"held"}`)}
	for range 2 {
		next, saved, err := step.advance(t.Context(), item)
		require.NoError(t, err)
		require.False(t, saved)
		require.Equal(t, now.Add(45*time.Second), next.NextAttemptAt.Time)
		next.NextAttemptAt = item.NextAttemptAt
		require.Equal(t, item, *next, "fetch alone cannot apply a head, review, merge or other product effect")
	}
	require.Equal(t, 2, calls)
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM github_synced_issues WHERE synced_repo_id=`+strconv.FormatInt(row.ID, 10)))
}

func TestGitHubIndividualPullDoesNotValidateAnOlderResponse(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	allowFetched(s)
	latest := json.RawMessage(strings.Replace(fetchedPullDetail, "10:00:00Z", "10:01:00Z", 1))
	require.NoError(t, s.commitFetched(t.Context(), row, "pulls", []json.RawMessage{latest}))
	var validators []string
	s.SetConditionalFetcherFactory(func(db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
		return func(_ context.Context, _ string, _ url.Values, etag string) (GitHubSyncedRepoConditionalPage, error) {
			validators = append(validators, etag)
			return GitHubSyncedRepoConditionalPage{Body: json.RawMessage(fetchedPullDetail), ETag: `"old"`}, nil
		}
	})
	for range 2 {
		require.NoError(t, s.pollInstallPull(t.Context(), row, 7))
	}
	require.Equal(t, []string{"", ""}, validators)
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests`))
	var updated string
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT payload->>'updated_at' FROM github_synced_issues`).Scan(&updated))
	require.Equal(t, "2026-10-05T10:01:00Z", updated)
}

func TestGitHubIndividualPullResourceBoundary(t *testing.T) {
	for _, resource := range []string{"pulls/1", "pulls/9223372036854775807"} {
		require.True(t, gitHubIndividualPullResource(resource), resource)
	}
	for _, resource := range []string{"pulls", "pulls/0", "pulls/-1", "pulls/+1", "pulls/01", "pulls/1/comments", "pulls/1?state=open", "pulls/9223372036854775808", "issues/1"} {
		require.False(t, gitHubIndividualPullResource(resource), resource)
	}
}

// Real database bindings and scheduling; the recording transport makes the
// independent provider log observable without running any product consumer.
func TestGitHubPullHintsWakeExistingStackAndKeepCadence(t *testing.T) {
	s, pool, row := newFetchedFixture(t)
	q := db.New(pool)
	ctx := t.Context()
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "hint-owner", LowerUsername: "hint-owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "hint-app", LowerName: "hint-app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE repositories SET mirror_destination='factory/app' WHERE id=$1`, repo.ID)
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, user.ID, 1, false)
	require.NoError(t, err)
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "proposed"})
	require.NoError(t, err)
	item.PRNumber = pgtype.Int8{Int64: 7, Valid: true}
	item.PRHead = "original"
	item.NextAttemptAt = pgtype.Timestamptz{Time: time.Now().UTC().Add(45 * time.Second).Truncate(time.Microsecond), Valid: true}
	item, err = q.SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	// Put the PR beyond the first thousand visible items. Polling must still
	// reach it, and the extra queued items must keep their scheduling waits.
	_, err = pool.Exec(ctx, `INSERT INTO mythical_items(repository_id,state,next_attempt_at)
	 SELECT $1,'queued',$2 FROM generate_series(1,1001)`, repo.ID, item.NextAttemptAt.Time)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET stack_position=2000 WHERE id=$1`, item.ID)
	require.NoError(t, err)
	item, err = q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	stack := NewMythicalService(pool, nil)
	stack.UseInstallGitHubPolling(s)
	now := item.NextAttemptAt.Time.Add(-35 * time.Second)
	stack.now = func() time.Time { return now }
	s.now = stack.now
	s.budget = NewGitHubResponseBudgetTracker()
	s.budget.now = stack.now
	var calls []string
	during := func() {}
	failure := false
	s.SetConditionalFetcherFactory(func(db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
		return func(ctx context.Context, resource string, _ url.Values, etag string) (GitHubSyncedRepoConditionalPage, error) {
			calls = append(calls, resource)
			during()
			if failure {
				return GitHubSyncedRepoConditionalPage{}, errors.New("temporary network failure")
			}
			return GitHubSyncedRepoConditionalPage{Body: json.RawMessage(fetchedPullDetail), ETag: `"hint"`}, nil
		}
	})
	hint := func() {
		require.NoError(t, s.ApplyIssueEvent(ctx, "factory", "app", row.GithubRepositoryID.Int64, "pulls", "synchronize", json.RawMessage(`{"number":7,"head":{"sha":"untrusted"}}`)))
	}
	// Missing qualification cannot request a stack pass or read the provider.
	before, err := q.GetMythicalStack(ctx, repo.ID)
	require.NoError(t, err)
	hint()
	require.Empty(t, stack.installPullHints.pending)
	after, err := q.GetMythicalStack(ctx, repo.ID)
	require.NoError(t, err)
	require.Equal(t, before.RequestedGeneration, after.RequestedGeneration)
	allowFetched(s)
	hint()
	hint()
	require.Len(t, stack.installPullHints.pending, 1)
	select {
	case <-stack.installPullHints.wake:
	default:
		t.Fatal("existing worker was not woken")
	}
	after, err = q.GetMythicalStack(ctx, repo.ID)
	require.NoError(t, err)
	require.Greater(t, after.RequestedGeneration, before.RequestedGeneration)
	require.False(t, after.NextAttemptAt.Time.After(time.Now()))
	run := &mythicalRun{row: after}
	stack.advanceItems(ctx, run)
	require.Equal(t, item.NextAttemptAt.Time, run.due, "the normal poll is still due at its original time")
	require.Equal(t, []string{"pulls/7"}, calls)
	retry, err := stack.fetchInstallPullHint(ctx, item)
	require.NoError(t, err)
	require.True(t, retry.IsZero())
	require.Len(t, calls, 1, "duplicates coalesce")
	unchanged, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, item, unchanged, "an early read changes neither product state nor the regular deadline")
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE state<>'completed'`))
	// A newer delivery arriving during the read survives its completion.
	hint()
	during = func() { during = func() {}; hint() }
	_, err = stack.fetchInstallPullHint(ctx, item)
	require.NoError(t, err)
	require.Len(t, stack.installPullHints.pending, 1)
	_, err = stack.fetchInstallPullHint(ctx, item)
	require.NoError(t, err)
	require.Empty(t, stack.installPullHints.pending)
	// Transient failures keep the hint and its backoff, including repeated input.
	failure = true
	hint()
	retry, err = stack.fetchInstallPullHint(ctx, item)
	require.ErrorContains(t, err, "temporary network failure")
	require.True(t, retry.After(now))
	count := len(calls)
	hint()
	again, err := stack.fetchInstallPullHint(ctx, item)
	require.NoError(t, err)
	require.Equal(t, retry, again)
	require.Len(t, calls, count)
	failure = false
	now = retry
	_, err = stack.fetchInstallPullHint(ctx, item)
	require.NoError(t, err)
	require.Len(t, calls, count+1)

	// Both a stream pause and exhausted resource budget stop reads before minting.
	for _, code := range []int{403, 429, 200} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if code == 200 {
				w.Header().Set("X-RateLimit-Resource", "core")
				w.Header().Set("X-RateLimit-Limit", "100")
				w.Header().Set("X-RateLimit-Remaining", "0")
				w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(now.Add(90*time.Second).Unix(), 10))
			} else {
				w.Header().Set("Retry-After", "90")
			}
			w.WriteHeader(code)
		}))
		client := s.budget.WrapClient(server.Client())
		s.budget.registerToken("hint-token", row.InstallationID.Int64, now.Add(time.Hour))
		request, err := http.NewRequestWithContext(ctx, "GET", server.URL+"/repos/factory/app/pulls/7", nil)
		require.NoError(t, err)
		request.Header.Set("Authorization", "Bearer hint-token")
		response, err := client.Do(request)
		require.NoError(t, err)
		response.Body.Close()
		server.Close()
		count = len(calls)
		for range 3 {
			hint()
			retry, err = stack.fetchInstallPullHint(ctx, item)
			require.NoError(t, err)
			require.WithinDuration(t, now.Add(90*time.Second), retry, time.Second)
		}
		require.Len(t, calls, count, "paused hints must not reach the fetcher")
		now = retry
		_, err = stack.fetchInstallPullHint(ctx, item)
		require.NoError(t, err)
		require.Len(t, calls, count+1)
	}
	// A destination change after admission cannot fetch the previous binding.
	hint()
	_, err = pool.Exec(ctx, `UPDATE repositories SET mirror_destination='other/repo' WHERE id=$1`, repo.ID)
	require.NoError(t, err)
	count = len(calls)
	_, err = stack.fetchInstallPullHint(ctx, item)
	require.NoError(t, err)
	require.Len(t, calls, count)
	hint()
	require.Empty(t, stack.installPullHints.pending)
}

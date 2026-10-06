package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

type installPollFixture struct {
	t              *testing.T
	service        *GitHubSyncedRepoService
	pool           *pgxpool.Pool
	row            db.GithubSyncedRepo
	upstream       *githubfake.Server
	clock          atomic.Int64
	low            atomic.Bool
	exhausted      atomic.Bool
	refuseIssue    atomic.Int64
	refuseComments atomic.Int64
	mu             sync.Mutex
	paths          []string
}

func newInstallPollFixture(t *testing.T) *installPollFixture {
	t.Helper()
	s, pool, initial := newFetchedFixture(t)
	minter, upstream := newScopedTokenMinter(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `DELETE FROM github_synced_repos WHERE id=$1`, initial.ID)
	require.NoError(t, err)
	row, err := db.New(pool).EnrollGitHubSyncedRepo(ctx, db.EnrollGitHubSyncedRepoParams{OwnerLogin: "acme", RepoName: "app", InstallationID: pgtype.Int8{Int64: 91, Valid: true}, GithubRepositoryID: pgtype.Int8{Int64: 100, Valid: true}, SyncMetadata: true, EnrolledVia: GitHubSyncedRepoEnrolledViaInstallation})
	require.NoError(t, err)
	f := &installPollFixture{t: t, service: s, pool: pool, row: row, upstream: upstream}
	f.clock.Store(1000)
	clock := func() time.Time { return time.Unix(f.clock.Load(), 0).UTC() }
	s.now = clock
	tracker := NewGitHubResponseBudgetTracker()
	tracker.now = clock
	s.budget = tracker
	minter.SetGitHubBudgetTracker(tracker)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.paths = append(f.paths, r.Method+" "+r.URL.Path)
		f.mu.Unlock()
		w.Header().Set("X-RateLimit-Resource", "core")
		w.Header().Set("X-RateLimit-Limit", "100")
		w.Header().Set("X-RateLimit-Remaining", "90")
		w.Header().Set("X-RateLimit-Reset", "1300")
		if f.low.Load() {
			w.Header().Set("X-RateLimit-Remaining", "19")
		}
		if f.exhausted.Load() {
			w.Header().Set("X-RateLimit-Remaining", "0")
		}
		if f.clock.Load() >= 1300 {
			w.Header().Set("X-RateLimit-Reset", "4600")
		}
		code := int64(0)
		if r.URL.Path == "/repos/acme/app/issues" {
			code = f.refuseIssue.Load()
		}
		if r.URL.Path == "/repos/acme/app/issues/comments" {
			code = f.refuseComments.Load()
		}
		if code != 0 {
			w.Header().Set("Retry-After", "50")
			w.WriteHeader(int(code))
			_, _ = w.Write([]byte(`{"message":"secondary rate limit"}`))
			return
		}
		upstream.Handler().ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	client := NewGitHubUserReposService(db.New(pool), nil, WithGitHubUserReposHTTPClient(tracker.WrapClient(server.Client())))
	s.SetConditionalFetcherFactory(client.SyncedRepoConditionalFetcherFactory(minter))
	allowFetched(s)
	return f
}

// poll drives the existing production reconcile boundary with a literal clock.
// It inspects the HTTP server log, not the scheduler's internal due state.
func (f *installPollFixture) poll(at int64, want ...string) {
	f.t.Helper()
	f.clock.Store(1000 + at)
	f.mu.Lock()
	f.paths = nil
	f.mu.Unlock()
	f.service.reconcileOnce(context.Background())
	f.mu.Lock()
	var reads []string
	for _, path := range f.paths {
		if len(path) >= 4 && path[:4] == "GET " {
			reads = append(reads, path[4:])
		}
	}
	f.mu.Unlock()
	if len(want) == 0 {
		require.Empty(f.t, reads)
		return
	}
	for i := range want {
		want[i] = "/repos/acme/app/" + want[i]
	}
	require.Equal(f.t, want, reads, "poll at %d seconds", at)
}

func TestGitHubInstallMetadataCadencesAndWebhookHints(t *testing.T) {
	f := newInstallPollFixture(t)
	ctx := context.Background()
	f.poll(0, "issues", "pulls", "issues/events", "issues/comments")
	f.poll(44)
	f.poll(45, "pulls", "issues/comments")
	f.poll(90, "pulls", "issues/comments")
	f.poll(119)
	f.poll(120, "issues", "issues/events")
	f.clock.Store(1130)
	for range 3 {
		require.NoError(t, f.service.ApplyIssueEvent(ctx, "acme", "app", 100, "pulls", "opened", json.RawMessage(`{"number":999}`)))
	}
	f.poll(130, "pulls")
	f.poll(134)
	f.poll(135, "pulls", "issues/comments") // The hint did not postpone the existing 45-second cadence.
	f.clock.Store(1140)
	require.NoError(t, f.service.ApplyIssueEvent(ctx, "acme", "app", 100, "issues", "labeled", json.RawMessage(`{"number":999}`)))
	f.poll(140, "issues", "issues/events")
	f.poll(180, "pulls", "issues/comments")
	f.poll(225, "pulls", "issues/comments")
	f.poll(240, "issues", "issues/events")
	require.Zero(t, fetchedCount(t, f.pool, `SELECT count(*) FROM github_synced_issues`), "hint payloads never become objects")
	reads := f.upstream.Reads()
	for _, read := range reads[4:] {
		require.Equal(t, 304, read.Status)
		require.NotEmpty(t, read.IfNoneMatch)
	}
	require.Len(t, f.upstream.Writes(), 1, "all polls use one cached scoped token")
}

func TestGitHubInstallMetadataLowBudgetAndReset(t *testing.T) {
	f := newInstallPollFixture(t)
	f.low.Store(true)
	f.poll(0, "issues", "pulls", "issues/events", "issues/comments")
	f.poll(45, "pulls", "issues/comments")
	f.poll(120, "pulls", "issues/comments") // Only low-priority streams stretch to 240 seconds.
	f.poll(239, "pulls", "issues/comments")
	f.poll(240, "issues", "issues/events")
	f.low.Store(false)
	f.poll(300, "pulls", "issues/comments") // Resource reset restores 120-second issue cadence.
	f.poll(359, "pulls", "issues/comments")
	f.poll(360, "issues", "issues/events")
}

func TestGitHubInstallMetadataPauseIsStreamScoped(t *testing.T) {
	for _, code := range []int64{403, 429} {
		t.Run(strconv.FormatInt(code, 10), func(t *testing.T) {
			f := newInstallPollFixture(t)
			f.refuseIssue.Store(code)
			f.poll(0, "issues", "pulls", "issues/events", "issues/comments")
			ctx := context.Background()
			f.clock.Store(1010)
			require.NoError(t, f.service.requestInstallFetch(ctx, 100))
			f.poll(10, "pulls", "issues/events", "issues/comments")
			row, err := db.New(f.pool).GetGitHubSyncedRepoByGitHubID(ctx, f.row.GithubRepositoryID)
			require.NoError(t, err)
			require.Equal(t, "error", row.SyncState, "successful streams cannot erase the issue refusal")
			f.poll(49, "pulls", "issues/comments")
			f.refuseIssue.Store(0)
			f.poll(50, "issues") // The pending hint and retry boundary survive the pause.
			f.poll(119, "pulls", "issues/comments")
			f.poll(120, "issues", "issues/events")
			row, err = db.New(f.pool).GetGitHubSyncedRepoByGitHubID(ctx, f.row.GithubRepositoryID)
			require.NoError(t, err)
			require.Equal(t, "ready", row.SyncState)
		})
	}
}

func TestGitHubInstallMetadataClaimRetainsHintsAndRestartForgetsCadences(t *testing.T) {
	f := newInstallPollFixture(t)
	ctx := context.Background()
	f.poll(0, "issues", "pulls", "issues/events", "issues/comments")
	f.clock.Store(1010)
	require.NoError(t, f.service.requestInstallFetch(ctx, 100, "pulls"))
	_, err := f.pool.Exec(ctx, `UPDATE github_synced_repos SET syncing_since=NOW() WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	f.poll(10)
	_, err = f.pool.Exec(ctx, `UPDATE github_synced_repos SET syncing_since=NULL WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	f.poll(11, "pulls")
	factory := f.service.conditionalFetcherFactory
	fresh := NewGitHubSyncedRepoService(db.New(f.pool), WithGitHubSyncedRepoNow(f.service.now), WithGitHubSyncedRepoBudget(f.service.budget))
	require.NoError(t, fresh.ConfigureInstallSync(f.pool))
	allowFetched(fresh)
	fresh.SetConditionalFetcherFactory(factory)
	f.service = fresh
	f.poll(12, "issues", "pulls", "issues/events", "issues/comments")
	reads := f.upstream.Reads()
	for _, read := range reads[len(reads)-4:] {
		require.Empty(t, read.IfNoneMatch)
		require.Equal(t, 200, read.Status)
	}
}

func TestGitHubInstallMetadataWorkerWakesWithoutWaitingForCadence(t *testing.T) {
	f := newInstallPollFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	notified := make(chan error, 4)
	f.service.syncDone = func(_ int64, err error) { notified <- err }
	go func() { defer close(done); f.service.StartReconciler(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("worker did not stop")
		}
	})
	select {
	case err := <-notified:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("initial poll did not run")
	}
	f.clock.Store(1010)
	require.NoError(t, f.service.requestInstallFetch(ctx, 100, "pulls"))
	select {
	case err := <-notified:
		require.NoError(t, err)
	case <-time.After(time.Second):
		t.Fatal("hint did not wake the existing worker")
	}
	reads := f.upstream.Reads()
	require.Len(t, reads, 5)
	require.Contains(t, reads[4].Path, "/pulls?")
	require.Equal(t, 304, reads[4].Status)
}

func TestGitHubInstallMetadataUnpolledStreamCannotLookReady(t *testing.T) {
	f := newInstallPollFixture(t)
	ctx := context.Background()
	f.refuseIssue.Store(403)
	fetch := f.service.conditionalFetcherFactory(f.row)
	_, err := fetch(ctx, "issues", url.Values{"per_page": {"100"}}, "")
	require.Error(t, err)
	f.refuseIssue.Store(0)
	f.poll(0, "pulls", "issues/events", "issues/comments")
	row, err := db.New(f.pool).GetGitHubSyncedRepoByGitHubID(ctx, f.row.GithubRepositoryID)
	require.NoError(t, err)
	require.Equal(t, "error", row.SyncState)
	require.False(t, row.LastSyncedAt.Valid, "an initial paused stream has no success receipt")
	f.poll(50, "issues", "pulls", "issues/comments")
	row, err = db.New(f.pool).GetGitHubSyncedRepoByGitHubID(ctx, f.row.GithubRepositoryID)
	require.NoError(t, err)
	require.Equal(t, "ready", row.SyncState)
}

func TestGitHubInstallMetadataFinishRechecksBindingAndDisable(t *testing.T) {
	for _, change := range []string{"disabled", "failed", "rebound"} {
		t.Run(change, func(t *testing.T) {
			f := newInstallPollFixture(t)
			ctx := context.Background()
			mutation := "sync_state='disabled'"
			if change == "failed" {
				mutation = "sync_state='failed'"
			}
			if change == "rebound" {
				mutation = "installation_id=92"
			}
			_, err := f.pool.Exec(ctx, `CREATE FUNCTION change_repo_at_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE github_synced_repos SET `+mutation+`; RETURN NEW; END $$; CREATE TRIGGER change_repo_at_cursor AFTER INSERT ON install_settings FOR EACH ROW EXECUTE FUNCTION change_repo_at_cursor()`)
			require.NoError(t, err)
			f.poll(0, "issues", "pulls", "issues/events", "issues/comments")
			row, err := db.New(f.pool).GetGitHubSyncedRepoByGitHubID(ctx, f.row.GithubRepositoryID)
			require.NoError(t, err)
			require.False(t, row.LastSyncedAt.Valid, "the old binding cannot establish freshness")
			if change == "rebound" {
				require.EqualValues(t, 92, row.InstallationID.Int64)
				require.Equal(t, "error", row.SyncState)
			} else {
				require.Equal(t, change, row.SyncState)
			}
		})
	}
}

func TestGitHubRetrySchedulesExistingReadersAndPreservesPauses(t *testing.T) {
	f := newInstallPollFixture(t)
	s := f.service
	ctx := t.Context()
	q := db.New(f.pool)
	_, err := s.RequiredStreams(ctx)
	require.Error(t, err, "the TODO reader is required")
	stack := NewMythicalService(f.pool, nil)
	stack.UseInstallGitHubPolling(s)
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "retry-owner", LowerUsername: "retry-owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "retry-repo", LowerName: "retry-repo", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE repositories SET mirror_destination='acme/app' WHERE id=$1`, repo.ID)
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, user.ID, 1, false)
	require.NoError(t, err)
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "proposed"})
	require.NoError(t, err)
	item.PRNumber = pgtype.Int8{Int64: 7, Valid: true}
	item, err = q.SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	main := NewGitHubMainPullService(q, nil, nil, nil)
	main.UseInstallPolicy()
	checks, reviews, permissions := &syncStreamFixture{}, &syncStreamFixture{}, &syncStreamFixture{}
	main.SetInstallSyncStreams(s, checks, reviews, nil)
	require.NoError(t, main.RetrySync(ctx))
	require.Equal(t, 1, fetchedCount(t, f.pool, `SELECT count(*) FROM github_main_pulls`))
	require.Len(t, stack.installPullHints.pending, 1)
	main.SetInstallSyncStreams(s, checks, reviews, permissions)
	started := time.Now()
	require.NoError(t, main.RetrySync(ctx))
	require.Less(t, time.Since(started), time.Second, "Retry schedules; it does not await a fetch")
	f.mu.Lock()
	require.Empty(t, f.paths, "Retry sends no upstream request")
	f.mu.Unlock()
	require.Equal(t, 1, fetchedCount(t, f.pool, `SELECT count(*) FROM github_main_pulls WHERE requested_generation > synced_generation`))
	require.Len(t, stack.installPullHints.pending, 1)
	select {
	case <-main.wake:
	default:
		t.Fatal("main worker not woken")
	}
	select {
	case <-stack.installPullHints.wake:
	default:
		t.Fatal("TODO worker not woken")
	}
	select {
	case <-s.install.wake:
	default:
		t.Fatal("repository worker not woken")
	}
	require.Equal(t, 2, checks.retries)
	require.Equal(t, 2, reviews.retries)
	require.Equal(t, 1, permissions.retries)
	f.poll(0, "issues", "pulls", "issues/events", "issues/comments")
	streams, err := s.RequiredStreams(ctx)
	require.NoError(t, err)
	require.Len(t, streams, 5)
	require.Equal(t, "stale", aggregateGitHubSyncHealth(streams, s.now()).State, "unread TODO must not appear fresh")
	for _, stream := range streams[:4] {
		require.NotNil(t, stream.LastSuccessAt)
	}
	require.Nil(t, streams[4].LastSuccessAt)
	f.clock.Store(1010)
	require.NoError(t, main.RetrySync(ctx))
	f.poll(10, "issues", "pulls", "issues/events", "issues/comments")
	f.poll(44)
	f.poll(45, "pulls", "issues/comments")
	// An issue-only secondary limit leaves other streams due; Retry cannot clear it.
	f.refuseIssue.Store(429)
	require.NoError(t, main.RetrySync(ctx))
	f.poll(46, "issues", "pulls", "issues/events", "issues/comments")
	require.NoError(t, main.RetrySync(ctx))
	f.poll(47, "pulls", "issues/events", "issues/comments")
	streams, err = s.RequiredStreams(ctx)
	require.NoError(t, err)
	require.Equal(t, "limited", aggregateGitHubSyncHealth(streams, s.now()).State)
	// A primary-resource exhaustion holds every REST reader and the main token path.
	f.exhausted.Store(true)
	require.NoError(t, main.RetrySync(ctx))
	f.poll(48, "pulls")
	require.NoError(t, main.RetrySync(ctx))
	f.poll(49)
	err = s.AuthorizeRefRead(ctx, repo.ID)
	var failure *pkgerrors.APIError
	require.ErrorAs(t, err, &failure)
	require.Equal(t, pkgerrors.CodeGitHubRateLimited, failure.Code)
	require.Equal(t, time.Unix(1300, 0).UTC(), *failure.RetryAt)
	out := main.pull(ctx, db.GithubMainPull{RepositoryID: repo.ID})
	require.Equal(t, "failed", out.state)
	require.Equal(t, *failure.RetryAt, out.retryAt)
	// A revocation at retry time must not enqueue another pass of any owner.
	before := checks.retries
	s.install.authorize = func(context.Context, db.GithubSyncedRepo) error { return errors.New("revoked") }
	require.ErrorContains(t, main.RetrySync(ctx), "revoked")
	require.Equal(t, before, checks.retries)
}

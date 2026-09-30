package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// pageFetcher returns `count` issues on page 1 and pages of `pageSize` until
// exhausted; records how many calls it served.
func fixedIssuesFetcher(count int, calls *atomic.Int64) GitHubSyncedRepoPageFetcher {
	return func(_ context.Context, _ string, query url.Values) (json.RawMessage, error) {
		if calls != nil {
			calls.Add(1)
		}
		page, _ := strconv.Atoi(query.Get("page"))
		perPage, _ := strconv.Atoi(query.Get("per_page"))
		start := (page-1)*perPage + 1
		items := make([]string, 0)
		for n := start; n <= count && n < start+perPage; n++ {
			items = append(items, `{"id":`+strconv.Itoa(n)+`,"number":`+strconv.Itoa(n)+
				`,"state":"open","title":"t","updated_at":"2026-08-01T00:00:00Z"}`)
		}
		return json.RawMessage("[" + join(items, ",") + "]"), nil
	}
}

func join(parts []string, sep string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += sep
		}
		out += p
	}
	return out
}

// R4: consecutive failures back off and trip the 14-strike hard-fail kill
// switch; a hard-failed row keeps serving last-good but is never claimed again.
func TestSyncedRepos_ConsecutiveFailuresTripKillSwitch(t *testing.T) {
	store := newFakeSyncedRepoStore()
	service := NewGitHubSyncedRepoService(store)
	row, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: "widget"})
	require.NoError(t, err)
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(context.Background(), row.ID))
	seedSyncedIssue(t, store, row.ID, GitHubRepoMetadataIssues, 7, "open", time.Now())

	for i := 0; i < githubSyncedRepoHardFailAfter; i++ {
		service.recordSyncError(row.ID, errors.New("github said no"))
	}
	failed := store.repoByID(row.ID)
	assert.Equal(t, "failed", failed.SyncState, "14 straight failures hard-fail the row")
	assert.Equal(t, int32(githubSyncedRepoHardFailAfter), failed.ConsecutiveFailures)

	// Still serves last-good (honestly, with the error surfaced)...
	page, served := service.ServeMetadata(context.Background(), testReadGrant("octo", "widget"),
		GitHubRepoMetadataIssues, url.Values{}, nil)
	require.True(t, served)
	assert.NotEmpty(t, page.SyncError)

	// ...but the claim (and therefore any backfill) is refused.
	claimed, err := store.ClaimGitHubSyncedRepoSync(context.Background(), row.ID)
	require.NoError(t, err)
	assert.Zero(t, claimed)

	// And the reconciler's due list excludes it.
	due, err := store.ListDueGitHubSyncedRepos(context.Background(), 10)
	require.NoError(t, err)
	assert.Empty(t, due)

	// A success resets the streak (fake mirrors the SQL).
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(context.Background(), row.ID))
	assert.Zero(t, store.repoByID(row.ID).ConsecutiveFailures)
}

// R3: the reconciler sweeps a stale enrolled repo without any read traffic,
// using the installation-token fetcher factory (R2) — no user in scope.
func TestSyncedRepos_ReconcilerSweepsStaleRepoWithInstallationToken(t *testing.T) {
	store := newFakeSyncedRepoStore()
	var calls atomic.Int64
	service := NewGitHubSyncedRepoService(store)
	service.SetFetcherFactory(func(row db.GithubSyncedRepo) GitHubSyncedRepoPageFetcher {
		if !row.InstallationID.Valid {
			return nil
		}
		return fixedIssuesFetcher(2, &calls)
	})

	_, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{
		Owner: "octo", Repo: "widget", InstallationID: 42,
	})
	require.NoError(t, err)
	// Never synced -> due immediately.
	service.reconcileOnce(context.Background())

	assert.Positive(t, calls.Load(), "reconciler fetched via the factory")
	rows, _ := store.ListGitHubSyncedIssues(context.Background(), db.ListGitHubSyncedIssuesParams{
		SyncedRepoID: 1, Resource: GitHubRepoMetadataIssues, State: "open", RowLimit: 10,
	})
	assert.Len(t, rows, 2)
	assert.Equal(t, "ready", store.repoByID(1).SyncState)
}

// R3/R4: a repo with a live webhook heartbeat is only swept on the slow 8h
// backstop; a repo with no credential path is skipped, not failed.
func TestSyncedRepos_ReconcilerRespectsHeartbeatAndCredentialGaps(t *testing.T) {
	store := newFakeSyncedRepoStore()
	now := time.Now()
	var calls atomic.Int64
	service := NewGitHubSyncedRepoService(store, WithGitHubSyncedRepoNow(func() time.Time { return now }))
	service.SetFetcherFactory(func(row db.GithubSyncedRepo) GitHubSyncedRepoPageFetcher {
		if !row.InstallationID.Valid {
			return nil
		}
		return fixedIssuesFetcher(1, &calls)
	})

	withApp, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{
		Owner: "octo", Repo: "widget", InstallationID: 42,
	})
	require.NoError(t, err)
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(context.Background(), withApp.ID))
	require.NoError(t, store.TouchGitHubSyncedRepoWebhook(context.Background(), withApp.ID))
	_, err = service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{
		Owner: "octo", Repo: "no-app", // no installation -> no reconciler credential
	})
	require.NoError(t, err)

	service.reconcileOnce(context.Background())
	assert.Zero(t, calls.Load(), "heartbeat-fresh repo waits for the 8h backstop; credential-less repo skipped")
	assert.Equal(t, "pending", store.repoByID(2).SyncState, "credential-less repo not claimed or failed")

	// 9 hours later the backstop sweeps the heartbeat-fresh repo too.
	now = now.Add(9 * time.Hour)
	service.reconcileOnce(context.Background())
	assert.Positive(t, calls.Load())
}

// Rename/transfer: a delivery whose slug misses re-keys on the immutable
// numeric repo id and repairs the stored slug in place.
func TestSyncedRepos_WebhookRenameAdoptsSlugByNumericID(t *testing.T) {
	store := newFakeSyncedRepoStore()
	service := NewGitHubSyncedRepoService(store)
	row, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{
		Owner: "octo", Repo: "widget", GitHubRepositoryID: 777,
	})
	require.NoError(t, err)
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(context.Background(), row.ID))

	require.NoError(t, service.ApplyIssueEvent(context.Background(), "octo", "gadget", 777,
		GitHubRepoMetadataIssues, "opened",
		json.RawMessage(`{"id":1,"number":4,"state":"open","title":"after rename","updated_at":"2026-08-01T00:00:00Z"}`)))

	adopted := store.repoByID(row.ID)
	assert.Equal(t, "gadget", adopted.RepoName, "slug repaired from the numeric id")
	rows, _ := store.ListGitHubSyncedIssues(context.Background(), db.ListGitHubSyncedIssuesParams{
		SyncedRepoID: row.ID, Resource: GitHubRepoMetadataIssues, State: "open", RowLimit: 10,
	})
	assert.Len(t, rows, 1, "the delivery was applied, not dropped")

	// The old slug no longer resolves; an unknown id + unknown slug is ignored.
	require.NoError(t, service.ApplyIssueEvent(context.Background(), "octo", "widget", 999,
		GitHubRepoMetadataIssues, "opened", json.RawMessage(`{"id":2,"number":5}`)))
	assert.Len(t, store.repos, 1)
}

// R2: when the row has an installation, scheduleBackfill prefers the
// installation-token factory over the request-bound user fetcher.
func TestSyncedRepos_BackfillPrefersInstallationTokenFetcher(t *testing.T) {
	store := newFakeSyncedRepoStore()
	var installCalls, userCalls atomic.Int64
	done := make(chan struct{}, 1)
	service := NewGitHubSyncedRepoService(store,
		WithGitHubSyncedRepoSyncNotify(func(int64, error) { done <- struct{}{} }))
	service.SetFetcherFactory(func(row db.GithubSyncedRepo) GitHubSyncedRepoPageFetcher {
		return fixedIssuesFetcher(1, &installCalls)
	})

	row, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{
		Owner: "octo", Repo: "widget", InstallationID: 42,
	})
	require.NoError(t, err)
	service.scheduleBackfill(row, fixedIssuesFetcher(1, &userCalls))
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("backfill did not finish")
	}
	assert.Positive(t, installCalls.Load())
	assert.Zero(t, userCalls.Load(), "user token never spent when an installation exists")
}

// Deletion reconcile: the NotIn prune only runs against a provably complete
// (single-page) snapshot; a multi-page walk keeps possibly-deleted stragglers.
func TestSyncedRepos_PruneOnlyOnSinglePageSnapshot(t *testing.T) {
	store := newFakeSyncedRepoStore()
	service := NewGitHubSyncedRepoService(store)
	row, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: "widget"})
	require.NoError(t, err)

	// A stale row GitHub no longer returns.
	seedSyncedIssue(t, store, row.ID, GitHubRepoMetadataIssues, 9999, "open", time.Now())

	// Multi-page walk (150 issues -> 2 pages): stragglers are kept.
	require.NoError(t, service.backfillResource(context.Background(), row, GitHubRepoMetadataIssues,
		fixedIssuesFetcher(150, nil)))
	_, ok := store.issues[issueKey(row.ID, GitHubRepoMetadataIssues, 9999)]
	assert.True(t, ok, "multi-page snapshot must not prune (unstable pagination)")

	// Single-page walk: the straggler is reconciled away.
	require.NoError(t, service.backfillResource(context.Background(), row, GitHubRepoMetadataIssues,
		fixedIssuesFetcher(3, nil)))
	_, ok = store.issues[issueKey(row.ID, GitHubRepoMetadataIssues, 9999)]
	assert.False(t, ok, "single-page snapshot prunes deleted rows")
}

// R5: an exhausted installation budget defers the sweep instead of hammering.
func TestSyncedRepos_BudgetExhaustionDefersSync(t *testing.T) {
	store := newFakeSyncedRepoStore()
	budget := NewBudgetTrackerWithLimits(1, time.Hour)
	var calls atomic.Int64
	service := NewGitHubSyncedRepoService(store, WithGitHubSyncedRepoBudget(budget))
	service.SetFetcherFactory(func(db.GithubSyncedRepo) GitHubSyncedRepoPageFetcher {
		return fixedIssuesFetcher(1, &calls)
	})
	row, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{
		Owner: "octo", Repo: "widget", InstallationID: 42,
	})
	require.NoError(t, err)

	allowed, _ := budget.Allow(42) // burn the only token
	require.True(t, allowed)
	service.reconcileOnce(context.Background())
	assert.Zero(t, calls.Load(), "no GitHub call once the shared budget is exhausted")
	assert.False(t, store.repoByID(row.ID).SyncingSince.Valid, "not claimed either")
}

// Out-of-order comment deliveries: the fake documents intent; the SQL guard is
// in UpsertGitHubSyncedIssueComment's WHERE clause. This exercises the service
// path: a delete for an unknown comment and an apply for an unenrolled repo
// are both safe no-ops.
func TestSyncedRepos_CommentEventEdgeCases(t *testing.T) {
	store := newFakeSyncedRepoStore()
	service := NewGitHubSyncedRepoService(store)
	row, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: "widget"})
	require.NoError(t, err)

	require.NoError(t, service.ApplyIssueCommentEvent(context.Background(), "octo", "widget", 0, "deleted",
		json.RawMessage(`{"id":44,"number":4,"comments":0}`), json.RawMessage(`{"id":900}`)))
	assert.Empty(t, store.comments)
	require.NoError(t, service.ApplyIssueCommentEvent(context.Background(), "ghost", "repo", 0, "created",
		json.RawMessage(`{"id":44,"number":4,"comments":1}`), json.RawMessage(`{"id":900}`)))
	assert.Empty(t, store.comments, "unenrolled repo deliveries never create rows")
	assert.Len(t, store.repos, 1, "and never enroll")
	_ = row
}

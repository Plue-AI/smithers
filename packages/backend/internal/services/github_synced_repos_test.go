package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// fakeSyncedRepoStore is an in-memory GitHubSyncedRepoStore. Keys mirror the
// real unique indexes so upsert/dedup semantics are exercised for real.
type fakeSyncedRepoStore struct {
	mu                 sync.Mutex
	nextID             int64
	repos              map[string]*db.GithubSyncedRepo
	issues             map[string]db.GithubSyncedIssue // "repoID|resource|number"
	comments           map[string]db.GithubSyncedIssueComment
	mirrorStatusParams []db.RecordGitHubMirrorStatusParams
	mirrorStatusRows   int64
	mirrorStatusErr    error
	readGrants         map[string]time.Time // "userID|owner/repo" -> verified_at
	readGrantErr       error
	readyImports       []fakeReadyImport
}

func newFakeSyncedRepoStore() *fakeSyncedRepoStore {
	return &fakeSyncedRepoStore{
		repos:            map[string]*db.GithubSyncedRepo{},
		issues:           map[string]db.GithubSyncedIssue{},
		comments:         map[string]db.GithubSyncedIssueComment{},
		readGrants:       map[string]time.Time{},
		mirrorStatusRows: 1,
	}
}

func syncedRepoKey(owner, repo string) string {
	return strings.ToLower(owner) + "/" + strings.ToLower(repo)
}

func (f *fakeSyncedRepoStore) GetGitHubSyncedRepo(_ context.Context, arg db.GetGitHubSyncedRepoParams) (db.GithubSyncedRepo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.repos[syncedRepoKey(arg.OwnerLogin, arg.RepoName)]
	if !ok {
		return db.GithubSyncedRepo{}, pgx.ErrNoRows
	}
	return *row, nil
}

func (f *fakeSyncedRepoStore) EnrollGitHubSyncedRepo(_ context.Context, arg db.EnrollGitHubSyncedRepoParams) (db.GithubSyncedRepo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := syncedRepoKey(arg.OwnerLogin, arg.RepoName)
	if existing, ok := f.repos[key]; ok {
		existing.SyncRefs = existing.SyncRefs || arg.SyncRefs
		existing.SyncMetadata = existing.SyncMetadata || arg.SyncMetadata
		if arg.InstallationID.Valid {
			existing.InstallationID = arg.InstallationID
		}
		if arg.GithubRepositoryID.Valid {
			existing.GithubRepositoryID = arg.GithubRepositoryID
		}
		return *existing, nil
	}
	f.nextID++
	row := &db.GithubSyncedRepo{
		ID:                 f.nextID,
		OwnerLogin:         arg.OwnerLogin,
		OwnerLoginLower:    strings.ToLower(arg.OwnerLogin),
		RepoName:           arg.RepoName,
		RepoNameLower:      strings.ToLower(arg.RepoName),
		InstallationID:     arg.InstallationID,
		GithubRepositoryID: arg.GithubRepositoryID,
		SyncRefs:           arg.SyncRefs,
		SyncMetadata:       arg.SyncMetadata,
		SyncState:          "pending",
		EnrolledVia:        arg.EnrolledVia,
	}
	f.repos[key] = row
	return *row, nil
}

func (f *fakeSyncedRepoStore) ListGitHubSyncedRepos(_ context.Context, refsOnly bool) ([]db.GithubSyncedRepo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]db.GithubSyncedRepo, 0, len(f.repos))
	for _, row := range f.repos {
		if row.SyncState == "disabled" || (refsOnly && !row.SyncRefs) {
			continue
		}
		out = append(out, *row)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].OwnerLoginLower < out[j].OwnerLoginLower })
	return out, nil
}

func (f *fakeSyncedRepoStore) SetGitHubSyncedRepoMirror(_ context.Context, arg db.SetGitHubSyncedRepoMirrorParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, row := range f.repos {
		if row.ID == arg.ID {
			row.MirrorOwner = pgtype.Text{String: arg.MirrorOwner, Valid: true}
			row.MirrorRepo = pgtype.Text{String: arg.MirrorRepo, Valid: true}
		}
	}
	return nil
}

func (f *fakeSyncedRepoStore) RecordGitHubMirrorStatus(_ context.Context, arg db.RecordGitHubMirrorStatusParams) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mirrorStatusParams = append(f.mirrorStatusParams, arg)
	return f.mirrorStatusRows, f.mirrorStatusErr
}

func (f *fakeSyncedRepoStore) ClaimGitHubSyncedRepoSync(_ context.Context, id int64) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, row := range f.repos {
		if row.ID == id {
			if row.SyncingSince.Valid || row.SyncState == "disabled" || row.SyncState == "failed" {
				return 0, nil
			}
			row.SyncingSince = pgtype.Timestamptz{Time: time.Now(), Valid: true}
			return 1, nil
		}
	}
	return 0, nil
}

func (f *fakeSyncedRepoStore) MarkGitHubSyncedRepoSynced(_ context.Context, id int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, row := range f.repos {
		if row.ID == id {
			row.LastSyncedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
			row.SyncState = "ready"
			row.SyncError = pgtype.Text{}
			row.ConsecutiveFailures = 0
			row.SyncingSince = pgtype.Timestamptz{}
		}
	}
	return nil
}

func (f *fakeSyncedRepoStore) SetGitHubSyncedRepoSyncError(_ context.Context, arg db.SetGitHubSyncedRepoSyncErrorParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, row := range f.repos {
		if row.ID == arg.ID {
			row.SyncError = pgtype.Text{String: arg.SyncError, Valid: true}
			row.ConsecutiveFailures++
			switch {
			case row.SyncState == "disabled":
			case arg.HardFailAfter > 0 && row.ConsecutiveFailures >= arg.HardFailAfter:
				row.SyncState = "failed"
			default:
				row.SyncState = "error"
			}
			row.SyncingSince = pgtype.Timestamptz{}
		}
	}
	return nil
}

func (f *fakeSyncedRepoStore) GetGitHubSyncedRepoByGitHubID(_ context.Context, githubRepositoryID pgtype.Int8) (db.GithubSyncedRepo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, row := range f.repos {
		if row.GithubRepositoryID.Valid && githubRepositoryID.Valid &&
			row.GithubRepositoryID.Int64 == githubRepositoryID.Int64 {
			return *row, nil
		}
	}
	return db.GithubSyncedRepo{}, pgx.ErrNoRows
}

func (f *fakeSyncedRepoStore) AdoptGitHubSyncedRepoSlug(_ context.Context, arg db.AdoptGitHubSyncedRepoSlugParams) (db.GithubSyncedRepo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	newKey := syncedRepoKey(arg.OwnerLogin, arg.RepoName)
	if other, ok := f.repos[newKey]; ok && other.ID != arg.ID {
		return db.GithubSyncedRepo{}, errors.New("unique slug violation")
	}
	for key, row := range f.repos {
		if row.ID == arg.ID {
			delete(f.repos, key)
			row.OwnerLogin = arg.OwnerLogin
			row.OwnerLoginLower = strings.ToLower(arg.OwnerLogin)
			row.RepoName = arg.RepoName
			row.RepoNameLower = strings.ToLower(arg.RepoName)
			f.repos[newKey] = row
			return *row, nil
		}
	}
	return db.GithubSyncedRepo{}, pgx.ErrNoRows
}

func (f *fakeSyncedRepoStore) ListDueGitHubSyncedRepos(_ context.Context, rowLimit int32) ([]db.GithubSyncedRepo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]db.GithubSyncedRepo, 0, len(f.repos))
	for _, row := range f.repos {
		if !row.SyncMetadata || row.SyncState == "disabled" || row.SyncState == "failed" {
			continue
		}
		if row.SyncingSince.Valid && time.Since(row.SyncingSince.Time) < 5*time.Minute {
			continue
		}
		out = append(out, *row)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.LastSyncedAt.Valid != b.LastSyncedAt.Valid {
			return !a.LastSyncedAt.Valid
		}
		if a.LastSyncedAt.Valid && !a.LastSyncedAt.Time.Equal(b.LastSyncedAt.Time) {
			return a.LastSyncedAt.Time.Before(b.LastSyncedAt.Time)
		}
		return a.ID < b.ID
	})
	if int(rowLimit) < len(out) {
		out = out[:rowLimit]
	}
	return out, nil
}

func (f *fakeSyncedRepoStore) TouchGitHubSyncedRepoWebhook(_ context.Context, id int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, row := range f.repos {
		if row.ID == id {
			row.LastWebhookAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
		}
	}
	return nil
}

func issueKey(repoID int64, resource string, number int64) string {
	return strings.Join([]string{string(rune(repoID)), resource, string(rune(number))}, "|")
}

func (f *fakeSyncedRepoStore) ListGitHubSyncedIssues(_ context.Context, arg db.ListGitHubSyncedIssuesParams) ([]db.GithubSyncedIssue, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	matched := make([]db.GithubSyncedIssue, 0, len(f.issues))
	for _, row := range f.issues {
		if row.SyncedRepoID != arg.SyncedRepoID || row.Resource != arg.Resource {
			continue
		}
		if arg.State != "all" && row.State != arg.State {
			continue
		}
		matched = append(matched, row)
	}
	sort.Slice(matched, func(i, j int) bool {
		return matched[i].GithubUpdatedAt.Time.After(matched[j].GithubUpdatedAt.Time)
	})
	start := int(arg.RowOffset)
	if start > len(matched) {
		start = len(matched)
	}
	end := start + int(arg.RowLimit)
	if end > len(matched) {
		end = len(matched)
	}
	return matched[start:end], nil
}

func (f *fakeSyncedRepoStore) CountGitHubSyncedIssues(_ context.Context, arg db.CountGitHubSyncedIssuesParams) (int64, error) {
	rows, _ := f.ListGitHubSyncedIssues(context.Background(), db.ListGitHubSyncedIssuesParams{
		SyncedRepoID: arg.SyncedRepoID, Resource: arg.Resource, State: arg.State, RowLimit: 1 << 20,
	})
	return int64(len(rows)), nil
}

func (f *fakeSyncedRepoStore) UpsertGitHubSyncedIssue(_ context.Context, arg db.UpsertGitHubSyncedIssueParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.issues[issueKey(arg.SyncedRepoID, arg.Resource, arg.Number)] = db.GithubSyncedIssue{
		SyncedRepoID:    arg.SyncedRepoID,
		Resource:        arg.Resource,
		Number:          arg.Number,
		GithubID:        arg.GithubID,
		State:           arg.State,
		Title:           arg.Title,
		Payload:         arg.Payload,
		GithubCreatedAt: arg.GithubCreatedAt,
		GithubUpdatedAt: arg.GithubUpdatedAt,
	}
	return nil
}

func (f *fakeSyncedRepoStore) DeleteGitHubSyncedIssue(_ context.Context, arg db.DeleteGitHubSyncedIssueParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.issues, issueKey(arg.SyncedRepoID, arg.Resource, arg.Number))
	return nil
}

func (f *fakeSyncedRepoStore) DeleteGitHubSyncedIssuesNotIn(_ context.Context, arg db.DeleteGitHubSyncedIssuesNotInParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	keep := map[int64]struct{}{}
	for _, number := range arg.Numbers {
		keep[number] = struct{}{}
	}
	for key, row := range f.issues {
		if row.SyncedRepoID != arg.SyncedRepoID || row.Resource != arg.Resource {
			continue
		}
		if _, ok := keep[row.Number]; !ok {
			delete(f.issues, key)
		}
	}
	return nil
}

func (f *fakeSyncedRepoStore) UpsertGitHubSyncedIssueComment(_ context.Context, arg db.UpsertGitHubSyncedIssueCommentParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.comments[string(rune(arg.SyncedRepoID))+"|"+string(rune(arg.GithubID))] = db.GithubSyncedIssueComment{
		SyncedRepoID: arg.SyncedRepoID,
		IssueNumber:  arg.IssueNumber,
		GithubID:     arg.GithubID,
		Payload:      arg.Payload,
	}
	return nil
}

func (f *fakeSyncedRepoStore) DeleteGitHubSyncedIssueComment(_ context.Context, arg db.DeleteGitHubSyncedIssueCommentParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.comments, string(rune(arg.SyncedRepoID))+"|"+string(rune(arg.GithubID)))
	return nil
}

func (f *fakeSyncedRepoStore) ListGitHubSyncedIssueComments(_ context.Context, arg db.ListGitHubSyncedIssueCommentsParams) ([]db.GithubSyncedIssueComment, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	rows := []db.GithubSyncedIssueComment{}
	for _, row := range f.comments {
		if row.SyncedRepoID == arg.SyncedRepoID && row.IssueNumber == arg.IssueNumber {
			rows = append(rows, row)
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].GithubID < rows[j].GithubID })
	start := int(arg.RowOffset)
	if start >= len(rows) {
		return []db.GithubSyncedIssueComment{}, nil
	}
	end := start + int(arg.RowLimit)
	if end > len(rows) {
		end = len(rows)
	}
	return rows[start:end], nil
}

func readGrantKey(userID int64, owner, repo string) string {
	return strconv.FormatInt(userID, 10) + "|" + syncedRepoKey(owner, repo)
}

func (f *fakeSyncedRepoStore) UpsertGitHubSyncedRepoReadGrant(_ context.Context, arg db.UpsertGitHubSyncedRepoReadGrantParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.readGrantErr != nil {
		return f.readGrantErr
	}
	f.readGrants[readGrantKey(arg.UserID, arg.OwnerLogin, arg.RepoName)] = time.Now()
	return nil
}

func (f *fakeSyncedRepoStore) GetGitHubSyncedRepoReadGrant(_ context.Context, arg db.GetGitHubSyncedRepoReadGrantParams) (db.GithubSyncedRepoReadGrant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.readGrantErr != nil {
		return db.GithubSyncedRepoReadGrant{}, f.readGrantErr
	}
	verifiedAt, ok := f.readGrants[readGrantKey(arg.UserID, arg.OwnerLogin, arg.RepoName)]
	if !ok {
		return db.GithubSyncedRepoReadGrant{}, pgx.ErrNoRows
	}
	return db.GithubSyncedRepoReadGrant{
		UserID:          arg.UserID,
		OwnerLoginLower: strings.ToLower(arg.OwnerLogin),
		RepoNameLower:   strings.ToLower(arg.RepoName),
		VerifiedAt:      verifiedAt,
	}, nil
}

func (f *fakeSyncedRepoStore) DeleteGitHubSyncedRepoReadGrantsForUser(_ context.Context, userID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	prefix := strconv.FormatInt(userID, 10) + "|"
	for key := range f.readGrants {
		if strings.HasPrefix(key, prefix) {
			delete(f.readGrants, key)
		}
	}
	return nil
}

// testReadGrant is a checked grant for unit tests that exercise the store
// read itself; request-level tests obtain grants through ReadGrant.
func testReadGrant(owner, repo string) GitHubRepoReadGrant {
	return GitHubRepoReadGrant{owner: owner, repo: repo, ok: true}
}

func (f *fakeSyncedRepoStore) repoByID(id int64) db.GithubSyncedRepo {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, row := range f.repos {
		if row.ID == id {
			return *row
		}
	}
	return db.GithubSyncedRepo{}
}

func seedSyncedIssue(t *testing.T, store *fakeSyncedRepoStore, repoID int64, resource string, number int64, state string, updated time.Time) {
	t.Helper()
	payload := json.RawMessage(`{"number":` + strconv.FormatInt(number, 10) + `,"state":"` + state + `"}`)
	require.NoError(t, store.UpsertGitHubSyncedIssue(context.Background(), db.UpsertGitHubSyncedIssueParams{
		SyncedRepoID:    repoID,
		Resource:        resource,
		Number:          number,
		GithubID:        number * 1000,
		State:           state,
		Payload:         payload,
		GithubUpdatedAt: pgtype.Timestamptz{Time: updated, Valid: true},
	}))
}

func TestSyncedRepos_ServeMetadataServesStoreWhenFresh(t *testing.T) {
	store := newFakeSyncedRepoStore()
	service := NewGitHubSyncedRepoService(store)

	row, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{
		Owner: "Octo", Repo: "Widget", EnrolledVia: GitHubSyncedRepoEnrolledViaImport,
	})
	require.NoError(t, err)
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(context.Background(), row.ID))

	now := time.Now()
	seedSyncedIssue(t, store, row.ID, GitHubRepoMetadataIssues, 7, "open", now)
	seedSyncedIssue(t, store, row.ID, GitHubRepoMetadataIssues, 5, "open", now.Add(-time.Hour))
	seedSyncedIssue(t, store, row.ID, GitHubRepoMetadataIssues, 3, "closed", now.Add(-2*time.Hour))

	page, served := service.ServeMetadata(context.Background(), testReadGrant("octo", "widget"),
		GitHubRepoMetadataIssues, url.Values{}, nil)
	require.True(t, served, "an enrolled, backfilled repo must be served from the store")
	assert.False(t, page.Stale)
	// Default state filter is open (GitHub's default), newest-updated first.
	assert.JSONEq(t, `[{"number":7,"state":"open"},{"number":5,"state":"open"}]`, string(page.Body))
	assert.Empty(t, page.Link, "a short page is the last page")
}

func TestSyncedRepos_StoreRefusesCallerWithoutReadGrant(t *testing.T) {
	store := newFakeSyncedRepoStore()
	service := NewGitHubSyncedRepoService(store)
	ctx := context.Background()
	row, err := service.EnrollGitHubRepo(ctx, EnrollGitHubRepoInput{
		Owner: "acme", Repo: "secret", EnrolledVia: GitHubSyncedRepoEnrolledViaImport,
	})
	require.NoError(t, err)
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(ctx, row.ID))
	require.NoError(t, store.TouchGitHubSyncedRepoWebhook(ctx, row.ID))
	seedSyncedIssue(t, store, row.ID, GitHubRepoMetadataIssues, 1, "open", time.Now())

	_, served := service.ServeMetadata(ctx, GitHubRepoReadGrant{}, GitHubRepoMetadataIssues, url.Values{}, nil)
	assert.False(t, served, "a fresh shared store must not answer a caller with no read grant")
	_, served = service.ServeComments(ctx, GitHubRepoReadGrant{}, 1, nil, nil)
	assert.False(t, served, "comments must not be served without a read grant")

	// User 7 never read acme/secret live: no grant.
	grant := service.ReadGrant(ctx, 7, "acme", "secret")
	_, served = service.ServeMetadata(ctx, grant, GitHubRepoMetadataIssues, url.Values{}, nil)
	assert.False(t, served)

	// User 8 did: served, case-insensitively.
	require.NoError(t, service.RecordReadGrant(ctx, 8, "acme", "secret"))
	_, served = service.ServeMetadata(ctx, service.ReadGrant(ctx, 8, "ACME", "Secret"), GitHubRepoMetadataIssues, url.Values{}, nil)
	assert.True(t, served)
	// A grant for one repo reads only that repo: the grant carries the slug.
	other := service.ReadGrant(ctx, 8, "acme", "other")
	_, served = service.ServeMetadata(ctx, other, GitHubRepoMetadataIssues, url.Values{}, nil)
	assert.False(t, served)
}

func TestSyncedRepos_ReadGrantExpiresAndFailsClosed(t *testing.T) {
	store := newFakeSyncedRepoStore()
	service := NewGitHubSyncedRepoService(store)
	ctx := context.Background()
	require.NoError(t, service.RecordReadGrant(ctx, 8, "acme", "secret"))
	require.NoError(t, service.RecordReadGrant(ctx, 9, "acme", "secret"))
	assert.True(t, service.ReadGrant(ctx, 8, "acme", "secret").ok)

	base := time.Now()
	service.now = func() time.Time { return base.Add(githubSyncedRepoReadGrantTTL - time.Second) }
	assert.True(t, service.ReadGrant(ctx, 8, "acme", "secret").ok, "inside the TTL the grant holds")
	service.now = func() time.Time { return base.Add(githubSyncedRepoReadGrantTTL + time.Second) }
	assert.False(t, service.ReadGrant(ctx, 8, "acme", "secret").ok, "past the TTL the user must re-prove access live")
	service.now = time.Now

	require.NoError(t, service.RevokeReadGrants(ctx, 8))
	assert.False(t, service.ReadGrant(ctx, 8, "acme", "secret").ok, "revocation drops the user's grants")
	assert.True(t, service.ReadGrant(ctx, 9, "acme", "secret").ok, "revocation leaves other users' grants")

	store.readGrantErr = errors.New("db down")
	assert.False(t, service.ReadGrant(ctx, 9, "acme", "secret").ok, "an unreadable grant fails closed to live")
	assert.False(t, service.ReadGrant(ctx, 0, "acme", "secret").ok)
}

func TestSyncedRepos_ServeMetadataFallsBackToLiveWhenNotEnrolledOrUnmodelled(t *testing.T) {
	store := newFakeSyncedRepoStore()
	service := NewGitHubSyncedRepoService(store)

	_, served := service.ServeMetadata(context.Background(), testReadGrant("octo", "widget"),
		GitHubRepoMetadataIssues, url.Values{}, nil)
	assert.False(t, served, "an unenrolled repo must fall through to the live passthrough")

	row, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: "widget"})
	require.NoError(t, err)
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(context.Background(), row.ID))

	// A label filter is not modeled by the store — it must go live, not lie.
	_, served = service.ServeMetadata(context.Background(), testReadGrant("octo", "widget"),
		GitHubRepoMetadataIssues, url.Values{"labels": {"bug"}}, nil)
	assert.False(t, served)
}

func TestSyncedRepos_ServeMetadataServesLastGoodWithStalenessAndRevalidates(t *testing.T) {
	store := newFakeSyncedRepoStore()
	done := make(chan error, 1)
	service := NewGitHubSyncedRepoService(store,
		WithGitHubSyncedRepoSyncNotify(func(int64, error) { done <- nil }),
	)

	row, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: "widget"})
	require.NoError(t, err)
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(context.Background(), row.ID))
	seedSyncedIssue(t, store, row.ID, GitHubRepoMetadataIssues, 9, "open", time.Now())

	// Jump the clock past both freshness windows: last-good is still served, but
	// honestly marked stale, and a revalidate is scheduled.
	service.now = func() time.Time { return time.Now().Add(48 * time.Hour) }

	var fetched int
	fetch := func(_ context.Context, resource string, _ url.Values) (json.RawMessage, error) {
		fetched++
		if resource == GitHubRepoMetadataIssues {
			return json.RawMessage(`[{"number":9,"state":"open","updated_at":"2026-08-01T00:00:00Z"}]`), nil
		}
		return json.RawMessage(`[]`), nil
	}

	page, served := service.ServeMetadata(context.Background(), testReadGrant("octo", "widget"),
		GitHubRepoMetadataIssues, url.Values{}, fetch)
	require.True(t, served, "stale must still serve last-good, never fail")
	assert.True(t, page.Stale)
	assert.JSONEq(t, `[{"number":9,"state":"open"}]`, string(page.Body))

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("background revalidate never ran")
	}
	assert.Positive(t, fetched)
	assert.Equal(t, "ready", store.repoByID(row.ID).SyncState)
}

func TestSyncedRepos_BackfillFailureRecordsErrorAndKeepsLastGood(t *testing.T) {
	store := newFakeSyncedRepoStore()
	done := make(chan error, 1)
	service := NewGitHubSyncedRepoService(store,
		WithGitHubSyncedRepoSyncNotify(func(_ int64, err error) { done <- err }),
	)
	row, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: "widget"})
	require.NoError(t, err)
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(context.Background(), row.ID))
	seedSyncedIssue(t, store, row.ID, GitHubRepoMetadataIssues, 9, "open", time.Now())
	service.now = func() time.Time { return time.Now().Add(48 * time.Hour) }

	fetch := func(context.Context, string, url.Values) (json.RawMessage, error) {
		return nil, errors.New("github is down")
	}
	page, served := service.ServeMetadata(context.Background(), testReadGrant("octo", "widget"),
		GitHubRepoMetadataIssues, url.Values{}, fetch)
	require.True(t, served)
	assert.JSONEq(t, `[{"number":9,"state":"open"}]`, string(page.Body))

	select {
	case err := <-done:
		require.Error(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("background revalidate never ran")
	}

	after := store.repoByID(row.ID)
	assert.Equal(t, "error", after.SyncState)
	assert.NotEmpty(t, after.SyncError.String, "the failure is recorded on the registry row")
	// Last-good rows survive the failure: the proxy never invents, it degrades.
	rows, _ := store.ListGitHubSyncedIssues(context.Background(), db.ListGitHubSyncedIssuesParams{
		SyncedRepoID: row.ID, Resource: GitHubRepoMetadataIssues, State: "open", RowLimit: 10,
	})
	assert.Len(t, rows, 1)
}

func TestSyncedRepos_WebhookEventsKeepStoreFresh(t *testing.T) {
	store := newFakeSyncedRepoStore()
	service := NewGitHubSyncedRepoService(store)
	row, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: "widget"})
	require.NoError(t, err)
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(context.Background(), row.ID))

	ctx := context.Background()
	require.NoError(t, service.ApplyIssueEvent(ctx, "octo", "widget", 0, GitHubRepoMetadataIssues, "opened",
		json.RawMessage(`{"id":1,"number":4,"state":"open","title":"New","updated_at":"2026-08-01T00:00:00Z"}`)))
	require.NoError(t, service.ApplyIssueEvent(ctx, "octo", "widget", 0, GitHubRepoMetadataPulls, "opened",
		json.RawMessage(`{"id":2,"number":11,"state":"open","title":"PR","updated_at":"2026-08-01T00:00:00Z"}`)))
	require.NoError(t, service.ApplyIssueCommentEvent(ctx, "octo", "widget", 0, "created", 4,
		json.RawMessage(`{"id":900,"body":"hi","updated_at":"2026-08-01T00:00:00Z"}`)))

	assert.True(t, store.repoByID(row.ID).LastWebhookAt.Valid, "deliveries heartbeat the registry row")
	assert.Len(t, store.issues, 2)
	assert.Len(t, store.comments, 1)

	// The heartbeat alone keeps a quiet repo fresh — no polling needed.
	page, served := service.ServeMetadata(ctx, testReadGrant("octo", "widget"), GitHubRepoMetadataPulls, url.Values{}, nil)
	require.True(t, served)
	assert.False(t, page.Stale)
	assert.JSONEq(t, `[{"id":2,"number":11,"state":"open","title":"PR","updated_at":"2026-08-01T00:00:00Z"}]`, string(page.Body))

	require.NoError(t, service.ApplyIssueEvent(ctx, "octo", "widget", 0, GitHubRepoMetadataIssues, "deleted",
		json.RawMessage(`{"id":1,"number":4}`)))
	assert.Len(t, store.issues, 1)

	// An unenrolled repo is simply ignored, never enrolled by a webhook alone.
	require.NoError(t, service.ApplyIssueEvent(ctx, "other", "repo", 0, GitHubRepoMetadataIssues, "opened",
		json.RawMessage(`{"id":3,"number":1}`)))
	assert.Len(t, store.issues, 1)
}

func TestSyncedRepos_EnrollIsIdempotentAndNeverDowngrades(t *testing.T) {
	store := newFakeSyncedRepoStore()
	service := NewGitHubSyncedRepoService(store)

	first, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{
		Owner: "Octo", Repo: "Widget", EnrolledVia: GitHubSyncedRepoEnrolledViaImport,
	})
	require.NoError(t, err)
	assert.True(t, first.SyncRefs, "ref mirroring is on by default for enrolled repos")

	// Case-folded re-enrollment as metadata-only must not turn ref sync off.
	second, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{
		Owner: "octo", Repo: "widget", EnrolledVia: GitHubSyncedRepoEnrolledViaLazy, MetadataOnly: true,
	})
	require.NoError(t, err)
	assert.Equal(t, first.ID, second.ID)
	assert.True(t, second.SyncRefs)
	assert.Equal(t, GitHubSyncedRepoEnrolledViaImport, second.EnrolledVia)
	assert.Len(t, store.repos, 1)
}

func TestSyncedRepos_ListSyncedReposFeedsGitHubSync(t *testing.T) {
	store := newFakeSyncedRepoStore()
	service := NewGitHubSyncedRepoService(store)

	refs, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: "widget"})
	require.NoError(t, err)
	service.SetPushAccess(pushAccessFunc(func(context.Context, int64, string, string) error { return nil }))
	store.recordReadyImport(fakeReadyImport{userID: 7, githubOwner: "octo", githubRepo: "widget", repoOwner: "alice", repoName: "widget"})
	require.NoError(t, service.BindMirror(context.Background(), 7, refs, "alice", "widget"))
	_, err = service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{
		Owner: "zulu", Repo: "meta", MetadataOnly: true,
	})
	require.NoError(t, err)

	all, err := service.ListSyncedRepos(context.Background(), false)
	require.NoError(t, err)
	assert.Len(t, all, 2)

	refsOnly, err := service.ListSyncedRepos(context.Background(), true)
	require.NoError(t, err)
	require.Len(t, refsOnly, 1)
	assert.Equal(t, "octo", refsOnly[0].GitHubOwner)
	assert.Equal(t, "alice", refsOnly[0].SmithersOwner)
	assert.Equal(t, "widget", refsOnly[0].SmithersRepo)
}

func TestSyncedRepos_RecordMirrorStatus(t *testing.T) {
	store := newFakeSyncedRepoStore()
	service := NewGitHubSyncedRepoService(store)

	err := service.RecordMirrorStatus(context.Background(), " Alice ", " Widget ", GitHubMirrorStatusReport{
		Status:     " FAILED ",
		Error:      "push rejected",
		BehindRefs: 3,
		FailedRefs: 1,
	})
	require.NoError(t, err)
	require.Len(t, store.mirrorStatusParams, 1)
	assert.Equal(t, db.RecordGitHubMirrorStatusParams{
		MirrorStatus: GitHubMirrorStatusFailed,
		BehindRefs:   3,
		FailedRefs:   1,
		MirrorError:  pgtype.Text{String: "push rejected", Valid: true},
		MirrorOwner:  "Alice",
		MirrorRepo:   "Widget",
	}, store.mirrorStatusParams[0])
}

func TestSyncedRepos_RecordMirrorStatusValidationAndStorageErrors(t *testing.T) {
	tests := []struct {
		name       string
		owner      string
		repo       string
		report     GitHubMirrorStatusReport
		storeSetup func(*fakeSyncedRepoStore)
		status     int
	}{
		{name: "missing identity", report: GitHubMirrorStatusReport{Status: GitHubMirrorStatusBehind}, status: 400},
		{name: "invalid status", owner: "alice", repo: "widget", report: GitHubMirrorStatusReport{Status: "unconfigured"}, status: 400},
		{name: "failed requires error", owner: "alice", repo: "widget", report: GitHubMirrorStatusReport{Status: GitHubMirrorStatusFailed}, status: 400},
		{name: "head length", owner: "alice", repo: "widget", report: GitHubMirrorStatusReport{Status: GitHubMirrorStatusSynced, GitHubHead: strings.Repeat("a", 65)}, status: 400},
		{name: "invalid counts", owner: "alice", repo: "widget", report: GitHubMirrorStatusReport{Status: GitHubMirrorStatusFailed, Error: "bad", BehindRefs: 1, FailedRefs: 2}, status: 400},
		{name: "mapping missing", owner: "alice", repo: "widget", report: GitHubMirrorStatusReport{Status: GitHubMirrorStatusBehind}, storeSetup: func(s *fakeSyncedRepoStore) { s.mirrorStatusRows = 0 }, status: 404},
		{name: "database failure", owner: "alice", repo: "widget", report: GitHubMirrorStatusReport{Status: GitHubMirrorStatusBehind}, storeSetup: func(s *fakeSyncedRepoStore) { s.mirrorStatusErr = errors.New("db down") }, status: 500},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeSyncedRepoStore()
			if tc.storeSetup != nil {
				tc.storeSetup(store)
			}
			err := NewGitHubSyncedRepoService(store).RecordMirrorStatus(context.Background(), tc.owner, tc.repo, tc.report)
			require.Error(t, err)
			assert.Equal(t, tc.status, err.(*pkgerrors.APIError).Status)
		})
	}
}

// githubSyncedRepoParams is a tiny constructor so tests read as owner/repo.
func githubSyncedRepoParams(owner, repo string) db.GetGitHubSyncedRepoParams {
	return db.GetGitHubSyncedRepoParams{OwnerLogin: owner, RepoName: repo}
}

type pushAccessFunc func(ctx context.Context, userID int64, owner, repo string) error

func (f pushAccessFunc) GitHubRepoPushAuthorized(ctx context.Context, userID int64, owner, repo string) error {
	return f(ctx, userID, owner, repo)
}

// fakeReadyImport is a ready import_jobs row: userID imported the GitHub
// source into the Smithers repo repoOwner/repoName.
type fakeReadyImport struct {
	userID                  int64
	githubOwner, githubRepo string
	repoOwner, repoName     string
}

func (f *fakeSyncedRepoStore) recordReadyImport(imp fakeReadyImport) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.readyImports = append(f.readyImports, imp)
}

// ListGitHubSyncedRepoMirrorBinders mirrors the SQL: the newest ready import
// whose source and destination match the row's recorded mirror.
func (f *fakeSyncedRepoStore) ListGitHubSyncedRepoMirrorBinders(context.Context) ([]db.ListGitHubSyncedRepoMirrorBindersRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []db.ListGitHubSyncedRepoMirrorBindersRow
	for _, row := range f.repos {
		if !row.MirrorOwner.Valid || !row.MirrorRepo.Valid {
			continue
		}
		for i := len(f.readyImports) - 1; i >= 0; i-- {
			imp := f.readyImports[i]
			if strings.EqualFold(imp.githubOwner, row.OwnerLogin) && strings.EqualFold(imp.githubRepo, row.RepoName) &&
				strings.EqualFold(imp.repoOwner, row.MirrorOwner.String) && strings.EqualFold(imp.repoName, row.MirrorRepo.String) {
				out = append(out, db.ListGitHubSyncedRepoMirrorBindersRow{SyncedRepoID: row.ID, UserID: imp.userID})
				break
			}
		}
	}
	return out, nil
}

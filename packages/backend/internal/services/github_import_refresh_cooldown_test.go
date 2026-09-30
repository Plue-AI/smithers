package services

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// cooldownImport re-imports smithersai/smithers into the existing mirror
// repositoryID as userID, with the refresh ledger in db. GitHub's API,
// git and repo-host are faked: the ledger is what these tests exercise. It
// returns how many GitHub clones the import ran and the bookmark it created.
func cooldownImport(t *testing.T, ledger GitHubImportDB, repositoryID, userID int64, cooldown time.Duration, pushErr error) (int, *refreshSeamRepoHost, WorkspaceResponse) {
	t.Helper()
	api := newRefreshImportAPI(t)
	existing := db.Repository{ID: repositoryID, Name: "smithers", LowerName: "smithers", DefaultBookmark: "main"}
	repoHost := &refreshSeamRepoHost{bookmarks: []repohost.Bookmark{{Name: "main", TargetChangeID: "c-main"}}}
	provisioner := &testGitHubImportWorkspaceProvisioner{
		resp: WorkspaceResponse{ID: "11111111-1111-1111-1111-111111111111", RepositoryID: repositoryID, UserID: userID, TargetBookmark: "feature", Status: "running"},
	}
	recorder := &gitCallRecorder{pushErr: pushErr}
	svc := NewGitHubImportService(
		ledger,
		testGitHubImportRepoDB{existing: &existing},
		testGitHubImportTokenDB{},
		repoHost,
		testGitHubImportDecrypter{},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportWorkspaceProvisioner(provisioner),
		withGitHubImportProvenance(func(context.Context, int64, string, string, int64) (bool, error) { return true, nil }),
	)
	svc.refreshCooldown = cooldown
	svc.runGit = recorder.run
	svc.mkdirTemp = func(string, string) (string, error) { return t.TempDir(), nil }

	repository, workspace, err := svc.runImport(context.Background(), userID, "smithersai", "smithers", "importer", "feature", "cooldown-job")
	require.NoError(t, err, "a re-import reaches ready whether or not it refreshes")
	require.Equal(t, repositoryID, repository.ID)
	require.True(t, repoHost.createdBookmarkOK, "the re-import still creates its bookmark")
	require.Equal(t, "feature", repoHost.createdBookmark.Name)
	clones := 0
	for _, call := range recorder.calls {
		if gitVerb(call) == "clone" {
			clones++
		}
	}
	return clones, repoHost, workspace
}

func cooldownFixture(t *testing.T) (*pgxpool.Pool, int64, int64, int64) {
	t.Helper()
	pool := newProductTestPool(t)
	ctx := context.Background()
	var alice, bob, repositoryID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('alice', 'alice') RETURNING id`).Scan(&alice))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('bob', 'bob') RETURNING id`).Scan(&bob))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name) VALUES ($1, 'smithers', 'smithers') RETURNING id`, alice).Scan(&repositoryID))
	return pool, repositoryID, alice, bob
}

func ageLastRefresh(t *testing.T, pool *pgxpool.Pool, repositoryID int64, age time.Duration) {
	t.Helper()
	tag, err := pool.Exec(context.Background(),
		`UPDATE github_mirror_refreshes SET refreshed_at = NOW() - make_interval(secs => $2::double precision) WHERE repository_id = $1`,
		repositoryID, age.Seconds())
	require.NoError(t, err)
	require.EqualValues(t, 1, tag.RowsAffected())
}

func refreshLedgerRow(t *testing.T, pool *pgxpool.Pool, repositoryID int64) (refreshed bool, leased bool) {
	t.Helper()
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT refreshed_at IS NOT NULL, claim_token IS NOT NULL FROM github_mirror_refreshes WHERE repository_id = $1`,
		repositoryID).Scan(&refreshed, &leased))
	return refreshed, leased
}

// Inside the window a re-import, by the same or another user, clones
// nothing and still gets its bookmark and workspace; past it, it clones.
func TestGitHubImportRefreshCooldownIsPerRepository(t *testing.T) {
	pool, repositoryID, alice, bob := cooldownFixture(t)
	const window = 10 * time.Minute

	clones, _, workspace := cooldownImport(t, pool, repositoryID, alice, window, nil)
	assert.Equal(t, 1, clones, "the first re-import refreshes")
	assert.Equal(t, "11111111-1111-1111-1111-111111111111", workspace.ID)
	refreshed, leased := refreshLedgerRow(t, pool, repositoryID)
	assert.True(t, refreshed, "a successful refresh starts the window")
	assert.False(t, leased, "a settled refresh holds no lease")

	clones, _, workspace = cooldownImport(t, pool, repositoryID, alice, window, nil)
	assert.Zero(t, clones, "a second import inside the window reuses the mirror")
	assert.Equal(t, "11111111-1111-1111-1111-111111111111", workspace.ID, "and still provisions its workspace")

	clones, _, _ = cooldownImport(t, pool, repositoryID, bob, window, nil)
	assert.Zero(t, clones, "another user shares the repository's window")

	// Just inside the window's edge, still no clone.
	ageLastRefresh(t, pool, repositoryID, window-time.Minute)
	clones, _, _ = cooldownImport(t, pool, repositoryID, bob, window, nil)
	assert.Zero(t, clones)

	ageLastRefresh(t, pool, repositoryID, window+time.Second)
	clones, _, _ = cooldownImport(t, pool, repositoryID, bob, window, nil)
	assert.Equal(t, 1, clones, "an import after the window clones again")
}

// A failed refresh does not start the window: the next import retries at
// once, and a success after it does start the window.
func TestGitHubImportRefreshFailureDoesNotStartCooldown(t *testing.T) {
	pool, repositoryID, alice, bob := cooldownFixture(t)
	const window = time.Hour

	clones, _, _ := cooldownImport(t, pool, repositoryID, alice, window, errors.New("push mirrored refs: connection refused"))
	assert.Equal(t, 1, clones, "the failing refresh ran")
	refreshed, leased := refreshLedgerRow(t, pool, repositoryID)
	assert.False(t, refreshed, "a failed refresh records no success")
	assert.False(t, leased, "a failed refresh releases its lease")

	clones, _, _ = cooldownImport(t, pool, repositoryID, bob, window, nil)
	assert.Equal(t, 1, clones, "the next import retries at once")
	clones, _, _ = cooldownImport(t, pool, repositoryID, alice, window, nil)
	assert.Zero(t, clones, "the success started the window")

	// A failure after a success keeps the earlier success's window.
	ageLastRefresh(t, pool, repositoryID, window+time.Second)
	clones, _, _ = cooldownImport(t, pool, repositoryID, alice, window, errors.New("github unavailable"))
	assert.Equal(t, 1, clones)
	var age float64
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT EXTRACT(EPOCH FROM NOW() - refreshed_at) FROM github_mirror_refreshes WHERE repository_id = $1`, repositoryID).Scan(&age))
	assert.Greater(t, age, window.Seconds(), "a failure does not move the last success")
}

// A refresh in flight holds a lease: concurrent imports of the mirror clone
// it once, and a lease whose holder died expires.
func TestGitHubImportRefreshLeaseAdmitsOneClone(t *testing.T) {
	pool, repositoryID, alice, bob := cooldownFixture(t)
	ctx := context.Background()
	svc := &GitHubImportService{db: pool}

	first, ok := svc.claimMirrorRefresh(ctx, repositoryID, "first")
	require.True(t, ok)
	_, ok = svc.claimMirrorRefresh(ctx, repositoryID, "second")
	require.False(t, ok, "a live lease blocks a second refresh even with a zero window")
	clones, _, _ := cooldownImport(t, pool, repositoryID, bob, 0, nil)
	assert.Zero(t, clones, "an import during another's refresh reuses the mirror")

	// A holder that died: its lease expires and the next import refreshes.
	_, err := pool.Exec(ctx, `UPDATE github_mirror_refreshes SET claim_expires_at = NOW() - interval '1 second' WHERE repository_id = $1`, repositoryID)
	require.NoError(t, err)
	clones, _, _ = cooldownImport(t, pool, repositoryID, alice, 0, nil)
	assert.Equal(t, 1, clones)

	// The dead holder settling late changes nothing: its token is gone.
	var before time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT refreshed_at FROM github_mirror_refreshes WHERE repository_id = $1`, repositoryID).Scan(&before))
	ageLastRefresh(t, pool, repositoryID, time.Hour)
	svc.settleMirrorRefresh(ctx, repositoryID, first, true)
	var age float64
	require.NoError(t, pool.QueryRow(ctx, `SELECT EXTRACT(EPOCH FROM NOW() - refreshed_at) FROM github_mirror_refreshes WHERE repository_id = $1`, repositoryID).Scan(&age))
	assert.Greater(t, age, time.Hour.Seconds()-60, "a stale lease cannot start the window")

	// Racing imports: exactly one wins the lease.
	ageLastRefresh(t, pool, repositoryID, 2*time.Hour)
	var wins sync.WaitGroup
	results := make(chan bool, 8)
	for i := range 8 {
		wins.Add(1)
		go func() {
			defer wins.Done()
			_, won := svc.claimMirrorRefresh(ctx, repositoryID, string(rune('a'+i)))
			results <- won
		}()
	}
	wins.Wait()
	close(results)
	won := 0
	for result := range results {
		if result {
			won++
		}
	}
	assert.Equal(t, 1, won)
}

// A fresh import's clone starts the window, so an immediate re-import does
// not clone the source a second time.
func TestGitHubImportFreshCloneStartsCooldown(t *testing.T) {
	pool, repositoryID, alice, _ := cooldownFixture(t)
	svc := &GitHubImportService{db: pool}
	svc.recordMirrorCloned(context.Background(), repositoryID)
	clones, _, _ := cooldownImport(t, pool, repositoryID, alice, time.Hour, nil)
	assert.Zero(t, clones)

	// Recording again moves the window forward.
	ageLastRefresh(t, pool, repositoryID, 2*time.Hour)
	svc.recordMirrorCloned(context.Background(), repositoryID)
	clones, _, _ = cooldownImport(t, pool, repositoryID, alice, time.Hour, nil)
	assert.Zero(t, clones)
}

// The ledger row goes with its repository.
func TestGitHubImportRefreshLedgerFollowsRepository(t *testing.T) {
	pool, repositoryID, _, _ := cooldownFixture(t)
	ctx := context.Background()
	(&GitHubImportService{db: pool}).recordMirrorCloned(ctx, repositoryID)
	// The storage fence guards product deletion; this checks only the key.
	_, err := pool.Exec(ctx, `ALTER TABLE repositories DISABLE TRIGGER repository_storage_fence`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `DELETE FROM repositories WHERE id = $1`, repositoryID)
	require.NoError(t, err)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM github_mirror_refreshes`).Scan(&count))
	assert.Zero(t, count)
}

// refreshLedgerDB answers the refresh claim with row or err.
type refreshLedgerDB struct {
	stageRecordingDB
	claimErr error
}

func (d *refreshLedgerDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if sql == claimGitHubMirrorRefreshSQL {
		d.ledger = append(d.ledger, sql)
		return stageIDRow{err: d.claimErr}
	}
	return d.stageRecordingDB.QueryRow(ctx, sql, args...)
}

// A refresh the ledger refuses, or cannot answer, clones nothing and settles
// nothing; the import still completes on the existing mirror.
func TestGitHubImportRefreshSkippedWithoutClaim(t *testing.T) {
	for name, claimErr := range map[string]error{
		"inside the window": pgx.ErrNoRows,
		"ledger failure":    errors.New("database unavailable"),
	} {
		t.Run(name, func(t *testing.T) {
			ledger := &refreshLedgerDB{claimErr: claimErr}
			clones, repoHost, workspace := cooldownImport(t, ledger, 99, 7, time.Hour, nil)
			assert.Zero(t, clones)
			assert.Empty(t, repoHost.importRefsOwner, "no refs are re-imported without a refresh")
			assert.Equal(t, "11111111-1111-1111-1111-111111111111", workspace.ID)
			assert.Equal(t, []string{claimGitHubMirrorRefreshSQL}, ledger.ledger)
		})
	}
}

// A granted refresh settles its lease: complete on success, release on
// failure.
func TestGitHubImportRefreshSettlesItsLease(t *testing.T) {
	for name, tc := range map[string]struct {
		pushErr error
		settle  string
	}{
		"success": {nil, completeGitHubMirrorRefreshSQL},
		"failure": {errors.New("push rejected"), releaseGitHubMirrorRefreshSQL},
	} {
		t.Run(name, func(t *testing.T) {
			ledger := &stageRecordingDB{}
			clones, _, _ := cooldownImport(t, ledger, 99, 7, time.Hour, tc.pushErr)
			assert.Equal(t, 1, clones)
			assert.Equal(t, []string{claimGitHubMirrorRefreshSQL, tc.settle}, ledger.ledger)
		})
	}
}

func TestGitHubMirrorRefreshCooldownConfiguration(t *testing.T) {
	for raw, want := range map[string]time.Duration{
		"":      defaultGitHubMirrorRefreshCooldown,
		"  ":    defaultGitHubMirrorRefreshCooldown,
		"90s":   90 * time.Second,
		"0":     0,
		"-1m":   defaultGitHubMirrorRefreshCooldown,
		"never": defaultGitHubMirrorRefreshCooldown,
	} {
		t.Setenv(envGitHubImportRefreshCooldown, raw)
		assert.Equal(t, want, githubMirrorRefreshCooldown(), "%q", raw)
	}
	t.Setenv(envGitHubImportRefreshCooldown, "2h")
	svc := NewGitHubImportService(nil, nil, nil, nil, nil, "")
	assert.Equal(t, 2*time.Hour, svc.refreshCooldown, "the service reads the window at construction")
}

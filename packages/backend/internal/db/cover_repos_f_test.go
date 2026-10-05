package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFCov_Repos_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userName := uniqueTestUsername(t)
	userID := mustCreateUser(t, pool, userName)
	repoID := mustCreateRepo(t, pool, userID, uniqueTestRepoName(t))
	userInt8 := pgtype.Int8{Int64: userID, Valid: true}

	// Counters are trigger-maintained from stars/watches membership rows
	// (trg_stars_count_*, trg_watches_count_*).
	socialCounts := func() (stars, watches int64) {
		t.Helper()
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT num_stars, num_watches FROM repositories WHERE id = $1`, repoID,
		).Scan(&stars, &watches))
		return stars, watches
	}
	_, err := q.StarRepo(ctx, StarRepoParams{UserID: userID, RepositoryID: repoID})
	require.NoError(t, err)
	_, err = q.WatchRepo(ctx, WatchRepoParams{UserID: userID, RepositoryID: repoID, Mode: "watching"})
	require.NoError(t, err)
	stars, watches := socialCounts()
	assert.Equal(t, int64(1), stars)
	assert.Equal(t, int64(1), watches)
	// Mode change hits the upsert's UPDATE arm and must not recount.
	_, err = q.WatchRepo(ctx, WatchRepoParams{UserID: userID, RepositoryID: repoID, Mode: "ignored"})
	require.NoError(t, err)
	_, watches = socialCounts()
	assert.Equal(t, int64(1), watches)
	unstarred, err := q.UnstarRepo(ctx, UnstarRepoParams{UserID: userID, RepositoryID: repoID})
	require.NoError(t, err)
	assert.Equal(t, int64(1), unstarred)
	unwatched, err := q.UnwatchRepo(ctx, UnwatchRepoParams{UserID: userID, RepositoryID: repoID})
	require.NoError(t, err)
	assert.Equal(t, int64(1), unwatched)
	stars, watches = socialCounts()
	assert.Equal(t, int64(0), stars)
	assert.Equal(t, int64(0), watches)
	// A raced second unstar deletes nothing: zero rows, zero webhook/counter drift.
	unstarred, err = q.UnstarRepo(ctx, UnstarRepoParams{UserID: userID, RepositoryID: repoID})
	require.NoError(t, err)
	assert.Zero(t, unstarred)
	stars, _ = socialCounts()
	assert.Equal(t, int64(0), stars)

	// Topics + archive lifecycle.
	topicsRepo, err := q.UpdateRepoTopics(ctx, UpdateRepoTopicsParams{Topics: []string{"go", "db"}, ID: repoID})
	require.NoError(t, err)
	assert.Equal(t, repoID, topicsRepo.ID)
	archived, err := q.ArchiveRepo(ctx, repoID)
	require.NoError(t, err)
	assert.True(t, archived.IsArchived)
	unarchived, err := q.UnarchiveRepo(ctx, repoID)
	require.NoError(t, err)
	assert.False(t, unarchived.IsArchived)

	// Fork metadata retains the parent's default bookmark.
	forkName := uniqueTestRepoName(t)
	fork, err := q.CreateForkRepo(ctx, CreateForkRepoParams{
		UserID: userInt8, Name: forkName, LowerName: forkName, Description: "", DefaultBookmark: "main",
		ForkID: pgtype.Int8{Int64: repoID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, repoID, fork.ForkID.Int64)

	// num_forks on the parent is trigger-maintained from the fork row
	// (trg_repositories_fork_count_*): fork insert increments, delete decrements.
	forkCountOfParent := func() (n int64) {
		t.Helper()
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT num_forks FROM repositories WHERE id = $1`, repoID,
		).Scan(&n))
		return n
	}
	assert.Equal(t, int64(1), forkCountOfParent())
	mustDurablyDeleteRepoForTest(t, pool, fork.ID)
	assert.Equal(t, int64(0), forkCountOfParent())

	// Re-create the fork for the list/transfer assertions below.
	fork, err = q.CreateForkRepo(ctx, CreateForkRepoParams{
		UserID: userInt8, Name: forkName, LowerName: forkName, Description: "", DefaultBookmark: "main",
		ForkID: pgtype.Int8{Int64: repoID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), forkCountOfParent())

	// Counts.
	all, err := q.CountAllRepos(ctx)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, all, int64(2))
	pubUser, err := q.CountPublicUserRepos(ctx, userInt8)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, pubUser, int64(1))
	forkCount, err := q.CountRepoForks(ctx, pgtype.Int8{Int64: repoID, Valid: true})
	require.NoError(t, err)
	assert.Equal(t, int64(1), forkCount)

	// Lists (each must return >= 1 row).
	allList, err := q.ListAllRepos(ctx, ListAllReposParams{PageOffset: 0, PageSize: 100})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(allList), 2)
	pubList, err := q.ListPublicUserRepos(ctx, ListPublicUserReposParams{UserID: userInt8, PageOffset: 0, PageSize: 100})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(pubList), 1)
	forkList, err := q.ListRepoForks(ctx, ListRepoForksParams{ForkID: pgtype.Int8{Int64: repoID, Valid: true}, PageOffset: 0, PageSize: 100})
	require.NoError(t, err)
	require.Len(t, forkList, 1)

	// Collaborators.
	collabUser := mustCreateUser(t, pool, uniqueTestUsername(t))
	mustExec(t, pool, `INSERT INTO collaborators (repository_id, user_id, permission, github_id, github_login) VALUES ($1, $2, 'write', 4242, 'octo-member')`, repoID, collabUser)
	collabs, err := q.ListCollaboratorsByRepo(ctx, repoID)
	require.NoError(t, err)
	require.Len(t, collabs, 1)
	// The listed row carries the roster columns from migration 0116.
	assert.Equal(t, pgtype.Int8{Int64: 4242, Valid: true}, collabs[0].GithubID)
	assert.Equal(t, pgtype.Text{String: "octo-member", Valid: true}, collabs[0].GithubLogin)
	assert.GreaterOrEqual(t, collabs[0].UnixUid, int32(20000))
	assert.False(t, collabs[0].SuspendedAt.Valid)
	require.NoError(t, q.DeleteCollaboratorsByRepo(ctx, repoID))
	collabs, err = q.ListCollaboratorsByRepo(ctx, repoID)
	require.NoError(t, err)
	assert.Empty(t, collabs)

	// Team repos.
	orgName := "org-" + randSlug(t)[:20]
	orgID := mustCreateOrganization(t, pool, orgName)
	teamID := mustCreateTeam(t, pool, orgID, "team-"+randSlug(t)[:20])
	mustAddTeamRepo(t, pool, teamID, repoID)
	teamRepos, err := q.ListTeamReposByRepo(ctx, repoID)
	require.NoError(t, err)
	require.Len(t, teamRepos, 1)
	require.NoError(t, q.DeleteTeamReposByRepo(ctx, repoID))
	teamRepos, err = q.ListTeamReposByRepo(ctx, repoID)
	require.NoError(t, err)
	assert.Empty(t, teamRepos)

	// Source provenance must follow the repository's current namespace. Imports
	// begin under a user, but TransferRepoToOrg clears repositories.user_id; a
	// user-only owner join would silently turn this ready import into a 404.
	sourceOwner := "github-" + randSlug(t)[:20]
	sourceRepo := "source-" + randSlug(t)[:20]
	mustExec(t, pool, `
		INSERT INTO import_jobs (user_id, repository_id, github_owner, github_repo, status)
		VALUES ($1, $2, $3, $4, 'ready')
	`, userID, fork.ID, sourceOwner, sourceRepo)
	imported, err := q.GetReadyImportedRepoForUserBySource(ctx, GetReadyImportedRepoForUserBySourceParams{
		UserID: userID, GithubOwner: sourceOwner, GithubRepo: sourceRepo,
	})
	require.NoError(t, err)
	assert.Equal(t, userName, imported.LocalOwner)

	// Transfers (use the fork so the main repo stays owned by userID above).
	mustDurablyMoveRepoForTest(t, pool, fork.ID, pgtype.Int8{}, pgtype.Int8{Int64: orgID, Valid: true})
	toOrg, err := q.GetRepoByID(ctx, fork.ID)
	require.NoError(t, err)
	assert.Equal(t, orgID, toOrg.OrgID.Int64)
	imported, err = q.GetReadyImportedRepoForUserBySource(ctx, GetReadyImportedRepoForUserBySourceParams{
		UserID: userID, GithubOwner: sourceOwner, GithubRepo: sourceRepo,
	})
	require.NoError(t, err)
	assert.Equal(t, orgName, imported.LocalOwner)
	newOwner := mustCreateUser(t, pool, uniqueTestUsername(t))
	mustDurablyMoveRepoForTest(t, pool, fork.ID, pgtype.Int8{Int64: newOwner, Valid: true}, pgtype.Int8{})
	toUser, err := q.GetRepoByID(ctx, fork.ID)
	require.NoError(t, err)
	assert.Equal(t, newOwner, toUser.UserID.Int64)
}

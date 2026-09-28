package db

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A GitHub mirror belongs to its Smithers repository, not to the namespace it
// was imported into: a transfer moves the sync-registry row with the
// repository, so github-sync never addresses a path that no longer exists (or
// that a later repository could claim). The importer's GitHub push credential
// does NOT follow. Transfer revokes the previous owner
// (TestTransferRepo_RevokesThePreviousPersonalOwner), so the moved mirror has
// no binder and outbound sync fails closed (GitHubPushProofNoBinder) until an
// authorized import binds it again. A transfer back to the importer restores
// the binding their own ready import recorded.
func TestTransferRepoMovesMirrorBindingButNotTheImportersCredential(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	importerName := uniqueTestUsername(t)
	importer := mustCreateUser(t, tx, importerName)
	name := uniqueTestRepoName(t)
	repoID := mustCreateRepo(t, tx, importer, name)
	orgName := "org-" + randSlug(t)[:20]
	orgID := mustCreateOrganization(t, tx, orgName)
	sourceOwner := "gh-" + randSlug(t)[:20]

	mustExec(t, tx, `INSERT INTO import_jobs (user_id, repository_id, github_owner, github_repo, repo_owner, repo_name, branch, status)
		VALUES ($1, $2, $3, $4, $5, $4, 'main', 'ready')`, importer, repoID, sourceOwner, name, importerName)
	row, err := q.EnrollGitHubSyncedRepo(ctx, EnrollGitHubSyncedRepoParams{
		OwnerLogin: sourceOwner, RepoName: name, SyncRefs: true, EnrolledVia: "import",
	})
	require.NoError(t, err)
	require.NoError(t, q.SetGitHubSyncedRepoMirror(ctx, SetGitHubSyncedRepoMirrorParams{
		ID: row.ID, MirrorOwner: importerName, MirrorRepo: name,
	}))

	assertBinding := func(wantOwner string, wantBinder int64) {
		t.Helper()
		got, err := q.GetGitHubSyncedRepo(ctx, GetGitHubSyncedRepoParams{OwnerLogin: sourceOwner, RepoName: name})
		require.NoError(t, err)
		assert.Equal(t, wantOwner, got.MirrorOwner.String, "the registry names the repository's current namespace")
		assert.Equal(t, name, got.MirrorRepo.String)

		binders, err := q.ListGitHubSyncedRepoMirrorBinders(ctx)
		require.NoError(t, err)
		bound := map[int64]int64{}
		for _, b := range binders {
			bound[b.SyncedRepoID] = b.UserID
		}
		if wantBinder == 0 {
			_, ok := bound[row.ID]
			assert.False(t, ok, "a transferred mirror keeps no binder: the previous owner's GitHub credential must not push for the new owner")
		} else {
			assert.Equal(t, wantBinder, bound[row.ID], "the importer's own ready import binds the mirror at its namespace")
		}

		sources, err := q.ListRepositoryGitHubSources(ctx, repoID)
		require.NoError(t, err)
		require.Len(t, sources, 1)
		assert.Equal(t, strings.ToLower(sourceOwner), strings.ToLower(sources[0].GithubOwner))
	}
	assertBinding(importerName, importer)

	transfer(t, q, tx, repoID, pgtype.Int8{}, pgtype.Int8{Int64: orgID, Valid: true})
	assertBinding(orgName, 0)

	transfer(t, q, tx, repoID, pgtype.Int8{Int64: importer, Valid: true}, pgtype.Int8{})
	assertBinding(importerName, importer)
}

// Alice imports a mirror and transfers it to Bob. Bob's commits must not be
// pushed to GitHub with Alice's credential: the moved mirror has no binder.
func TestTransferRepoToAnotherUserLeavesTheMirrorUnbound(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	aliceName := uniqueTestUsername(t)
	alice := mustCreateUser(t, tx, aliceName)
	bobName := uniqueTestUsername(t)
	bob := mustCreateUser(t, tx, bobName)
	name := uniqueTestRepoName(t)
	repoID := mustCreateRepo(t, tx, alice, name)
	sourceOwner := "gh-" + randSlug(t)[:20]
	mustExec(t, tx, `INSERT INTO import_jobs (user_id, repository_id, github_owner, github_repo, repo_owner, repo_name, branch, status)
		VALUES ($1, $2, $3, $4, $5, $4, 'main', 'ready')`, alice, repoID, sourceOwner, name, aliceName)
	row, err := q.EnrollGitHubSyncedRepo(ctx, EnrollGitHubSyncedRepoParams{
		OwnerLogin: sourceOwner, RepoName: name, SyncRefs: true, EnrolledVia: "import",
	})
	require.NoError(t, err)
	require.NoError(t, q.SetGitHubSyncedRepoMirror(ctx, SetGitHubSyncedRepoMirrorParams{
		ID: row.ID, MirrorOwner: aliceName, MirrorRepo: name,
	}))

	transfer(t, q, tx, repoID, pgtype.Int8{Int64: bob, Valid: true}, pgtype.Int8{})

	got, err := q.GetGitHubSyncedRepo(ctx, GetGitHubSyncedRepoParams{OwnerLogin: sourceOwner, RepoName: name})
	require.NoError(t, err)
	assert.Equal(t, bobName, got.MirrorOwner.String)
	binders, err := q.ListGitHubSyncedRepoMirrorBinders(ctx)
	require.NoError(t, err)
	for _, b := range binders {
		assert.NotEqual(t, row.ID, b.SyncedRepoID, "no user binds Bob's mirror, least of all Alice")
	}
}

// A binding to a different repository of the same name is not moved.
func TestTransferRepoLeavesOtherMirrorBindingsAlone(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	ownerName := uniqueTestUsername(t)
	owner := mustCreateUser(t, tx, ownerName)
	otherName := uniqueTestUsername(t)
	other := mustCreateUser(t, tx, otherName)
	name := uniqueTestRepoName(t)
	repoID := mustCreateRepo(t, tx, owner, name)
	mustCreateRepo(t, tx, other, name)
	orgID := mustCreateOrganization(t, tx, "org-"+randSlug(t)[:20])

	row, err := q.EnrollGitHubSyncedRepo(ctx, EnrollGitHubSyncedRepoParams{
		OwnerLogin: "gh-" + randSlug(t)[:20], RepoName: name, SyncRefs: true, EnrolledVia: "import",
	})
	require.NoError(t, err)
	require.NoError(t, q.SetGitHubSyncedRepoMirror(ctx, SetGitHubSyncedRepoMirrorParams{
		ID: row.ID, MirrorOwner: otherName, MirrorRepo: name,
	}))

	transfer(t, q, tx, repoID, pgtype.Int8{}, pgtype.Int8{Int64: orgID, Valid: true})
	got, err := q.GetGitHubSyncedRepo(ctx, GetGitHubSyncedRepoParams{OwnerLogin: row.OwnerLogin, RepoName: name})
	require.NoError(t, err)
	assert.Equal(t, otherName, got.MirrorOwner.String)
}

// transfer moves the repository with the production transfer query inside an
// authorized durable storage operation, as the repository service does, so the
// ownership fence admits the update.
func transfer(t *testing.T, q *Queries, tx DBTX, repositoryID int64, targetUser, targetOrg pgtype.Int8) {
	t.Helper()
	ctx := context.Background()
	var name, sourceOwner, targetOwner string
	var sourceUser, sourceOrg pgtype.Int8
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT r.name, COALESCE(u.username, o.name), r.user_id, r.org_id
		FROM repositories r
		LEFT JOIN users u ON u.id = r.user_id
		LEFT JOIN organizations o ON o.id = r.org_id
		WHERE r.id = $1`, repositoryID).Scan(&name, &sourceOwner, &sourceUser, &sourceOrg))
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT COALESCE((SELECT username FROM users WHERE id = $1), (SELECT name FROM organizations WHERE id = $2))`,
		targetUser, targetOrg).Scan(&targetOwner))
	token := newRepositoryStorageOperationToken(t)
	mustExec(t, tx, `
		INSERT INTO repository_storage_operations (
			repository_id, operation_type, token, storage_route_key,
			source_owner, source_repo, source_user_id, source_org_id,
			target_owner, target_repo, target_user_id, target_org_id
		) VALUES ($1, 'move', $2, 's1', $3, $4, $5, $6, $7, $4, $8, $9)`,
		repositoryID, token, sourceOwner, name, sourceUser, sourceOrg, targetOwner, targetUser, targetOrg)
	mustExec(t, tx, `SELECT set_config('smithers.repository_storage_operation_token', $1, TRUE)`, token)
	var err error
	if targetOrg.Valid {
		_, err = q.TransferRepoToOrg(ctx, TransferRepoToOrgParams{NewOrgID: targetOrg, ID: repositoryID})
	} else {
		_, err = q.TransferRepoToUser(ctx, TransferRepoToUserParams{NewUserID: targetUser, ID: repositoryID})
	}
	require.NoError(t, err)
	mustExec(t, tx, `DELETE FROM repository_storage_operations WHERE repository_id = $1 AND token = $2`, repositoryID, token)
}

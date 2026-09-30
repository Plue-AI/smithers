package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// A full sandbox allowance must not fail an import whose repository is already
// mirrored: the workspace start is deferred to when the user opens it.
func TestGitHubImportBoundWorkspaceDefersOnSandboxAllowance(t *testing.T) {
	repository := db.Repository{ID: 42, Name: "demo"}
	for name, refusal := range map[string]error{
		"running sandboxes": pkgerrors.New(pkgerrors.CodePlanLimitExceeded, "Your Pro plan allows 3 running sandboxes. Suspend one to continue."),
		"workspace cap":     pkgerrors.QuotaExceeded("sandbox limit reached"),
	} {
		t.Run(name, func(t *testing.T) {
			svc := NewGitHubImportService(nil, nil, nil, nil, nil, "", WithGitHubImportWorkspaceProvisioner(githubImportCovWorkspaceProvisioner{err: refusal}))
			workspace, err := svc.createBoundWorkspace(context.Background(), 7, repository, "alice", "demo", "main")
			require.NoError(t, err)
			assert.Empty(t, workspace.ID, "no workspace was started")
			assert.Equal(t, "main", workspace.TargetBookmark)
		})
	}

	svc := NewGitHubImportService(nil, nil, nil, nil, nil, "", WithGitHubImportWorkspaceProvisioner(githubImportCovWorkspaceProvisioner{err: pkgerrors.Internal("runtime down")}))
	_, err := svc.createBoundWorkspace(context.Background(), 7, repository, "alice", "demo", "main")
	require.ErrorContains(t, err, "create bound workspace: runtime down", "other failures still fail the import")
}

func TestGitHubImportReadyWithDeferredWorkspaceKeepsNoWorkspace(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	var userID, repoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('importer', 'importer') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name, description, is_public, default_bookmark)
		VALUES ($1, 'demo', 'demo', '', false, 'main') RETURNING id`, userID).Scan(&repoID))
	const claim = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	insertJob := func(claimToken any) string {
		var id string
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO import_jobs
			(user_id, github_owner, github_repo, repo_owner, repo_name, branch, status, claim_token, claimed_at)
			VALUES ($1, 'alice', 'demo', 'importer', 'demo', 'main', 'cloning', $2, NOW()) RETURNING id`,
			userID, claimToken).Scan(&id))
		return id
	}
	repository := db.Repository{ID: repoID, Name: "demo"}
	deferred := WorkspaceResponse{TargetBookmark: "main"}
	svc := &GitHubImportService{pool: pool, db: pool}

	durable := insertJob(claim)
	require.NoError(t, svc.markDurableImportReady(ctx, claimedGitHubImportJob{ID: durable, ClaimToken: claim, UserID: userID}, repository, deferred))
	direct := insertJob(nil)
	_, err := svc.scanImportJob(pool.QueryRow(ctx, markImportJobReadySQL, direct, repoID, deferred.ID, deferred.TargetBookmark, repository.Name))
	require.NoError(t, err)

	for _, id := range []string{durable, direct} {
		var status, bookmark string
		var workspaceID pgtype.UUID
		var gotRepo int64
		require.NoError(t, pool.QueryRow(ctx, `SELECT status, workspace_id, target_bookmark, repository_id FROM import_jobs WHERE id = $1`, id).
			Scan(&status, &workspaceID, &bookmark, &gotRepo))
		assert.Equal(t, "ready", status, "the imported repository is ready")
		assert.False(t, workspaceID.Valid, "no workspace is recorded until one starts")
		assert.Equal(t, "main", bookmark)
		assert.Equal(t, repoID, gotRepo)
	}
}

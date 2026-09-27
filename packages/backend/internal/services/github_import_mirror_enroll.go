package services

import (
	"context"
	"log/slog"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// MirrorEnrolledGitHubRepo creates (or refreshes) the jjhub-side git mirror for a
// repository enrolled in github_synced_repos, WITHOUT the workspace-provisioning
// half of a real import. It is the import flow's own clone → repo-host push →
// ImportRefs path (refreshMirrorFromGitHub), reused so enrolled repos get ref
// mirroring by default and github-sync's mirror mode has something to keep
// current from push webhooks.
//
// Returns the local owner/name the mirror landed under, which the caller records
// on the registry row. It implements GitHubSyncedRepoMirrorer.
func (s *GitHubImportService) MirrorEnrolledGitHubRepo(ctx context.Context, userID int64, owner, repo string) (string, string, error) {
	if s == nil || s.repoHost == nil || s.repoDB == nil {
		return "", "", pkgerrors.Internal("github import service unavailable")
	}

	localOwner, err := s.resolveLocalOwner(ctx, userID)
	if err != nil {
		return "", "", err
	}

	githubCloneToken, private, defaultBranch, err := s.githubCloneInfoForRepo(ctx, userID, owner, repo)
	if err != nil {
		return "", "", err
	}
	// A public repo clones anonymously; spending the user's token on it would
	// burn rate limit the metadata proxy needs.
	if !private {
		githubCloneToken = ""
	}
	if defaultBranch == "" {
		defaultBranch = "main"
	}

	// Reuses the mirror when one already exists for this GitHub source (#47
	// provenance), so re-mirroring an enrolled repo is idempotent rather than
	// creating a second deduped copy per sync.
	repository, _, err := s.ensureLocalRepo(ctx, userID, localOwner, owner, repo, defaultBranch)
	if err != nil {
		return "", "", err
	}

	// jobID is empty: this is not an import job, so there is no stage row to
	// write. setStage tolerates the miss and only logs.
	if err := s.refreshMirrorFromGitHub(ctx, userID, repository.ID, owner, repo, localOwner, repository.Name, "", githubCloneToken); err != nil {
		return "", "", err
	}
	slog.Info("mirror.enrolled.ok",
		"github_owner", owner, "github_repo", repo,
		"repo_owner", localOwner, "repo_name", repository.Name)
	return localOwner, repository.Name, nil
}

// EnrollImportedGitHubRepo adds a just-imported GitHub source to the sync
// registry (spec §1a). Best-effort: an import must never fail because the
// registry was briefly unavailable. The mirror it just created becomes the
// repo github-sync pushes to GitHub only when userID can push to the GitHub
// repo (BindMirror); an importer who can only read it gets a private copy and
// leaves the existing binding alone.
func (s *GitHubImportService) EnrollImportedGitHubRepo(ctx context.Context, userID int64, githubOwner, githubRepo, mirrorOwner, mirrorRepo string) {
	if s == nil || s.syncedRepos == nil {
		return
	}
	row, err := s.syncedRepos.EnrollGitHubRepo(ctx, EnrollGitHubRepoInput{
		Owner:       githubOwner,
		Repo:        githubRepo,
		EnrolledVia: GitHubSyncedRepoEnrolledViaImport,
	})
	if err != nil {
		slog.Warn("github synced repo import enrollment failed",
			"github_owner", githubOwner, "github_repo", githubRepo, "error", err)
		return
	}
	if mirrorOwner == "" || mirrorRepo == "" {
		return
	}
	if err := s.syncedRepos.BindMirror(ctx, userID, row, mirrorOwner, mirrorRepo); err != nil {
		slog.Warn("github synced repo import mirror not recorded",
			"github_owner", githubOwner, "github_repo", githubRepo, "error", err)
	}
}

package services

import (
	"context"
	stdErrors "errors"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/smithersai/smithers/packages/backend/internal/githubrepo"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const upsertRepoConnectionSQL = `
INSERT INTO repo_connections (
	user_id,
	repo_owner,
	repo_name,
	repo_owner_lower,
	repo_name_lower,
	license_spdx_id,
	github_repository_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (user_id, repo_owner_lower, repo_name_lower)
DO UPDATE SET
	repo_owner = EXCLUDED.repo_owner,
	repo_name = EXCLUDED.repo_name,
	license_spdx_id = EXCLUDED.license_spdx_id,
	github_repository_id = EXCLUDED.github_repository_id,
	updated_at = NOW()
RETURNING user_id, repo_owner, repo_name, license_spdx_id, created_at, updated_at;
`

const deleteRepoConnectionSQL = `
DELETE FROM repo_connections
WHERE user_id = $1
  AND repo_owner_lower = $2
  AND repo_name_lower = $3;
`

const getRepoConnectionSQL = `
SELECT user_id, repo_owner, repo_name, license_spdx_id, created_at, updated_at
FROM repo_connections
WHERE user_id = $1
  AND repo_owner_lower = $2
  AND repo_name_lower = $3;
`

type RepoConnectionDB interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type RepoConnection struct {
	UserID       int64     `json:"user_id"`
	Owner        string    `json:"owner"`
	Repo         string    `json:"repo"`
	LicenseSPDX  string    `json:"license_spdx_id"`
	ConnectedAt  time.Time `json:"connected_at"`
	LastSyncedAt time.Time `json:"last_synced_at"`
}

type RepoConnectionStatus struct {
	Connected   bool   `json:"connected"`
	LicenseSPDX string `json:"license_spdx_id,omitempty"`
	Owner       string `json:"owner,omitempty"`
	Repo        string `json:"repo,omitempty"`
}

// GitHubRepoAccessVerifier proves the caller's own GitHub identity can push to
// the GitHub repository being connected and returns that repository's
// immutable id. Implemented by *GitHubUserReposService.
type GitHubRepoAccessVerifier interface {
	VerifyUserCanPushToGitHubRepo(ctx context.Context, userID int64, owner string, repo string) (int64, error)
}

type RepoConnectionService struct {
	db                   RepoConnectionDB
	githubAppCredentials GitHubAppCredentialReader
	gitHubBudgetTracker  *BudgetTracker
	githubAccessVerifier GitHubRepoAccessVerifier

	// importedSourcePublic remembers, per "owner/repo", until when GitHub last
	// confirmed an imported source is public.
	importedSourceMu     sync.Mutex
	importedSourcePublic map[string]time.Time
}

func NewRepoConnectionService(db RepoConnectionDB, credentials ...GitHubAppCredentialReader) *RepoConnectionService {
	s := &RepoConnectionService{db: db}
	if len(credentials) > 0 {
		s.githubAppCredentials = credentials[0]
	}
	return s
}

func (s *RepoConnectionService) SetGitHubBudgetTracker(tracker *BudgetTracker) {
	if s != nil {
		s.gitHubBudgetTracker = tracker
	}
}

// SetGitHubRepoAccessVerifier wires GitHub-side access verification for
// ConnectRepo. Connecting is the trust boundary for GitHub App installation
// tokens, so without a verifier ConnectRepo fails closed.
func (s *RepoConnectionService) SetGitHubRepoAccessVerifier(verifier GitHubRepoAccessVerifier) {
	if s != nil {
		s.githubAccessVerifier = verifier
	}
}

func (s *RepoConnectionService) ConnectRepo(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
	licenseSPDX string,
) (RepoConnection, error) {
	if userID <= 0 {
		return RepoConnection{}, pkgerrors.Unauthorized("authentication required")
	}

	normalizedOwner, normalizedRepo, err := normalizeRepoRef(owner, repo)
	if err != nil {
		return RepoConnection{}, err
	}
	trimmedLicense := strings.TrimSpace(licenseSPDX)
	if trimmedLicense == "" {
		return RepoConnection{}, pkgerrors.BadRequest("license_spdx_id is required")
	}

	// repo_connections is the trust boundary for GitHub App installation
	// tokens (installation lookups join it), so a row must never be created
	// from unverified owner/repo strings: prove the caller's own GitHub
	// identity can push to the repository first, and fail closed when no
	// verifier is wired.
	if s.githubAccessVerifier == nil {
		return RepoConnection{}, pkgerrors.Internal("github repository access verification is not configured")
	}
	repositoryID, err := s.githubAccessVerifier.VerifyUserCanPushToGitHubRepo(ctx, userID, normalizedOwner, normalizedRepo)
	if err != nil {
		return RepoConnection{}, err
	}
	if repositoryID <= 0 {
		return RepoConnection{}, pkgerrors.Internal("github did not identify the repository")
	}

	var connection RepoConnection
	scanErr := s.db.QueryRow(
		ctx,
		upsertRepoConnectionSQL,
		userID,
		strings.TrimSpace(owner),
		strings.TrimSpace(repo),
		normalizedOwner,
		normalizedRepo,
		trimmedLicense,
		repositoryID,
	).Scan(
		&connection.UserID,
		&connection.Owner,
		&connection.Repo,
		&connection.LicenseSPDX,
		&connection.ConnectedAt,
		&connection.LastSyncedAt,
	)
	if scanErr != nil {
		return RepoConnection{}, pkgerrors.Internal("failed to persist repo connection").WithCause(scanErr)
	}

	return connection, nil
}

func (s *RepoConnectionService) DisconnectRepo(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
) (bool, error) {
	if userID <= 0 {
		return false, pkgerrors.Unauthorized("authentication required")
	}

	normalizedOwner, normalizedRepo, err := normalizeRepoRef(owner, repo)
	if err != nil {
		return false, err
	}

	tag, execErr := s.db.Exec(ctx, deleteRepoConnectionSQL, userID, normalizedOwner, normalizedRepo)
	if execErr != nil {
		return false, pkgerrors.Internal("failed to remove repo connection").WithCause(execErr)
	}

	return tag.RowsAffected() > 0, nil
}

func (s *RepoConnectionService) GetRepoConnectionStatus(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
) (RepoConnectionStatus, error) {
	if userID <= 0 {
		return RepoConnectionStatus{}, pkgerrors.Unauthorized("authentication required")
	}

	normalizedOwner, normalizedRepo, err := normalizeRepoRef(owner, repo)
	if err != nil {
		return RepoConnectionStatus{}, err
	}

	var connection RepoConnection
	scanErr := s.db.QueryRow(
		ctx,
		getRepoConnectionSQL,
		userID,
		normalizedOwner,
		normalizedRepo,
	).Scan(
		&connection.UserID,
		&connection.Owner,
		&connection.Repo,
		&connection.LicenseSPDX,
		&connection.ConnectedAt,
		&connection.LastSyncedAt,
	)
	if scanErr != nil {
		if stdErrors.Is(scanErr, pgx.ErrNoRows) {
			return RepoConnectionStatus{
				Connected: false,
				Owner:     strings.TrimSpace(owner),
				Repo:      strings.TrimSpace(repo),
			}, nil
		}
		return RepoConnectionStatus{}, pkgerrors.Internal("failed to load repo connection").WithCause(scanErr)
	}

	return RepoConnectionStatus{
		Connected:   true,
		LicenseSPDX: connection.LicenseSPDX,
		Owner:       connection.Owner,
		Repo:        connection.Repo,
	}, nil
}

func normalizeRepoRef(owner string, repo string) (string, string, error) {
	normalizedOwner, normalizedRepo, err := githubrepo.NormalizeRef(owner, repo)
	if err != nil {
		return "", "", pkgerrors.BadRequest(err.Error())
	}
	return normalizedOwner, normalizedRepo, nil
}

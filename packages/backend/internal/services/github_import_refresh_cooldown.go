package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// A GitHub mirror is cloned from GitHub at most once per cooldown window,
// whichever user, job or replica imports it (#2970). A re-import inside the
// window reuses the mirror as it is and still gets its bookmark and workspace.
// The window starts only when a clone succeeds: a failed refresh leaves the
// last success in place, so the next import retries at once. A refresh in
// flight holds a lease, so concurrent imports of one mirror clone it once.

// envGitHubImportRefreshCooldown sets the window as a Go duration; 0 lets
// every import refresh, one at a time per mirror.
const envGitHubImportRefreshCooldown = "SMITHERS_GITHUB_IMPORT_REFRESH_COOLDOWN"

const defaultGitHubMirrorRefreshCooldown = 10 * time.Minute

// githubMirrorRefreshLease bounds a refresh claim whose holder died; it
// outlasts any refresh a live import runs.
const githubMirrorRefreshLease = 30 * time.Minute

const (
	// claimGitHubMirrorRefreshSQL takes the refresh lease when the last
	// successful refresh is older than the window ($3 seconds) and no live
	// lease exists. No row means the refresh is skipped.
	claimGitHubMirrorRefreshSQL = `
INSERT INTO github_mirror_refreshes (repository_id, claim_token, claim_expires_at)
VALUES ($1, $2, NOW() + make_interval(secs => $4::double precision))
ON CONFLICT (repository_id) DO UPDATE
SET claim_token = EXCLUDED.claim_token, claim_expires_at = EXCLUDED.claim_expires_at
WHERE (github_mirror_refreshes.refreshed_at IS NULL
       OR github_mirror_refreshes.refreshed_at <= NOW() - make_interval(secs => $3::double precision))
  AND (github_mirror_refreshes.claim_expires_at IS NULL OR github_mirror_refreshes.claim_expires_at <= NOW())
RETURNING repository_id`

	// completeGitHubMirrorRefreshSQL starts the window and ends the lease $2.
	completeGitHubMirrorRefreshSQL = `
UPDATE github_mirror_refreshes
SET refreshed_at = NOW(), claim_token = NULL, claim_expires_at = NULL
WHERE repository_id = $1 AND claim_token = $2
RETURNING repository_id`

	// releaseGitHubMirrorRefreshSQL ends the lease $2 of a failed refresh
	// without starting the window.
	releaseGitHubMirrorRefreshSQL = `
UPDATE github_mirror_refreshes
SET claim_token = NULL, claim_expires_at = NULL
WHERE repository_id = $1 AND claim_token = $2
RETURNING repository_id`

	// recordGitHubMirrorClonedSQL starts the window for a mirror a fresh
	// import just cloned.
	recordGitHubMirrorClonedSQL = `
INSERT INTO github_mirror_refreshes (repository_id, refreshed_at)
VALUES ($1, NOW())
ON CONFLICT (repository_id) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at
RETURNING repository_id`
)

// githubMirrorRefreshCooldown is the configured window. An unparsable or
// negative value logs and keeps the default.
func githubMirrorRefreshCooldown() time.Duration {
	raw := strings.TrimSpace(os.Getenv(envGitHubImportRefreshCooldown))
	if raw == "" {
		return defaultGitHubMirrorRefreshCooldown
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil || parsed < 0 {
		slog.Warn("invalid "+envGitHubImportRefreshCooldown+"; using the default",
			"value", raw, "default", defaultGitHubMirrorRefreshCooldown.String())
		return defaultGitHubMirrorRefreshCooldown
	}
	return parsed
}

// claimMirrorRefresh reports whether this import may clone repositoryID from
// GitHub, and the lease to settle when it may. When the ledger cannot be read
// the refresh is skipped: the mirror is served as it is, as for any refresh
// failure, rather than cloning without a bound. A service without a job
// database (setStage) keeps no ledger and always refreshes.
func (s *GitHubImportService) claimMirrorRefresh(ctx context.Context, repositoryID int64, jobID string) (string, bool) {
	if s.db == nil {
		return "", true
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		slog.Warn("mirror.reuse.refresh_claim_failed", "import_job_id", jobID, "repo_id", repositoryID, "error", err)
		return "", false
	}
	token := hex.EncodeToString(raw[:])
	var claimed int64
	err := s.db.QueryRow(ctx, claimGitHubMirrorRefreshSQL, repositoryID, token,
		s.refreshCooldown.Seconds(), githubMirrorRefreshLease.Seconds()).Scan(&claimed)
	if errors.Is(err, pgx.ErrNoRows) {
		slog.Info("mirror.reuse.refresh_cooldown", "import_job_id", jobID, "repo_id", repositoryID)
		return "", false
	}
	if err != nil {
		slog.Warn("mirror.reuse.refresh_claim_failed", "import_job_id", jobID, "repo_id", repositoryID, "error", err)
		return "", false
	}
	return token, true
}

// settleMirrorRefresh ends the lease token: a success starts the window, a
// failure does not. It outlives a cancelled import so the lease is not left
// to expire.
func (s *GitHubImportService) settleMirrorRefresh(ctx context.Context, repositoryID int64, token string, refreshed bool) {
	if s.db == nil {
		return
	}
	sql := releaseGitHubMirrorRefreshSQL
	if refreshed {
		sql = completeGitHubMirrorRefreshSQL
	}
	settleCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), repoProvisionDBCleanupTimeout)
	defer cancel()
	var settled int64
	if err := s.db.QueryRow(settleCtx, sql, repositoryID, token).Scan(&settled); err != nil {
		slog.Warn("mirror.reuse.refresh_settle_failed", "repo_id", repositoryID, "refreshed", refreshed, "error", err)
	}
}

// recordMirrorCloned starts the window of a mirror a fresh import cloned. A
// failure only lets the next import refresh early.
func (s *GitHubImportService) recordMirrorCloned(ctx context.Context, repositoryID int64) {
	if s.db == nil {
		return
	}
	var recorded int64
	if err := s.db.QueryRow(ctx, recordGitHubMirrorClonedSQL, repositoryID).Scan(&recorded); err != nil {
		slog.Warn("mirror.import.refresh_record_failed", "repo_id", repositoryID, "error", err)
	}
}

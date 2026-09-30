package services

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const upsertGitHubAppInstallationSQL = `
INSERT INTO github_app_installations (
	installation_id,
	account_login,
	account_type,
	repository_selection
)
VALUES ($1, $2, $3, $4)
ON CONFLICT (installation_id)
DO UPDATE SET
	account_login = EXCLUDED.account_login,
	account_type = EXCLUDED.account_type,
	repository_selection = EXCLUDED.repository_selection,
	updated_at = NOW();
`

const deleteGitHubAppInstallationSQL = `
DELETE FROM github_app_installations
WHERE installation_id = $1;
`

const deleteGitHubAppInstallationRepositoriesSQL = `
DELETE FROM github_app_installation_repositories
WHERE installation_id = $1;
`

const upsertGitHubAppInstallationRepositorySQL = `
INSERT INTO github_app_installation_repositories (
	installation_id,
	github_repository_id,
	owner_login,
	owner_login_lower,
	repo_name,
	repo_name_lower,
	is_private
)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (installation_id, github_repository_id)
DO UPDATE SET
	owner_login = EXCLUDED.owner_login,
	owner_login_lower = EXCLUDED.owner_login_lower,
	repo_name = EXCLUDED.repo_name,
	repo_name_lower = EXCLUDED.repo_name_lower,
	is_private = EXCLUDED.is_private,
	updated_at = NOW();
`

const deleteGitHubAppInstallationRepositorySQL = `
DELETE FROM github_app_installation_repositories
WHERE installation_id = $1
  AND github_repository_id = $2;
`

const enqueueGitHubWebhookJobSQL = `
INSERT INTO github_webhook_jobs (
	delivery_id,
	event_type,
	action,
	installation_id,
	github_repository_id,
	payload
)
VALUES ($1, $2, $3, $4, $5, $6::jsonb)
ON CONFLICT (delivery_id) DO NOTHING;
`

var supportedGitHubWebhookEvents = map[string]struct{}{
	"push":                      {},
	"issues":                    {},
	"issue_comment":             {},
	"pull_request":              {},
	"pull_request_review":       {},
	"check_suite":               {},
	"check_run":                 {},
	"installation":              {},
	"installation_repositories": {},
}

type GitHubWebhookDB interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

// gitHubWebhookExecer is the subset of database operations shared by both the
// connection pool and an active transaction, so the upsert helpers can run
// against either without changing their signatures per caller.
type gitHubWebhookExecer interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

// gitHubWebhookTxBeginner is implemented by transaction-capable backends (e.g.
// *pgxpool.Pool). The webhook DB interface only requires Exec, so we probe for
// this optionally to keep multi-statement updates atomic when available.
type gitHubWebhookTxBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

type GitHubWebhookService struct {
	db            GitHubWebhookDB
	webhookSecret string
	// syncedRepos keeps the continuously-synced metadata store current from the
	// deliveries this service already receives. Optional: nil keeps the
	// pre-mirror behavior (enqueue + installation bookkeeping only).
	syncedRepos *GitHubSyncedRepoService
}

type GitHubWebhookOption func(*GitHubWebhookService)

// WithGitHubWebhookSyncedRepos wires the sync registry + metadata store, so
// issues / issue_comment / pull_request deliveries keep the proxy's store fresh
// and installation events enroll the repos they grant access to.
func WithGitHubWebhookSyncedRepos(syncedRepos *GitHubSyncedRepoService) GitHubWebhookOption {
	return func(s *GitHubWebhookService) { s.syncedRepos = syncedRepos }
}

type gitHubWebhookEnvelope struct {
	Action              string                     `json:"action"`
	Installation        *gitHubWebhookInstallation `json:"installation"`
	Repository          *gitHubWebhookRepository   `json:"repository"`
	Repositories        []gitHubWebhookRepository  `json:"repositories"`
	RepositoriesAdded   []gitHubWebhookRepository  `json:"repositories_added"`
	RepositoriesRemoved []gitHubWebhookRepository  `json:"repositories_removed"`

	// Raw GitHub objects, kept as bytes so the metadata store persists exactly
	// what GitHub sent (the proxy serves those bytes back verbatim).
	Issue       json.RawMessage `json:"issue"`
	PullRequest json.RawMessage `json:"pull_request"`
	Comment     json.RawMessage `json:"comment"`
}

type gitHubWebhookInstallation struct {
	ID                  int64                    `json:"id"`
	RepositorySelection string                   `json:"repository_selection"`
	Account             gitHubWebhookAccountInfo `json:"account"`
}

type gitHubWebhookAccountInfo struct {
	Login string `json:"login"`
	Type  string `json:"type"`
}

type gitHubWebhookRepository struct {
	ID       int64                  `json:"id"`
	Name     string                 `json:"name"`
	FullName string                 `json:"full_name"`
	Private  bool                   `json:"private"`
	Owner    gitHubWebhookRepoOwner `json:"owner"`
}

type gitHubWebhookRepoOwner struct {
	Login string `json:"login"`
}

func NewGitHubWebhookService(db GitHubWebhookDB, webhookSecret string, opts ...GitHubWebhookOption) *GitHubWebhookService {
	s := &GitHubWebhookService{
		db:            db,
		webhookSecret: strings.TrimSpace(webhookSecret),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// gitHubWebhookDedupNamespace is the fixed UUIDv5 namespace used to derive the
// replay-dedup key for a delivery from its HMAC-signed body.
var gitHubWebhookDedupNamespace = uuid.MustParse("40f4316b-6863-4d3d-a1a4-2f4f2fd0c8d0")

func (s *GitHubWebhookService) HandleGitHubWebhook(ctx context.Context, deliveryID, eventType, signature string, payload []byte) error {
	if s == nil || s.db == nil {
		return pkgerrors.Internal("github webhook service is not configured")
	}
	if s.webhookSecret == "" {
		return pkgerrors.Internal("github webhook secret is not configured")
	}
	if !verifyGitHubWebhookSignature(payload, signature, s.webhookSecret) {
		return pkgerrors.Unauthorized("invalid github webhook signature")
	}

	normalizedEvent := strings.ToLower(strings.TrimSpace(eventType))
	if normalizedEvent == "" {
		return pkgerrors.BadRequest("missing github event header")
	}
	if _, ok := supportedGitHubWebhookEvents[normalizedEvent]; !ok {
		return nil
	}

	if _, err := uuid.Parse(strings.TrimSpace(deliveryID)); err != nil {
		return pkgerrors.BadRequest("invalid github delivery id")
	}

	var envelope gitHubWebhookEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return pkgerrors.BadRequest("invalid github webhook payload")
	}

	action := strings.ToLower(strings.TrimSpace(envelope.Action))
	installationID := envelope.installationID()

	// The replay/dedup key is derived from the HMAC-signed body, not from the
	// unsigned X-GitHub-Delivery header: replaying a captured signed payload
	// under a fresh delivery id must still be detected as a duplicate. The
	// guard row is inserted BEFORE any installation side effect and in the
	// same transaction, so a duplicate delivery short-circuits without
	// mutating installation state, while a failed delivery leaves no guard
	// row behind (GitHub's redelivery re-runs the whole thing).
	dedupKey := uuid.NewSHA1(gitHubWebhookDedupNamespace, payload)

	apply := func(execer gitHubWebhookExecer) (bool, error) {
		tag, err := execer.Exec(
			ctx,
			enqueueGitHubWebhookJobSQL,
			dedupKey,
			normalizedEvent,
			action,
			nullableInt64(installationID),
			nullableInt64(envelope.repositoryID()),
			string(payload),
		)
		if err != nil {
			return false, pkgerrors.Internal("failed to enqueue github webhook event").WithCause(err)
		}
		if tag.RowsAffected() == 0 {
			// Duplicate/replayed delivery: already processed, skip side effects.
			return false, nil
		}

		switch normalizedEvent {
		case "installation":
			if err := s.handleInstallationEvent(ctx, execer, action, envelope); err != nil {
				return false, err
			}
		case "installation_repositories":
			if err := s.handleInstallationRepositoriesEvent(ctx, execer, action, envelope); err != nil {
				return false, err
			}
		}
		return true, nil
	}

	beginner, ok := s.db.(gitHubWebhookTxBeginner)
	if !ok {
		inserted, err := apply(s.db)
		if err != nil || !inserted {
			return err
		}
		s.applySyncedRepoEvent(ctx, normalizedEvent, action, envelope)
		return nil
	}

	tx, err := beginner.Begin(ctx)
	if err != nil {
		return pkgerrors.Internal("failed to begin github webhook transaction").WithCause(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	inserted, err := apply(tx)
	if err != nil {
		return err
	}
	if !inserted {
		return nil
	}
	if err := tx.Commit(ctx); err != nil {
		return pkgerrors.Internal("failed to commit github webhook transaction").WithCause(err)
	}
	// Metadata-store updates run AFTER the commit, outside the delivery
	// transaction: they must never roll back the installation bookkeeping (or
	// the dedup guard) when the store is briefly unavailable. A delivery lost in
	// that crash window is recovered by the staleness-driven backfill, which is
	// exactly the degradation the spec asks for.
	s.applySyncedRepoEvent(ctx, normalizedEvent, action, envelope)
	return nil
}

// applySyncedRepoEvent keeps the continuously-synced metadata store fresh from
// the delivery just accepted, and enrolls repos an installation grants access
// to. Best-effort: a store failure is logged, never surfaced to GitHub — the
// delivery WAS accepted, and re-delivering it would only re-hit the same store.
func (s *GitHubWebhookService) applySyncedRepoEvent(ctx context.Context, event, action string, envelope gitHubWebhookEnvelope) {
	if s.syncedRepos == nil {
		return
	}

	switch event {
	case "installation", "installation_repositories":
		// A SmithersPreviewRelease installation granting access to a repo is one
		// of the three enrollment triggers (spec §1b).
		if action == "deleted" || action == "removed" {
			return
		}
		granted := envelope.Repositories
		granted = append(granted, envelope.RepositoriesAdded...)
		for _, repository := range granted {
			owner, name := gitHubWebhookRepoSlug(repository)
			if owner == "" || name == "" {
				continue
			}
			if _, err := s.syncedRepos.EnrollGitHubRepo(ctx, EnrollGitHubRepoInput{
				Owner:              owner,
				Repo:               name,
				InstallationID:     envelope.installationID(),
				GitHubRepositoryID: repository.ID,
				EnrolledVia:        GitHubSyncedRepoEnrolledViaInstallation,
			}); err != nil {
				slog.Warn("github synced repo installation enrollment failed",
					"owner", owner, "repo", name, "error", err)
			}
		}
		return
	}

	if envelope.Repository == nil {
		return
	}
	owner, name := gitHubWebhookRepoSlug(*envelope.Repository)
	if owner == "" || name == "" {
		return
	}

	repoID := envelope.repositoryID()
	var err error
	switch event {
	case "issues":
		err = s.syncedRepos.ApplyIssueEvent(ctx, owner, name, repoID, GitHubRepoMetadataIssues, action, envelope.Issue)
	case "pull_request":
		err = s.syncedRepos.ApplyIssueEvent(ctx, owner, name, repoID, GitHubRepoMetadataPulls, action, envelope.PullRequest)
	case "issue_comment":
		err = s.syncedRepos.ApplyIssueCommentEvent(ctx, owner, name, repoID, action, envelope.Issue, envelope.Comment)
	default:
		// push / check_* only prove deliveries are still arriving.
		err = s.syncedRepos.TouchWebhook(ctx, owner, name, repoID)
	}
	if err != nil {
		slog.Warn("github synced metadata webhook apply failed",
			"event", event, "action", action, "owner", owner, "repo", name, "error", err)
	}
}

// gitHubWebhookRepoSlug resolves owner/name from a webhook repository object,
// falling back to full_name exactly like upsertInstallationRepository does.
func gitHubWebhookRepoSlug(repository gitHubWebhookRepository) (string, string) {
	owner := strings.TrimSpace(repository.Owner.Login)
	name := strings.TrimSpace(repository.Name)
	if (owner == "" || name == "") && strings.Contains(repository.FullName, "/") {
		parts := strings.SplitN(strings.TrimSpace(repository.FullName), "/", 2)
		if owner == "" {
			owner = strings.TrimSpace(parts[0])
		}
		if name == "" {
			name = strings.TrimSpace(parts[1])
		}
	}
	return owner, name
}

func (s *GitHubWebhookService) handleInstallationEvent(ctx context.Context, execer gitHubWebhookExecer, action string, envelope gitHubWebhookEnvelope) error {
	installationID := envelope.installationID()
	if installationID <= 0 {
		return pkgerrors.BadRequest("installation.id is required")
	}

	// Any installation lifecycle event (created, deleted, suspend, unsuspend,
	// new_permissions_accepted) can invalidate a cached installation token, so
	// drop it on the pod that received this webhook. This only clears THIS
	// process; other replicas self-heal via the consumer-side 401 eviction on
	// the repo-list/proxy paths. On "created" it is a harmless no-op re-mint.
	invalidateCachedInstallationToken(installationID)

	switch action {
	case "created":
		return s.replaceInstallationRepositories(ctx, execer, installationID, envelope)
	case "deleted":
		if _, err := execer.Exec(ctx, deleteGitHubAppInstallationSQL, installationID); err != nil {
			return pkgerrors.Internal("failed to delete installation mapping").WithCause(err)
		}
	default:
		// Other installation actions are acknowledged and only enqueued.
	}

	return nil
}

// replaceInstallationRepositories persists the installation mapping and
// replaces its repository set. The upsert + delete-all + re-insert sequence
// must be atomic — HandleGitHubWebhook runs it inside the per-delivery
// transaction when the backend supports one.
func (s *GitHubWebhookService) replaceInstallationRepositories(ctx context.Context, execer gitHubWebhookExecer, installationID int64, envelope gitHubWebhookEnvelope) error {
	if err := s.upsertInstallation(ctx, execer, installationID, envelope); err != nil {
		return err
	}
	if _, err := execer.Exec(ctx, deleteGitHubAppInstallationRepositoriesSQL, installationID); err != nil {
		return pkgerrors.Internal("failed to reset installation repositories").WithCause(err)
	}
	for _, repository := range envelope.Repositories {
		if err := s.upsertInstallationRepository(ctx, execer, installationID, repository); err != nil {
			return err
		}
	}
	return nil
}

func (s *GitHubWebhookService) handleInstallationRepositoriesEvent(ctx context.Context, execer gitHubWebhookExecer, action string, envelope gitHubWebhookEnvelope) error {
	installationID := envelope.installationID()
	if installationID <= 0 {
		return pkgerrors.BadRequest("installation.id is required")
	}

	// Installation tokens are repository-scoped at issuance: a token minted
	// before a repo was added to (or removed from) the installation keeps the
	// old grant set for up to an hour. Evict the cached token so the next mint
	// reflects the updated repository set instead of serving stale scope
	// (403/404s on newly added repos that the consumer-side 401 eviction never
	// self-heals).
	invalidateCachedInstallationToken(installationID)

	switch action {
	case "added":
		if err := s.upsertInstallation(ctx, execer, installationID, envelope); err != nil {
			return err
		}
		for _, repository := range envelope.RepositoriesAdded {
			if err := s.upsertInstallationRepository(ctx, execer, installationID, repository); err != nil {
				return err
			}
		}
	case "removed":
		for _, repository := range envelope.RepositoriesRemoved {
			if repository.ID <= 0 {
				continue
			}
			if _, err := execer.Exec(ctx, deleteGitHubAppInstallationRepositorySQL, installationID, repository.ID); err != nil {
				return pkgerrors.Internal("failed to remove installation repository mapping").WithCause(err)
			}
		}
	default:
		// Other installation_repositories actions are acknowledged and only enqueued.
	}

	return nil
}

func (s *GitHubWebhookService) upsertInstallation(ctx context.Context, execer gitHubWebhookExecer, installationID int64, envelope gitHubWebhookEnvelope) error {
	installation := envelope.Installation
	if installation == nil {
		return pkgerrors.BadRequest("installation is required")
	}
	if _, err := execer.Exec(
		ctx,
		upsertGitHubAppInstallationSQL,
		installationID,
		strings.TrimSpace(installation.Account.Login),
		strings.TrimSpace(installation.Account.Type),
		strings.TrimSpace(installation.RepositorySelection),
	); err != nil {
		return pkgerrors.Internal("failed to persist installation mapping").WithCause(err)
	}
	return nil
}

func (s *GitHubWebhookService) upsertInstallationRepository(ctx context.Context, execer gitHubWebhookExecer, installationID int64, repository gitHubWebhookRepository) error {
	if repository.ID <= 0 {
		return nil
	}

	ownerLogin := strings.TrimSpace(repository.Owner.Login)
	repoName := strings.TrimSpace(repository.Name)
	if (ownerLogin == "" || repoName == "") && strings.Contains(repository.FullName, "/") {
		parts := strings.SplitN(strings.TrimSpace(repository.FullName), "/", 2)
		if ownerLogin == "" {
			ownerLogin = strings.TrimSpace(parts[0])
		}
		if repoName == "" {
			repoName = strings.TrimSpace(parts[1])
		}
	}
	if ownerLogin == "" || repoName == "" {
		return nil
	}

	if _, err := execer.Exec(
		ctx,
		upsertGitHubAppInstallationRepositorySQL,
		installationID,
		repository.ID,
		ownerLogin,
		strings.ToLower(ownerLogin),
		repoName,
		strings.ToLower(repoName),
		repository.Private,
	); err != nil {
		return pkgerrors.Internal("failed to persist installation repository mapping").WithCause(err)
	}
	return nil
}

func (e gitHubWebhookEnvelope) installationID() int64 {
	if e.Installation == nil {
		return 0
	}
	return e.Installation.ID
}

func (e gitHubWebhookEnvelope) repositoryID() int64 {
	if e.Repository == nil {
		return 0
	}
	return e.Repository.ID
}

func verifyGitHubWebhookSignature(payload []byte, signatureHeader, secret string) bool {
	signatureHeader = strings.TrimSpace(signatureHeader)
	secret = strings.TrimSpace(secret)
	if signatureHeader == "" || secret == "" {
		return false
	}

	parts := strings.SplitN(signatureHeader, "=", 2)
	if len(parts) != 2 || !strings.EqualFold(strings.TrimSpace(parts[0]), "sha256") {
		return false
	}

	providedSignature, err := hex.DecodeString(strings.TrimSpace(parts[1]))
	if err != nil {
		return false
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	expectedSignature := mac.Sum(nil)

	return hmac.Equal(expectedSignature, providedSignature)
}

func nullableInt64(value int64) any {
	if value <= 0 {
		return nil
	}
	return value
}

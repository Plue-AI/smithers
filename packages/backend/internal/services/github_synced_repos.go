package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	// GitHubSyncedRepoEnrolledViaImport / Installation / Lazy are the three ways
	// a repository enters the registry (see the spec's §1).
	GitHubSyncedRepoEnrolledViaImport       = "import"
	GitHubSyncedRepoEnrolledViaInstallation = "installation"
	GitHubSyncedRepoEnrolledViaLazy         = "lazy"

	// githubSyncedRepoWebhookFreshness is how long a webhook heartbeat keeps the
	// store fresh WITHOUT any polling. Deliveries only arrive when something
	// changes, so a quiet repo must not be declared stale after a few minutes —
	// but a repo that has heard nothing for a day probably lost its App.
	githubSyncedRepoWebhookFreshness = 24 * time.Hour
	// githubSyncedRepoSyncFreshness is how long a completed reconcile keeps the
	// store fresh on its own (the belt to the webhook heartbeat's braces).
	githubSyncedRepoSyncFreshness = 10 * time.Minute
	// githubSyncedRepoBackfillBudget bounds one full backfill/revalidate.
	githubSyncedRepoBackfillBudget = 90 * time.Second
	// githubSyncedRepoBackfillPageSize / MaxPages bound the backfill at 1000
	// rows per resource, matching the repo-listing cache's ceiling.
	githubSyncedRepoBackfillPageSize = 100
	githubSyncedRepoBackfillMaxPages = 10
	// githubSyncedRepoDefaultPerPage mirrors GitHub's default page size.
	githubSyncedRepoDefaultPerPage = 30

	// githubSyncedRepoHardFailAfter is the consecutive-failure kill switch
	// (GitLab's importer hard-fails a project after 14 strikes; we match it).
	// A hard-failed row keeps serving last-good and applying webhooks — only
	// background reconciliation stops, until an operator resets the row.
	githubSyncedRepoHardFailAfter = 14
	// githubSyncedRepoMinSyncInterval / MaxSyncInterval clamp the adaptive
	// per-repo reconcile interval (Sourcegraph repo-updater clamps ~45s–8h).
	githubSyncedRepoMinSyncInterval = 45 * time.Second
	githubSyncedRepoMaxSyncInterval = 8 * time.Hour
	// githubSyncedRepoReconcilerTick is how often the singleton reconciler
	// wakes to look for due repos; per-repo intervals gate the actual work.
	githubSyncedRepoReconcilerTick = time.Minute
	// githubSyncedRepoReconcilerBatch bounds one tick's candidate scan.
	githubSyncedRepoReconcilerBatch = 20
	// githubSyncedRepoReadGrantTTL bounds how long one successful live read
	// with a user's own GitHub credential lets the shared store answer that
	// user for that repo. It is the revocation bound: a user who loses GitHub
	// access keeps store access for at most this long.
	githubSyncedRepoReadGrantTTL = 10 * time.Minute
)

// GitHubSyncedRepoStore is the registry + metadata store surface, satisfied by
// the generated *db.Queries.
type GitHubSyncedRepoStore interface {
	GetGitHubSyncedRepo(ctx context.Context, arg db.GetGitHubSyncedRepoParams) (db.GithubSyncedRepo, error)
	GetGitHubSyncedRepoByGitHubID(ctx context.Context, githubRepositoryID pgtype.Int8) (db.GithubSyncedRepo, error)
	AdoptGitHubSyncedRepoSlug(ctx context.Context, arg db.AdoptGitHubSyncedRepoSlugParams) (db.GithubSyncedRepo, error)
	ListDueGitHubSyncedRepos(ctx context.Context, rowLimit int32) ([]db.GithubSyncedRepo, error)
	EnrollGitHubSyncedRepo(ctx context.Context, arg db.EnrollGitHubSyncedRepoParams) (db.GithubSyncedRepo, error)
	ListGitHubSyncedRepos(ctx context.Context, refsOnly bool) ([]db.GithubSyncedRepo, error)
	SetGitHubSyncedRepoMirror(ctx context.Context, arg db.SetGitHubSyncedRepoMirrorParams) error
	ListGitHubSyncedRepoMirrorBinders(ctx context.Context) ([]db.ListGitHubSyncedRepoMirrorBindersRow, error)
	RecordGitHubMirrorStatus(ctx context.Context, arg db.RecordGitHubMirrorStatusParams) (int64, error)
	ClaimGitHubSyncedRepoSync(ctx context.Context, id int64) (int64, error)
	MarkGitHubSyncedRepoSynced(ctx context.Context, id int64) error
	SetGitHubSyncedRepoSyncError(ctx context.Context, arg db.SetGitHubSyncedRepoSyncErrorParams) error
	TouchGitHubSyncedRepoWebhook(ctx context.Context, id int64) error
	ListGitHubSyncedIssues(ctx context.Context, arg db.ListGitHubSyncedIssuesParams) ([]db.GithubSyncedIssue, error)
	CountGitHubSyncedIssues(ctx context.Context, arg db.CountGitHubSyncedIssuesParams) (int64, error)
	UpsertGitHubSyncedIssue(ctx context.Context, arg db.UpsertGitHubSyncedIssueParams) error
	DeleteGitHubSyncedIssue(ctx context.Context, arg db.DeleteGitHubSyncedIssueParams) error
	DeleteGitHubSyncedIssuesNotIn(ctx context.Context, arg db.DeleteGitHubSyncedIssuesNotInParams) error
	UpsertGitHubSyncedIssueComment(ctx context.Context, arg db.UpsertGitHubSyncedIssueCommentParams) error
	DeleteGitHubSyncedIssueComment(ctx context.Context, arg db.DeleteGitHubSyncedIssueCommentParams) error
	ListGitHubSyncedIssueComments(ctx context.Context, arg db.ListGitHubSyncedIssueCommentsParams) ([]db.GithubSyncedIssueComment, error)
	GetGitHubSyncedIssueCommentCoverage(ctx context.Context, arg db.GetGitHubSyncedIssueCommentCoverageParams) (db.GetGitHubSyncedIssueCommentCoverageRow, error)
	DeleteGitHubSyncedIssueCommentsNotIn(ctx context.Context, arg db.DeleteGitHubSyncedIssueCommentsNotInParams) error
	UpsertGitHubSyncedRepoReadGrant(ctx context.Context, arg db.UpsertGitHubSyncedRepoReadGrantParams) error
	GetGitHubSyncedRepoReadGrant(ctx context.Context, arg db.GetGitHubSyncedRepoReadGrantParams) (db.GithubSyncedRepoReadGrant, error)
	DeleteGitHubSyncedRepoReadGrantsForUser(ctx context.Context, userID int64) error
}

// GitHubSyncedRepoMirrorer creates (or refreshes) the jjhub-side git mirror for
// an enrolled repository, reusing the import flow's clone → repo-host push →
// ImportRefs path WITHOUT the workspace provisioning half. Implemented by
// *GitHubImportService.MirrorEnrolledGitHubRepo. Optional: with no mirrorer
// wired, enrollment is metadata-only.
type GitHubSyncedRepoMirrorer interface {
	MirrorEnrolledGitHubRepo(ctx context.Context, userID int64, owner, repo string) (mirrorOwner string, mirrorRepo string, err error)
}

// GitHubSyncedRepoPageFetcher pulls one page of a resource live from GitHub.
// It is supplied by the caller that owns the credential, so the store service
// never touches OAuth. The wired fetcher factory (installation tokens) is
// preferred; a request-bound user-token fetcher is only the fallback for rows
// with no installation.
type GitHubSyncedRepoPageFetcher func(ctx context.Context, resource string, query url.Values) (json.RawMessage, error)

// gitHubSyncedRepoPageFetcher is the package-internal alias the service and
// the metadata proxy use; the exported name exists for main-wired factories.
type gitHubSyncedRepoPageFetcher = GitHubSyncedRepoPageFetcher

// GitHubSyncedRepoService owns the sync registry and the issue/PR/comment
// metadata store: enrollment, webhook-driven freshness, backfill, and the
// stale-while-revalidate read the metadata proxy serves from.
type GitHubSyncedRepoService struct {
	store    GitHubSyncedRepoStore
	mirrorer GitHubSyncedRepoMirrorer
	now      func() time.Time
	// fetcherFactory builds an installation-token-backed page fetcher for a
	// registry row (R2: sync uses installation tokens, cached ~1h, never user
	// tokens). When set it is preferred over any request-bound user fetcher;
	// it also powers the background reconciler, which has no user in scope.
	fetcherFactory func(row db.GithubSyncedRepo) GitHubSyncedRepoPageFetcher
	// budget is the shared per-installation GitHub API budget (R5: one
	// process-wide accounting point, the same tracker the proxy layer uses).
	budget *BudgetTracker
	// syncDone, when set, fires after every background backfill attempt.
	// Test seam — nil in production.
	syncDone func(syncedRepoID int64, err error)
	// commentBaselines holds the in-flight per-issue comment baseline loads
	// ("repoID|issue"), so concurrent reads start one load, not many.
	commentBaselines sync.Map
	// commentBaselineDone, when set, fires after every background comment
	// baseline load. Test seam — nil in production.
	commentBaselineDone func(syncedRepoID, issueNumber int64, err error)
	// pushAccess proves a user's current GitHub push access. github-sync
	// writes the mirror's refs, issues, landings and merges to the GitHub repo
	// with the platform token, so a mirror is bound, and advertised to
	// github-sync, only while its binding user can push. Nil fails closed.
	pushAccess GitHubRepoPushProver
	// mirrorFailures counts refused bindings and suspended mirrors.
	mirrorFailures GitHubMirrorFailureObserver
	pullMirror     func(ctx context.Context, owner, repo string) (bool, error)
	// syncWebhook gives a mirrored repository the hook that feeds its
	// Smithers events to github-sync. Nil when no github-sync is deployed.
	syncWebhook func(ctx context.Context, owner, repo string) (bool, error)
}

// GitHubMirrorFailureObserver records a mirror failure by stage and reason
// (smithers_mirror_failures_total). Satisfied by *routes.SmithersMetrics.
type GitHubMirrorFailureObserver interface {
	ObserveMirrorFailure(stage, reason string)
}

type GitHubSyncedRepoOption func(*GitHubSyncedRepoService)

// WithGitHubSyncedRepoMirrorer turns ref mirroring on for enrolled repos.
func WithGitHubSyncedRepoMirrorer(mirrorer GitHubSyncedRepoMirrorer) GitHubSyncedRepoOption {
	return func(s *GitHubSyncedRepoService) { s.mirrorer = mirrorer }
}

// WithGitHubSyncedRepoNow overrides the clock (tests only).
func WithGitHubSyncedRepoNow(now func() time.Time) GitHubSyncedRepoOption {
	return func(s *GitHubSyncedRepoService) {
		if now != nil {
			s.now = now
		}
	}
}

// WithGitHubSyncedRepoBudget shares the process-wide per-installation GitHub
// API budget tracker with the sync path, so backfills and the reconciler draw
// from the same accounting the proxy layer uses instead of a private counter.
func WithGitHubSyncedRepoBudget(budget *BudgetTracker) GitHubSyncedRepoOption {
	return func(s *GitHubSyncedRepoService) { s.budget = budget }
}

// WithGitHubSyncedRepoSyncNotify registers a callback fired after every
// background backfill attempt (tests only — lets tests wait for the goroutine).
func WithGitHubSyncedRepoSyncNotify(fn func(syncedRepoID int64, err error)) GitHubSyncedRepoOption {
	return func(s *GitHubSyncedRepoService) { s.syncDone = fn }
}

// WithGitHubSyncedRepoCommentBaselineNotify registers a callback fired after
// every background comment baseline load (tests only).
func WithGitHubSyncedRepoCommentBaselineNotify(fn func(syncedRepoID, issueNumber int64, err error)) GitHubSyncedRepoOption {
	return func(s *GitHubSyncedRepoService) { s.commentBaselineDone = fn }
}

func NewGitHubSyncedRepoService(store GitHubSyncedRepoStore, opts ...GitHubSyncedRepoOption) *GitHubSyncedRepoService {
	s := &GitHubSyncedRepoService{store: store, now: time.Now}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// SetMirrorer turns ref mirroring on after construction. Needed because the
// import service that performs the mirroring is itself built later in startup
// (it depends on the repo-host client and storage set), so the two are wired in
// two steps rather than through a construction cycle.
func (s *GitHubSyncedRepoService) SetMirrorer(mirrorer GitHubSyncedRepoMirrorer) {
	if s != nil {
		s.mirrorer = mirrorer
	}
}

// SetPushAccess wires the GitHub push proof that gates mirror binding and the
// github-sync feed. Two-step: the user-repos service that implements it is
// built after this one.
func (s *GitHubSyncedRepoService) SetPushAccess(access GitHubRepoPushProver) {
	if s != nil {
		s.pushAccess = access
	}
}

// SetPullMirror stops every sync feed advertising ref sync for repositories
// that follow GitHub (`mirror: "pull"`): GitHub writes their refs, and a
// Smithers -> GitHub ref mirror would overwrite main and prune GitHub-only
// branches. The ref-push feed omits them; the full feed keeps their metadata.
func (s *GitHubSyncedRepoService) SetPullMirror(pullMirror func(ctx context.Context, owner, repo string) (bool, error)) {
	if s != nil {
		s.pullMirror = pullMirror
	}
}

// SetMirrorFailureObserver wires the mirror failure metric.
func (s *GitHubSyncedRepoService) SetMirrorFailureObserver(observer GitHubMirrorFailureObserver) {
	if s != nil {
		s.mirrorFailures = observer
	}
}

// SetFetcherFactory wires the installation-token page fetcher (R2). Two-step
// for the same reason as SetMirrorer: the issuer-backed factory depends on
// services built after this one.
func (s *GitHubSyncedRepoService) SetFetcherFactory(factory func(row db.GithubSyncedRepo) GitHubSyncedRepoPageFetcher) {
	if s != nil {
		s.fetcherFactory = factory
	}
}

// GitHubSyncedRepoSummary is the registry row as github-sync consumes it: the
// dynamic replacement for the static SMITHERS_SYNC_MAPPINGS entry.
type GitHubSyncedRepoSummary struct {
	GitHubOwner    string     `json:"github_owner"`
	GitHubRepo     string     `json:"github_repo"`
	SmithersOwner  string     `json:"smithers_owner,omitempty"`
	SmithersRepo   string     `json:"smithers_repo,omitempty"`
	InstallationID int64      `json:"installation_id,omitempty"`
	SyncRefs       bool       `json:"sync_refs"`
	SyncMetadata   bool       `json:"sync_metadata"`
	SyncState      string     `json:"sync_state"`
	EnrolledVia    string     `json:"enrolled_via"`
	LastSyncedAt   *time.Time `json:"last_synced_at,omitempty"`
	LastWebhookAt  *time.Time `json:"last_webhook_at,omitempty"`
	SyncError      string     `json:"sync_error,omitempty"`
	// MirrorSuspended names why a recorded mirror is withheld from
	// github-sync (a GitHubPushProofReason). SmithersOwner/SmithersRepo are
	// empty whenever it is set, so github-sync writes nothing to the repo.
	MirrorSuspended string `json:"mirror_suspended,omitempty"`
}

const (
	GitHubMirrorStatusSynced = "synced"
	GitHubMirrorStatusBehind = "behind"
	GitHubMirrorStatusFailed = "failed"
)

// GitHubMirrorStatusReport is the outcome github-sync reports for one push
// mirror run. GitHubHead is the destination repository's HEAD after a
// successful push; it may be empty for an empty repository.
type GitHubMirrorStatusReport struct {
	Status     string
	GitHubHead string
	Error      string
	BehindRefs int32
	FailedRefs int32
}

// RecordMirrorStatus persists github-sync's view of a configured push mirror.
// A worker cannot manufacture the "unconfigured" state: that state belongs to
// repositories without an active registry mapping.
func (s *GitHubSyncedRepoService) RecordMirrorStatus(ctx context.Context, mirrorOwner, mirrorRepo string, report GitHubMirrorStatusReport) error {
	if s == nil || s.store == nil {
		return pkgerrors.Internal("github sync registry unavailable")
	}

	mirrorOwner = strings.TrimSpace(mirrorOwner)
	mirrorRepo = strings.TrimSpace(mirrorRepo)
	report.Status = strings.ToLower(strings.TrimSpace(report.Status))
	report.GitHubHead = strings.TrimSpace(report.GitHubHead)
	report.Error = strings.TrimSpace(report.Error)
	if mirrorOwner == "" || mirrorRepo == "" {
		return pkgerrors.BadRequest("mirror owner and repository are required")
	}
	if report.Status != GitHubMirrorStatusSynced && report.Status != GitHubMirrorStatusBehind && report.Status != GitHubMirrorStatusFailed {
		return pkgerrors.BadRequest("mirror_status must be synced, behind, or failed")
	}
	if report.Status == GitHubMirrorStatusFailed && report.Error == "" {
		return pkgerrors.BadRequest("error is required when mirror_status is failed")
	}
	if len(report.GitHubHead) > 64 {
		return pkgerrors.BadRequest("github_head must be at most 64 characters")
	}
	if report.BehindRefs < 0 || report.FailedRefs < 0 || report.FailedRefs > report.BehindRefs {
		return pkgerrors.BadRequest("mirror ref counts are invalid")
	}

	rows, err := s.store.RecordGitHubMirrorStatus(ctx, db.RecordGitHubMirrorStatusParams{
		MirrorStatus: report.Status,
		MirrorError:  pgtype.Text{String: report.Error, Valid: report.Error != ""},
		GithubHead:   pgtype.Text{String: report.GitHubHead, Valid: report.GitHubHead != ""},
		MirrorOwner:  mirrorOwner,
		MirrorRepo:   mirrorRepo,
		BehindRefs:   report.BehindRefs,
		FailedRefs:   report.FailedRefs,
	})
	if err != nil {
		return pkgerrors.Internal("failed to record github mirror status").WithCause(err)
	}
	if rows == 0 {
		return pkgerrors.NotFound("configured github mirror not found")
	}
	return nil
}

// ListSyncedRepos returns the registry feed. refsOnly narrows it to the repos
// whose git refs are mirrored (what github-sync's mirror mode needs).
// GitHubSyncWebhookEvents are the Smithers events github-sync consumes: refs
// (push, create, delete) and issue, landing and commit-status metadata.
var GitHubSyncWebhookEvents = []string{
	"push", "create", "delete", "issues", "issue_comment", "status",
	"landing_request", "landing_request_review", "landing_request_comment",
}

// SetSyncWebhook wires the hook ensurer that feeds each mirrored repository's
// Smithers events to github-sync. Without that hook no landing, comment or
// status on the mirror reaches GitHub.
func (s *GitHubSyncedRepoService) SetSyncWebhook(ensure func(ctx context.Context, owner, repo string) (bool, error)) {
	if s == nil {
		return
	}
	s.syncWebhook = ensure
}

// EnsureSyncWebhooks gives every registry row with a bound mirror its event
// hook, and returns how many it created. A suspended mirror keeps its hook;
// github-sync withholds its mapping, so its events write nothing.
func (s *GitHubSyncedRepoService) EnsureSyncWebhooks(ctx context.Context) (int, error) {
	if s == nil || s.store == nil || s.syncWebhook == nil {
		return 0, nil
	}
	rows, err := s.store.ListGitHubSyncedRepos(ctx, false)
	if err != nil {
		return 0, pkgerrors.Internal("failed to list synced github repositories").WithCause(err)
	}
	created := 0
	for _, row := range rows {
		if !row.MirrorOwner.Valid || !row.MirrorRepo.Valid || row.MirrorOwner.String == "" || row.MirrorRepo.String == "" {
			continue
		}
		repository := row.MirrorOwner.String + "/" + row.MirrorRepo.String
		ok, err := s.syncWebhook(ctx, row.MirrorOwner.String, row.MirrorRepo.String)
		if err != nil {
			slog.WarnContext(ctx, "github sync webhook not ensured", "repository", repository, "error", err)
			continue
		}
		if ok {
			created++
			slog.InfoContext(ctx, "github sync webhook created", "repository", repository)
		}
	}
	return created, nil
}

// StartSyncWebhookReconciler runs EnsureSyncWebhooks now and every interval
// until ctx is done, so a newly bound mirror gets its hook without a deploy.
func (s *GitHubSyncedRepoService) StartSyncWebhookReconciler(ctx context.Context, interval time.Duration) {
	if s == nil || s.syncWebhook == nil {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if _, err := s.EnsureSyncWebhooks(ctx); err != nil {
			slog.WarnContext(ctx, "github sync webhook reconcile failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *GitHubSyncedRepoService) ListSyncedRepos(ctx context.Context, refsOnly bool) ([]GitHubSyncedRepoSummary, error) {
	if s == nil || s.store == nil {
		return nil, pkgerrors.Internal("github sync registry unavailable")
	}
	rows, err := s.store.ListGitHubSyncedRepos(ctx, refsOnly)
	if err != nil {
		return nil, pkgerrors.Internal("failed to list synced github repositories").WithCause(err)
	}
	suspended := s.suspendedMirrors(ctx, rows)
	summaries := make([]GitHubSyncedRepoSummary, 0, len(rows))
	for _, row := range rows {
		if reason, ok := suspended[row.ID]; ok {
			// github-sync maps a row only when it names the Smithers side, so
			// withholding it stops every write to this GitHub repo: refs,
			// prune, issues, landings and merges.
			if refsOnly {
				continue
			}
			// Suspended rows name no Smithers side, so nothing can push them.
			summaries = append(summaries, GitHubSyncedRepoSummary{
				GitHubOwner:     row.OwnerLogin,
				GitHubRepo:      row.RepoName,
				SyncRefs:        false,
				SyncMetadata:    row.SyncMetadata,
				SyncState:       row.SyncState,
				EnrolledVia:     row.EnrolledVia,
				SyncError:       row.SyncError.String,
				MirrorSuspended: string(reason),
			})
			continue
		}
		// GitHub is the only writer of a `mirror: "pull"` repository's refs,
		// so no feed advertises ref sync for it: combined-mode github-sync
		// reads the full feed and mirrors refs per row, and a clean outbound
		// pass would prune every GitHub-only branch. Metadata sync continues.
		// A policy read that fails withholds ref sync for that row only (fail
		// closed); the rest of the feed and this row's metadata still flow.
		pull := false
		if s.pullMirror != nil && row.MirrorOwner.Valid && row.MirrorRepo.Valid {
			if pull, err = s.pullMirror(ctx, row.MirrorOwner.String, row.MirrorRepo.String); err != nil {
				slog.WarnContext(ctx, "github sync registry could not read a repository's GitHub policy; withholding ref sync",
					"repository", row.MirrorOwner.String+"/"+row.MirrorRepo.String, "error", err)
				pull = true
			}
		}
		if refsOnly && pull {
			continue
		}
		summary := GitHubSyncedRepoSummary{
			GitHubOwner:   row.OwnerLogin,
			GitHubRepo:    row.RepoName,
			SmithersOwner: row.MirrorOwner.String,
			SmithersRepo:  row.MirrorRepo.String,
			SyncRefs:      row.SyncRefs && !pull,
			SyncMetadata:  row.SyncMetadata,
			SyncState:     row.SyncState,
			EnrolledVia:   row.EnrolledVia,
			SyncError:     row.SyncError.String,
		}
		if row.InstallationID.Valid {
			summary.InstallationID = row.InstallationID.Int64
		}
		if row.LastSyncedAt.Valid {
			at := row.LastSyncedAt.Time
			summary.LastSyncedAt = &at
		}
		if row.LastWebhookAt.Valid {
			at := row.LastWebhookAt.Time
			summary.LastWebhookAt = &at
		}
		summaries = append(summaries, summary)
	}
	return summaries, nil
}

// EnrollGitHubRepoInput describes one enrollment. SyncRefs defaults to ON for
// every enrollment path (spec §3): the registry is the mirror set, not just a
// metadata cache.
type EnrollGitHubRepoInput struct {
	Owner          string
	Repo           string
	InstallationID int64
	// GitHubRepositoryID is GitHub's immutable numeric repo id, when the
	// enrollment source knows it (webhooks always do). It is what keeps a row
	// attached to its repo across renames and transfers.
	GitHubRepositoryID int64
	EnrolledVia        string
	// MetadataOnly opts a repo out of ref mirroring. Used by the lazy read-path
	// enrollment of a repo the app can see but has no mirror namespace for yet.
	MetadataOnly bool
}

// EnrollGitHubRepo idempotently adds owner/repo to the registry. Re-enrolling is
// a no-op upgrade: sync kinds only ever turn ON, and the original provenance is
// preserved (see the EnrollGitHubSyncedRepo query).
func (s *GitHubSyncedRepoService) EnrollGitHubRepo(ctx context.Context, input EnrollGitHubRepoInput) (db.GithubSyncedRepo, error) {
	if s == nil || s.store == nil {
		return db.GithubSyncedRepo{}, pkgerrors.Internal("github sync registry unavailable")
	}
	owner, err := normalizeGitHubRepoMetadataSegment(input.Owner, "owner")
	if err != nil {
		return db.GithubSyncedRepo{}, err
	}
	repo, err := normalizeGitHubRepoMetadataSegment(input.Repo, "repository")
	if err != nil {
		return db.GithubSyncedRepo{}, err
	}
	via := strings.TrimSpace(input.EnrolledVia)
	switch via {
	case GitHubSyncedRepoEnrolledViaImport, GitHubSyncedRepoEnrolledViaInstallation, GitHubSyncedRepoEnrolledViaLazy:
	default:
		via = GitHubSyncedRepoEnrolledViaLazy
	}

	if err := s.adoptSlugForKnownRepo(ctx, owner, repo, input.GitHubRepositoryID); err != nil {
		return db.GithubSyncedRepo{}, err
	}
	row, err := s.store.EnrollGitHubSyncedRepo(ctx, db.EnrollGitHubSyncedRepoParams{
		OwnerLogin:         owner,
		RepoName:           repo,
		InstallationID:     nullableSyncedRepoInt64(input.InstallationID),
		GithubRepositoryID: nullableSyncedRepoInt64(input.GitHubRepositoryID),
		SyncRefs:           !input.MetadataOnly,
		SyncMetadata:       true,
		EnrolledVia:        via,
	})
	if err != nil {
		return db.GithubSyncedRepo{}, pkgerrors.Internal("failed to enroll github repository for sync").WithCause(err)
	}
	return row, nil
}

// adoptSlugForKnownRepo keys enrollment on GitHub's immutable repo id when the
// source knows it: a row already holding the id under another slug is the same
// repository after a rename or transfer, so it adopts the incoming slug before
// the slug upsert runs. Without this the upsert would insert a second row for
// the id and violate uq_github_synced_repos_github_id. A different row still
// holding the incoming slug fails the adoption; an operator untangles, as in
// lookupEnrolled.
func (s *GitHubSyncedRepoService) adoptSlugForKnownRepo(ctx context.Context, owner, repo string, githubRepoID int64) error {
	if githubRepoID <= 0 {
		return nil
	}
	existing, err := s.store.GetGitHubSyncedRepoByGitHubID(ctx, nullableSyncedRepoInt64(githubRepoID))
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return pkgerrors.Internal("failed to enroll github repository for sync").WithCause(err)
	}
	if existing.OwnerLoginLower == strings.ToLower(owner) && existing.RepoNameLower == strings.ToLower(repo) {
		return nil
	}
	if _, err := s.store.AdoptGitHubSyncedRepoSlug(ctx, db.AdoptGitHubSyncedRepoSlugParams{
		OwnerLogin: owner,
		RepoName:   repo,
		ID:         existing.ID,
	}); err != nil {
		slog.Warn("github synced repo rename detected at enrollment but slug not adopted",
			"old_owner", existing.OwnerLogin, "old_repo", existing.RepoName,
			"new_owner", owner, "new_repo", repo, "error", err)
		return pkgerrors.Internal("failed to enroll github repository for sync").WithCause(err)
	}
	slog.Info("github synced repo slug adopted at enrollment after rename/transfer",
		"old_owner", existing.OwnerLogin, "old_repo", existing.RepoName,
		"new_owner", owner, "new_repo", repo)
	return nil
}

// MirrorEnrolledRepo creates or refreshes the jjhub-side git mirror for an
// already-enrolled repository and records where it landed, so github-sync's
// mirror mode can keep its refs current from push webhooks. Best-effort by
// contract: with no mirrorer wired, or on a GitHub/repo-host failure, the
// enrollment stays metadata-only and the failure is recorded on the row.
func (s *GitHubSyncedRepoService) MirrorEnrolledRepo(ctx context.Context, userID int64, row db.GithubSyncedRepo) {
	if s == nil || s.store == nil || s.mirrorer == nil || !row.SyncRefs {
		return
	}
	mirrorOwner, mirrorRepo, err := s.mirrorer.MirrorEnrolledGitHubRepo(ctx, userID, row.OwnerLogin, row.RepoName)
	if err != nil {
		// Log only: sync_error/sync_state describe the METADATA store (they
		// drive X-Metadata-Sync-Error and release the backfill singleflight
		// claim), and a refs-only clone failure must not poison either.
		slog.Warn("github.synced_repo.mirror_failed",
			"owner", row.OwnerLogin, "repo", row.RepoName, "error", err)
		return
	}
	if strings.TrimSpace(mirrorOwner) == "" || strings.TrimSpace(mirrorRepo) == "" {
		return
	}
	if err := s.BindMirror(ctx, userID, row, mirrorOwner, mirrorRepo); err != nil {
		slog.Warn("github.synced_repo.mirror_not_recorded",
			"owner", row.OwnerLogin, "repo", row.RepoName, "error", err)
	}
}

// BindMirror points a registry row at the jjhub repo userID mirrored it into,
// so github-sync knows which repo to push to GitHub. github-sync writes with
// the platform token, which can push to repositories userID cannot, so the
// binding needs userID's own current GitHub push access to the source. Without
// it the row keeps its existing mirror and the refusal is returned as a
// *GitHubPushProofError, logged, and counted.
func (s *GitHubSyncedRepoService) BindMirror(ctx context.Context, userID int64, row db.GithubSyncedRepo, mirrorOwner, mirrorRepo string) error {
	if s == nil || s.store == nil {
		return pkgerrors.Internal("github sync registry unavailable")
	}
	if err := s.provePush(ctx, userID, row.OwnerLogin, row.RepoName); err != nil {
		s.observeMirrorRefusal("github.mirror.bind_refused", "bind", row, userID, err)
		return err
	}
	if err := s.store.SetGitHubSyncedRepoMirror(ctx, db.SetGitHubSyncedRepoMirrorParams{
		MirrorOwner: mirrorOwner,
		MirrorRepo:  mirrorRepo,
		ID:          row.ID,
	}); err != nil {
		return err
	}
	// Hook the mirror now so its first events reach github-sync; the
	// reconciler retries a failure.
	if s.syncWebhook != nil {
		if _, err := s.syncWebhook(ctx, mirrorOwner, mirrorRepo); err != nil {
			slog.WarnContext(ctx, "github sync webhook not ensured", "repository", mirrorOwner+"/"+mirrorRepo, "error", err)
		}
	}
	return nil
}

func (s *GitHubSyncedRepoService) provePush(ctx context.Context, userID int64, owner, repo string) error {
	if userID <= 0 {
		return &GitHubPushProofError{UserID: userID, Owner: owner, Repo: repo, Reason: GitHubPushProofNoBinder}
	}
	if s.pushAccess == nil {
		return &GitHubPushProofError{UserID: userID, Owner: owner, Repo: repo, Reason: GitHubPushProofUnwired}
	}
	return s.pushAccess.GitHubRepoPushAuthorized(ctx, userID, owner, repo)
}

func (s *GitHubSyncedRepoService) observeMirrorRefusal(event, stage string, row db.GithubSyncedRepo, userID int64, err error) {
	reason := string(GitHubPushProofDenied)
	var proofErr *GitHubPushProofError
	if stdErrors.As(err, &proofErr) {
		reason = string(proofErr.Reason)
	}
	slog.Warn(event,
		"github_owner", row.OwnerLogin, "github_repo", row.RepoName,
		"mirror_owner", row.MirrorOwner.String, "mirror_repo", row.MirrorRepo.String,
		"user_id", userID, "reason", reason)
	if s.mirrorFailures != nil {
		s.mirrorFailures.ObserveMirrorFailure("github_push_"+stage, reason)
	}
}

// githubMirrorFeedProofConcurrency bounds the push proofs one feed request
// runs at once. github-sync gives the whole request 10 seconds and keeps its
// previous mappings when a request fails, so the proofs share a shorter budget
// and a proof that runs out of time suspends its mirror instead.
const (
	githubMirrorFeedProofConcurrency = 16
	githubMirrorFeedProofBudget      = 6 * time.Second
)

// suspendedMirrors re-proves, for every row with a recorded mirror, that the
// user who bound it (ListGitHubSyncedRepoMirrorBinders: the newest ready
// import that produced that mirror) can still push to the GitHub repo. It
// returns the rows whose mirror must be withheld from github-sync, with the
// reason.
func (s *GitHubSyncedRepoService) suspendedMirrors(ctx context.Context, rows []db.GithubSyncedRepo) map[int64]GitHubPushProofReason {
	suspended := map[int64]GitHubPushProofReason{}
	binders := map[int64]int64{}
	binderRows, err := s.store.ListGitHubSyncedRepoMirrorBinders(ctx)
	if err != nil {
		// Without binders nothing can be proven: every mirror is withheld.
		slog.Warn("github.mirror.binders_unavailable", "error", err)
	}
	for _, binder := range binderRows {
		binders[binder.SyncedRepoID] = binder.UserID
	}
	ctx, cancel := context.WithTimeout(ctx, githubMirrorFeedProofBudget)
	defer cancel()
	var mu sync.Mutex
	var wg sync.WaitGroup
	slots := make(chan struct{}, githubMirrorFeedProofConcurrency)
	for _, row := range rows {
		if !row.MirrorOwner.Valid || !row.MirrorRepo.Valid || row.MirrorOwner.String == "" || row.MirrorRepo.String == "" {
			continue
		}
		wg.Add(1)
		go func(row db.GithubSyncedRepo) {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			binder := binders[row.ID]
			err := s.provePush(ctx, binder, row.OwnerLogin, row.RepoName)
			if err == nil {
				return
			}
			s.observeMirrorRefusal("github.mirror.suspended", "feed", row, binder, err)
			reason := GitHubPushProofDenied
			var proofErr *GitHubPushProofError
			if stdErrors.As(err, &proofErr) {
				reason = proofErr.Reason
			}
			mu.Lock()
			suspended[row.ID] = reason
			mu.Unlock()
		}(row)
	}
	wg.Wait()
	return suspended
}

// GitHubRepoReadGrant is proof that one user's own GitHub credential read one
// repository live within githubSyncedRepoReadGrantTTL. Its fields are
// unexported and ReadGrant is its only constructor, so the shared store cannot
// be read without a checked grant. The zero value is "no grant".
type GitHubRepoReadGrant struct {
	owner string
	repo  string
	ok    bool
}

// ReadGrant looks up the caller's live-read proof for owner/repo. It fails
// closed: a missing, expired, or unreadable grant sends the caller live.
func (s *GitHubSyncedRepoService) ReadGrant(ctx context.Context, userID int64, owner, repo string) GitHubRepoReadGrant {
	if s == nil || s.store == nil || userID <= 0 {
		return GitHubRepoReadGrant{}
	}
	row, err := s.store.GetGitHubSyncedRepoReadGrant(ctx, db.GetGitHubSyncedRepoReadGrantParams{
		UserID: userID, OwnerLogin: owner, RepoName: repo,
	})
	if err != nil {
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			slog.Warn("github synced repo read grant unreadable; serving live",
				"user_id", userID, "owner", owner, "repo", repo, "error", err)
		}
		return GitHubRepoReadGrant{}
	}
	if s.now().Sub(row.VerifiedAt) > githubSyncedRepoReadGrantTTL {
		return GitHubRepoReadGrant{}
	}
	return GitHubRepoReadGrant{owner: owner, repo: repo, ok: true}
}

// RecordReadGrant stamps the caller's live-read proof. Call it only after a
// live GitHub read with the user's own credential succeeded for owner/repo.
func (s *GitHubSyncedRepoService) RecordReadGrant(ctx context.Context, userID int64, owner, repo string) error {
	if s == nil || s.store == nil || userID <= 0 {
		return nil
	}
	return s.store.UpsertGitHubSyncedRepoReadGrant(ctx, db.UpsertGitHubSyncedRepoReadGrantParams{
		UserID: userID, OwnerLogin: owner, RepoName: repo,
	})
}

// RevokeReadGrants drops every live-read proof the user holds, so their next
// read of any repo goes live. Call it when the user's GitHub credential is
// gone.
func (s *GitHubSyncedRepoService) RevokeReadGrants(ctx context.Context, userID int64) error {
	if s == nil || s.store == nil || userID <= 0 {
		return nil
	}
	return s.store.DeleteGitHubSyncedRepoReadGrantsForUser(ctx, userID)
}

// GitHubSyncedMetadataPage is a store-served metadata response plus the honest
// provenance the proxy exposes as headers.
type GitHubSyncedMetadataPage struct {
	Body      json.RawMessage
	Link      string
	SyncedAt  time.Time
	Stale     bool
	SyncError string
}

// ServeMetadata answers a metadata proxy read FROM THE STORE, stale-while-
// revalidate, and reports served=false when the caller must fall back to the
// live GitHub passthrough. It never blocks on GitHub: the very first read for a
// newly enrolled repo is a miss that schedules a background backfill, so the
// user sees live data immediately and the store takes over from the next read.
// The store is shared across users, so it answers only a caller holding a
// fresh read grant for this repo; without one the caller goes live, where
// GitHub itself decides what the user's credential can see.
func (s *GitHubSyncedRepoService) ServeMetadata(
	ctx context.Context,
	grant GitHubRepoReadGrant,
	resource string,
	query url.Values,
	fetch gitHubSyncedRepoPageFetcher,
) (page GitHubSyncedMetadataPage, served bool) {
	if s == nil || s.store == nil || !grant.ok {
		return GitHubSyncedMetadataPage{}, false
	}
	owner, repo := grant.owner, grant.repo
	// Filters the store does not model (labels/head/base, custom sorts) go
	// live, exactly like the repo-listing cache's non-canonical shapes.
	if !storeServableGitHubMetadataQuery(query) {
		return GitHubSyncedMetadataPage{}, false
	}

	row, err := s.store.GetGitHubSyncedRepo(ctx, db.GetGitHubSyncedRepoParams{OwnerLogin: owner, RepoName: repo})
	if err != nil {
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			// Store INFRASTRUCTURE failure (missing table, DB blip) — degrade to
			// live rather than 500 a page that live GitHub can still serve.
			slog.Warn("github synced repo registry unreadable; serving live",
				"owner", owner, "repo", repo, "error", err)
		}
		return GitHubSyncedMetadataPage{}, false
	}
	if !row.SyncMetadata || row.SyncState == "disabled" {
		return GitHubSyncedMetadataPage{}, false
	}
	if !row.LastSyncedAt.Valid {
		// Enrolled but never backfilled: nothing last-good to serve. Kick the
		// backfill off and let this request go live.
		s.scheduleBackfill(row, fetch)
		return GitHubSyncedMetadataPage{}, false
	}

	state := storeMetadataStateFilter(query)
	limit, offset, pageNumber, perPage := storeMetadataPaging(query)
	// The backfill stores at most maxPages×pageSize rows per resource; a page
	// past that ceiling could be silently truncated, so it goes live instead.
	if int(offset)+int(limit) > githubSyncedRepoBackfillMaxPages*githubSyncedRepoBackfillPageSize {
		return GitHubSyncedMetadataPage{}, false
	}
	rows, err := s.store.ListGitHubSyncedIssues(ctx, db.ListGitHubSyncedIssuesParams{
		SyncedRepoID:  row.ID,
		Resource:      resource,
		State:         state,
		SortByUpdated: strings.TrimSpace(query.Get("sort")) == "updated",
		RowLimit:      limit,
		RowOffset:     offset,
	})
	if err != nil {
		slog.Warn("github synced metadata unreadable; serving live",
			"owner", owner, "repo", repo, "resource", resource, "error", err)
		return GitHubSyncedMetadataPage{}, false
	}

	stale := s.stale(row)
	// A hard-failed row ('failed', the consecutive-failure kill switch) still
	// serves last-good behind its staleness header, but no longer schedules
	// work — the claim query would refuse it anyway; skip the goroutine churn.
	if stale && row.SyncState != "failed" {
		s.scheduleBackfill(row, fetch)
	}

	body, err := encodeSyncedIssuePayloads(rows)
	if err != nil {
		slog.Warn("github synced metadata payload corrupt; serving live",
			"owner", owner, "repo", repo, "resource", resource, "error", err)
		return GitHubSyncedMetadataPage{}, false
	}

	result := GitHubSyncedMetadataPage{
		Body:      body,
		SyncedAt:  row.LastSyncedAt.Time,
		Stale:     stale,
		SyncError: row.SyncError.String,
	}
	// Only synthesize rel="next" when a full page came back: a short page is
	// the last page, and counting on every read would double the query cost.
	if len(rows) == int(limit) {
		result.Link = fmt.Sprintf("</api/user/github-repos/%s/%s/%s?cursor=%d&per_page=%d>; rel=\"next\"",
			url.PathEscape(owner), url.PathEscape(repo), resource, pageNumber+1, perPage)
	}
	return result, true
}

// ServeComments answers an issue-comments read FROM THE STORE with the same
// stale-while-revalidate provenance as ServeMetadata, and reports served=false
// when the caller must fall back to the live GitHub passthrough. A repository
// heartbeat proves deliveries arrive, not that one issue's historical comments
// were ever loaded, so the store serves an issue only while it holds exactly
// the comment count the stored issue advertises (see
// GetGitHubSyncedIssueCommentCoverage). A stored issue whose count differs is
// served live while a background load fetches its complete comment list; a
// later reconcile that refreshes the count exposes missed deliveries the same
// way. Pull requests and unstored issues advertise no count and stay live.
func (s *GitHubSyncedRepoService) ServeComments(
	ctx context.Context,
	grant GitHubRepoReadGrant,
	issueNumber int64,
	query url.Values,
	fetch gitHubSyncedRepoPageFetcher,
) (page GitHubSyncedMetadataPage, served bool) {
	if s == nil || s.store == nil || !grant.ok || issueNumber <= 0 {
		return GitHubSyncedMetadataPage{}, false
	}
	owner, repo := grant.owner, grant.repo
	row, err := s.store.GetGitHubSyncedRepo(ctx, db.GetGitHubSyncedRepoParams{OwnerLogin: owner, RepoName: repo})
	if err != nil {
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			slog.Warn("github synced repo registry unreadable; serving live",
				"owner", owner, "repo", repo, "error", err)
		}
		return GitHubSyncedMetadataPage{}, false
	}
	if !row.SyncMetadata || row.SyncState == "disabled" {
		return GitHubSyncedMetadataPage{}, false
	}
	if !row.LastSyncedAt.Valid {
		s.scheduleBackfill(row, fetch)
		return GitHubSyncedMetadataPage{}, false
	}
	if !row.LastWebhookAt.Valid {
		return GitHubSyncedMetadataPage{}, false
	}
	coverage, err := s.store.GetGitHubSyncedIssueCommentCoverage(ctx, db.GetGitHubSyncedIssueCommentCoverageParams{
		SyncedRepoID: row.ID,
		IssueNumber:  issueNumber,
	})
	if err != nil {
		// No row: the issue or its advertised count is not stored (pull
		// requests never carry one), so no baseline can ever be proven.
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			slog.Warn("github synced comment coverage unreadable; serving live",
				"owner", owner, "repo", repo, "issue", issueNumber, "error", err)
		}
		return GitHubSyncedMetadataPage{}, false
	}
	if coverage.Stored != coverage.Advertised {
		s.scheduleCommentBaseline(row, issueNumber, fetch)
		return GitHubSyncedMetadataPage{}, false
	}

	limit, offset, pageNumber, perPage := storeMetadataPaging(query)
	rows, err := s.store.ListGitHubSyncedIssueComments(ctx, db.ListGitHubSyncedIssueCommentsParams{
		SyncedRepoID: row.ID,
		IssueNumber:  issueNumber,
		RowLimit:     limit + 1,
		RowOffset:    offset,
	})
	if err != nil {
		slog.Warn("github synced issue comments unreadable; serving live",
			"owner", owner, "repo", repo, "issue", issueNumber, "error", err)
		return GitHubSyncedMetadataPage{}, false
	}

	stale := s.stale(row)
	if stale && row.SyncState != "failed" {
		s.scheduleBackfill(row, fetch)
	}

	hasNext := len(rows) > int(limit)
	if hasNext {
		rows = rows[:limit]
	}
	body, err := encodeSyncedCommentPayloads(rows)
	if err != nil {
		slog.Warn("github synced comment payload corrupt; serving live",
			"owner", owner, "repo", repo, "issue", issueNumber, "error", err)
		return GitHubSyncedMetadataPage{}, false
	}
	result := GitHubSyncedMetadataPage{
		Body:      body,
		SyncedAt:  row.LastSyncedAt.Time,
		Stale:     stale,
		SyncError: row.SyncError.String,
	}
	if hasNext {
		result.Link = fmt.Sprintf("</api/user/github-repos/%s/%s/issues/%d/comments?cursor=%d&per_page=%d>; rel=\"next\"",
			url.PathEscape(owner), url.PathEscape(repo), issueNumber, pageNumber+1, perPage)
	}
	return result, true
}

// stale reports whether the store has neither a recent webhook heartbeat nor a
// recent reconcile. A repo with a live App is kept fresh by deliveries alone.
func (s *GitHubSyncedRepoService) stale(row db.GithubSyncedRepo) bool {
	now := s.now()
	if row.LastWebhookAt.Valid && now.Sub(row.LastWebhookAt.Time) <= githubSyncedRepoWebhookFreshness {
		return false
	}
	return !row.LastSyncedAt.Valid || now.Sub(row.LastSyncedAt.Time) > githubSyncedRepoSyncFreshness
}

// scheduleBackfill wins the singleflight claim and runs one reconcile in the
// background. Never uses the request context: the request that scheduled it has
// long returned.
func (s *GitHubSyncedRepoService) scheduleBackfill(row db.GithubSyncedRepo, fetch gitHubSyncedRepoPageFetcher) {
	// R2: prefer the installation-token fetcher whenever the row has an
	// installation; the request-bound user-token fetcher is only the fallback
	// for repos synced without an App installation.
	fetch = s.preferredFetcher(row, fetch)
	if fetch == nil {
		return
	}
	if !s.allowBudget(row) {
		return
	}
	claimCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	claimed, err := s.store.ClaimGitHubSyncedRepoSync(claimCtx, row.ID)
	cancel()
	if err != nil || claimed == 0 {
		return
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("github synced metadata backfill panicked",
					"owner", row.OwnerLogin, "repo", row.RepoName, "panic", fmt.Sprint(r))
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), githubSyncedRepoBackfillBudget)
		defer cancel()
		err := s.backfill(ctx, row, fetch)
		if s.syncDone != nil {
			s.syncDone(row.ID, err)
		}
	}()
}

// scheduleCommentBaseline loads one issue's complete comment list in the
// background. Like scheduleBackfill it never uses the request context.
func (s *GitHubSyncedRepoService) scheduleCommentBaseline(row db.GithubSyncedRepo, issueNumber int64, fetch gitHubSyncedRepoPageFetcher) {
	fetch = s.preferredFetcher(row, fetch)
	if fetch == nil {
		return
	}
	key := strconv.FormatInt(row.ID, 10) + "|" + strconv.FormatInt(issueNumber, 10)
	if _, running := s.commentBaselines.LoadOrStore(key, struct{}{}); running {
		return
	}
	if !s.allowBudget(row) {
		s.commentBaselines.Delete(key)
		return
	}
	go func() {
		defer s.commentBaselines.Delete(key)
		defer func() {
			if r := recover(); r != nil {
				slog.Error("github synced comment baseline panicked",
					"owner", row.OwnerLogin, "repo", row.RepoName, "issue", issueNumber, "panic", fmt.Sprint(r))
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), githubSyncedRepoBackfillBudget)
		defer cancel()
		err := s.loadCommentBaseline(ctx, row, issueNumber, fetch)
		if err != nil {
			slog.Warn("github synced comment baseline failed; serving live",
				"owner", row.OwnerLogin, "repo", row.RepoName, "issue", issueNumber, "error", err)
		}
		if s.commentBaselineDone != nil {
			s.commentBaselineDone(row.ID, issueNumber, err)
		}
	}()
}

// loadCommentBaseline stores every comment GitHub returns for one issue and,
// when the walk saw the whole list, drops stored comments GitHub no longer has.
// GitHub lists issue comments oldest first, so a comment created mid-walk only
// appends; a list longer than the page ceiling is stored without pruning.
func (s *GitHubSyncedRepoService) loadCommentBaseline(ctx context.Context, row db.GithubSyncedRepo, issueNumber int64, fetch gitHubSyncedRepoPageFetcher) error {
	resource := "issues/" + strconv.FormatInt(issueNumber, 10) + "/comments"
	seen := make([]int64, 0, githubSyncedRepoBackfillPageSize)
	for page := 1; page <= githubSyncedRepoBackfillMaxPages; page++ {
		query := url.Values{}
		query.Set("per_page", strconv.Itoa(githubSyncedRepoBackfillPageSize))
		query.Set("page", strconv.Itoa(page))
		body, err := fetch(ctx, resource, query)
		if err != nil {
			return err
		}
		var comments []json.RawMessage
		if err := json.Unmarshal(body, &comments); err != nil {
			return fmt.Errorf("decode github issue comments page: %w", err)
		}
		for _, comment := range comments {
			var header gitHubCommentHeader
			if err := json.Unmarshal(comment, &header); err != nil || header.ID <= 0 {
				continue
			}
			if err := s.store.UpsertGitHubSyncedIssueComment(ctx, db.UpsertGitHubSyncedIssueCommentParams{
				SyncedRepoID:    row.ID,
				IssueNumber:     issueNumber,
				GithubID:        header.ID,
				Payload:         comment,
				GithubCreatedAt: parseGitHubTimestamp(header.CreatedAt),
				GithubUpdatedAt: parseGitHubTimestamp(header.UpdatedAt),
			}); err != nil {
				return err
			}
			seen = append(seen, header.ID)
		}
		if len(comments) < githubSyncedRepoBackfillPageSize {
			return s.store.DeleteGitHubSyncedIssueCommentsNotIn(ctx, db.DeleteGitHubSyncedIssueCommentsNotInParams{
				SyncedRepoID: row.ID,
				IssueNumber:  issueNumber,
				GithubIds:    seen,
			})
		}
	}
	return nil
}

// backfill reconciles BOTH collections for a repo against GitHub. On failure the
// last-good rows are preserved and only sync_error is recorded (which also
// releases the singleflight claim) — the proxy then serves last-good behind a
// staleness header rather than inventing anything.
func (s *GitHubSyncedRepoService) backfill(ctx context.Context, row db.GithubSyncedRepo, fetch gitHubSyncedRepoPageFetcher) error {
	for _, resource := range []string{GitHubRepoMetadataIssues, GitHubRepoMetadataPulls} {
		if err := s.backfillResource(ctx, row, resource, fetch); err != nil {
			s.recordSyncError(row.ID, err)
			slog.Warn("github synced metadata backfill failed; serving last-good",
				"owner", row.OwnerLogin, "repo", row.RepoName, "resource", resource, "error", err)
			return err
		}
	}
	markCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := s.store.MarkGitHubSyncedRepoSynced(markCtx, row.ID); err != nil {
		slog.Warn("github synced repo sync completion not recorded",
			"owner", row.OwnerLogin, "repo", row.RepoName, "error", err)
		return err
	}
	return nil
}

func (s *GitHubSyncedRepoService) backfillResource(ctx context.Context, row db.GithubSyncedRepo, resource string, fetch gitHubSyncedRepoPageFetcher) error {
	seen := make([]int64, 0, githubSyncedRepoBackfillPageSize)
	singlePage := false
	for page := 1; page <= githubSyncedRepoBackfillMaxPages; page++ {
		query := url.Values{}
		// state=all: the store holds both open and closed rows and filters on
		// read, so one backfill serves every state the proxy can be asked for.
		query.Set("state", "all")
		query.Set("sort", "updated")
		query.Set("direction", "desc")
		query.Set("per_page", strconv.Itoa(githubSyncedRepoBackfillPageSize))
		query.Set("page", strconv.Itoa(page))

		body, err := fetch(ctx, resource, query)
		if err != nil {
			return err
		}
		var objects []json.RawMessage
		if err := json.Unmarshal(body, &objects); err != nil {
			return fmt.Errorf("decode github %s page: %w", resource, err)
		}
		for _, object := range objects {
			number, upsertErr := s.storeSyncedIssue(ctx, row.ID, resource, object)
			if upsertErr != nil {
				return upsertErr
			}
			if number > 0 {
				seen = append(seen, number)
			}
		}
		if len(objects) < githubSyncedRepoBackfillPageSize {
			singlePage = page == 1
			break
		}
	}

	// Prune rows GitHub no longer returns — but only when the backfill actually
	// returned something. An empty result can also mean "the token lost access",
	// and wiping last-good rows on that would be exactly the invention the spec
	// forbids; the row's staleness header carries the truth instead.
	if len(seen) == 0 {
		return nil
	}
	// The NotIn prune requires a provably COMPLETE number set. Pagination here
	// is sort=updated desc, which is unstable under concurrent activity: an
	// issue updated mid-walk jumps to page 1 (already read) and vanishes from
	// its old page, so a multi-page `seen` can silently miss a live issue —
	// and pruning would delete it. Only a collection that fit entirely in the
	// FIRST page (one atomic snapshot, no walk) is safe to reconcile deletes
	// against; larger repos keep possibly-deleted stragglers until a webhook
	// `deleted` (or an operator resync) removes them.
	if !singlePage {
		return nil
	}
	return s.store.DeleteGitHubSyncedIssuesNotIn(ctx, db.DeleteGitHubSyncedIssuesNotInParams{
		SyncedRepoID: row.ID,
		Resource:     resource,
		Numbers:      seen,
	})
}

// storeSyncedIssue persists one raw GitHub issue/PR object, returning its number.
func (s *GitHubSyncedRepoService) storeSyncedIssue(ctx context.Context, syncedRepoID int64, resource string, object json.RawMessage) (int64, error) {
	var header gitHubIssueHeader
	if err := json.Unmarshal(object, &header); err != nil {
		// One malformed object must not abort the whole reconcile.
		return 0, nil
	}
	if header.Number <= 0 {
		return 0, nil
	}
	// GET /issues also returns pull requests. Storing them under 'issues' would
	// double-count every PR in the issue list the proxy serves.
	if resource == GitHubRepoMetadataIssues && header.PullRequest != nil {
		return 0, nil
	}
	if err := s.store.UpsertGitHubSyncedIssue(ctx, db.UpsertGitHubSyncedIssueParams{
		SyncedRepoID:    syncedRepoID,
		Resource:        resource,
		Number:          header.Number,
		GithubID:        header.ID,
		State:           normalizeSyncedIssueState(header.State),
		Title:           header.Title,
		Payload:         object,
		GithubCreatedAt: parseGitHubTimestamp(header.CreatedAt),
		GithubUpdatedAt: parseGitHubTimestamp(header.UpdatedAt),
	}); err != nil {
		return 0, err
	}
	return header.Number, nil
}

func (s *GitHubSyncedRepoService) recordSyncError(syncedRepoID int64, cause error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.store.SetGitHubSyncedRepoSyncError(ctx, db.SetGitHubSyncedRepoSyncErrorParams{
		// Sanitized: sync_error is echoed to clients in the staleness header and
		// cause may carry internal detail (hostnames, constraint names).
		SyncError:     sanitizedSyncErrorMessage(cause),
		HardFailAfter: githubSyncedRepoHardFailAfter,
		ID:            syncedRepoID,
	}); err != nil {
		slog.Warn("github synced repo sync error not recorded", "synced_repo_id", syncedRepoID, "error", err)
	}
}

// ---- Reconciliation backstop (R3/R4/R5) -----------------------------------

// preferredFetcher applies the R2 rule: the installation-token factory wins
// whenever the row carries an installation; the caller-supplied (user-token)
// fetcher is only the fallback for rows with none.
func (s *GitHubSyncedRepoService) preferredFetcher(row db.GithubSyncedRepo, fallback gitHubSyncedRepoPageFetcher) gitHubSyncedRepoPageFetcher {
	if s.fetcherFactory != nil && row.InstallationID.Valid {
		if fetch := s.fetcherFactory(row); fetch != nil {
			return fetch
		}
	}
	return fallback
}

// allowBudget consults the shared per-installation budget tracker (R5). One
// reconcile costs up to maxPages×2 requests; charging a single token per
// reconcile keeps the accounting coarse but centralized — the proxy layer
// charges the same tracker per request.
func (s *GitHubSyncedRepoService) allowBudget(row db.GithubSyncedRepo) bool {
	if s.budget == nil || !row.InstallationID.Valid {
		return true
	}
	allowed, retryAfter := s.budget.Allow(row.InstallationID.Int64)
	if !allowed {
		slog.Warn("github synced repo sync deferred: installation budget exhausted",
			"owner", row.OwnerLogin, "repo", row.RepoName,
			"installation_id", row.InstallationID.Int64, "retry_after", retryAfter)
	}
	return allowed
}

// reconcileInterval is the adaptive per-repo cadence (R4), clamped to
// [45s, 8h]. Base cadence matches the sync-freshness window; consecutive
// failures back the repo off exponentially; a repo with a live webhook
// heartbeat only needs the slow backstop sweep (webhooks carry its changes).
func (s *GitHubSyncedRepoService) reconcileInterval(row db.GithubSyncedRepo) time.Duration {
	interval := githubSyncedRepoSyncFreshness
	for i := int32(0); i < row.ConsecutiveFailures && interval < githubSyncedRepoMaxSyncInterval; i++ {
		interval *= 2
	}
	if row.LastWebhookAt.Valid && s.now().Sub(row.LastWebhookAt.Time) <= githubSyncedRepoWebhookFreshness {
		interval = githubSyncedRepoMaxSyncInterval
	}
	if interval < githubSyncedRepoMinSyncInterval {
		interval = githubSyncedRepoMinSyncInterval
	}
	if interval > githubSyncedRepoMaxSyncInterval {
		interval = githubSyncedRepoMaxSyncInterval
	}
	return interval
}

func (s *GitHubSyncedRepoService) reconcileDue(row db.GithubSyncedRepo) bool {
	if !row.LastSyncedAt.Valid {
		return true
	}
	return s.now().Sub(row.LastSyncedAt.Time) >= s.reconcileInterval(row)
}

// StartReconciler runs the mandatory reconciliation backstop (R3): webhooks
// are hints, this sweep is the truth. A single loop per process — repos are
// reconciled sequentially, oldest staleness first, so GitHub never sees a
// thundering herd and rate-limit accounting stays in one place (R5). The DB
// singleflight claim keeps multiple API replicas from double-sweeping a repo.
// Blocks until ctx is done; run it as `go svc.StartReconciler(workerCtx)`.
func (s *GitHubSyncedRepoService) StartReconciler(ctx context.Context) {
	if s == nil || s.store == nil || s.fetcherFactory == nil {
		slog.Warn("github synced repo reconciler not started: no installation fetcher wired")
		return
	}
	ticker := time.NewTicker(githubSyncedRepoReconcilerTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.reconcileOnce(ctx)
		}
	}
}

// reconcileOnce sweeps one batch of due repos. Exported to the tests via the
// service's test seams; production only reaches it through StartReconciler.
func (s *GitHubSyncedRepoService) reconcileOnce(ctx context.Context) {
	listCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	rows, err := s.store.ListDueGitHubSyncedRepos(listCtx, githubSyncedRepoReconcilerBatch)
	cancel()
	if err != nil {
		slog.Warn("github synced repo reconciler list failed", "error", err)
		return
	}
	for _, row := range rows {
		if ctx.Err() != nil {
			return
		}
		if !s.reconcileDue(row) {
			continue
		}
		fetch := s.preferredFetcher(row, nil)
		if fetch == nil {
			// No installation and no user in scope: this row can only be
			// revalidated by the read path's user-token fetcher.
			continue
		}
		if !s.allowBudget(row) {
			continue
		}
		claimCtx, cancelClaim := context.WithTimeout(ctx, 5*time.Second)
		claimed, claimErr := s.store.ClaimGitHubSyncedRepoSync(claimCtx, row.ID)
		cancelClaim()
		if claimErr != nil || claimed == 0 {
			continue
		}
		runCtx, cancelRun := context.WithTimeout(ctx, githubSyncedRepoBackfillBudget)
		err := s.backfill(runCtx, row, fetch)
		cancelRun()
		if s.syncDone != nil {
			s.syncDone(row.ID, err)
		}
	}
}

// ---- Webhook-driven freshness -------------------------------------------

type gitHubIssueHeader struct {
	ID          int64           `json:"id"`
	Number      int64           `json:"number"`
	State       string          `json:"state"`
	Title       string          `json:"title"`
	CreatedAt   string          `json:"created_at"`
	UpdatedAt   string          `json:"updated_at"`
	PullRequest json.RawMessage `json:"pull_request"`
}

type gitHubCommentHeader struct {
	ID        int64  `json:"id"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// ApplyIssueEvent applies an `issues` or `pull_request` webhook to the store and
// heartbeats the registry row. Unenrolled repos are ignored (the App can be
// installed on repos nobody has asked us to sync).
func (s *GitHubSyncedRepoService) ApplyIssueEvent(ctx context.Context, owner, repo string, githubRepoID int64, resource, action string, object json.RawMessage) error {
	row, ok, err := s.lookupEnrolled(ctx, owner, repo, githubRepoID)
	if err != nil || !ok {
		return err
	}
	if err := s.store.TouchGitHubSyncedRepoWebhook(ctx, row.ID); err != nil {
		return err
	}
	if len(object) == 0 {
		return nil
	}
	var header gitHubIssueHeader
	if err := json.Unmarshal(object, &header); err != nil || header.Number <= 0 {
		return nil
	}
	if action == "deleted" {
		return s.store.DeleteGitHubSyncedIssue(ctx, db.DeleteGitHubSyncedIssueParams{
			SyncedRepoID: row.ID,
			Resource:     resource,
			Number:       header.Number,
		})
	}
	_, err = s.storeSyncedIssue(ctx, row.ID, resource, object)
	return err
}

// ApplyIssueCommentEvent applies an `issue_comment` webhook to the store. The
// delivery's issue object carries the issue's current comment count; storing it
// keeps the per-issue coverage check in ServeComments exact.
func (s *GitHubSyncedRepoService) ApplyIssueCommentEvent(ctx context.Context, owner, repo string, githubRepoID int64, action string, issue, comment json.RawMessage) error {
	row, ok, err := s.lookupEnrolled(ctx, owner, repo, githubRepoID)
	if err != nil || !ok {
		return err
	}
	if err := s.store.TouchGitHubSyncedRepoWebhook(ctx, row.ID); err != nil {
		return err
	}
	var issueHeader gitHubIssueHeader
	if len(issue) == 0 || json.Unmarshal(issue, &issueHeader) != nil || issueHeader.Number <= 0 {
		return nil
	}
	issueNumber := issueHeader.Number
	if _, err := s.storeSyncedIssue(ctx, row.ID, GitHubRepoMetadataIssues, issue); err != nil {
		return err
	}
	if len(comment) == 0 {
		return nil
	}
	var header gitHubCommentHeader
	if err := json.Unmarshal(comment, &header); err != nil || header.ID <= 0 {
		return nil
	}
	if action == "deleted" {
		return s.store.DeleteGitHubSyncedIssueComment(ctx, db.DeleteGitHubSyncedIssueCommentParams{
			SyncedRepoID: row.ID,
			GithubID:     header.ID,
		})
	}
	return s.store.UpsertGitHubSyncedIssueComment(ctx, db.UpsertGitHubSyncedIssueCommentParams{
		SyncedRepoID:    row.ID,
		IssueNumber:     issueNumber,
		GithubID:        header.ID,
		Payload:         comment,
		GithubCreatedAt: parseGitHubTimestamp(header.CreatedAt),
		GithubUpdatedAt: parseGitHubTimestamp(header.UpdatedAt),
	})
}

// TouchWebhook records that a delivery arrived for owner/repo without changing
// any stored object (push, check_run, …). This heartbeat is what lets the proxy
// call a quiet repo fresh instead of polling it.
func (s *GitHubSyncedRepoService) TouchWebhook(ctx context.Context, owner, repo string, githubRepoID int64) error {
	row, ok, err := s.lookupEnrolled(ctx, owner, repo, githubRepoID)
	if err != nil || !ok {
		return err
	}
	return s.store.TouchGitHubSyncedRepoWebhook(ctx, row.ID)
}

// lookupEnrolled resolves the registry row for a delivery. The slug is tried
// first; on a miss the immutable numeric repo id is the fallback — a rename or
// transfer changed the slug out from under the row — and the stored slug is
// repaired in place so subsequent lookups (and the reconciler's REST calls)
// use the current name.
func (s *GitHubSyncedRepoService) lookupEnrolled(ctx context.Context, owner, repo string, githubRepoID int64) (db.GithubSyncedRepo, bool, error) {
	if s == nil || s.store == nil {
		return db.GithubSyncedRepo{}, false, nil
	}
	if strings.TrimSpace(owner) == "" || strings.TrimSpace(repo) == "" {
		return db.GithubSyncedRepo{}, false, nil
	}
	row, err := s.store.GetGitHubSyncedRepo(ctx, db.GetGitHubSyncedRepoParams{OwnerLogin: owner, RepoName: repo})
	if err != nil {
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			return db.GithubSyncedRepo{}, false, err
		}
		if githubRepoID <= 0 {
			return db.GithubSyncedRepo{}, false, nil
		}
		row, err = s.store.GetGitHubSyncedRepoByGitHubID(ctx, nullableSyncedRepoInt64(githubRepoID))
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return db.GithubSyncedRepo{}, false, nil
			}
			return db.GithubSyncedRepo{}, false, err
		}
		adopted, adoptErr := s.store.AdoptGitHubSyncedRepoSlug(ctx, db.AdoptGitHubSyncedRepoSlugParams{
			OwnerLogin: owner,
			RepoName:   repo,
			ID:         row.ID,
		})
		if adoptErr != nil {
			// Most likely a unique-slug collision (a different row already claims
			// the new name). Keep serving under the old row; an operator untangles.
			slog.Warn("github synced repo rename detected but slug not adopted",
				"old_owner", row.OwnerLogin, "old_repo", row.RepoName,
				"new_owner", owner, "new_repo", repo, "error", adoptErr)
		} else {
			slog.Info("github synced repo slug adopted after rename/transfer",
				"old_owner", row.OwnerLogin, "old_repo", row.RepoName,
				"new_owner", owner, "new_repo", repo)
			row = adopted
		}
	}
	if row.SyncState == "disabled" {
		return db.GithubSyncedRepo{}, false, nil
	}
	return row, true, nil
}

// ---- helpers -------------------------------------------------------------

// storeServableGitHubMetadataQuery reports whether a request matches the shape
// the store models. Anything narrower (label/head/base filters, a sort the
// stored ordering does not reproduce) proxies live.
func storeServableGitHubMetadataQuery(query url.Values) bool {
	for _, key := range []string{"labels", "head", "base"} {
		if strings.TrimSpace(query.Get(key)) != "" {
			return false
		}
	}
	if sort := strings.TrimSpace(query.Get("sort")); sort != "" && sort != "updated" {
		return false
	}
	if direction := strings.TrimSpace(query.Get("direction")); direction != "" && direction != "desc" {
		return false
	}
	return true
}

// storeMetadataStateFilter mirrors GitHub's default (open) when unspecified.
func storeMetadataStateFilter(query url.Values) string {
	switch state := strings.TrimSpace(query.Get("state")); state {
	case "closed", "all", "open":
		return state
	default:
		return "open"
	}
}

func storeMetadataPaging(query url.Values) (limit int32, offset int32, page int, perPage int) {
	page = 1
	if raw := strings.TrimSpace(query.Get("page")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			page = parsed
		}
	}
	if raw := strings.TrimSpace(query.Get("cursor")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			page = parsed
		}
	}
	perPage = githubSyncedRepoDefaultPerPage
	if raw := strings.TrimSpace(query.Get("per_page")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			perPage = parsed
		}
	}
	if perPage > githubSyncedRepoBackfillPageSize {
		perPage = githubSyncedRepoBackfillPageSize
	}
	return int32(perPage), int32((page - 1) * perPage), page, perPage
}

// encodeSyncedIssuePayloads splices the stored raw GitHub objects back into a
// JSON array WITHOUT re-encoding them, so the proxy's bytes stay byte-identical
// to what GitHub sent (the same contract the live passthrough holds).
func encodeSyncedIssuePayloads(rows []db.GithubSyncedIssue) (json.RawMessage, error) {
	var buf strings.Builder
	buf.WriteByte('[')
	for i, row := range rows {
		if !json.Valid(row.Payload) {
			return nil, fmt.Errorf("stored github object %d is not valid json", row.Number)
		}
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.Write(row.Payload)
	}
	buf.WriteByte(']')
	return json.RawMessage(buf.String()), nil
}

// encodeSyncedCommentPayloads is the comments twin of
// encodeSyncedIssuePayloads: same byte-identical splice contract.
func encodeSyncedCommentPayloads(rows []db.GithubSyncedIssueComment) (json.RawMessage, error) {
	var buf strings.Builder
	buf.WriteByte('[')
	for i, row := range rows {
		if !json.Valid(row.Payload) {
			return nil, fmt.Errorf("stored github comment %d is not valid json", row.GithubID)
		}
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.Write(row.Payload)
	}
	buf.WriteByte(']')
	return json.RawMessage(buf.String()), nil
}

func normalizeSyncedIssueState(state string) string {
	if strings.EqualFold(strings.TrimSpace(state), "closed") {
		return "closed"
	}
	return "open"
}

func parseGitHubTimestamp(value string) pgtype.Timestamptz {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return pgtype.Timestamptz{}
	}
	parsed, err := time.Parse(time.RFC3339, trimmed)
	if err != nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: parsed, Valid: true}
}

func nullableSyncedRepoInt64(value int64) pgtype.Int8 {
	if value <= 0 {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: value, Valid: true}
}

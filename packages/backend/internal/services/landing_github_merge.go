package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// A send-upstream landing is delivered as GitHub pull request
// smithers/landing-<n>. Every synced GitHub main pull of a `mirror: "pull"`
// repository reconciles its open landings: one whose pull request GitHub
// merged at the landing's exact tip is merged with GitHub's merge commit as
// its receipt. Smithers main is not written here; the pull brings it in. The
// pull runs after every GitHub push and on its poll, so a missed webhook is
// caught, and a failed reconciliation is retried by the next pull.

// landingGitHubMergeLimit bounds the open landings one pull reconciles; the
// next pulls continue through the rest, then start again at the newest.
const landingGitHubMergeLimit = int32(50)

var landingGitHubMergePermissions = map[string]string{"pull_requests": "read"}

type landingGitHubMergeStore interface {
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
	ListOpenLandingNumbers(ctx context.Context, repositoryID, before int64, limit int32) ([]int64, error)
	GetLandingRequestWithChangeIDsByNumber(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error)
	MergeLandingRequestFromGitHub(ctx context.Context, arg db.MergeLandingRequestFromGitHubParams) (db.LandingGitHubMerge, error)
	FixIssuesForLanding(ctx context.Context, arg db.FixIssuesForLandingParams) ([]int64, error)
}

type landingGitHubMergeHost interface {
	GetChange(ctx context.Context, owner, repo, changeID string) (repohost.Change, error)
}

type landingGitHubMergePulls interface {
	Find(ctx context.Context, token, owner, repo, branch string) (*landingGitHubPullRequest, error)
}

// LandingGitHubMergeService merges landings whose GitHub pull request merged.
type LandingGitHubMergeService struct {
	store      landingGitHubMergeStore
	host       landingGitHubMergeHost
	tokens     LandingGitHubPullTokens
	github     landingGitHubMergePulls
	dispatcher webhooks.Dispatcher
	logger     *slog.Logger
	// cursors holds, per repository, the landing number the next page starts below.
	cursors sync.Map
}

func NewLandingGitHubMergeService(store landingGitHubMergeStore, host landingGitHubMergeHost, tokens LandingGitHubPullTokens, dispatcher webhooks.Dispatcher) *LandingGitHubMergeService {
	return &LandingGitHubMergeService{store: store, host: host, tokens: tokens, dispatcher: dispatcher, logger: slog.Default(),
		github: &landingGitHubAPI{client: observability.NewHTTPClient(30 * time.Second), baseURL: githubAPIBaseURL}}
}

// Reconcile runs after a synced main pull of repositoryID from
// githubRepository ("owner/repo"), whose followed branch is branch.
func (s *LandingGitHubMergeService) Reconcile(ctx context.Context, repositoryID int64, githubRepository, branch string) {
	if err := s.reconcile(ctx, repositoryID, githubRepository, branch); err != nil && ctx.Err() == nil {
		s.logger.Warn("github.landing_merge.failed", "repository_id", repositoryID, "github_repository", githubRepository, "error", err)
	}
}

func (s *LandingGitHubMergeService) reconcile(ctx context.Context, repositoryID int64, githubRepository, branch string) error {
	ghOwner, ghRepo, ok := strings.Cut(githubRepository, "/")
	if s == nil || s.store == nil || !ok || ghOwner == "" || ghRepo == "" || branch == "" {
		return nil
	}
	before, _ := s.cursors.Load(repositoryID)
	start, _ := before.(int64)
	numbers, err := s.store.ListOpenLandingNumbers(ctx, repositoryID, start, landingGitHubMergeLimit)
	if err != nil {
		return err
	}
	if len(numbers) < int(landingGitHubMergeLimit) {
		s.cursors.Delete(repositoryID)
	} else {
		s.cursors.Store(repositoryID, numbers[len(numbers)-1])
	}
	if len(numbers) == 0 {
		return nil
	}
	repository, err := s.store.GetRepoByID(ctx, repositoryID)
	if err != nil {
		return fmt.Errorf("load repository: %w", err)
	}
	owner, err := repositoryOwnerName(ctx, s.store, repository)
	if err != nil {
		return err
	}
	if s.tokens == nil {
		return nil
	}
	installation, err := s.tokens.CreateGitHubInstallationTokenForRepositoryOwner(ctx, repository.UserID.Int64, repository.OrgID.Int64, ghOwner, ghRepo, landingGitHubMergePermissions)
	if err != nil {
		return fmt.Errorf("github installation token: %w", err)
	}
	if strings.TrimSpace(installation.Token) == "" {
		return nil
	}
	var failures []error
	for _, number := range numbers {
		if err := s.reconcileLanding(ctx, repository, owner, number, installation.Token, ghOwner, ghRepo, branch); err != nil {
			failures = append(failures, fmt.Errorf("landing %d: %w", number, err))
		}
	}
	return stdErrors.Join(failures...)
}

func (s *LandingGitHubMergeService) reconcileLanding(ctx context.Context, repository db.Repository, owner string, number int64, token, ghOwner, ghRepo, branch string) error {
	pull, err := s.github.Find(ctx, token, ghOwner, ghRepo, LandingGitHubPullBranch(number))
	if err != nil || pull == nil || pull.MergedAt == nil {
		return err
	}
	log := s.logger.With("repository_id", repository.ID, "landing", number, "github_repository", ghOwner+"/"+ghRepo, "pull", pull.Number)
	if pull.MergeCommitSHA == nil || !immutableLandingCommit(*pull.MergeCommitSHA) || !immutableLandingCommit(pull.Head.SHA) {
		return fmt.Errorf("GitHub pull request #%d has no merge receipt", pull.Number)
	}
	landing, err := s.store.GetLandingRequestWithChangeIDsByNumber(ctx, db.GetLandingRequestWithChangeIDsByNumberParams{RepositoryID: repository.ID, Number: number})
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if landing.State != landingStateOpen || len(landing.ChangeIds) == 0 {
		return nil
	}
	if pull.Base.Ref != branch || landing.TargetBookmark != branch {
		log.Info("github.landing_merge.skipped", "reason", "pull request base is not the landing target")
		return nil
	}
	// The landed revisions are the stack GitHub merged, read from repo-host.
	revisions := make(map[string]string, len(landing.ChangeIds))
	tip := ""
	for _, changeID := range landing.ChangeIds {
		change, err := s.host.GetChange(ctx, owner, repository.Name, changeID)
		if err != nil {
			return fmt.Errorf("resolve change %s: %w", changeID, err)
		}
		revisions[changeID], tip = change.CommitID, change.CommitID
	}
	if tip != pull.Head.SHA {
		log.Warn("github.landing_merge.skipped", "reason", "landing tip moved", "head_sha", pull.Head.SHA, "tip", tip)
		return nil
	}
	encoded, err := json.Marshal(revisions)
	if err != nil {
		return err
	}
	// Linked issues are fixed first: the fix is idempotent, and a landing
	// that stays open is reconciled again by the next pull.
	if _, err := s.store.FixIssuesForLanding(ctx, db.FixIssuesForLandingParams{LandingRequestID: landing.ID,
		FixedByID: pgtype.Int8{Int64: landing.AuthorID, Valid: true}, FixedByAgentSessionID: uuidString(landing.AuthorAgentSessionID)}); err != nil {
		return fmt.Errorf("fix issues: %w", err)
	}
	receipt, err := s.store.MergeLandingRequestFromGitHub(ctx, db.MergeLandingRequestFromGitHubParams{LandingRequestID: landing.ID,
		GithubRepository: ghOwner + "/" + ghRepo, PullNumber: pull.Number, HeadSha: pull.Head.SHA, MergeCommit: *pull.MergeCommitSHA,
		Revisions: encoded})
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("merge: %w", err)
	}
	log.Info("github.landing_merge.recorded", "merge_commit", receipt.MergeCommit)
	dispatchLandingLandedEvent(ctx, s.dispatcher, s.store, s.logger, repository, owner, db.LandingRequest{ID: landing.ID, Number: landing.Number,
		Title: landing.Title, Body: landing.Body, State: landingStateMerged, AuthorID: landing.AuthorID, TargetBookmark: landing.TargetBookmark,
		ConflictStatus: landing.ConflictStatus, StackSize: landing.StackSize, CreatedAt: landing.CreatedAt, UpdatedAt: landing.UpdatedAt},
		landing.ChangeIds)
	return nil
}

package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/gitutil"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// A repository whose declared GitHub policy is `mirror: "pull"` has one
// writer of main: GitHub. When GitHub's branch named by the Smithers default
// bookmark moves, Smithers fast-forwards that bookmark to exactly GitHub's tip
// and writes nothing else. See github_main_pulls (migration 0024).

const (
	gitHubMainPullStateSynced  = "synced"
	gitHubMainPullStateSkipped = "skipped"
	gitHubMainPullStateFailed  = "failed"

	gitHubMainPullPolicyPull       = "pull"
	gitHubMainPullPolicyUndeclared = "undeclared"

	gitHubMainPullInterval       = 5 * time.Second
	gitHubMainPullPollInterval   = 5 * time.Minute
	gitHubMainPullSkippedRecheck = 6 * time.Hour
	// An install has no public address, so its main follows GitHub's by
	// polling alone, within a minute (mvp.md §9): its refs are read again
	// 30 s after the last read, and the sweep that makes them due runs
	// every 10 s.
	gitHubMainPullInstallPollInterval  = 30 * time.Second
	gitHubMainPullInstallSweepInterval = 10 * time.Second
	gitHubMainPullDiscoverLimit        = int32(50)
	// The lease outlives the run deadline, which cancels every subprocess and
	// the in-process push, so a stale owner cannot write after a takeover.
	gitHubMainPullLease         = 15 * time.Minute
	gitHubMainPullTimeout       = 10 * time.Minute
	gitHubMainPullLeaseMargin   = time.Minute
	gitHubMainPullMinimumRun    = time.Minute
	gitHubMainPullClaimLimit    = int32(4)
	gitHubMainPullSyncedTimeout = 2 * time.Minute
	gitHubMainPullBaseBackoff   = 30 * time.Second
	gitHubMainPullMaxBackoff    = 30 * time.Minute
	gitHubMainPullFactoryPath   = ".smithers/factory.json"
	gitHubMainPullFactoryLimit  = 4 << 20
	defaultGitHubRawBaseURL     = "https://raw.githubusercontent.com"
)

// GitHubMainPullStore is the durable state and repository lookup the pull uses.
type GitHubMainPullStore interface {
	gitHubDestinationStore
	RequestGithubMainPull(ctx context.Context, repositoryID int64) (db.GithubMainPull, error)
	GetGithubMainPull(ctx context.Context, repositoryID int64) (db.GithubMainPull, error)
	ClaimGithubMainPulls(ctx context.Context, limit int32, leaseSeconds float64) ([]db.GithubMainPull, error)
	FinishGithubMainPull(ctx context.Context, arg db.FinishGithubMainPullParams) (int64, error)
	RequestStaleGithubMainPulls(ctx context.Context, pullOlderThanSeconds, skippedOlderThanSeconds float64) (int64, error)
	RequestUntrackedGithubMainPulls(ctx context.Context, limit int32) (int64, error)
	ListRepositoryIDsForGitHubSource(ctx context.Context, owner, repo string) ([]int64, error)
	IsGithubMainPullMirror(ctx context.Context, owner, repo string) (bool, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
}

// GitHubMainPullTokens mints the repository owner's GitHub App installation
// token for its GitHub source. *RepoConnectionService implements it. Without
// one, a public source is read anonymously, which also proves it is public now.
type GitHubMainPullTokens interface {
	CreateGitHubInstallationTokenForRepositoryOwner(ctx context.Context, ownerUserID, ownerOrgID int64, owner, repo string, permissions map[string]string) (GitHubInstallationToken, error)
}

// GitHubMainPullStatus is the receipt of a repository's last observation.
// Fresh means that observation found Smithers equal to GitHub with nothing
// requested since; it is not a live comparison.
type GitHubMainPullStatus struct {
	State            string     `json:"state"`
	GitHubRepository string     `json:"github_repository"`
	Branch           string     `json:"branch"`
	Policy           string     `json:"policy"`
	PolicyCommit     string     `json:"policy_commit"`
	GitHubHead       string     `json:"github_head"`
	SmithersHead     string     `json:"smithers_head"`
	Pending          bool       `json:"pending"`
	Fresh            bool       `json:"fresh"`
	Attempts         int32      `json:"attempts"`
	FactoryState     string     `json:"factory_state"`
	FactoryError     string     `json:"factory_error"`
	LastError        string     `json:"last_error"`
	NextAttemptAt    *time.Time `json:"next_attempt_at"`
	LastCheckedAt    *time.Time `json:"last_checked_at"`
	LastSyncedAt     *time.Time `json:"last_synced_at"`
}

type GitHubMainPullService struct {
	// install is the install's GitHub sync (UseInstallPolicy): it always
	// follows, polls on the install cadence and serves its health.
	install     bool
	syncStreams GitHubSyncStreams

	reconcileFactory func(context.Context, int64, string, FactoryProjection) error
	readFactory      func(context.Context, string, string, string, string) ([]byte, error)
	store            GitHubMainPullStore
	host             gitHubMainPullRepoHost
	tokens           GitHubMainPullTokens
	connections      RepoSyncConnectionChecker
	logger           *slog.Logger

	gitHubGitBaseURL func() string
	lsRemote         func(ctx context.Context, remote, ref string) (string, error)
	readPolicy       func(ctx context.Context, token, owner, repo, commit string) (string, error)
	git              gitHubMainPullGit
	now              func() time.Time
	// mainMoved hears every pull that moved Smithers main (the mythical
	// stack folds it).
	mainMoved func(ctx context.Context, repositoryID int64)
	// synced hears every pull that observed main equal to GitHub (open
	// landings whose pull requests merged are reconciled).
	synced func(ctx context.Context, repositoryID int64, githubRepository, branch string)
	// syncing holds the repositories whose synced listener is running.
	syncing sync.Map
	// issueEvents is the install's issue-events stream (SetIssueEvents):
	// each followed repository's read, run from Start every
	// issueEventsEvery; issueEventsRead holds each repository's last turn.
	issueEvents      func(ctx context.Context, repositoryID int64) error
	issueEventsEvery time.Duration
	issueEventsRead  map[int64]time.Time
}

// SetFactoryReconciler registers owner-main declaration reconciliation. Failures
// have an independent receipt and retry on the next pull observation.
func (s *GitHubMainPullService) SetFactoryReconciler(reconcile func(context.Context, int64, string, FactoryProjection) error) {
	s.reconcileFactory = reconcile
}

// SetSynced registers the listener for every synced pull.
func (s *GitHubMainPullService) SetSynced(listener func(ctx context.Context, repositoryID int64, githubRepository, branch string)) {
	s.synced = listener
}

// SetMainMoved registers the listener for pulls that moved main.
func (s *GitHubMainPullService) SetMainMoved(listener func(ctx context.Context, repositoryID int64)) {
	s.mainMoved = listener
}

// gitHubMainPullGit is the transfer, in a disposable bare repository.
type gitHubMainPullGit interface {
	// Fetch takes a depth-1 base of the Smithers ref and GitHub's ref on top
	// of it, and returns both commits.
	Fetch(ctx context.Context, dir, smithersURL, githubURL, ref string) (base, tip string, err error)
	IsAncestor(ctx context.Context, dir, ancestor, descendant string) (bool, error)
	Push(ctx context.Context, dir, smithersURL, commit, ref string) error
}

func NewGitHubMainPullService(store GitHubMainPullStore, host gitHubMainPullRepoHost, tokens GitHubMainPullTokens, connections RepoSyncConnectionChecker) *GitHubMainPullService {
	client := gitHubProviderClient(tokens, 30*time.Second)
	return &GitHubMainPullService{
		store: store, host: host, tokens: tokens, connections: connections, logger: slog.Default(),
		gitHubGitBaseURL: githubGitBaseURL,
		readFactory: func(ctx context.Context, token, owner, repo, commit string) ([]byte, error) {
			return readGitHubFactory(ctx, client, githubAPIBaseURL(), defaultGitHubRawBaseURL, token, owner, repo, commit)
		},
		lsRemote: defaultLsRemoteRef,
		readPolicy: func(ctx context.Context, token, owner, repo, commit string) (string, error) {
			return readGitHubMirrorPolicy(ctx, client, githubAPIBaseURL(), defaultGitHubRawBaseURL, token, owner, repo, commit)
		},
		git: cliGitHubMainPullGit{},
		now: time.Now,
	}
}

// RequestForGitHub requests a pull for every Smithers repository whose
// recorded GitHub source is owner/repo. The worker decides whether to write.
func (s *GitHubMainPullService) RequestForGitHub(ctx context.Context, owner, repo string) error {
	if s == nil || s.store == nil {
		return nil
	}
	ids, err := s.store.ListRepositoryIDsForGitHubSource(ctx, owner, repo)
	if err != nil {
		return fmt.Errorf("resolve repositories for github %s/%s: %w", owner, repo, err)
	}
	for _, id := range ids {
		if _, err := s.store.RequestGithubMainPull(ctx, id); err != nil {
			return fmt.Errorf("request main pull for repository %d: %w", id, err)
		}
	}
	return nil
}

// Request asks for a pull of one repository now and returns its status.
func (s *GitHubMainPullService) Request(ctx context.Context, repositoryID int64) (GitHubMainPullStatus, error) {
	if s == nil || s.store == nil {
		return GitHubMainPullStatus{}, pkgerrors.Internal("github main pull is not configured")
	}
	row, err := s.store.RequestGithubMainPull(ctx, repositoryID)
	if err != nil {
		return GitHubMainPullStatus{}, pkgerrors.Internal("failed to request github main pull").WithCause(err)
	}
	return gitHubMainPullStatus(row), nil
}

// Status returns the repository's pull receipt; a repository never requested
// reports state "none".
func (s *GitHubMainPullService) Status(ctx context.Context, repositoryID int64) (GitHubMainPullStatus, error) {
	if s == nil || s.store == nil {
		return GitHubMainPullStatus{}, pkgerrors.Internal("github main pull is not configured")
	}
	row, err := s.store.GetGithubMainPull(ctx, repositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return GitHubMainPullStatus{State: "none"}, nil
	}
	if err != nil {
		return GitHubMainPullStatus{}, pkgerrors.Internal("failed to load github main pull").WithCause(err)
	}
	return gitHubMainPullStatus(row), nil
}

// PullPolicyRecorded reports whether the last evaluation found `mirror: "pull"`.
func (s *GitHubMainPullService) PullPolicyRecorded(ctx context.Context, repositoryID int64) (bool, error) {
	if s == nil || s.store == nil {
		return false, nil
	}
	row, err := s.store.GetGithubMainPull(ctx, repositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return row.Policy == gitHubMainPullPolicyPull, nil
}

// PullsBranch reports whether the last evaluation found `mirror: "pull"` and
// pulled GitHub's branch of this name, so the pull's own push starts that
// branch's runs.
func (s *GitHubMainPullService) PullsBranch(ctx context.Context, repositoryID int64, branch string) (bool, error) {
	if s == nil || s.store == nil {
		return false, nil
	}
	row, err := s.store.GetGithubMainPull(ctx, repositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return row.Policy == gitHubMainPullPolicyPull && row.Branch == branch, nil
}

// PullMirror reports whether the Smithers repository owner/repo follows
// GitHub; no sync feed advertises ref sync for such repositories.
func (s *GitHubMainPullService) PullMirror(ctx context.Context, owner, repo string) (bool, error) {
	if s == nil || s.store == nil {
		return false, nil
	}
	return s.store.IsGithubMainPullMirror(ctx, owner, repo)
}

func gitHubMainPullStatus(row db.GithubMainPull) GitHubMainPullStatus {
	status := GitHubMainPullStatus{State: row.State, GitHubRepository: row.GithubRepository, Branch: row.Branch, Policy: row.Policy,
		PolicyCommit: row.PolicyCommit, GitHubHead: row.GithubHead, SmithersHead: row.SmithersHead,
		Pending: row.RequestedGeneration > row.SyncedGeneration, Attempts: row.Attempts, LastError: row.LastError,
		FactoryState: row.FactoryState, FactoryError: row.FactoryError}
	status.Fresh = !status.Pending && row.State == gitHubMainPullStateSynced && row.Policy == gitHubMainPullPolicyPull &&
		row.GithubHead != "" && row.GithubHead == row.SmithersHead
	if row.NextAttemptAt.Valid && status.Pending {
		at := row.NextAttemptAt.Time
		status.NextAttemptAt = &at
	}
	if row.LastCheckedAt.Valid {
		at := row.LastCheckedAt.Time
		status.LastCheckedAt = &at
	}
	if row.LastSyncedAt.Valid {
		at := row.LastSyncedAt.Time
		status.LastSyncedAt = &at
	}
	return status
}

// Start drains due pulls and periodically re-checks and discovers
// repositories, so a missed webhook or enrollment is caught by the poll.
func (s *GitHubMainPullService) Start(ctx context.Context) {
	sweepEvery := gitHubMainPullPollInterval
	if s.install {
		sweepEvery = gitHubMainPullInstallSweepInterval
	}
	lastPoll := time.Time{}
	for {
		if s.now().Sub(lastPoll) >= sweepEvery {
			s.Sweep(ctx)
			lastPoll = s.now()
		}
		if err := s.PollOnce(ctx); err != nil && ctx.Err() == nil {
			s.logger.Error("github.main_pull.claim_failed", "error", err)
		}
		s.readIssueEvents(ctx)
		select {
		case <-ctx.Done():
			return
		case <-time.After(gitHubMainPullInterval):
		}
	}
}

// Sweep re-requests stale pull and skipped rows and starts tracking
// GitHub-sourced repositories that have never been evaluated.
func (s *GitHubMainPullService) Sweep(ctx context.Context) {
	pollEvery := gitHubMainPullPollInterval
	if s.install {
		pollEvery = gitHubMainPullInstallPollInterval
	}
	if _, err := s.store.RequestStaleGithubMainPulls(ctx, pollEvery.Seconds(), gitHubMainPullSkippedRecheck.Seconds()); err != nil && ctx.Err() == nil {
		s.logger.Error("github.main_pull.poll_failed", "error", err)
	}
	if _, err := s.store.RequestUntrackedGithubMainPulls(ctx, gitHubMainPullDiscoverLimit); err != nil && ctx.Err() == nil {
		s.logger.Error("github.main_pull.discover_failed", "error", err)
	}
}

// PollOnce claims and runs due pulls one at a time. Each claim is taken
// immediately before its run, so the run deadline always ends inside its
// lease.
func (s *GitHubMainPullService) PollOnce(ctx context.Context) error {
	for range gitHubMainPullClaimLimit {
		if ctx.Err() != nil {
			return nil
		}
		rows, err := s.store.ClaimGithubMainPulls(ctx, 1, gitHubMainPullLease.Seconds())
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}
		s.runClaimed(ctx, rows[0])
	}
	return nil
}

// gitHubMainPullOutcome is what one run records.
type gitHubMainPullOutcome struct {
	forcePush *GitHubMainForcePush

	state, githubRepository, branch, policy, policyCommit, githubHead, smithersHead, err string
	// resetPolicy forgets the recorded source/policy tuple, so a policy is
	// never reused for a source it was not read from.
	factoryState, factoryError string
	resetPolicy                bool
}

func (s *GitHubMainPullService) runClaimed(parent context.Context, row db.GithubMainPull) {
	// The run ends a margin before its lease does. A claim that arrives
	// already too close to expiry (a delayed response, a paused process) is
	// not run: another replica may claim it, and this one writes nothing.
	deadline := s.now().Add(gitHubMainPullTimeout)
	if row.LeaseExpiresAt.Valid {
		if leaseEnd := row.LeaseExpiresAt.Time.Add(-gitHubMainPullLeaseMargin); leaseEnd.Before(deadline) {
			deadline = leaseEnd
		}
	}
	if !deadline.After(s.now().Add(gitHubMainPullMinimumRun)) {
		s.logger.Warn("github.main_pull.claim_expired", "repository_id", row.RepositoryID, "claim", row.Claim)
		return
	}
	ctx, cancel := context.WithDeadline(parent, deadline)
	defer cancel()
	var outcome gitHubMainPullOutcome
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				outcome = gitHubMainPullOutcome{state: gitHubMainPullStateFailed, err: "internal error"}
				s.logger.Error("github.main_pull.panic", "repository_id", row.RepositoryID, "panic", recovered)
			}
		}()
		outcome = s.pull(ctx, row)
	}()
	backoff := gitHubMainPullBackoff(row.Attempts)
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer finishCancel()
	written, err := s.store.FinishGithubMainPull(finishCtx, db.FinishGithubMainPullParams{
		RepositoryID: row.RepositoryID, Claim: row.Claim, State: outcome.state, GithubRepository: outcome.githubRepository,
		Branch: outcome.branch, Policy: outcome.policy, PolicyCommit: outcome.policyCommit, GithubHead: outcome.githubHead,
		SmithersHead: outcome.smithersHead, Error: outcome.err, FactoryState: outcome.factoryState, FactoryError: outcome.factoryError, BackoffSeconds: backoff.Seconds(), ResetPolicy: outcome.resetPolicy,
	})
	switch {
	case err != nil:
		s.logger.Error("github.main_pull.finish_failed", "repository_id", row.RepositoryID, "error", err)
	case written == 0:
		s.logger.Warn("github.main_pull.claim_lost", "repository_id", row.RepositoryID, "claim", row.Claim)
	case s.mainMoved != nil && outcome.state == gitHubMainPullStateSynced && outcome.smithersHead != "" && outcome.smithersHead != row.SmithersHead:
		s.mainMoved(finishCtx, row.RepositoryID)
	}
	if err == nil && written > 0 && outcome.state == gitHubMainPullStateSynced {
		s.notifySynced(parent, row.RepositoryID, outcome.githubRepository, outcome.branch)
	}
	attrs := []any{"repository_id", row.RepositoryID, "github", outcome.githubRepository, "state", outcome.state,
		"policy", outcome.policy, "github_head", outcome.githubHead, "smithers_head", outcome.smithersHead}
	if outcome.state == gitHubMainPullStateFailed {
		s.logger.Warn("github.main_pull.failed", append(attrs, "attempts", row.Attempts, "retry_in", backoff.String(), "error", outcome.err)...)
	} else {
		s.logger.Info("github.main_pull."+outcome.state, attrs...)
	}
}

// notifySynced runs the synced listener beside the pull worker, so it never
// delays another repository's pull. A repository whose listener is still
// running is skipped; its next synced pull runs it again.
func (s *GitHubMainPullService) notifySynced(parent context.Context, repositoryID int64, githubRepository, branch string) {
	if s.synced == nil {
		return
	}
	if _, running := s.syncing.LoadOrStore(repositoryID, struct{}{}); running {
		return
	}
	go func() {
		defer s.syncing.Delete(repositoryID)
		ctx, cancel := context.WithTimeout(parent, gitHubMainPullSyncedTimeout)
		defer cancel()
		s.synced(ctx, repositoryID, githubRepository, branch)
	}()
}

func gitHubMainPullBackoff(attempts int32) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	if attempts > 16 {
		return gitHubMainPullMaxBackoff
	}
	backoff := gitHubMainPullBaseBackoff << uint(attempts-1)
	if backoff > gitHubMainPullMaxBackoff {
		return gitHubMainPullMaxBackoff
	}
	return backoff
}

// pull performs one observation. It targets GitHub's tip read now, never a
// webhook's `after`, so duplicate and out-of-order deliveries converge.
func (s *GitHubMainPullService) pull(ctx context.Context, row db.GithubMainPull) gitHubMainPullOutcome {
	out := gitHubMainPullOutcome{}
	fail := func(message string) gitHubMainPullOutcome {
		out.state, out.err = gitHubMainPullStateFailed, message
		return out
	}
	repository, err := s.store.GetRepoByID(ctx, row.RepositoryID)
	if err != nil {
		return fail("load repository: " + err.Error())
	}
	owner, err := repositoryOwnerName(ctx, s.store, repository)
	if err != nil {
		return fail(err.Error())
	}
	githubOwner, githubRepo, err := resolveGitHubDestination(ctx, s.store, s.connections, repository.UserID.Int64, repository.ID, owner, repository.Name)
	if err != nil {
		var apiErr *pkgerrors.APIError
		if errors.As(err, &apiErr) && apiErr.Status < 500 {
			out.state, out.err, out.resetPolicy = gitHubMainPullStateSkipped, apiErr.Message, true
			return out
		}
		return fail("resolve GitHub source: " + err.Error())
	}
	out.githubRepository = githubOwner + "/" + githubRepo
	branch := strings.TrimSpace(repository.DefaultBookmark)
	if branch == "" {
		branch = "main"
	}
	out.branch = branch
	ref := "refs/heads/" + branch

	token := s.readToken(ctx, repository, githubOwner, githubRepo)
	githubURL, err := gitMirrorURL(s.gitHubGitBaseURL(), token, githubOwner, githubRepo)
	if err != nil {
		return fail("build GitHub URL: " + err.Error())
	}
	githubHead, err := s.lsRemote(ctx, githubURL, ref)
	if err != nil {
		return fail("read GitHub " + branch + ": " + sanitizeMirrorError(err, githubURL))
	}
	if githubHead == "" {
		return fail("GitHub " + out.githubRepository + " has no " + branch + " branch")
	}
	out.githubHead = githubHead
	smithersHead, err := s.bookmarkCommit(ctx, owner, repository.Name, branch)
	if err != nil {
		return fail("read Smithers " + branch + ": " + err.Error())
	}
	if smithersHead == "" {
		return fail("Smithers has no " + branch + " bookmark")
	}
	out.smithersHead = smithersHead
	policy := func(commit string) (string, bool) {
		if s.install {
			out.policy, out.policyCommit = gitHubMainPullPolicyPull, commit
			return gitHubMainPullPolicyPull, true
		}
		if row.PolicyCommit == commit && row.Policy != "" && row.GithubRepository == out.githubRepository {
			out.policy, out.policyCommit = row.Policy, commit
			return row.Policy, true
		}
		value, err := s.readPolicy(ctx, token, githubOwner, githubRepo, commit)
		if err != nil {
			fail("read the declared GitHub policy: " + sanitizeMirrorError(err, githubURL))
			return "", false
		}
		out.policy, out.policyCommit = value, commit
		return value, true
	}
	// The policy is evaluated once per GitHub tip, before any transfer, so a
	// first request or a policy change is recorded even when nothing moves,
	// and a repository that does not follow GitHub costs no fetch.
	declared, ok := policy(githubHead)
	if !ok {
		return out
	}
	if declared != gitHubMainPullPolicyPull {
		out.state = gitHubMainPullStateSkipped
		return out
	}
	reconcile := func(revision string) {
		if s.reconcileFactory == nil {
			return
		}
		// The install reads main every 30 s; a commit it reconciled is not
		// read again. A failed reconciliation retries on the next read.
		if s.install && row.PolicyCommit == revision && row.FactoryState != "" && row.FactoryState != "failed" {
			return
		}
		// Factory failures must not invalidate an observed or completed ref sync.
		// Keep their receipt separate, including a panic in an injected reconciler.
		out.factoryState = "failed"
		defer func() {
			if recovered := recover(); recovered != nil {
				out.factoryError = "internal factory error"
				s.logger.ErrorContext(ctx, "github.main_pull.factory_panic", "repository_id", repository.ID, "panic", recovered)
			}
		}()
		raw, err := s.readFactory(ctx, token, githubOwner, githubRepo, revision)
		if err != nil {
			out.factoryError = sanitizeMirrorError(err, githubURL)
			return
		}
		var projection FactoryProjection
		if len(raw) > 0 {
			if err = json.Unmarshal(raw, &projection); err != nil {
				out.factoryError = "invalid factory projection"
				return
			}
		}
		err = s.reconcileFactory(ctx, repository.ID, revision, projection)
		switch {
		case errors.Is(err, ErrFactoryNeedsOwner):
			out.factoryState, out.factoryError = "skipped", err.Error()
		case err != nil:
			out.factoryError = sanitizeMirrorError(err, githubURL)
		case len(projection.On) == 0:
			out.factoryState = "empty"
		default:
			out.factoryState, out.factoryError = "reconciled", factoryWarningsMessage(factoryWarnings(projection))
		}
	}
	if githubHead == smithersHead {
		reconcile(githubHead)
		out.state = gitHubMainPullStateSynced
		return out
	}

	dir, err := os.MkdirTemp("", "smithers-main-pull-")
	if err != nil {
		return fail("create pull directory: " + err.Error())
	}
	defer func() { _ = os.RemoveAll(dir) }()
	// The write is bound under repo-host's lock to this repository: a deleted
	// or transferred repository's name can be reused.
	verify := RepositoryStillAt(s.store, repository.ID, owner, repository.Name)
	bridge, err := startGitHubMainPullBridge(ctx, s.host, owner, repository.Name, gitHubMainPullUpdate{repositoryID: repository.ID, ref: ref, old: smithersHead, writer: s.mainWriter()}, verify)
	if err != nil {
		return fail(err.Error())
	}
	defer bridge.Close()
	bridgeURL := bridge.URL()
	sanitize := func(err error) string { return sanitizeMirrorError(err, githubURL, bridgeURL) }

	base, tip, err := s.git.Fetch(ctx, dir, bridgeURL, githubURL, ref)
	if err != nil {
		return fail("fetch: " + sanitize(err))
	}
	if base != smithersHead {
		return fail("Smithers " + branch + " moved during the pull; retrying")
	}
	// The tip actually fetched is what is pulled; GitHub may have moved
	// since ls-remote.
	if tip != githubHead {
		out.githubHead = tip
		if declared, ok = policy(tip); !ok {
			return out
		}
		if declared != gitHubMainPullPolicyPull {
			out.state = gitHubMainPullStateSkipped
			return out
		}
	}
	ancestor, err := s.git.IsAncestor(ctx, dir, smithersHead, tip)
	if err != nil {
		return fail("compare histories: " + sanitize(err))
	}
	if !ancestor {
		if s.install {
			out.forcePush = &GitHubMainForcePush{Old: smithersHead, New: tip}
			return fail("force_push")
		}
		return fail("Smithers " + branch + " (" + smithersHead + ") is not an ancestor of GitHub " + branch + " (" + tip +
			"); it diverged and is never overwritten. Merge Smithers " + branch + " into GitHub's " + branch + ", then retry")
	}
	bridge.allow(tip)
	if err := s.git.Push(ctx, dir, bridgeURL, tip, ref); err != nil {
		return fail("push to Smithers: " + sanitize(err))
	}
	after, err := s.bookmarkCommit(ctx, owner, repository.Name, branch)
	if err != nil {
		return fail("verify Smithers " + branch + ": " + err.Error())
	}
	out.smithersHead = after
	if after != tip {
		return fail("Smithers " + branch + " did not reach GitHub's tip")
	}
	reconcile(after)
	out.state = gitHubMainPullStateSynced
	return out
}

// mainWriter is the credential the verified fast-forward presents to the
// repository host. On an install the pull is the GitHub sync, the one
// writer of main there (repohost.RequireInstallMainMirror), and presents
// the sync's authority, bound to the repository by RepositoryID and
// VerifyLocked like the import's sync token. Hosted keeps the platform's
// reviewed write, which push consumers treat as reviewed.
func (s *GitHubMainPullService) mainWriter() middleware.CredentialKind {
	if s.install {
		return middleware.CredentialSync
	}
	return middleware.CredentialPlatform
}

// repositoryOwnerName is the owner segment of a repository's Smithers path.
func repositoryOwnerName(ctx context.Context, store interface {
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
}, repository db.Repository) (string, error) {
	switch {
	case repository.UserID.Valid:
		user, err := store.GetUserByID(ctx, repository.UserID.Int64)
		if err != nil {
			return "", fmt.Errorf("load repository owner: %w", err)
		}
		return user.Username, nil
	case repository.OrgID.Valid:
		org, err := store.GetOrgByID(ctx, repository.OrgID.Int64)
		if err != nil {
			return "", fmt.Errorf("load repository owner: %w", err)
		}
		return org.Name, nil
	}
	return "", fmt.Errorf("repository %d has no owner", repository.ID)
}

// gitHubMainPullPermissions only reads the GitHub repository.
var gitHubMainPullPermissions = map[string]string{"contents": "read"}

// readToken resolves a read credential now; it is never stored.
func (s *GitHubMainPullService) readToken(ctx context.Context, repository db.Repository, owner, repo string) string {
	if s.tokens == nil {
		return ""
	}
	installation, err := s.tokens.CreateGitHubInstallationTokenForRepositoryOwner(ctx, repository.UserID.Int64, repository.OrgID.Int64, owner, repo, gitHubMainPullPermissions)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(installation.Token)
}

func (s *GitHubMainPullService) bookmarkCommit(ctx context.Context, owner, repo, name string) (string, error) {
	bookmark, _, err := repohost.LookupBookmark(ctx, s.host, owner, repo, name)
	return strings.TrimSpace(bookmark.TargetCommitID), err
}

// gitHubMainPullCommand bounds a git command by the run: after cancellation
// its pipes are closed within WaitDelay even if a transport helper lingers.
func gitHubMainPullCommand(ctx context.Context, args ...string) *exec.Cmd {
	return mirrorCommand(ctx, args...)
}

func defaultLsRemoteRef(ctx context.Context, remote, ref string) (string, error) {
	out, err := gitHubMainPullCommand(ctx, "ls-remote", "--refs", remote, ref).CombinedOutput()
	if err != nil {
		return "", gitHubMainPullCommandError("git ls-remote", err, out)
	}
	refs, err := parseRemoteRefs(string(out))
	if err != nil {
		return "", err
	}
	return refs[ref], nil
}

func gitHubMainPullCommandError(what string, err error, out []byte) error {
	detail := strings.TrimSpace(string(out))
	if len(detail) > 2048 {
		detail = detail[len(detail)-2048:]
	}
	if detail == "" {
		return fmt.Errorf("%s failed: %w", what, err)
	}
	return fmt.Errorf("%s failed: %w: %s", what, err, detail)
}

// cliGitHubMainPullGit transfers with plain git. A depth-1 base of Smithers'
// ref lets GitHub send only the new objects, and lets the push send only
// those. Measured on smithersai/smithers: ~25 MB RSS per step, versus a full
// in-memory history with git-sync.
type cliGitHubMainPullGit struct{}

func (cliGitHubMainPullGit) run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	out, err := gitHubMainPullCommand(ctx, append([]string{"--git-dir", dir}, args...)...).CombinedOutput()
	if err != nil {
		return out, gitHubMainPullCommandError("git "+args[0], err, out)
	}
	return out, nil
}

func (g cliGitHubMainPullGit) Fetch(ctx context.Context, dir, smithersURL, githubURL, ref string) (string, string, error) {
	if out, err := gitHubMainPullCommand(ctx, "init", "--quiet", "--bare", dir).CombinedOutput(); err != nil {
		return "", "", gitHubMainPullCommandError("git init", err, out)
	}
	if _, err := g.run(ctx, dir, "fetch", "--quiet", "--no-tags", "--depth=1", smithersURL, "+"+ref+":refs/pull/base"); err != nil {
		return "", "", err
	}
	// --update-shallow accepts GitHub commits whose older parents are
	// already in Smithers' history (e.g. a merged branch forked earlier).
	if _, err := g.run(ctx, dir, "fetch", "--quiet", "--no-tags", "--update-shallow", githubURL, "+"+ref+":refs/pull/tip"); err != nil {
		return "", "", err
	}
	out, err := g.run(ctx, dir, "rev-parse", "refs/pull/base", "refs/pull/tip")
	if err != nil {
		return "", "", err
	}
	lines := strings.Fields(string(out))
	if len(lines) != 2 {
		return "", "", errors.New("git rev-parse returned an unexpected result")
	}
	return lines[0], lines[1], nil
}

func (g cliGitHubMainPullGit) IsAncestor(ctx context.Context, dir, ancestor, descendant string) (bool, error) {
	return gitutil.IsAncestor(ctx, dir, ancestor, descendant, gitHubMainPullCommand)
}

// Push is not forced; the bridge also accepts only ref: base -> commit.
func (g cliGitHubMainPullGit) Push(ctx context.Context, dir, smithersURL, commit, ref string) error {
	_, err := g.run(ctx, dir, "push", "--quiet", "--no-verify", smithersURL, commit+":"+ref)
	return err
}

// readGitHubMirrorPolicy reads github.mirror from the factory projection at
// the exact commit being pulled: with the installation token through the API,
// else anonymously from raw content (a private repository answers 404 and is
// never read without a token). An absent file or field is "undeclared".
func readGitHubFactory(ctx context.Context, client *http.Client, apiBase, rawBase, token, owner, repo, commit string) ([]byte, error) {
	var endpoint string
	if token != "" {
		endpoint = strings.TrimRight(apiBase, "/") + "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo) +
			"/contents/" + gitHubMainPullFactoryPath + "?ref=" + url.QueryEscape(commit)
	} else {
		endpoint = strings.TrimRight(rawBase, "/") + "/" + url.PathEscape(owner) + "/" + url.PathEscape(repo) + "/" +
			url.PathEscape(commit) + "/" + gitHubMainPullFactoryPath
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "smithers-server")
	if token != "" {
		req.Header.Set("Accept", "application/vnd.github.raw")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New("GitHub did not answer")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub answered HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, gitHubMainPullFactoryLimit+1))
	if err != nil {
		return nil, errors.New("GitHub response could not be read")
	}
	if len(raw) > gitHubMainPullFactoryLimit {
		return nil, errors.New(gitHubMainPullFactoryPath + " exceeds its size bound")
	}
	return raw, nil
}

func readGitHubMirrorPolicy(ctx context.Context, client *http.Client, apiBase, rawBase, token, owner, repo, commit string) (string, error) {
	raw, err := readGitHubFactory(ctx, client, apiBase, rawBase, token, owner, repo, commit)
	if err != nil {
		return "", err
	}
	if len(raw) == 0 {
		return gitHubMainPullPolicyUndeclared, nil
	}
	var projection struct {
		GitHub *struct {
			Mirror string `json:"mirror"`
		} `json:"github"`
	}
	if err := json.Unmarshal(raw, &projection); err != nil {
		return "", errors.New(gitHubMainPullFactoryPath + " is not valid JSON")
	}
	if projection.GitHub == nil || projection.GitHub.Mirror == "" {
		return gitHubMainPullPolicyUndeclared, nil
	}
	switch projection.GitHub.Mirror {
	case "pull", "push", "none":
		return projection.GitHub.Mirror, nil
	default:
		return "", errors.New(gitHubMainPullFactoryPath + " declares an unknown github.mirror")
	}
}

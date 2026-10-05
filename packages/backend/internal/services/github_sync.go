package services

import (
	"context"
	"fmt"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// GitHubSyncHealth projects T-GH-02's persisted required-stream receipts; it
// replaces the install's per-repository pull status, without another store.
type GitHubSyncHealth struct {
	State         string     `json:"state"`
	LastSuccessAt *time.Time `json:"last_success_at"`
	Cause         string     `json:"cause,omitempty"`
	RetryAt       *time.Time `json:"retry_at,omitempty"`
}

// GitHubSyncStream is a required stream's persisted input, not a new receipt.
// A transport failure leaves LastSuccessAt intact; only permission and
// not_installed are refusals. RetryAt includes the shared budget pause.
type GitHubSyncStream struct {
	LastSuccessAt *time.Time
	Cause         string
	RetryAt       *time.Time
}

// GitHubSyncStreams is supplied by the existing poll/admission provider.
// Retry must durably schedule every required stream atomically, retaining
// persisted pauses and charging admission before any upstream request.
type GitHubSyncStreams interface {
	RequiredStreams(context.Context) ([]GitHubSyncStream, error)
	RetryStreams(context.Context) error
}

// gitHubMainPullReceipts are the main pull's own rows, read and requested
// as a whole; *db.Queries implements them.
type gitHubMainPullReceipts interface {
	ListGithubMainPulls(ctx context.Context) ([]db.GithubMainPull, error)
	RequestAllGithubMainPulls(ctx context.Context) (int64, error)
	RequestUntrackedGithubMainPulls(ctx context.Context, limit int32) (int64, error)
}

// gitHubMainPullStreams is the install's one required stream so far: each
// followed repository's main, read by the main pull. github_main_pulls is
// its receipt: last_synced_at is the last read that found or made the
// install's main equal to GitHub's, which a failed read leaves intact.
type gitHubMainPullStreams struct{ receipts gitHubMainPullReceipts }

func (g gitHubMainPullStreams) RequiredStreams(ctx context.Context) ([]GitHubSyncStream, error) {
	rows, err := g.receipts.ListGithubMainPulls(ctx)
	if err != nil {
		return nil, err
	}
	streams := make([]GitHubSyncStream, 0, len(rows))
	for _, row := range rows {
		var stream GitHubSyncStream
		if row.LastSyncedAt.Valid {
			at := row.LastSyncedAt.Time
			stream.LastSuccessAt = &at
		}
		streams = append(streams, stream)
	}
	return streams, nil
}

// RetryStreams makes every followed main due now, enrolling any repository
// the sweep has not reached yet; the worker reads them on its next pass.
func (g gitHubMainPullStreams) RetryStreams(ctx context.Context) error {
	if _, err := g.receipts.RequestUntrackedGithubMainPulls(ctx, gitHubMainPullDiscoverLimit); err != nil {
		return err
	}
	_, err := g.receipts.RequestAllGithubMainPulls(ctx)
	return err
}

type GitHubSyncUnavailable struct {
	Code    string `json:"code"`
	Class   string `json:"class"`
	Message string `json:"message"`
}

func (e *GitHubSyncUnavailable) Error() string { return e.Message }
func githubSyncUnavailable() error {
	return &GitHubSyncUnavailable{Code: "github_sync_unavailable", Class: "infra", Message: "GitHub sync is unavailable"}
}

// UseInstallPolicy makes the pull the install's GitHub sync: every GitHub
// repository is followed with no declaration, on the install cadence, as
// the one writer of the install's main (mainWriter), and its receipts are
// the sync's health. Plue keeps declaration-based enrollment.
// gitHubIssueEventsEvery is the install's issue-events cadence (engineering
// spec §12.2: issues and issue events every 120 s; mvp.md §6.3: issues
// within 5 minutes), and gitHubIssueEventsTimeout bounds one repository's
// read.
const (
	gitHubIssueEventsEvery   = 120 * time.Second
	gitHubIssueEventsTimeout = time.Minute
)

// SetIssueEvents registers the install's issue-events stream: read runs for
// each followed repository every `every` (gitHubIssueEventsEvery when not
// positive), from the sync's own loop. MythicalService.ReadIssueEvents is
// the read: it hands a member's todo label to the label door.
func (s *GitHubMainPullService) SetIssueEvents(read func(ctx context.Context, repositoryID int64) error, every time.Duration) {
	if every <= 0 {
		every = gitHubIssueEventsEvery
	}
	s.issueEvents, s.issueEventsEvery, s.issueEventsRead = read, every, map[int64]time.Time{}
}

// readIssueEvents runs each followed repository's issue-events read that is
// due. A failed read is logged and runs again on its next turn; it holds up
// no other repository's read.
func (s *GitHubMainPullService) readIssueEvents(ctx context.Context) {
	receipts, ok := s.store.(gitHubMainPullReceipts)
	if !s.install || s.issueEvents == nil || !ok {
		return
	}
	rows, err := receipts.ListGithubMainPulls(ctx)
	if err != nil {
		if ctx.Err() == nil {
			s.logger.Error("github.issue_events.list_failed", "error", err)
		}
		return
	}
	for _, row := range rows {
		now := s.now()
		if last, read := s.issueEventsRead[row.RepositoryID]; row.GithubRepository == "" || read && now.Sub(last) < s.issueEventsEvery {
			continue
		}
		s.issueEventsRead[row.RepositoryID] = now
		readCtx, cancel := context.WithTimeout(ctx, gitHubIssueEventsTimeout)
		err := s.issueEvents(readCtx, row.RepositoryID)
		cancel()
		if err != nil && ctx.Err() == nil {
			s.logger.Warn("github.issue_events.failed", "repository_id", row.RepositoryID, "github", row.GithubRepository, "error", err)
		}
	}
}

func (s *GitHubMainPullService) UseInstallPolicy() {
	s.install = true
	if receipts, ok := s.store.(gitHubMainPullReceipts); ok {
		s.syncStreams = gitHubMainPullStreams{receipts: receipts}
	}
}

func (s *GitHubMainPullService) SyncHealth(ctx context.Context) (GitHubSyncHealth, error) {
	if s == nil || s.syncStreams == nil {
		return GitHubSyncHealth{}, githubSyncUnavailable()
	}
	streams, err := s.syncStreams.RequiredStreams(ctx)
	if err != nil {
		return GitHubSyncHealth{}, err
	}
	if len(streams) == 0 {
		return GitHubSyncHealth{}, githubSyncUnavailable()
	}
	return aggregateGitHubSyncHealth(streams, s.now()), nil
}

func (s *GitHubMainPullService) RetrySync(ctx context.Context) error {
	if s == nil || s.syncStreams == nil {
		return githubSyncUnavailable()
	}
	return s.syncStreams.RetryStreams(ctx)
}

func aggregateGitHubSyncHealth(streams []GitHubSyncStream, now time.Time) GitHubSyncHealth {
	health := GitHubSyncHealth{State: "fresh"}
	missing, refused := len(streams) == 0, false
	for _, stream := range streams {
		if stream.LastSuccessAt == nil {
			missing = true
		} else if health.LastSuccessAt == nil || stream.LastSuccessAt.Before(*health.LastSuccessAt) {
			at := *stream.LastSuccessAt
			health.LastSuccessAt = &at
		}
		if stream.RetryAt != nil && stream.RetryAt.After(now) && (health.RetryAt == nil || stream.RetryAt.After(*health.RetryAt)) {
			at := *stream.RetryAt
			health.RetryAt = &at
		}
		// Fixed refusal precedence makes the aggregate independent of stream order.
		if stream.Cause == "not_installed" {
			health.Cause = "not_installed"
			refused = true
		} else if stream.Cause == "permission" {
			if health.Cause != "not_installed" {
				health.Cause = "permission"
			}
			refused = true
		}
	}
	if missing {
		health.LastSuccessAt = nil
	}
	switch {
	case refused:
		health.State = "refused"
	case health.RetryAt != nil:
		health.State = "limited"
	case missing || now.Sub(*health.LastSuccessAt) > 120*time.Second:
		health.State = "stale"
	}
	return health
}

// WatchSyncHealth recovers the stale boundary from persisted receipts at boot.
// The stream worker supplies changes; the timer publishes once without polling
// or sending per-second age deltas. It stays unmounted without the live seam.
func (s *GitHubMainPullService) WatchSyncHealth(ctx context.Context, changes <-chan struct{}, publish func(GitHubSyncHealth)) error {
	var previous GitHubSyncHealth
	first := true
	for {
		health, err := s.SyncHealth(ctx)
		if err != nil {
			return err
		}
		if first || !sameGitHubSyncHealth(previous, health) {
			publish(health)
			previous = health
			first = false
		}
		var timer *time.Timer
		var boundary <-chan time.Time
		var next time.Time
		if health.State == "fresh" && health.LastSuccessAt != nil {
			next = health.LastSuccessAt.Add(120*time.Second + time.Nanosecond)
		} else if health.RetryAt != nil {
			// Persisted pauses expire even when the stream worker stops polling.
			next = *health.RetryAt
		}
		if !next.IsZero() {
			timer = time.NewTimer(next.Sub(s.now()))
			boundary = timer.C
		}
		select {
		case <-ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return ctx.Err()
		case _, open := <-changes:
			if timer != nil {
				timer.Stop()
			}
			if !open {
				return nil
			}
		case <-boundary:
		}
	}
}
func sameGitHubSyncHealth(a, b GitHubSyncHealth) bool {
	equalTime := func(x, y *time.Time) bool { return x == nil && y == nil || x != nil && y != nil && x.Equal(*y) }
	return a.State == b.State && a.Cause == b.Cause && equalTime(a.LastSuccessAt, b.LastSuccessAt) && equalTime(a.RetryAt, b.RetryAt)
}

// GitHubMainForcePush binds detection to the observed mirror and fetched tip.
// Stack attention, not a TODO wait, will retain this binding (T-STK-01).
type GitHubMainForcePush struct {
	Old string `json:"old"`
	New string `json:"new"`
}

func (e *GitHubMainForcePush) Error() string { return fmt.Sprintf("force_push{%s,%s}", e.Old, e.New) }

// ResetToGitHub must not fall back to an unfenced force push. The stack's
// durable intent/settlement transaction and machine-only consumers are absent;
// retain the owner's attention rather than performing any ref effect.
func (s *GitHubMainPullService) ResetToGitHub(ctx context.Context, repositoryID int64, old, new string) error {
	return githubSyncUnavailable()
}

package services

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

type mainHealthProvider struct{ err error }

func (*mainHealthProvider) RequiredStreams(context.Context) ([]GitHubSyncStream, error) {
	return nil, nil
}
func (*mainHealthProvider) RetryStreams(context.Context) error { return nil }
func (p *mainHealthProvider) prepareRefRead(ctx context.Context, row db.GithubMainPull) (gitHubRefReadCommit, error) {
	if p.err != nil {
		return nil, p.err
	}
	return (allowRefFixture{}).prepareRefRead(ctx, row)
}

func TestMainPullHealthRetainsTypedRefusal(t *testing.T) {
	for _, boundary := range []string{"admission", "token"} {
		for _, kind := range []string{"permission", "not_installed", "limited", "unreachable"} {
			t.Run(boundary+"/"+kind, func(t *testing.T) {
				h := newPullHarness(t)
				provider := &mainHealthProvider{}
				h.service.UseInstallPolicy()
				h.service.SetInstallSyncStreams(provider, provider, provider, provider)
				_, err := h.service.Request(t.Context(), 19)
				require.NoError(t, err)
				require.NoError(t, h.service.PollOnce(t.Context()))
				before := h.row(t)
				require.Equal(t, "synced", before.State)
				now := h.service.now().UTC()
				var failure error
				wantState, wantCause := "refused", kind
				switch kind {
				case "permission":
					failure = GitHubResponseFailure(403, http.Header{}, now)
				case "not_installed":
					failure = pkgerrors.New(pkgerrors.CodeGitHubNotInstalled, "GitHub App is not installed")
				case "limited":
					failure = GitHubRateLimitError(429, http.Header{"Retry-After": {"3600"}}, now)
					wantState, wantCause = "limited", ""
				case "unreachable":
					failure = errors.New("connection closed")
					wantState, wantCause = "fresh", ""
				}
				originalTokens := h.service.tokens
				if boundary == "admission" {
					provider.err = failure
				} else {
					h.service.tokens = &refusedMainPullTokens{err: failure}
				}
				require.NoError(t, h.service.RetrySync(t.Context()))
				require.NoError(t, h.service.PollOnce(t.Context()))
				failed := h.row(t)
				require.Equal(t, "failed", failed.State)
				require.Equal(t, before.LastSyncedAt, failed.LastSyncedAt)
				health, err := h.service.SyncHealth(t.Context())
				require.NoError(t, err)
				require.Equal(t, wantState, health.State)
				require.Equal(t, wantCause, health.Cause)
				require.Equal(t, before.LastSyncedAt.Time, *health.LastSuccessAt)
				if kind == "limited" {
					require.Equal(t, now.Add(time.Hour), *health.RetryAt)
				}
				// Requesting a retry is not proof that the refusal has cleared.
				require.NoError(t, h.service.RetrySync(t.Context()))
				pending, err := h.service.SyncHealth(t.Context())
				require.NoError(t, err)
				require.Equal(t, health, pending)
				provider.err = nil
				h.service.tokens = originalTokens
				require.NoError(t, h.service.PollOnce(t.Context()))
				health, err = h.service.SyncHealth(t.Context())
				require.NoError(t, err)
				require.Equal(t, "fresh", health.State)
				require.Empty(t, health.Cause)
				require.Nil(t, health.RetryAt)
			})
		}
	}
}

func TestMainPullHealthUsesOnlyTheCompletedReceipt(t *testing.T) {
	h := newPullHarness(t)
	qualifyMainPullFixture(h.service)
	h.service.tokens = &refusedMainPullTokens{err: GitHubResponseFailure(403, http.Header{}, time.Now())}
	_, err := h.service.Request(t.Context(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(t.Context()))
	row := h.row(t)
	require.Equal(t, "permission", h.service.refHealthStream(row).Cause)
	for _, change := range []struct {
		name  string
		apply func(*db.GithubMainPull)
	}{
		{"later read", func(r *db.GithubMainPull) { r.LastCheckedAt.Time = r.LastCheckedAt.Time.Add(time.Second) }},
		{"repository", func(r *db.GithubMainPull) { r.GithubRepository = "different/repo" }},
		{"branch", func(r *db.GithubMainPull) { r.Branch = "different" }},
		{"error", func(r *db.GithubMainPull) { r.LastError = "a different failure" }},
	} {
		t.Run(change.name, func(t *testing.T) {
			changed := row
			change.apply(&changed)
			stream := h.service.refHealthStream(changed)
			require.Empty(t, stream.Cause)
			require.Nil(t, stream.LastSuccessAt)
			require.Nil(t, stream.RetryAt)
		})
	}
	// An old claimant must not replace the accepted refusal.
	old := row
	old.Claim--
	h.service.recordRefHealth(t.Context(), old, gitHubMainPullOutcome{err: row.LastError, faultCause: "not_installed"})
	require.Equal(t, "permission", h.service.refHealthStream(row).Cause)
	// No unpersisted failure can override a completed receipt.
	h.service.recordRefHealth(t.Context(), row, gitHubMainPullOutcome{err: "not committed", faultCause: "not_installed"})
	require.Equal(t, "permission", h.service.refHealthStream(row).Cause)
	// A later claim owns the observation even if the wall clock moved back.
	h.store.mu.Lock()
	h.store.rows[19].Claim++
	h.store.rows[19].LastCheckedAt.Time = row.LastCheckedAt.Time.Add(-time.Second)
	later := *h.store.rows[19]
	h.store.mu.Unlock()
	h.service.recordRefHealth(t.Context(), later, gitHubMainPullOutcome{err: later.LastError, faultCause: "not_installed"})
	require.Equal(t, "not_installed", h.service.refHealthStream(later).Cause)
	// Replaying the earlier receipt cannot replace the higher claim's result.
	h.store.mu.Lock()
	*h.store.rows[19] = row
	h.store.mu.Unlock()
	h.service.recordRefHealth(t.Context(), row, gitHubMainPullOutcome{err: row.LastError, faultCause: "permission"})
	require.Equal(t, later.Claim, h.service.refHealth[19].claim)
}

func TestMainPullHealthRequiresItsObservationProvider(t *testing.T) {
	_, err := (gitHubMainPullStreams{receipts: newFakeMainPullStore()}).RequiredStreams(t.Context())
	require.Error(t, err)
}

func TestMainPullHealthCommittedFailureAndRestartPostgres(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := t.Context()
	q := db.New(pool)
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "main-health", LowerUsername: "main-health", DisplayName: "Main health"})
	require.NoError(t, err)
	var repoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name) VALUES ($1, 'app', 'app') RETURNING id`, user.ID).Scan(&repoID))
	_, err = q.RequestGithubMainPull(ctx, repoID)
	require.NoError(t, err)
	claims, err := q.ClaimGithubMainPulls(ctx, 1, 900)
	require.NoError(t, err)
	require.Len(t, claims, 1)
	written, err := q.FinishGithubMainPull(ctx, db.FinishGithubMainPullParams{RepositoryID: repoID, Claim: claims[0].Claim, State: "synced", GithubRepository: "owner/app", Branch: "main", Policy: "pull", GithubHead: pullNew, SmithersHead: pullNew})
	require.NoError(t, err)
	require.EqualValues(t, 1, written)
	provider := &mainHealthProvider{err: GitHubResponseFailure(403, http.Header{}, time.Now())}
	newService := func() *GitHubMainPullService {
		s := NewGitHubMainPullService(q, nil, nil, nil)
		s.UseInstallPolicy()
		s.SetInstallSyncStreams(provider, provider, provider, provider)
		return s
	}
	s := newService()
	require.NoError(t, s.RetrySync(ctx))
	require.NoError(t, s.PollOnce(ctx))
	health, err := s.SyncHealth(ctx)
	require.NoError(t, err)
	require.Equal(t, "refused", health.State)
	require.Equal(t, "permission", health.Cause)
	require.NotNil(t, health.LastSuccessAt)
	// Restart loses in-memory classification. It cannot promote an unread
	// failure to fresh using the older success timestamp.
	restarted := newService()
	health, err = restarted.SyncHealth(ctx)
	require.NoError(t, err)
	require.Equal(t, "stale", health.State)
	require.Nil(t, health.LastSuccessAt)
	require.NoError(t, restarted.RetrySync(ctx))
	require.NoError(t, restarted.PollOnce(ctx))
	health, err = restarted.SyncHealth(ctx)
	require.NoError(t, err)
	require.Equal(t, "refused", health.State)
	require.Equal(t, "permission", health.Cause)
}

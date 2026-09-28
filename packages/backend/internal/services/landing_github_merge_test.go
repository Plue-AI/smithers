package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

var (
	landingMergeHead   = strings.Repeat("a", 40)
	landingMergeCommit = strings.Repeat("b", 40)
)

type fakeLandingMergeStore struct {
	landing db.GetLandingRequestWithChangeIDsByNumberRow
	fixErr  error
	merges  []db.MergeLandingRequestFromGitHubParams
	fixed   []int64
}

func (f *fakeLandingMergeStore) GetRepoByID(_ context.Context, id int64) (db.Repository, error) {
	return db.Repository{ID: id, Name: "smithers", UserID: pgtype.Int8{Int64: 1, Valid: true}}, nil
}
func (f *fakeLandingMergeStore) GetUserByID(_ context.Context, id int64) (db.User, error) {
	return db.User{ID: id, Username: "smithers-canary"}, nil
}
func (f *fakeLandingMergeStore) GetOrgByID(context.Context, int64) (db.Organization, error) {
	return db.Organization{}, errors.New("unused")
}
func (f *fakeLandingMergeStore) ListOpenLandingNumbers(context.Context, int64, int64, int32) ([]int64, error) {
	if f.landing.State != landingStateOpen {
		return nil, nil
	}
	return []int64{f.landing.Number}, nil
}
func (f *fakeLandingMergeStore) GetLandingRequestWithChangeIDsByNumber(_ context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
	if arg.Number != f.landing.Number {
		return db.GetLandingRequestWithChangeIDsByNumberRow{}, pgx.ErrNoRows
	}
	return f.landing, nil
}
func (f *fakeLandingMergeStore) MergeLandingRequestFromGitHub(_ context.Context, arg db.MergeLandingRequestFromGitHubParams) (db.LandingGitHubMerge, error) {
	f.merges = append(f.merges, arg)
	f.landing.State = landingStateMerged
	return db.LandingGitHubMerge{LandingRequestID: arg.LandingRequestID, GithubRepository: arg.GithubRepository,
		PullNumber: arg.PullNumber, HeadSha: arg.HeadSha, MergeCommit: arg.MergeCommit}, nil
}
func (f *fakeLandingMergeStore) FixIssuesForLanding(_ context.Context, arg db.FixIssuesForLandingParams) ([]int64, error) {
	if f.fixErr != nil {
		return nil, f.fixErr
	}
	f.fixed = append(f.fixed, arg.LandingRequestID)
	return nil, nil
}

type fakeLandingMergeHost struct {
	commits map[string]string
	err     error
}

func (h *fakeLandingMergeHost) GetChange(_ context.Context, owner, repo, changeID string) (repohost.Change, error) {
	if owner != "smithers-canary" || repo != "smithers" {
		return repohost.Change{}, errors.New("wrong repository")
	}
	return repohost.Change{ChangeID: changeID, CommitID: h.commits[changeID]}, h.err
}

type fakeLandingMergePulls struct {
	pull   *landingGitHubPullRequest
	tokens []string
	finds  []string
}

func (f *fakeLandingMergePulls) Find(_ context.Context, token, owner, repo, branch string) (*landingGitHubPullRequest, error) {
	f.tokens = append(f.tokens, token)
	f.finds = append(f.finds, owner+"/"+repo+":"+branch)
	return f.pull, nil
}

type recordingLandedDispatcher struct {
	events []webhooks.LandingRequestEventPayload
}

func (d *recordingLandedDispatcher) DispatchEvent(_ context.Context, _ int64, _ webhooks.EventType, payload any) error {
	d.events = append(d.events, payload.(webhooks.LandingRequestEventPayload))
	return nil
}
func (d *recordingLandedDispatcher) DispatchOrgEvent(context.Context, int64, webhooks.EventType, any) error {
	return nil
}

type landingMergeTokens struct{ token string }

func (t landingMergeTokens) CreateGitHubInstallationTokenForRepositoryOwner(_ context.Context, _, _ int64, _, _ string, permissions map[string]string) (GitHubInstallationToken, error) {
	if len(permissions) != 1 || permissions["pull_requests"] != "read" {
		return GitHubInstallationToken{}, errors.New("unexpected permissions")
	}
	return GitHubInstallationToken{Token: t.token}, nil
}

type landingMergeFixture struct {
	store      *fakeLandingMergeStore
	host       *fakeLandingMergeHost
	pulls      *fakeLandingMergePulls
	dispatcher *recordingLandedDispatcher
	service    *LandingGitHubMergeService
}

func newLandingMergeFixture() *landingMergeFixture {
	merged, mergeCommit := "2026-09-26T10:00:00Z", landingMergeCommit
	pull := &landingGitHubPullRequest{Number: 41, State: "closed", MergedAt: &merged, MergeCommitSHA: &mergeCommit}
	pull.Head.Ref, pull.Head.SHA, pull.Base.Ref = "smithers/landing-7", landingMergeHead, "main"
	f := &landingMergeFixture{
		store: &fakeLandingMergeStore{landing: db.GetLandingRequestWithChangeIDsByNumberRow{ID: 70, RepositoryID: 9, Number: 7,
			State: landingStateOpen, AuthorID: 3, TargetBookmark: "main", ChangeIds: []string{"kbase", "ktip"}}},
		host:       &fakeLandingMergeHost{commits: map[string]string{"kbase": strings.Repeat("d", 40), "ktip": landingMergeHead}},
		pulls:      &fakeLandingMergePulls{pull: pull},
		dispatcher: &recordingLandedDispatcher{},
	}
	f.service = NewLandingGitHubMergeService(f.store, f.host, landingMergeTokens{token: "installation"}, f.dispatcher)
	f.service.github = f.pulls
	return f
}

func (f *landingMergeFixture) reconcile(t *testing.T) error {
	t.Helper()
	return f.service.reconcile(context.Background(), 9, "smithersai/smithers", "main")
}

func TestLandingGitHubMergeMergesTheLandingWithItsReceiptOnce(t *testing.T) {
	f := newLandingMergeFixture()
	require.NoError(t, f.reconcile(t))
	require.Len(t, f.store.merges, 1)
	merge := f.store.merges[0]
	assert.Equal(t, db.MergeLandingRequestFromGitHubParams{LandingRequestID: 70, GithubRepository: "smithersai/smithers", PullNumber: 41,
		HeadSha: landingMergeHead, MergeCommit: landingMergeCommit,
		Revisions: []byte(`{"kbase":"` + strings.Repeat("d", 40) + `","ktip":"` + landingMergeHead + `"}`)}, merge)
	assert.Equal(t, []string{"smithersai/smithers:smithers/landing-7"}, f.pulls.finds)
	assert.Equal(t, []string{"installation"}, f.pulls.tokens)
	assert.Equal(t, []int64{70}, f.store.fixed)
	require.Len(t, f.dispatcher.events, 1)
	assert.Equal(t, "landed", f.dispatcher.events[0].Action)
	assert.Equal(t, "merged", f.dispatcher.events[0].LandingRequest.State)
	assert.Equal(t, "smithers-canary/smithers", f.dispatcher.events[0].Repository.FullName)

	// The next synced pull finds no open landing: nothing merges twice.
	require.NoError(t, f.reconcile(t))
	assert.Len(t, f.store.merges, 1)
	assert.Len(t, f.pulls.finds, 1)
}

func TestLandingGitHubMergeLeavesLandingsGitHubDidNotMerge(t *testing.T) {
	cases := map[string]func(*landingMergeFixture){
		"no pull request":     func(f *landingMergeFixture) { f.pulls.pull = nil },
		"closed unmerged":     func(f *landingMergeFixture) { f.pulls.pull.MergedAt = nil },
		"other base":          func(f *landingMergeFixture) { f.pulls.pull.Base.Ref = "release" },
		"tip moved":           func(f *landingMergeFixture) { f.host.commits["ktip"] = strings.Repeat("c", 40) },
		"landing not open":    func(f *landingMergeFixture) { f.store.landing.State = landingStateClosed },
		"no app installation": func(f *landingMergeFixture) { f.service.tokens = landingMergeTokens{} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			f := newLandingMergeFixture()
			mutate(f)
			require.NoError(t, f.reconcile(t))
			assert.Empty(t, f.store.merges)
			assert.Empty(t, f.dispatcher.events)
		})
	}
}

func TestLandingGitHubMergeFailureLeavesTheLandingForTheNextPull(t *testing.T) {
	for name, mutate := range map[string]func(*landingMergeFixture){
		"repo-host": func(f *landingMergeFixture) { f.host.err = errors.New("repo-host unavailable") },
		"issues":    func(f *landingMergeFixture) { f.store.fixErr = errors.New("database unavailable") },
		"receipt":   func(f *landingMergeFixture) { f.pulls.pull.MergeCommitSHA = nil },
	} {
		t.Run(name, func(t *testing.T) {
			f := newLandingMergeFixture()
			mutate(f)
			require.Error(t, f.reconcile(t))
			assert.Empty(t, f.store.merges)
			assert.Equal(t, landingStateOpen, f.store.landing.State)
		})
	}
}

// A synced main pull reconciles landings, whether or not main moved; a
// skipped or failed one does not.
func TestGitHubMainPullReconcilesLandingsAfterEverySyncedPull(t *testing.T) {
	for name, tc := range map[string]struct {
		mutate func(*pullHarness)
		want   int
	}{"synced": {func(*pullHarness) {}, 1}, "skipped": {func(h *pullHarness) { h.policy = "push" }, 0},
		"failed": {func(h *pullHarness) { h.git.ancestor = false }, 0}} {
		t.Run(name, func(t *testing.T) {
			h := newPullHarness(t)
			tc.mutate(h)
			heard := make(chan string, 1)
			h.service.SetSynced(func(_ context.Context, repositoryID int64, githubRepository, branch string) {
				heard <- fmt.Sprintf("%d %s %s", repositoryID, githubRepository, branch)
			})
			_, err := h.service.Request(context.Background(), 19)
			require.NoError(t, err)
			require.NoError(t, h.service.PollOnce(context.Background()))
			if tc.want == 0 {
				select {
				case got := <-heard:
					t.Fatalf("reconciled after a %s pull: %s", name, got)
				case <-time.After(100 * time.Millisecond):
				}
				return
			}
			select {
			case got := <-heard:
				assert.Equal(t, "19 smithersai/smithers main", got)
			case <-time.After(5 * time.Second):
				t.Fatal("a synced pull did not reconcile landings")
			}
		})
	}
}

type pagedLandingMergeStore struct {
	*fakeLandingMergeStore
	open  int64
	pages [][2]int64
}

func (p *pagedLandingMergeStore) ListOpenLandingNumbers(_ context.Context, _, before int64, limit int32) ([]int64, error) {
	numbers := []int64{}
	for n := p.open; n >= 1 && len(numbers) < int(limit); n-- {
		if before == 0 || n < before {
			numbers = append(numbers, n)
		}
	}
	if len(numbers) > 0 {
		p.pages = append(p.pages, [2]int64{numbers[0], numbers[len(numbers)-1]})
	}
	return numbers, nil
}

// Successive pulls page through every open landing, then start again.
func TestLandingGitHubMergePagesThroughAllOpenLandings(t *testing.T) {
	f := newLandingMergeFixture()
	f.pulls.pull = nil
	store := &pagedLandingMergeStore{fakeLandingMergeStore: f.store, open: 120}
	f.service.store = store
	for range 4 {
		require.NoError(t, f.reconcile(t))
	}
	assert.Equal(t, [][2]int64{{120, 71}, {70, 21}, {20, 1}, {120, 71}}, store.pages)
	assert.Len(t, f.pulls.finds, 170)
}

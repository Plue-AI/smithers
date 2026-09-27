package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

const (
	pullOld = "1111111111111111111111111111111111111111"
	pullNew = "2222222222222222222222222222222222222222"
)

// fakeMainPullStore follows the SQL generation/claim semantics closely enough
// to drive the worker end to end. The SQL itself is covered by the PostgreSQL
// test in github_main_pull_db_test.go.
type fakeMainPullStore struct {
	mu        sync.Mutex
	rows      map[int64]*db.GithubMainPull
	repos     map[int64]db.Repository
	sources   map[int64][]db.ListRepositoryGitHubSourcesRow
	bySource  map[string][]int64
	requests  int
	finishErr error
	renamed   bool
}

func newFakeMainPullStore() *fakeMainPullStore {
	return &fakeMainPullStore{
		rows: map[int64]*db.GithubMainPull{},
		repos: map[int64]db.Repository{19: {ID: 19, Name: "smithers", LowerName: "smithers", DefaultBookmark: "main",
			UserID: pgtype.Int8{Int64: 1, Valid: true}}},
		sources:  map[int64][]db.ListRepositoryGitHubSourcesRow{19: {{GithubOwner: "smithersai", GithubRepo: "smithers"}}},
		bySource: map[string][]int64{"smithersai/smithers": {19}},
	}
}

func (f *fakeMainPullStore) GetRepoByID(_ context.Context, id int64) (db.Repository, error) {
	repo, ok := f.repos[id]
	if !ok {
		return db.Repository{}, pgx.ErrNoRows
	}
	return repo, nil
}

func (f *fakeMainPullStore) ListRepositoryGitHubSources(_ context.Context, id int64) ([]db.ListRepositoryGitHubSourcesRow, error) {
	return f.sources[id], nil
}

func (f *fakeMainPullStore) GetRepoByOwnerAndLowerName(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.renamed {
		return db.Repository{ID: 99}, nil
	}
	for _, repo := range f.repos {
		if arg.Owner == "smithers-canary" && repo.LowerName == arg.LowerName {
			return repo, nil
		}
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (f *fakeMainPullStore) GetUserByID(context.Context, int64) (db.User, error) {
	return db.User{Username: "smithers-canary"}, nil
}

func (f *fakeMainPullStore) GetOrgByID(context.Context, int64) (db.Organization, error) {
	return db.Organization{}, pgx.ErrNoRows
}

func (f *fakeMainPullStore) ListRepositoryIDsForGitHubSource(_ context.Context, owner, repo string) ([]int64, error) {
	return f.bySource[strings.ToLower(owner+"/"+repo)], nil
}

func (f *fakeMainPullStore) RequestGithubMainPull(_ context.Context, id int64) (db.GithubMainPull, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests++
	row, ok := f.rows[id]
	if !ok {
		row = &db.GithubMainPull{RepositoryID: id, State: "pending"}
		f.rows[id] = row
	}
	row.RequestedGeneration++
	row.NextAttemptAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
	return *row, nil
}

func (f *fakeMainPullStore) GetGithubMainPull(_ context.Context, id int64) (db.GithubMainPull, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.rows[id]
	if !ok {
		return db.GithubMainPull{}, pgx.ErrNoRows
	}
	return *row, nil
}

func (f *fakeMainPullStore) ClaimGithubMainPulls(_ context.Context, limit int32, _ float64) ([]db.GithubMainPull, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var claimed []db.GithubMainPull
	for _, row := range f.rows {
		if row.RequestedGeneration <= row.SyncedGeneration || row.NextAttemptAt.Time.After(time.Now()) ||
			(row.State == "running" && row.LeaseExpiresAt.Time.After(time.Now())) || int32(len(claimed)) >= limit {
			continue
		}
		row.State, row.Claim, row.ClaimedGeneration = "running", row.Claim+1, row.RequestedGeneration
		row.Attempts++
		row.LeaseExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}
		claimed = append(claimed, *row)
	}
	return claimed, nil
}

func (f *fakeMainPullStore) FinishGithubMainPull(_ context.Context, arg db.FinishGithubMainPullParams) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.finishErr != nil {
		return 0, f.finishErr
	}
	row := f.rows[arg.RepositoryID]
	if row == nil || row.Claim != arg.Claim || row.State != "running" {
		return 0, nil
	}
	if arg.State == "failed" {
		row.State = "failed"
		row.NextAttemptAt = pgtype.Timestamptz{Time: time.Now().Add(time.Duration(arg.BackoffSeconds) * time.Second), Valid: true}
	} else {
		row.SyncedGeneration = max(row.SyncedGeneration, row.ClaimedGeneration)
		row.State = arg.State
		if row.RequestedGeneration > row.ClaimedGeneration {
			row.State = "pending"
		}
		row.Attempts = 0
	}
	if arg.ResetPolicy {
		row.Policy, row.PolicyCommit, row.GithubRepository = "", "", ""
	}
	if arg.Policy != "" {
		row.Policy = arg.Policy
	}
	if arg.PolicyCommit != "" {
		row.PolicyCommit = arg.PolicyCommit
	}
	if arg.GithubRepository != "" {
		row.GithubRepository = arg.GithubRepository
	}
	if arg.Branch != "" {
		row.Branch = arg.Branch
	}
	if arg.GithubHead != "" {
		row.GithubHead = arg.GithubHead
	}
	if arg.SmithersHead != "" {
		row.SmithersHead = arg.SmithersHead
	}
	row.LastError = arg.Error
	row.LeaseExpiresAt = pgtype.Timestamptz{}
	return 1, nil
}

func (f *fakeMainPullStore) RequestUntrackedGithubMainPulls(context.Context, int32) (int64, error) {
	return 0, nil
}

func (f *fakeMainPullStore) IsGithubMainPullMirror(context.Context, string, string) (bool, error) {
	return false, nil
}

// Time is not modelled: a zero age re-requests, any other age does not.
func (f *fakeMainPullStore) RequestStaleGithubMainPulls(_ context.Context, pullAge, skippedAge float64) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var n int64
	for _, row := range f.rows {
		if row.RequestedGeneration == row.SyncedGeneration &&
			((row.Policy == "pull" && row.State == "synced" && pullAge == 0) || (row.State == "skipped" && skippedAge == 0)) {
			row.RequestedGeneration++
			n++
		}
	}
	return n, nil
}

// fakeMainPullHost is repo-host: one bookmark map and the receive-pack
// commands it accepted.
type fakeMainPullHost struct {
	mu        sync.Mutex
	bookmarks map[string]string
	received  []repohost.ReceivePackCommand
	meta      []repohost.ReceivePackMetadata
}

func (h *fakeMainPullHost) InfoRefs(context.Context, string, string, string, io.Writer) (string, error) {
	return "", nil
}

func (h *fakeMainPullHost) ProxyUploadPack(context.Context, string, string, io.Reader, io.Writer) error {
	return nil
}

func (h *fakeMainPullHost) ProxyReceivePack(_ context.Context, _, _ string, stdin io.Reader, _ io.Writer, meta ...repohost.ReceivePackMetadata) error {
	commands, _, err := repohost.PeekReceivePackCommands(stdin)
	if err != nil {
		return err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.received = append(h.received, commands...)
	h.meta = append(h.meta, meta...)
	for _, command := range commands {
		h.bookmarks[strings.TrimPrefix(command.RefName, "refs/heads/")] = command.NewOID
	}
	return nil
}

func (h *fakeMainPullHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []repohost.Bookmark
	for name, commit := range h.bookmarks {
		out = append(out, repohost.Bookmark{Name: name, TargetCommitID: commit})
	}
	return out, "", nil
}

type fakeMainPullTokens struct {
	calls       int
	permissions []map[string]string
}

func (t *fakeMainPullTokens) CreateGitHubInstallationTokenForRepositoryOwner(_ context.Context, _, _ int64, _, _ string, permissions map[string]string) (GitHubInstallationToken, error) {
	t.calls++
	t.permissions = append(t.permissions, permissions)
	return GitHubInstallationToken{Token: "ghs_installation_secret"}, nil
}

// pullHarness wires the service to fakes. github is GitHub's current main;
// the fake git pushes through the real bridge.
type pullHarness struct {
	store       *fakeMainPullStore
	host        *fakeMainPullHost
	service     *GitHubMainPullService
	git         *fakeMainPullGit
	github      string
	policy      string
	policyReads int
}

type fakeMainPullGit struct {
	h          *pullHarness
	fetches    int
	pushes     int
	ancestor   bool
	fetchErr   error
	skipPush   bool
	githubMove string
}

func (g *fakeMainPullGit) Fetch(context.Context, string, string, string, string) (string, string, error) {
	g.fetches++
	if g.fetchErr != nil {
		return "", "", g.fetchErr
	}
	if g.githubMove != "" {
		g.h.github = g.githubMove
	}
	return g.h.host.bookmarkSnapshot("main"), g.h.github, nil
}

func (g *fakeMainPullGit) IsAncestor(context.Context, string, string, string) (bool, error) {
	return g.ancestor, nil
}

func (g *fakeMainPullGit) Push(ctx context.Context, _, bridgeURL, commit, ref string) error {
	g.pushes++
	if g.skipPush {
		return nil
	}
	return pushThroughBridge(ctx, bridgeURL, ref, g.h.host.bookmarkSnapshot("main"), commit)
}

func newPullHarness(t *testing.T) *pullHarness {
	t.Helper()
	h := &pullHarness{store: newFakeMainPullStore(), host: &fakeMainPullHost{bookmarks: map[string]string{"main": pullOld, "smithers/landing-7": pullOld}},
		github: pullNew, policy: "pull"}
	h.git = &fakeMainPullGit{h: h, ancestor: true}
	h.service = NewGitHubMainPullService(h.store, h.host, &fakeMainPullTokens{}, nil)
	h.service.git = h.git
	h.service.gitHubGitBaseURL = func() string { return "https://github.example" }
	h.service.lsRemote = func(_ context.Context, remote, ref string) (string, error) {
		require.Equal(t, "refs/heads/main", ref)
		require.Contains(t, remote, "ghs_installation_secret", "the credential rides the URL only into mirrorCommand")
		return h.github, nil
	}
	h.service.readPolicy = func(_ context.Context, token, owner, repo, commit string) (string, error) {
		h.policyReads++
		assert.Equal(t, "smithersai/smithers", owner+"/"+repo)
		assert.Equal(t, h.github, commit, "the policy is read at the exact tip being pulled")
		return h.policy, nil
	}
	return h
}

func (h *fakeMainPullHost) bookmarkSnapshot(name string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.bookmarks[name]
}

// pushThroughBridge sends one receive-pack command, as git-sync would.
func pushThroughBridge(ctx context.Context, bridgeURL, ref, old, new string) error {
	status, _, err := postReceivePack(ctx, bridgeURL, "", []repohost.ReceivePackCommand{{OldOID: old, NewOID: new, RefName: ref}})
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("bridge answered %d", status)
	}
	return nil
}

func postReceivePack(ctx context.Context, bridgeURL, password string, commands []repohost.ReceivePackCommand) (int, string, error) {
	var body bytes.Buffer
	for i, command := range commands {
		line := command.OldOID + " " + command.NewOID + " " + command.RefName
		if i == 0 {
			line += "\x00report-status"
		}
		line += "\n"
		fmt.Fprintf(&body, "%04x%s", len(line)+4, line)
	}
	body.WriteString("0000")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.Replace(bridgeURL, "/repository.git", "/repository.git/git-receive-pack", 1), &body)
	if err != nil {
		return 0, "", err
	}
	if password != "" {
		req.SetBasicAuth("x-access-token", password)
	} else if req.URL.User != nil {
		secret, _ := req.URL.User.Password()
		req.SetBasicAuth(req.URL.User.Username(), secret)
	}
	req.URL.User = nil
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(raw), nil
}

func (h *pullHarness) row(t *testing.T) db.GithubMainPull {
	t.Helper()
	row, err := h.store.GetGithubMainPull(context.Background(), 19)
	require.NoError(t, err)
	return row
}

func TestGitHubMainPullFastForwardsOnlyMainToGitHubsCurrentTip(t *testing.T) {
	h := newPullHarness(t)
	require.NoError(t, h.service.RequestForGitHub(context.Background(), "SmithersAI", "smithers"))
	require.NoError(t, h.service.PollOnce(context.Background()))

	row := h.row(t)
	assert.Equal(t, "synced", row.State)
	assert.Equal(t, "pull", row.Policy)
	assert.Equal(t, pullNew, row.GithubHead)
	assert.Equal(t, pullNew, row.SmithersHead)
	assert.Equal(t, 1, h.git.pushes)
	assert.Equal(t, "smithersai/smithers", row.GithubRepository)
	assert.Equal(t, "main", row.Branch)
	assert.Equal(t, pullNew, row.PolicyCommit)
	assert.Equal(t, pullNew, h.host.bookmarks["main"])
	assert.Equal(t, pullOld, h.host.bookmarks["smithers/landing-7"], "landing bookmarks are untouched")
	require.Len(t, h.host.meta, 1)
	assert.Equal(t, "github", h.host.meta[0].PusherLogin)
	assert.Equal(t, middleware.CredentialPlatform, h.host.meta[0].PusherCredential, "the main pull is the platform's own verified write")
	assert.Equal(t, "refs/heads/main", h.host.meta[0].RefName)
	status, err := h.service.Status(context.Background(), 19)
	require.NoError(t, err)
	assert.True(t, status.Fresh)
	assert.False(t, status.Pending)
}

func TestGitHubMainPullCoalescesDuplicateAndOutOfOrderRequests(t *testing.T) {
	h := newPullHarness(t)
	// Three deliveries (a duplicate and an older push arriving last) before
	// the worker runs: one pull, to GitHub's tip at run time.
	for range 3 {
		require.NoError(t, h.service.RequestForGitHub(context.Background(), "smithersai", "smithers"))
	}
	require.NoError(t, h.service.PollOnce(context.Background()))
	require.NoError(t, h.service.PollOnce(context.Background()))
	assert.Equal(t, 1, h.git.pushes)
	assert.Equal(t, "synced", h.row(t).State)

	// A replay after success is a no-op: heads match, nothing is written and
	// the policy is not re-read.
	reads := h.policyReads
	require.NoError(t, h.service.RequestForGitHub(context.Background(), "smithersai", "smithers"))
	require.NoError(t, h.service.PollOnce(context.Background()))
	assert.Equal(t, 1, h.git.pushes)
	assert.Equal(t, reads, h.policyReads)
	assert.Equal(t, "synced", h.row(t).State)
}

func TestGitHubMainPullRequestDuringRunRunsAgain(t *testing.T) {
	h := newPullHarness(t)
	h.service.store = &pausingClaims{fakeMainPullStore: h.store, stopAfter: 1}
	h.service.git = &requestingGit{fakeMainPullGit: h.git, store: h.store}
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	assert.Equal(t, "pending", h.row(t).State, "a request that arrived mid-run keeps the row due")
	h.github = "3333333333333333333333333333333333333333"
	h.service.store = h.store
	require.NoError(t, h.service.PollOnce(context.Background()))
	assert.Equal(t, "synced", h.row(t).State)
	assert.Equal(t, h.github, h.host.bookmarks["main"])
}

// pausingClaims stops claiming after stopAfter claims, so a test can look
// between runs.
type pausingClaims struct {
	*fakeMainPullStore
	stopAfter int
	claims    int
}

func (p *pausingClaims) ClaimGithubMainPulls(ctx context.Context, limit int32, lease float64) ([]db.GithubMainPull, error) {
	if p.claims >= p.stopAfter {
		return nil, nil
	}
	p.claims++
	return p.fakeMainPullStore.ClaimGithubMainPulls(ctx, limit, lease)
}

func TestGitHubMainPullSkipsWhenPolicyIsNotPull(t *testing.T) {
	for _, policy := range []string{"push", "none", "undeclared"} {
		t.Run(policy, func(t *testing.T) {
			h := newPullHarness(t)
			h.policy = policy
			_, err := h.service.Request(context.Background(), 19)
			require.NoError(t, err)
			require.NoError(t, h.service.PollOnce(context.Background()))
			row := h.row(t)
			assert.Equal(t, "skipped", row.State)
			assert.Equal(t, policy, row.Policy)
			assert.Zero(t, h.git.pushes)
			assert.Zero(t, h.git.fetches, "a repository that does not follow GitHub costs no transfer")
			assert.Equal(t, pullOld, h.host.bookmarks["main"])
			// The poll only re-checks pull repositories.
			n, err := h.store.RequestStaleGithubMainPulls(context.Background(), 0, gitHubMainPullSkippedRecheck.Seconds())
			require.NoError(t, err)
			assert.Zero(t, n)
		})
	}
}

func TestGitHubMainPullSkipsRepositoriesWithoutAGitHubSource(t *testing.T) {
	h := newPullHarness(t)
	h.store.sources[19] = nil
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	assert.Equal(t, "skipped", h.row(t).State)
	assert.Zero(t, h.git.pushes)
}

func TestGitHubMainPullDivergenceFailsVisiblyAndRetries(t *testing.T) {
	h := newPullHarness(t)
	h.git.ancestor = false
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	row := h.row(t)
	assert.Equal(t, "failed", row.State)
	assert.Contains(t, row.LastError, "diverged")
	assert.Equal(t, pullOld, h.host.bookmarks["main"], "a diverged main is never overwritten")
	assert.True(t, row.RequestedGeneration > row.SyncedGeneration, "a failure stays requested")
	assert.True(t, row.NextAttemptAt.Time.After(time.Now()), "and waits for its backoff")
	status, err := h.service.Status(context.Background(), 19)
	require.NoError(t, err)
	assert.False(t, status.Fresh)
	assert.True(t, status.Pending)
	assert.NotNil(t, status.NextAttemptAt)

	// Once the divergence is resolved, the retry succeeds.
	h.git.ancestor = true
	h.store.rows[19].NextAttemptAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
	require.NoError(t, h.service.PollOnce(context.Background()))
	assert.Equal(t, "synced", h.row(t).State)
	assert.Empty(t, h.row(t).LastError)
}

func TestGitHubMainPullFailuresNeverLeakCredentials(t *testing.T) {
	h := newPullHarness(t)
	h.service.lsRemote = func(_ context.Context, remote, _ string) (string, error) {
		return "", fmt.Errorf("git ls-remote failed: fatal: unable to access '%s': 503", remote)
	}
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	row := h.row(t)
	assert.Equal(t, "failed", row.State)
	assert.NotContains(t, row.LastError, "ghs_installation_secret")
	assert.Contains(t, row.LastError, "503")
}

func TestGitHubMainPullRefusesAMainThatDidNotReachGitHub(t *testing.T) {
	h := newPullHarness(t)
	h.git.skipPush = true // pushed nothing
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	assert.Equal(t, "failed", h.row(t).State)
	assert.Contains(t, h.row(t).LastError, "did not reach")
}

func TestGitHubMainPullRestartedClaimIsFenced(t *testing.T) {
	h := newPullHarness(t)
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	rows, err := h.store.ClaimGithubMainPulls(context.Background(), 1, 1)
	require.NoError(t, err)
	stale := rows[0]
	// The first worker died; its lease expired and another worker re-claims.
	h.store.rows[19].LeaseExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(-time.Second), Valid: true}
	require.NoError(t, h.service.PollOnce(context.Background()))
	assert.Equal(t, "synced", h.row(t).State)
	written, err := h.store.FinishGithubMainPull(context.Background(), db.FinishGithubMainPullParams{RepositoryID: 19, Claim: stale.Claim, State: "failed", Error: "late"})
	require.NoError(t, err)
	assert.Zero(t, written, "the dead worker's late finish writes nothing")
	assert.Equal(t, "synced", h.row(t).State)
}

func TestGitHubMainPullPollRechecksPullRepositories(t *testing.T) {
	h := newPullHarness(t)
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	require.Equal(t, 1, h.git.pushes)
	// A webhook is missed: GitHub moves with no delivery.
	h.github = "4444444444444444444444444444444444444444"
	n, err := h.store.RequestStaleGithubMainPulls(context.Background(), 0, gitHubMainPullSkippedRecheck.Seconds())
	require.NoError(t, err)
	assert.EqualValues(t, 1, n)
	require.NoError(t, h.service.PollOnce(context.Background()))
	assert.Equal(t, h.github, h.host.bookmarks["main"])
}

func TestGitHubMainPullBridgeAcceptsOnlyTheObservedFastForward(t *testing.T) {
	host := &fakeMainPullHost{bookmarks: map[string]string{"main": pullOld}}
	bridge, err := startGitHubMainPullBridge(context.Background(), host, "smithers-canary", "smithers", gitHubMainPullUpdate{ref: "refs/heads/main", old: pullOld, new: pullNew}, nil)
	require.NoError(t, err)
	defer bridge.Close()
	ctx := context.Background()
	zero := strings.Repeat("0", 40)
	for name, commands := range map[string][]repohost.ReceivePackCommand{
		"other ref": {{OldOID: pullOld, NewOID: pullNew, RefName: "refs/heads/smithers/landing-7"}},
		"stale old": {{OldOID: pullNew, NewOID: pullNew, RefName: "refs/heads/main"}},
		"other new": {{OldOID: pullOld, NewOID: pullOld, RefName: "refs/heads/main"}},
		"delete":    {{OldOID: pullOld, NewOID: zero, RefName: "refs/heads/main"}},
		"two ref updates": {{OldOID: pullOld, NewOID: pullNew, RefName: "refs/heads/main"},
			{OldOID: zero, NewOID: pullNew, RefName: "refs/smithers/workspaces/x/head"}},
	} {
		status, _, err := postReceivePack(ctx, bridge.URL(), "", commands)
		require.NoError(t, err, name)
		assert.Equal(t, http.StatusForbidden, status, name)
	}
	status, _, err := postReceivePack(ctx, bridge.URL(), "wrong-secret", []repohost.ReceivePackCommand{{OldOID: pullOld, NewOID: pullNew, RefName: "refs/heads/main"}})
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, status)
	assert.Empty(t, host.received)

	require.NoError(t, pushThroughBridge(ctx, bridge.URL(), "refs/heads/main", pullOld, pullNew))
	assert.Equal(t, pullNew, host.bookmarks["main"])
}

func TestReadGitHubMirrorPolicy(t *testing.T) {
	answers := map[string]struct {
		status int
		body   string
	}{
		"pull":        {200, `{"github":{"_tag":"GithubPolicy","mirror":"pull","issues":"two-way","changes":"send-upstream"}}`},
		"push":        {200, `{"github":{"mirror":"push"}}`},
		"nogithub":    {200, `{"summary":"x"}`},
		"missing":     {404, `{}`},
		"unknown":     {200, `{"github":{"mirror":"sideways"}}`},
		"invalid":     {200, `{`},
		"unavailable": {502, ``},
	}
	var sawToken, sawAnonymous bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var commit string
		if r.Header.Get("Authorization") != "" {
			// API: /repos/{owner}/{repo}/contents/.smithers/factory.json?ref={commit}
			assert.Equal(t, "Bearer tok", r.Header.Get("Authorization"))
			commit = r.URL.Query().Get("ref")
			assert.Equal(t, "/api/repos/o/r/contents/.smithers/factory.json", r.URL.Path)
			sawToken = true
		} else {
			// Anonymous raw content: /{owner}/{repo}/{commit}/.smithers/factory.json
			parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/raw/"), "/")
			require.Len(t, parts, 5)
			commit = parts[2]
			sawAnonymous = true
		}
		answer := answers[commit]
		w.WriteHeader(answer.status)
		_, _ = w.Write([]byte(answer.body))
	}))
	defer server.Close()
	for _, token := range []string{"tok", ""} {
		for name, want := range map[string]string{"pull": "pull", "push": "push", "nogithub": "undeclared", "missing": "undeclared"} {
			got, err := readGitHubMirrorPolicy(context.Background(), server.Client(), server.URL+"/api", server.URL+"/raw", token, "o", "r", name)
			require.NoError(t, err, name)
			assert.Equal(t, want, got, name)
		}
		for _, name := range []string{"unknown", "invalid", "unavailable"} {
			_, err := readGitHubMirrorPolicy(context.Background(), server.Client(), server.URL+"/api", server.URL+"/raw", token, "o", "r", name)
			assert.Error(t, err, name)
		}
	}
	assert.True(t, sawToken)
	assert.True(t, sawAnonymous)
}

func TestGitHubWebhookPushToDefaultBranchRequestsMainPull(t *testing.T) {
	cases := []struct {
		name string
		ref  string
		want bool
	}{
		{"default branch", "refs/heads/main", true},
		{"landing branch", "refs/heads/smithers/landing-7", false},
		{"other branch", "refs/heads/feature", false},
		{"tag", "refs/tags/v1", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload, _ := json.Marshal(map[string]any{"ref": tc.ref, "after": pullNew,
				"repository": map[string]any{"id": 5, "name": "smithers", "default_branch": "main", "owner": map[string]any{"login": "smithersai"}}})
			queries := &mockGitHubWebhookEventWorkerQuerier{claimPendingGitHubWebhookJobsFn: func(context.Context, int32) ([]db.GithubWebhookJob, error) {
				return []db.GithubWebhookJob{{ID: 1, EventType: "push", Payload: payload, Attempts: 1}}, nil
			}}
			worker := NewGitHubWebhookEventWorker(queries, &mockGitHubWebhookEventRunDispatcher{})
			pulls := &recordingMainPull{}
			worker.SetMainPull(pulls)
			require.NoError(t, worker.PollOnce(context.Background()))
			if tc.want {
				assert.Equal(t, []string{"smithersai/smithers"}, pulls.requests)
			} else {
				assert.Empty(t, pulls.requests)
			}
			assert.Equal(t, []int64{1}, queries.markDoneIDs)
		})
	}
}

func TestGitHubWebhookMainPullRequestFailureRetriesTheJob(t *testing.T) {
	payload := []byte(`{"ref":"refs/heads/main","repository":{"id":5,"name":"smithers","default_branch":"main","owner":{"login":"smithersai"}}}`)
	queries := &mockGitHubWebhookEventWorkerQuerier{claimPendingGitHubWebhookJobsFn: func(context.Context, int32) ([]db.GithubWebhookJob, error) {
		return []db.GithubWebhookJob{{ID: 1, EventType: "push", Payload: payload, Attempts: 1}}, nil
	}}
	worker := NewGitHubWebhookEventWorker(queries, &mockGitHubWebhookEventRunDispatcher{})
	worker.SetMainPull(&recordingMainPull{err: errors.New("database unavailable")})
	require.NoError(t, worker.PollOnce(context.Background()))
	assert.Empty(t, queries.markDoneIDs)
	require.Len(t, queries.retried, 1)
	assert.Contains(t, queries.retried[0].Error, "request main pull")
}

type recordingMainPull struct {
	requests []string
	err      error
}

func (r *recordingMainPull) RequestForGitHub(_ context.Context, owner, repo string) error {
	r.requests = append(r.requests, owner+"/"+repo)
	return r.err
}

func TestGitMirrorSyncRefusesPullPolicyRepositories(t *testing.T) {
	resolved := false
	service := NewGitMirrorSyncService(newFakeGitMirrorSyncStore(), WithGitMirrorPullPolicy(func(context.Context, int64) (bool, error) { return true, nil }))
	service.resolveRemotes = func(context.Context, int64, int64, string, string) (gitMirrorRemotes, error) {
		resolved = true
		return gitMirrorRemotes{}, nil
	}
	_, err := service.StartMirrorSync(context.Background(), 7, 19, "smithers-canary", "smithers")
	require.Error(t, err)
	assert.Equal(t, http.StatusConflict, apiStatus(t, err))
	_, err = service.StartGitHubReconcile(context.Background(), 7, 19, "smithers-canary", "smithers")
	assert.Equal(t, http.StatusConflict, apiStatus(t, err))
	_, err = service.RetryMirrorRef(context.Background(), 7, 19, "smithers-canary", "smithers", "refs/heads/main")
	assert.Equal(t, http.StatusConflict, apiStatus(t, err))
	assert.False(t, resolved, "no credential is minted for a refused sync")
}

// requestingGit records a request while the pull runs, as a webhook for a
// newer GitHub push would.
type requestingGit struct {
	*fakeMainPullGit
	store     *fakeMainPullStore
	requested bool
}

func (g *requestingGit) Fetch(ctx context.Context, dir, smithersURL, githubURL, ref string) (string, string, error) {
	if !g.requested {
		g.requested = true
		_, _ = g.store.RequestGithubMainPull(ctx, 19)
	}
	return g.fakeMainPullGit.Fetch(ctx, dir, smithersURL, githubURL, ref)
}

func TestGitHubMainPullRecordsPolicyOnFirstEvaluationWithEqualHeads(t *testing.T) {
	h := newPullHarness(t)
	h.github = pullOld // already equal
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	row := h.row(t)
	assert.Equal(t, "synced", row.State)
	assert.Equal(t, "pull", row.Policy, "an already-current repository is still recorded as pull, so the poll keeps it")
	assert.Equal(t, pullOld, row.PolicyCommit)
	assert.Equal(t, 1, h.policyReads)
	assert.Zero(t, h.git.fetches)

	// The policy is read once per GitHub tip.
	_, err = h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	assert.Equal(t, 1, h.policyReads)
}

func TestGitHubMainPullFollowsATipThatMovedDuringTheRun(t *testing.T) {
	h := newPullHarness(t)
	h.git.githubMove = "5555555555555555555555555555555555555555"
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	row := h.row(t)
	assert.Equal(t, "synced", row.State)
	assert.Equal(t, h.git.githubMove, row.GithubHead)
	assert.Equal(t, h.git.githubMove, h.host.bookmarks["main"])
	assert.Equal(t, h.git.githubMove, row.PolicyCommit, "the policy is read at the tip actually pulled")
}

func TestGitHubMainPullRefusesWhenSmithersMovedDuringTheRun(t *testing.T) {
	h := newPullHarness(t)
	h.service.git = &movingBaseGit{fakeMainPullGit: h.git}
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	assert.Equal(t, "failed", h.row(t).State)
	assert.Contains(t, h.row(t).LastError, "moved")
	assert.Zero(t, h.git.pushes)
}

type movingBaseGit struct{ *fakeMainPullGit }

func (g *movingBaseGit) Fetch(ctx context.Context, dir, smithersURL, githubURL, ref string) (string, string, error) {
	_, tip, err := g.fakeMainPullGit.Fetch(ctx, dir, smithersURL, githubURL, ref)
	return "6666666666666666666666666666666666666666", tip, err
}

func TestGitHubMainPullNeverPersistsTheBridgeSecret(t *testing.T) {
	h := newPullHarness(t)
	h.service.git = &echoURLGit{fakeMainPullGit: h.git}
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	row := h.row(t)
	assert.Equal(t, "failed", row.State)
	assert.Contains(t, row.LastError, "unable to access")
	assert.NotContains(t, row.LastError, "ghs_installation_secret")
	assert.Contains(t, row.LastError, "%2A%2A%2A", "credentials are redacted")
	assert.NotRegexp(t, `x-access-token:[0-9a-f]{64}`, row.LastError)
}

type echoURLGit struct{ *fakeMainPullGit }

func (g *echoURLGit) Fetch(_ context.Context, _, smithersURL, githubURL, _ string) (string, string, error) {
	return "", "", fmt.Errorf("fatal: unable to access '%s' or '%s'", smithersURL, githubURL)
}

func TestGitHubMainPullLeaseOutlivesTheRunDeadline(t *testing.T) {
	assert.Greater(t, gitHubMainPullLease, gitHubMainPullTimeout+time.Minute,
		"a claim must not be re-leased while its run can still push")
}

func TestSyncedReposWithholdsPullRepositoriesFromTheRefPushFeed(t *testing.T) {
	store := newFakeSyncedRepoStore()
	service := NewGitHubSyncedRepoService(store)
	refs, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: "widget"})
	require.NoError(t, err)
	service.SetPushAccess(pushAccessFunc(func(context.Context, int64, string, string) error { return nil }))
	store.recordReadyImport(fakeReadyImport{userID: 7, githubOwner: "octo", githubRepo: "widget", repoOwner: "alice", repoName: "widget"})
	require.NoError(t, service.BindMirror(context.Background(), 7, refs, "alice", "widget"))

	pull := true
	service.SetPullMirror(func(_ context.Context, owner, repo string) (bool, error) {
		assert.Equal(t, "alice/widget", owner+"/"+repo)
		return pull, nil
	})
	refsOnly, err := service.ListSyncedRepos(context.Background(), true)
	require.NoError(t, err)
	assert.Empty(t, refsOnly, "GitHub writes this repository's main; nothing may push refs to it")
	all, err := service.ListSyncedRepos(context.Background(), false)
	require.NoError(t, err)
	require.Len(t, all, 1, "metadata and issue sync continue")
	assert.Equal(t, "alice", all[0].SmithersOwner)

	pull = false
	refsOnly, err = service.ListSyncedRepos(context.Background(), true)
	require.NoError(t, err)
	assert.Len(t, refsOnly, 1)
}

func TestGitHubMainPullRefusesAReusedRepositoryName(t *testing.T) {
	h := newPullHarness(t)
	h.service.git = &renamingGit{fakeMainPullGit: h.git, store: h.store}
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	assert.Equal(t, "failed", h.row(t).State)
	assert.Empty(t, h.host.received, "nothing is forwarded to a repository that took over the name")
	assert.Equal(t, pullOld, h.host.bookmarks["main"])
}

// renamingGit deletes the repository and reuses its name during the fetch.
type renamingGit struct {
	*fakeMainPullGit
	store *fakeMainPullStore
}

func (g *renamingGit) Fetch(ctx context.Context, dir, smithersURL, githubURL, ref string) (string, string, error) {
	g.store.mu.Lock()
	g.store.renamed = true
	g.store.mu.Unlock()
	return g.fakeMainPullGit.Fetch(ctx, dir, smithersURL, githubURL, ref)
}

func TestGitHubMainPullForgetsThePolicyWhenTheSourceIsLost(t *testing.T) {
	h := newPullHarness(t)
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	require.Equal(t, "pull", h.row(t).Policy)

	// The GitHub source is disconnected: the recorded policy is forgotten,
	// so neither the outbound guard nor the policy cache reuses it.
	sources := h.store.sources[19]
	h.store.sources[19] = nil
	_, err = h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	row := h.row(t)
	assert.Equal(t, "skipped", row.State)
	assert.Empty(t, row.Policy)
	assert.Empty(t, row.PolicyCommit)
	recorded, err := h.service.PullPolicyRecorded(context.Background(), 19)
	require.NoError(t, err)
	assert.False(t, recorded)
	status, err := h.service.Status(context.Background(), 19)
	require.NoError(t, err)
	assert.False(t, status.Fresh)

	// Reconnected at the same GitHub tip: the policy is read again.
	h.store.sources[19] = sources
	reads := h.policyReads
	_, err = h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	assert.Equal(t, reads+1, h.policyReads)
	assert.Equal(t, "pull", h.row(t).Policy)
}

func TestGitHubMainPullEqualHeadsWithAnotherPolicyStaySkipped(t *testing.T) {
	h := newPullHarness(t)
	h.github, h.policy = pullOld, "push"
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	assert.Equal(t, "skipped", h.row(t).State, "so the six-hour re-evaluation keeps checking it")
	status, err := h.service.Status(context.Background(), 19)
	require.NoError(t, err)
	assert.False(t, status.Fresh)
}

func TestGitHubMainPullClaimsOneRowPerRun(t *testing.T) {
	h := newPullHarness(t)
	h.store.repos[20] = db.Repository{ID: 20, Name: "other", LowerName: "other", DefaultBookmark: "main", UserID: pgtype.Int8{Int64: 1, Valid: true}}
	h.store.sources[20] = []db.ListRepositoryGitHubSourcesRow{{GithubOwner: "smithersai", GithubRepo: "smithers"}}
	counting := &countingClaims{fakeMainPullStore: h.store}
	h.service.store = counting
	for _, id := range []int64{19, 20} {
		_, err := h.service.Request(context.Background(), id)
		require.NoError(t, err)
	}
	require.NoError(t, h.service.PollOnce(context.Background()))
	assert.Equal(t, []int32{1, 1, 1}, counting.limits, "each claim is taken immediately before its run")
}

type countingClaims struct {
	*fakeMainPullStore
	limits []int32
}

func (c *countingClaims) ClaimGithubMainPulls(ctx context.Context, limit int32, lease float64) ([]db.GithubMainPull, error) {
	c.limits = append(c.limits, limit)
	return c.fakeMainPullStore.ClaimGithubMainPulls(ctx, limit, lease)
}

func TestGitHubMainPullPolicyReceiptStaysBoundToItsCommit(t *testing.T) {
	const a, b = pullOld, pullNew
	h := newPullHarness(t)
	policies := map[string]string{a: "none", b: "pull"}
	h.service.readPolicy = func(_ context.Context, _, _, _, commit string) (string, error) {
		h.policyReads++
		return policies[commit], nil
	}
	// Recorded: A declares none. GitHub advertises B, then rolls back to A
	// before the fetch.
	h.store.rows[19] = &db.GithubMainPull{RepositoryID: 19, State: "skipped", GithubRepository: "smithersai/smithers",
		Policy: "none", PolicyCommit: a}
	h.host.bookmarks["main"] = "7777777777777777777777777777777777777777"
	h.github = b
	h.git.githubMove = a
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	row := h.row(t)
	assert.Equal(t, "skipped", row.State)
	assert.Equal(t, "none", row.Policy)
	assert.Equal(t, a, row.PolicyCommit, "a cached policy is recorded with the commit it was read at")

	// GitHub returns to B: its policy (pull) is read, not the cached one.
	h.git.githubMove = ""
	h.github = b
	h.host.bookmarks["main"] = a
	_, err = h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(context.Background()))
	row = h.row(t)
	assert.Equal(t, "synced", row.State, row.LastError)
	assert.Equal(t, "pull", row.Policy)
	assert.Equal(t, b, h.host.bookmarks["main"])
}

func TestGitHubMainPullDoesNotRunAnExpiredClaim(t *testing.T) {
	h := newPullHarness(t)
	_, err := h.service.Request(context.Background(), 19)
	require.NoError(t, err)
	rows, err := h.store.ClaimGithubMainPulls(context.Background(), 1, 900)
	require.NoError(t, err)
	claim := rows[0]
	claim.LeaseExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(30 * time.Second), Valid: true}
	h.service.runClaimed(context.Background(), claim)
	assert.Zero(t, h.git.fetches)
	assert.Zero(t, h.policyReads)
	assert.Equal(t, "running", h.row(t).State, "the claim is left for its next claimant")
}

func TestGitMirrorSyncRechecksThePolicyAtExecution(t *testing.T) {
	pull := false
	var queued []func()
	store := newFakeGitMirrorSyncStore()
	service := NewGitMirrorSyncService(store, WithGitMirrorPullPolicy(func(context.Context, int64) (bool, error) { return pull, nil }))
	service.resolveRemotes = func(context.Context, int64, int64, string, string) (gitMirrorRemotes, error) {
		return gitMirrorRemotes{sourceURL: "https://smithers.example/a/b.git", targetURL: "https://github.example/c/d.git"}, nil
	}
	service.launch = func(_ string, run func()) { queued = append(queued, run) }
	listed := false
	service.listRemoteRefs = func(context.Context, string) (map[string]string, error) {
		listed = true
		return map[string]string{}, nil
	}
	_, err := service.StartMirrorSync(context.Background(), 7, 19, "smithers-canary", "smithers")
	require.NoError(t, err)
	require.Len(t, queued, 1)
	// The repository begins following GitHub before the queued run starts.
	pull = true
	queued[0]()
	assert.False(t, listed, "the queued run never reaches either remote")
	assert.Equal(t, gitMirrorRunFailed, store.run.State)
}

// The main pull only reads GitHub, so its installation token is scoped to
// contents:read and can never push or carry workflows.
func TestGitHubMainPullReadTokenIsReadOnly(t *testing.T) {
	tokens := &fakeMainPullTokens{}
	service := NewGitHubMainPullService(nil, nil, tokens, nil)
	assert.Equal(t, "ghs_installation_secret", service.readToken(context.Background(), db.Repository{UserID: pgtype.Int8{Int64: 1, Valid: true}}, "acme", "app"))
	assert.Equal(t, []map[string]string{{"contents": "read"}}, tokens.permissions)
}

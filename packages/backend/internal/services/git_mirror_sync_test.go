package services

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type fakeGitMirrorSyncStore struct {
	mu sync.Mutex

	run          db.GithubMirrorSyncRun
	refs         map[string]db.GithubMirrorSyncRefResult
	succeeded    map[string]db.GithubMirrorSyncRefResult
	createErr    error
	getErr       error
	listErr      error
	markErr      error
	upsertErr    error
	finishErr    error
	verifiedRefs map[string]string
	createArgs   db.CreateGithubMirrorSyncRunParams
}

func newFakeGitMirrorSyncStore() *fakeGitMirrorSyncStore {
	return &fakeGitMirrorSyncStore{refs: make(map[string]db.GithubMirrorSyncRefResult), succeeded: make(map[string]db.GithubMirrorSyncRefResult)}
}

// seed records an earlier run's ref result as the real store would.
func (f *fakeGitMirrorSyncStore) seed(result db.GithubMirrorSyncRefResult) {
	f.refs[result.Name] = result
	if result.Status == gitMirrorRefSucceeded && result.FromRevision != result.ToRevision {
		f.succeeded[result.Name] = result
	}
}

func (f *fakeGitMirrorSyncStore) CreateGithubMirrorSyncRun(_ context.Context, arg db.CreateGithubMirrorSyncRunParams) (db.GithubMirrorSyncRun, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.createErr != nil {
		return db.GithubMirrorSyncRun{}, f.createErr
	}
	f.createArgs = arg
	id := int64(41)
	if f.run.ID != 0 {
		id = f.run.ID + 1
	}
	f.run = db.GithubMirrorSyncRun{ID: id, RepositoryID: arg.RepositoryID, RequestedBy: arg.RequestedBy, State: "queued"}
	return f.run, nil
}

func (f *fakeGitMirrorSyncStore) GetGithubMirrorSyncRun(_ context.Context, arg db.GetGithubMirrorSyncRunParams) (db.GithubMirrorSyncRun, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.getErr != nil {
		return db.GithubMirrorSyncRun{}, f.getErr
	}
	if f.run.ID != arg.ID || f.run.RepositoryID != arg.RepositoryID {
		return db.GithubMirrorSyncRun{}, pgx.ErrNoRows
	}
	return f.run, nil
}

func (f *fakeGitMirrorSyncStore) MarkGithubMirrorSyncRunRunning(_ context.Context, id int64) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.markErr != nil {
		return 0, f.markErr
	}
	if f.run.ID != id || f.run.State != "queued" {
		return 0, nil
	}
	f.run.State = "running"
	f.run.StartedAt = pgtype.Timestamptz{Time: time.Unix(100, 0), Valid: true}
	return 1, nil
}

func (f *fakeGitMirrorSyncStore) FinishGithubMirrorSyncRun(_ context.Context, arg db.FinishGithubMirrorSyncRunParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.finishErr != nil {
		return f.finishErr
	}
	f.run.State = arg.State
	f.run.FinishedAt = pgtype.Timestamptz{Time: time.Unix(200, 0), Valid: true}
	return nil
}

func (f *fakeGitMirrorSyncStore) FinishSuccessfulGithubMirrorSyncRun(ctx context.Context, arg db.FinishSuccessfulGithubMirrorSyncRunParams) (int64, error) {
	if err := f.FinishGithubMirrorSyncRun(ctx, db.FinishGithubMirrorSyncRunParams{ID: arg.ID, State: gitMirrorRunSucceeded}); err != nil {
		return 0, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := json.Unmarshal(arg.VerifiedRefs, &f.verifiedRefs); err != nil {
		return 0, err
	}
	return 1, nil
}

func (f *fakeGitMirrorSyncStore) UpsertGithubMirrorSyncRefResult(_ context.Context, arg db.UpsertGithubMirrorSyncRefResultParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.upsertErr != nil {
		return f.upsertErr
	}
	result := db.GithubMirrorSyncRefResult{
		RunID: arg.RunID, Name: arg.Name, FromRevision: arg.FromRevision,
		ToRevision: arg.ToRevision, Status: arg.Status, Error: arg.Error,
	}
	f.refs[arg.Name] = result
	if arg.Status == gitMirrorRefSucceeded && arg.FromRevision != arg.ToRevision {
		f.succeeded[arg.Name] = result
	} else if f.succeeded[arg.Name].RunID == arg.RunID {
		delete(f.succeeded, arg.Name)
	}
	return nil
}

func (f *fakeGitMirrorSyncStore) ListGithubMirrorSyncRefResults(_ context.Context, runID int64) ([]db.GithubMirrorSyncRefResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	result := make([]db.GithubMirrorSyncRefResult, 0, len(f.refs))
	for _, ref := range f.refs {
		if ref.RunID == runID {
			result = append(result, ref)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func (f *fakeGitMirrorSyncStore) GetLatestGithubMirrorSyncRefResult(_ context.Context, arg db.GetLatestGithubMirrorSyncRefResultParams) (db.GithubMirrorSyncRefResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ref, ok := f.refs[arg.Name]
	if !ok {
		return db.GithubMirrorSyncRefResult{}, pgx.ErrNoRows
	}
	return ref, nil
}

func (f *fakeGitMirrorSyncStore) GetLatestSucceededGithubMirrorSyncRefResult(_ context.Context, arg db.GetLatestSucceededGithubMirrorSyncRefResultParams) (db.GithubMirrorSyncRefResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ref, ok := f.succeeded[arg.Name]
	if !ok {
		return db.GithubMirrorSyncRefResult{}, pgx.ErrNoRows
	}
	return ref, nil
}

func synchronousGitMirrorService(store GitMirrorSyncQuerier) *GitMirrorSyncService {
	svc := NewGitMirrorSyncService(store)
	svc.launch = func(_ string, fn func()) { fn() }
	return svc
}

func setGitMirrorEnv(t *testing.T) {
	t.Helper()
	t.Setenv("SMITHERS_GIT_BASE_URL", "https://smithers.example")
	t.Setenv("SMITHERS_TOKEN", "source-token")
	t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", "https://github.example")
	t.Setenv("SMITHERS_GITHUB_TOKEN", "target-token")
}

func TestGitMirrorSyncService_StartAndGetRunRecordsPerRefResults(t *testing.T) {
	setGitMirrorEnv(t)
	store := newFakeGitMirrorSyncStore()
	svc := synchronousGitMirrorService(store)

	const oldMain = "1111111111111111111111111111111111111111"
	const newMain = "2222222222222222222222222222222222222222"
	const tag = "3333333333333333333333333333333333333333"
	const obsolete = "4444444444444444444444444444444444444444"
	const githubOnly = "5555555555555555555555555555555555555555"
	// An earlier run of this mirror wrote obsolete; GitHub created github-only.
	store.seed(db.GithubMirrorSyncRefResult{RunID: 40, Name: "refs/heads/obsolete", ToRevision: obsolete, Status: gitMirrorRefSucceeded})
	remoteCalls := 0
	svc.listRemoteRefs = func(_ context.Context, _ string) (map[string]string, error) {
		remoteCalls++
		switch remoteCalls {
		case 1:
			return map[string]string{"refs/heads/main": newMain, "refs/tags/v1": tag}, nil
		case 2:
			return map[string]string{"refs/heads/main": oldMain, "refs/tags/v1": tag, "refs/heads/obsolete": obsolete, "refs/heads/github-only": githubOnly}, nil
		default:
			return map[string]string{"refs/heads/main": newMain, "refs/tags/v1": tag, "refs/heads/github-only": githubOnly}, nil
		}
	}
	var sourceURL, targetURL string
	var pushed []gitMirrorRefChange
	svc.runGitSync = func(_ context.Context, source, target string, changes []gitMirrorRefChange) error {
		sourceURL, targetURL, pushed = source, target, changes
		return nil
	}

	runID, err := svc.StartMirrorSync(context.Background(), 7, 101, " Alice ", " Demo ")
	require.NoError(t, err)
	assert.Equal(t, int64(41), runID)
	assert.Equal(t, int64(101), store.createArgs.RepositoryID)
	assert.Equal(t, pgtype.Int8{Int64: 7, Valid: true}, store.createArgs.RequestedBy)
	assert.Equal(t, []gitMirrorRefChange{
		{name: "refs/heads/main", from: oldMain, to: newMain},
		{name: "refs/heads/obsolete", from: obsolete},
	}, pushed)
	assert.Contains(t, sourceURL, "/Alice/Demo.git")
	assert.Contains(t, targetURL, "/Alice/Demo.git")

	run, err := svc.GetMirrorSyncRun(context.Background(), 101, runID)
	require.NoError(t, err)
	assert.Equal(t, runID, run.ID)
	assert.Equal(t, gitMirrorRunSucceeded, run.State)
	assert.Equal(t, newMain, store.verifiedRefs["refs/heads/main"])
	require.NotNil(t, run.StartedAt)
	require.NotNil(t, run.FinishedAt)
	require.Len(t, run.Refs, 2)
	assert.Equal(t, GitMirrorSyncRefResult{
		Name: "refs/heads/main", From: oldMain, To: newMain, Status: gitMirrorRefSucceeded,
	}, run.Refs[0])
	assert.Equal(t, GitMirrorSyncRefResult{
		Name: "refs/heads/obsolete", From: obsolete, To: "", Status: gitMirrorRefSucceeded,
	}, run.Refs[1])
}

func TestGitMirrorSyncService_StartGitHubReconcileReturnsQueuedRun(t *testing.T) {
	setGitMirrorEnv(t)
	store := newFakeGitMirrorSyncStore()
	svc := NewGitMirrorSyncService(store)
	launched := make(chan struct{}, 1)
	svc.launch = func(_ string, _ func()) { launched <- struct{}{} }

	run, err := svc.StartGitHubReconcile(context.Background(), 7, 101, "alice", "demo")
	require.NoError(t, err)
	assert.Equal(t, int64(41), run.RunID)
	assert.Equal(t, int64(41), run.ID)
	assert.Equal(t, "queued", run.State)
	assert.NotNil(t, run.Refs)
	assert.Empty(t, run.Refs)
	assert.Equal(t, pgtype.Int8{Int64: 7, Valid: true}, store.createArgs.RequestedBy)
	assert.Equal(t, int64(101), store.createArgs.RepositoryID)
	select {
	case <-launched:
	default:
		t.Fatal("mirror sync worker was not launched")
	}
}

func TestGitMirrorSyncService_RejectsConcurrentRepositoryRun(t *testing.T) {
	setGitMirrorEnv(t)
	store := newFakeGitMirrorSyncStore()
	store.createErr = &pgconn.PgError{
		Code:           "23505",
		ConstraintName: gitMirrorActiveRunConstraint,
	}
	svc := NewGitMirrorSyncService(store)

	_, err := svc.StartGitHubReconcile(context.Background(), 7, 101, "alice", "demo")
	require.Error(t, err)
	assert.Equal(t, 409, apiStatus(t, err))
	assert.Contains(t, err.Error(), "already running")

	store.createErr = &pgconn.PgError{Code: "23505", ConstraintName: "some_other_constraint"}
	_, err = svc.StartGitHubReconcile(context.Background(), 7, 101, "alice", "demo")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestGitMirrorSyncService_FailedRefPreservesSafeRunnerError(t *testing.T) {
	setGitMirrorEnv(t)
	store := newFakeGitMirrorSyncStore()
	svc := synchronousGitMirrorService(store)
	const oldRevision = "1111111111111111111111111111111111111111"
	const newRevision = "2222222222222222222222222222222222222222"
	remoteCalls := 0
	svc.listRemoteRefs = func(_ context.Context, _ string) (map[string]string, error) {
		remoteCalls++
		if remoteCalls == 1 {
			return map[string]string{"refs/heads/main": newRevision}, nil
		}
		return map[string]string{"refs/heads/main": oldRevision}, nil
	}
	svc.runGitSync = func(_ context.Context, _, targetURL string, _ []gitMirrorRefChange) error {
		return errors.New("push to " + targetURL + " was rejected")
	}

	_, err := svc.StartMirrorSync(context.Background(), 7, 101, "alice", "demo")
	require.NoError(t, err)
	run, err := svc.GetMirrorSyncRun(context.Background(), 101, 41)
	require.NoError(t, err)
	assert.Equal(t, gitMirrorRunFailed, run.State)
	assert.Equal(t, 1, run.BehindRefs)
	assert.Equal(t, 1, run.FailedRefs)
	require.Len(t, run.Refs, 1)
	assert.Equal(t, gitMirrorRefFailed, run.Refs[0].Status)
	assert.Contains(t, run.Refs[0].Error, "was rejected")
	assert.NotContains(t, run.Refs[0].Error, "target-token")
}

func TestGitMirrorSyncService_RetryMirrorRefRunsOnlyFailedRef(t *testing.T) {
	setGitMirrorEnv(t)
	store := newFakeGitMirrorSyncStore()
	store.refs["refs/heads/main"] = db.GithubMirrorSyncRefResult{
		RunID: 40, Name: "refs/heads/main", FromRevision: "old", ToRevision: "new", Status: gitMirrorRefFailed,
	}
	svc := synchronousGitMirrorService(store)
	remoteCalls := 0
	svc.listRemoteRefs = func(_ context.Context, _ string) (map[string]string, error) {
		remoteCalls++
		switch remoteCalls {
		case 1:
			return map[string]string{"refs/heads/main": "new", "refs/heads/other": "other-new"}, nil
		case 2:
			return map[string]string{"refs/heads/main": "old", "refs/heads/other": "other-old"}, nil
		default:
			return map[string]string{"refs/heads/main": "new", "refs/heads/other": "other-old"}, nil
		}
	}
	var retriedRef string
	svc.runGitRefSync = func(_ context.Context, _, _ string, ref, _, targetRevision string) error {
		retriedRef = ref
		assert.Equal(t, "new", targetRevision)
		return nil
	}

	runID, err := svc.RetryMirrorRef(context.Background(), 7, 101, "alice", "demo", "refs/heads/main")
	require.NoError(t, err)
	assert.Equal(t, int64(41), runID)
	assert.Equal(t, "refs/heads/main", retriedRef)
	run, err := svc.GetMirrorSyncRun(context.Background(), 101, runID)
	require.NoError(t, err)
	assert.Equal(t, gitMirrorRunSucceeded, run.State)
	require.Len(t, run.Refs, 1)
	assert.Equal(t, "refs/heads/main", run.Refs[0].Name)
	assert.Zero(t, run.BehindRefs)
	assert.Zero(t, run.FailedRefs)
}

func TestGitMirrorSyncService_RetryMirrorRefNeverDeletesAGitHubRef(t *testing.T) {
	setGitMirrorEnv(t)
	for name, prior := range map[string]db.GithubMirrorSyncRefResult{
		"failed update":           {FromRevision: "old", ToRevision: "new"},
		"prune of another commit": {FromRevision: "old"},
	} {
		t.Run(name, func(t *testing.T) {
			store := newFakeGitMirrorSyncStore()
			prior.RunID, prior.Name, prior.Status = 40, "refs/heads/feature", gitMirrorRefFailed
			store.refs["refs/heads/feature"] = prior
			svc := synchronousGitMirrorService(store)
			svc.listRemoteRefs = func(_ context.Context, remote string) (map[string]string, error) {
				if strings.Contains(remote, "github.example") {
					return map[string]string{"refs/heads/feature": "github-moved"}, nil
				}
				return map[string]string{}, nil
			}
			svc.runGitRefSync = func(context.Context, string, string, string, string, string) error {
				t.Fatal("a ref the source lacks and this mirror never wrote is not deleted")
				return nil
			}

			runID, err := svc.RetryMirrorRef(context.Background(), 7, 101, "alice", "demo", "refs/heads/feature")
			require.NoError(t, err)
			run, err := svc.GetMirrorSyncRun(context.Background(), 101, runID)
			require.NoError(t, err)
			assert.Equal(t, gitMirrorRunFailed, run.State)
			require.Len(t, run.Refs, 1)
			assert.Equal(t, gitMirrorRefFailed, run.Refs[0].Status)
		})
	}
}

func TestGitMirrorSyncService_RetryMirrorRefRejectsMissingOrRepairedRef(t *testing.T) {
	setGitMirrorEnv(t)
	store := newFakeGitMirrorSyncStore()
	svc := synchronousGitMirrorService(store)
	_, err := svc.RetryMirrorRef(context.Background(), 7, 101, "alice", "demo", "refs/heads/main")
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	store.refs["refs/heads/main"] = db.GithubMirrorSyncRefResult{Name: "refs/heads/main", Status: gitMirrorRefSucceeded}
	_, err = svc.RetryMirrorRef(context.Background(), 7, 101, "alice", "demo", "refs/heads/main")
	require.Error(t, err)
	assert.Equal(t, 409, apiStatus(t, err))

	_, err = svc.RetryMirrorRef(context.Background(), 7, 101, "alice", "demo", "main")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
}

func TestGitMirrorSyncService_ValidationAndStoreErrors(t *testing.T) {
	setGitMirrorEnv(t)
	tests := []struct {
		name         string
		userID       int64
		repositoryID int64
		owner        string
		repo         string
		wantStatus   int
	}{
		{name: "auth", userID: 0, repositoryID: 1, owner: "a", repo: "b", wantStatus: 401},
		{name: "repository", userID: 1, repositoryID: 0, owner: "a", repo: "b", wantStatus: 400},
		{name: "owner", userID: 1, repositoryID: 1, owner: " ", repo: "b", wantStatus: 400},
		{name: "name", userID: 1, repositoryID: 1, owner: "a", repo: " ", wantStatus: 400},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewGitMirrorSyncService(newFakeGitMirrorSyncStore()).StartMirrorSync(
				context.Background(), tc.userID, tc.repositoryID, tc.owner, tc.repo,
			)
			require.Error(t, err)
			assert.Equal(t, tc.wantStatus, apiStatus(t, err))
		})
	}

	_, err := NewGitMirrorSyncService(nil).StartMirrorSync(context.Background(), 1, 1, "a", "b")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	store := newFakeGitMirrorSyncStore()
	store.createErr = errors.New("db down")
	_, err = NewGitMirrorSyncService(store).StartMirrorSync(context.Background(), 1, 1, "a", "b")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestGitMirrorSyncService_GetRunErrorsAndEmptyRefs(t *testing.T) {
	store := newFakeGitMirrorSyncStore()
	store.run = db.GithubMirrorSyncRun{ID: 9, RepositoryID: 3, State: "queued"}
	svc := NewGitMirrorSyncService(store)

	run, err := svc.GetMirrorSyncRun(context.Background(), 3, 9)
	require.NoError(t, err)
	assert.Equal(t, "queued", run.State)
	assert.Equal(t, int64(9), run.ID)
	assert.Empty(t, run.Refs)
	assert.NotNil(t, run.Refs)
	assert.Nil(t, run.StartedAt)
	assert.Nil(t, run.FinishedAt)

	_, err = svc.GetMirrorSyncRun(context.Background(), 3, 10)
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))
	_, err = svc.GetMirrorSyncRun(context.Background(), 0, 9)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	_, err = svc.GetMirrorSyncRun(context.Background(), 3, 0)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	store.getErr = errors.New("db down")
	_, err = svc.GetMirrorSyncRun(context.Background(), 3, 9)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	store.getErr = nil
	store.listErr = errors.New("db down")
	_, err = svc.GetMirrorSyncRun(context.Background(), 3, 9)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestGitMirrorSyncHelpers(t *testing.T) {
	refs, err := parseRemoteRefs("aaa\trefs/heads/main\nbbb refs/tags/v1\n")
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"refs/heads/main": "aaa", "refs/tags/v1": "bbb"}, refs)
	_, err = parseRemoteRefs("malformed")
	require.Error(t, err)

	got, err := gitMirrorURL("https://git.example.test/base/", " token ", "Alice", "Demo")
	require.NoError(t, err)
	assert.Equal(t, "https://x-access-token:token@git.example.test/base/Alice/Demo.git", got)
	for _, base := range []string{"", "git.example.test", "://bad"} {
		_, err := gitMirrorURL(base, "", "a", "b")
		require.Error(t, err)
	}

	changes := mirrorRefChanges(
		map[string]string{"refs/heads/main": "new", "refs/tags/same": "same", "refs/tags/v2": "v2"},
		map[string]string{"refs/heads/main": "old", "refs/tags/same": "same", "refs/tags/github-only": "gone"},
	)
	assert.Equal(t, []gitMirrorRefChange{
		{name: "refs/heads/main", from: "old", to: "new"},
		{name: "refs/tags/v2", to: "v2"},
	}, changes, "a target-only ref is never a change")
	assert.True(t, mirrorRefReached(gitMirrorRefChange{name: "refs/heads/main", to: "new"}, map[string]string{"refs/heads/main": "new"}))
	assert.True(t, mirrorRefReached(gitMirrorRefChange{name: "refs/tags/gone", to: ""}, map[string]string{}))
}

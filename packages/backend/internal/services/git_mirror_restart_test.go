package services

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// The child exits without running defer handlers, as an API process does when
// its host terminates after accepting a durable mirror request.
func TestMirrorRestartChild(t *testing.T) {
	if os.Getenv("SMITHERS_MIRROR_RESTART_CHILD") != "1" {
		return
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("SMITHERS_MIRROR_RESTART_DATABASE_URL"))
	require.NoError(t, err)
	repoID, err := strconv.ParseInt(os.Getenv("SMITHERS_MIRROR_RESTART_REPOSITORY_ID"), 10, 64)
	require.NoError(t, err)
	userID, err := strconv.ParseInt(os.Getenv("SMITHERS_MIRROR_RESTART_USER_ID"), 10, 64)
	require.NoError(t, err)
	svc := NewGitMirrorSyncService(db.New(pool))
	phase := os.Getenv("SMITHERS_MIRROR_RESTART_PHASE")
	mode := os.Getenv("SMITHERS_MIRROR_RESTART_MODE")
	if mode == "recover" {
		runID, parseErr := strconv.ParseInt(os.Getenv("SMITHERS_MIRROR_RESTART_RUN_ID"), 10, 64)
		require.NoError(t, parseErr)
		run, getErr := svc.GetMirrorSyncRun(ctx, repoID, runID)
		require.NoError(t, getErr)
		require.Equal(t, gitMirrorRunFailed, run.State)
		require.NotNil(t, run.FinishedAt)
		return
	}
	svc.resolveRemotes = func(context.Context, int64, int64, string, string) (gitMirrorRemotes, error) {
		if phase == "real-verification" {
			return gitMirrorRemotes{sourceURL: os.Getenv("SMITHERS_MIRROR_RESTART_SOURCE"), targetURL: os.Getenv("SMITHERS_MIRROR_RESTART_TARGET")}, nil
		}
		return gitMirrorRemotes{sourceURL: "source", targetURL: "target"}, nil
	}
	var accepted chan struct{}
	if phase == "" || phase == "queued" {
		svc.launch = func(_ string, _ func()) {}
	} else {
		accepted = make(chan struct{})
		svc.launch = func(_ string, run func()) {
			go func() {
				<-accepted
				run()
			}()
		}
		targetCalls := 0
		if phase == "real-verification" {
			svc.listRemoteRefs = func(ctx context.Context, remote string) (map[string]string, error) {
				if remote == os.Getenv("SMITHERS_MIRROR_RESTART_TARGET") {
					targetCalls++
					if targetCalls == 2 {
						os.Exit(0)
					}
				}
				return defaultListRemoteRefs(ctx, remote)
			}
		} else {
			svc.listRemoteRefs = func(_ context.Context, remote string) (map[string]string, error) {
				if remote == "source" {
					if phase == "source-read" {
						os.Exit(0)
					}
					return map[string]string{"refs/heads/main": strings.Repeat("a", 40)}, nil
				}
				if phase == "verification" {
					// The target is read once before transfer and again to verify it.
					targetCalls++
					if targetCalls == 2 {
						os.Exit(0)
					}
				}
				return map[string]string{}, nil
			}
			svc.runGitSync = func(context.Context, string, string, []gitMirrorRefChange) error {
				if phase == "transfer" {
					os.Exit(0)
				}
				return nil
			}
			svc.runGitRefSync = func(context.Context, string, string, string, string, string) error {
				if phase == "transfer" {
					os.Exit(0)
				}
				return nil
			}
		}
	}
	if mode == "retry" {
		_, err = svc.RetryMirrorRef(ctx, userID, repoID, "owner", "repo", "refs/heads/main")
	} else {
		_, err = svc.StartGitHubReconcile(ctx, userID, repoID, "owner", "repo")
	}
	require.NoError(t, err)
	if phase == "" || phase == "queued" {
		os.Exit(0)
	}
	close(accepted)
	// The request has returned before the detached worker is allowed to run.
	// A callback that reaches its exit point terminates the whole child.
	select {
	case <-time.After(10 * time.Second):
		t.Fatalf("child failed to exit in %s/%s", mode, phase)
	}
}

func TestMirrorRestartQueuedPollRecoversExpiredRun(t *testing.T) {
	if os.Getenv("SMITHERS_MIRROR_RESTART_CHILD") == "1" {
		return
	}
	ctx := context.Background()
	pool := servicesSuite.Pool(t)
	userID, repoID := setupTestUserAndRepo(t, pool)
	runMirrorRestartChild(t, pool, userID, repoID, "full", "queued", 0)
	var runID int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM github_mirror_sync_runs WHERE repository_id=$1`, repoID).Scan(&runID))
	_, err := pool.Exec(ctx, `UPDATE github_mirror_sync_runs SET created_at=NOW()-INTERVAL '12 minutes', updated_at=NOW()-INTERVAL '12 minutes' WHERE id=$1`, runID)
	require.NoError(t, err)
	runMirrorRestartChild(t, pool, userID, repoID, "recover", "", runID)
	result, err := NewGitMirrorSyncService(db.New(pool)).GetMirrorSyncRun(ctx, repoID, runID)
	require.NoError(t, err)
	require.Equal(t, gitMirrorRunFailed, result.State)
	require.NotNil(t, result.FinishedAt)
	require.WithinDuration(t, time.Now(), *result.FinishedAt, time.Minute)
}

func runMirrorRestartChild(t *testing.T, pool *pgxpool.Pool, userID, repoID int64, mode, phase string, runID int64, remotes ...string) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.short", "-test.run=^TestMirrorRestartChild$")
	childEnv := make([]string, 0, len(os.Environ())+7)
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, "SMITHERS_TEST_DATABASE_URL=") || strings.HasPrefix(entry, "SMITHERS_REQUIRE_DATABASE_TESTS=") {
			continue // The child connects to the parent's database without migrating another one.
		}
		childEnv = append(childEnv, entry)
	}
	command.Env = append(childEnv,
		"SMITHERS_MIRROR_RESTART_CHILD=1",
		"SMITHERS_MIRROR_RESTART_DATABASE_URL="+pool.Config().ConnString(),
		fmt.Sprintf("SMITHERS_MIRROR_RESTART_REPOSITORY_ID=%d", repoID),
		fmt.Sprintf("SMITHERS_MIRROR_RESTART_USER_ID=%d", userID),
		fmt.Sprintf("SMITHERS_MIRROR_RESTART_RUN_ID=%d", runID),
		"SMITHERS_MIRROR_RESTART_MODE="+mode,
		"SMITHERS_MIRROR_RESTART_PHASE="+phase,
	)
	if len(remotes) == 2 {
		command.Env = append(command.Env,
			"SMITHERS_MIRROR_RESTART_SOURCE="+remotes[0],
			"SMITHERS_MIRROR_RESTART_TARGET="+remotes[1],
		)
	}
	output, err := command.CombinedOutput()
	require.NoError(t, err, "child process %s/%s: %s", mode, phase, output)
}

func TestMirrorRestartRunningPhasesAndRefRetry(t *testing.T) {
	if os.Getenv("SMITHERS_MIRROR_RESTART_CHILD") == "1" {
		return
	}
	ctx := context.Background()
	pool := servicesSuite.Pool(t)
	for _, mode := range []string{"full", "retry"} {
		phases := []string{"source-read", "transfer", "verification"}
		if mode == "retry" {
			phases = append([]string{"queued"}, phases...)
		}
		for _, phase := range phases {
			t.Run(mode+"/"+phase, func(t *testing.T) {
				userID, repoID := setupTestUserAndRepo(t, pool)
				if mode == "retry" {
					q := db.New(pool)
					prior, err := q.CreateGithubMirrorSyncRun(ctx, db.CreateGithubMirrorSyncRunParams{RepositoryID: repoID})
					require.NoError(t, err)
					claimed, err := q.MarkGithubMirrorSyncRunRunning(ctx, prior.ID)
					require.NoError(t, err)
					require.Equal(t, int64(1), claimed)
					written, err := q.UpsertGithubMirrorSyncRefResult(ctx, db.UpsertGithubMirrorSyncRefResultParams{
						RunID: prior.ID, Name: "refs/heads/main", ToRevision: strings.Repeat("a", 40), Status: gitMirrorRefFailed, Error: "earlier transfer failed",
					})
					require.NoError(t, err)
					require.Equal(t, int64(1), written)
					require.NoError(t, q.FinishGithubMirrorSyncRun(ctx, db.FinishGithubMirrorSyncRunParams{ID: prior.ID, State: gitMirrorRunFailed}))
				}
				runMirrorRestartChild(t, pool, userID, repoID, mode, phase, 0)
				var runID int64
				require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM github_mirror_sync_runs WHERE repository_id=$1 ORDER BY id DESC LIMIT 1`, repoID).Scan(&runID))
				var state string
				require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM github_mirror_sync_runs WHERE id=$1`, runID).Scan(&state))
				wantState := "running"
				if phase == "queued" {
					wantState = "queued"
				}
				require.Equal(t, wantState, state, "child must exit at the requested phase")
				_, err := pool.Exec(ctx, `UPDATE github_mirror_sync_runs SET created_at=NOW()-INTERVAL '12 minutes', updated_at=NOW()-INTERVAL '12 minutes' WHERE id=$1`, runID)
				require.NoError(t, err)
				runMirrorRestartChild(t, pool, userID, repoID, "recover", "", runID)
				result, err := NewGitMirrorSyncService(db.New(pool)).GetMirrorSyncRun(ctx, repoID, runID)
				require.NoError(t, err)
				require.Equal(t, gitMirrorRunFailed, result.State)
				require.NotNil(t, result.FinishedAt)
				if phase == "transfer" || phase == "verification" || (mode == "retry" && phase != "queued") {
					require.Len(t, result.Refs, 1)
					require.Equal(t, gitMirrorRefFailed, result.Refs[0].Status)
				}
				if phase == "transfer" {
					verifyFreshMirrorRetry(t, pool, userID, repoID, runID, mode)
				}
			})
		}
	}
}

func TestMirrorRestartAfterRealGitTransferVerifiesOnExplicitRetry(t *testing.T) {
	if os.Getenv("SMITHERS_MIRROR_RESTART_CHILD") == "1" {
		return
	}
	ctx := context.Background()
	pool := servicesSuite.Pool(t)
	userID, repoID := setupTestUserAndRepo(t, pool)
	repos := newRealMirrorRepos(t)
	want := repos.commit("new source commit")
	repos.push(repos.source, "HEAD:refs/heads/main")
	runMirrorRestartChild(t, pool, userID, repoID, "full", "real-verification", 0, repos.source, repos.target)
	require.Equal(t, want, repos.refs(repos.target)["refs/heads/main"], "real Git push completed before process exit")
	var abandonedRunID int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM github_mirror_sync_runs WHERE repository_id=$1`, repoID).Scan(&abandonedRunID))
	var state string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM github_mirror_sync_runs WHERE id=$1`, abandonedRunID).Scan(&state))
	require.Equal(t, "running", state)
	_, err := pool.Exec(ctx, `UPDATE github_mirror_sync_runs SET created_at=NOW()-INTERVAL '12 minutes', updated_at=NOW()-INTERVAL '12 minutes' WHERE id=$1`, abandonedRunID)
	require.NoError(t, err)
	runMirrorRestartChild(t, pool, userID, repoID, "recover", "", abandonedRunID)
	abandoned, err := NewGitMirrorSyncService(db.New(pool)).GetMirrorSyncRun(ctx, repoID, abandonedRunID)
	require.NoError(t, err)
	require.Equal(t, gitMirrorRunFailed, abandoned.State)
	require.Len(t, abandoned.Refs, 1)
	require.Equal(t, gitMirrorRefFailed, abandoned.Refs[0].Status)

	service := repos.service(db.New(pool))
	secondPushes := 0
	service.runGitSync = func(context.Context, string, string, []gitMirrorRefChange) error {
		secondPushes++
		return nil
	}
	newRunID, err := service.StartMirrorSync(ctx, userID, repoID, "owner", "repo")
	require.NoError(t, err)
	newRun, err := service.GetMirrorSyncRun(ctx, repoID, newRunID)
	require.NoError(t, err)
	require.Equal(t, gitMirrorRunSucceeded, newRun.State)
	require.Zero(t, secondPushes, "the explicit retry must observe the already-pushed ref")
	require.Equal(t, want, repos.refs(repos.target)["refs/heads/main"])
}

func verifyFreshMirrorRetry(t *testing.T, pool *pgxpool.Pool, userID, repoID, abandonedRunID int64, mode string) {
	t.Helper()
	ctx := context.Background()
	q := db.New(pool)
	svc := NewGitMirrorSyncService(q)
	svc.resolveRemotes = func(context.Context, int64, int64, string, string) (gitMirrorRemotes, error) {
		return gitMirrorRemotes{sourceURL: "source-fresh-credential", targetURL: "target-fresh-credential"}, nil
	}
	svc.launch = func(_ string, run func()) { run() }
	transferred := false
	svc.listRemoteRefs = func(_ context.Context, remote string) (map[string]string, error) {
		if remote == "source-fresh-credential" {
			return map[string]string{"refs/heads/main": strings.Repeat("a", 40)}, nil
		}
		require.Equal(t, "target-fresh-credential", remote)
		if transferred {
			return map[string]string{"refs/heads/main": strings.Repeat("a", 40)}, nil
		}
		return map[string]string{}, nil
	}
	svc.runGitSync = func(_ context.Context, source, target string, _ []gitMirrorRefChange) error {
		require.Equal(t, "source-fresh-credential", source)
		require.Equal(t, "target-fresh-credential", target)
		transferred = true
		return nil
	}
	svc.runGitRefSync = func(_ context.Context, source, target, _, _, _ string) error {
		require.Equal(t, "source-fresh-credential", source)
		require.Equal(t, "target-fresh-credential", target)
		transferred = true
		return nil
	}
	var newRunID int64
	var err error
	if mode == "retry" {
		newRunID, err = svc.RetryMirrorRef(ctx, userID, repoID, "owner", "repo", "refs/heads/main")
	} else {
		newRunID, err = svc.StartMirrorSync(ctx, userID, repoID, "owner", "repo")
	}
	require.NoError(t, err)
	require.NotEqual(t, abandonedRunID, newRunID)
	require.True(t, transferred)
	newRun, err := svc.GetMirrorSyncRun(ctx, repoID, newRunID)
	require.NoError(t, err)
	require.Equal(t, gitMirrorRunSucceeded, newRun.State)
	require.Len(t, newRun.Refs, 1)
	require.Equal(t, gitMirrorRefSucceeded, newRun.Refs[0].Status)

	// A delayed callback from the expired worker cannot change its receipt or
	// overwrite the health published by the newer full reconciliation.
	written, err := q.UpsertGithubMirrorSyncRefResult(ctx, db.UpsertGithubMirrorSyncRefResultParams{
		RunID: abandonedRunID, Name: "refs/heads/main", ToRevision: strings.Repeat("b", 40), Status: gitMirrorRefSucceeded,
	})
	require.NoError(t, err)
	require.Zero(t, written)
	rows, err := q.FinishSuccessfulGithubMirrorSyncRun(ctx, db.FinishSuccessfulGithubMirrorSyncRunParams{
		ID: abandonedRunID, VerifiedRefs: []byte(`{"refs/heads/main":"stale"}`),
	})
	require.NoError(t, err)
	require.Zero(t, rows)
	abandoned, err := svc.GetMirrorSyncRun(ctx, repoID, abandonedRunID)
	require.NoError(t, err)
	require.Equal(t, gitMirrorRunFailed, abandoned.State)
	if mode == "retry" {
		require.Len(t, abandoned.Refs, 1)
		require.Equal(t, gitMirrorRefFailed, abandoned.Refs[0].Status)
	} else {
		require.Len(t, abandoned.Refs, 1)
		require.Equal(t, gitMirrorRefFailed, abandoned.Refs[0].Status)
		var health, head string
		require.NoError(t, pool.QueryRow(ctx, `SELECT mirror_status, last_mirror_github_head FROM repositories WHERE id=$1`, repoID).Scan(&health, &head))
		require.Equal(t, "synced", health)
		require.Equal(t, strings.Repeat("a", 40), head)
	}
}

func TestMirrorRestartMintsFreshCredentialsForNewReconciliation(t *testing.T) {
	ctx := context.Background()
	pool := servicesSuite.Pool(t)
	userID, repoID := setupTestUserAndRepo(t, pool)
	_, err := pool.Exec(ctx, `UPDATE repositories SET mirror_destination='https://github.com/upstream/renamed.git' WHERE id=$1`, repoID)
	require.NoError(t, err)
	q := db.New(pool)
	issued := 0
	github := mirrorGitHubCredentialFunc(func(_ context.Context, gotUser int64, owner, repo string) (string, error) {
		require.Equal(t, userID, gotUser)
		require.Equal(t, "upstream", owner)
		require.Equal(t, "renamed", repo)
		issued++
		return fmt.Sprintf("caller-github-secret-%d", issued), nil
	})
	first := NewGitMirrorSyncService(q, WithGitMirrorCredentials(q, github, "https://forge.example"))
	first.launch = func(_ string, _ func()) {} // accepted before its process exits
	abandonedRunID, err := first.StartMirrorSync(ctx, userID, repoID, "native", "copy")
	require.NoError(t, err)
	require.Equal(t, 1, issued)
	_, err = pool.Exec(ctx, `UPDATE github_mirror_sync_runs SET created_at=NOW()-INTERVAL '12 minutes', updated_at=NOW()-INTERVAL '12 minutes' WHERE id=$1`, abandonedRunID)
	require.NoError(t, err)
	runMirrorRestartChild(t, pool, userID, repoID, "recover", "", abandonedRunID)

	second := NewGitMirrorSyncService(q, WithGitMirrorCredentials(q, github, "https://forge.example"))
	second.launch = func(_ string, run func()) { run() }
	transferred := false
	second.listRemoteRefs = func(_ context.Context, remote string) (map[string]string, error) {
		parsed, parseErr := url.Parse(remote)
		require.NoError(t, parseErr)
		if parsed.Host == "forge.example" {
			return map[string]string{"refs/heads/main": strings.Repeat("a", 40)}, nil
		}
		require.Equal(t, "github.com", parsed.Host)
		if transferred {
			return map[string]string{"refs/heads/main": strings.Repeat("a", 40)}, nil
		}
		return map[string]string{}, nil
	}
	second.runGitSync = func(_ context.Context, _, target string, _ []gitMirrorRefChange) error {
		parsed, parseErr := url.Parse(target)
		require.NoError(t, parseErr)
		password, ok := parsed.User.Password()
		require.True(t, ok)
		require.Equal(t, "caller-github-secret-2", password)
		transferred = true
		return nil
	}
	newRunID, err := second.StartMirrorSync(ctx, userID, repoID, "native", "copy")
	require.NoError(t, err)
	require.Equal(t, 2, issued)
	require.True(t, transferred)
	newRun, err := second.GetMirrorSyncRun(ctx, repoID, newRunID)
	require.NoError(t, err)
	require.Equal(t, gitMirrorRunSucceeded, newRun.State)
}

func (f *fakeGitMirrorSyncStore) ExpireGithubMirrorSyncRuns(context.Context, int64) (int64, error) {
	return 0, nil
}

type failingMirrorRecoveryStore struct{ *fakeGitMirrorSyncStore }

func (s *failingMirrorRecoveryStore) ExpireGithubMirrorSyncRuns(context.Context, int64) (int64, error) {
	return 0, errors.New("PostgreSQL recovery unavailable")
}

func TestMirrorRecoveryErrorStopsAdmissionPollAndRetryBeforeCredentials(t *testing.T) {
	for _, operation := range []string{"admission", "poll", "retry"} {
		t.Run(operation, func(t *testing.T) {
			store := &failingMirrorRecoveryStore{fakeGitMirrorSyncStore: newFakeGitMirrorSyncStore()}
			svc := NewGitMirrorSyncService(store)
			credentialReads := 0
			launches := 0
			svc.resolveRemotes = func(context.Context, int64, int64, string, string) (gitMirrorRemotes, error) {
				credentialReads++
				return gitMirrorRemotes{}, nil
			}
			svc.launch = func(string, func()) { launches++ }
			var err error
			switch operation {
			case "admission":
				_, err = svc.StartGitHubReconcile(context.Background(), 7, 101, "owner", "repo")
			case "poll":
				_, err = svc.GetMirrorSyncRun(context.Background(), 101, 41)
			case "retry":
				_, err = svc.RetryMirrorRef(context.Background(), 7, 101, "owner", "repo", "refs/heads/main")
			}
			require.ErrorContains(t, err, "recover interrupted git mirror sync")
			require.Zero(t, credentialReads)
			require.Zero(t, launches)
			require.Zero(t, store.run.ID)
		})
	}
}

type transientMirrorRecoveryStore struct {
	*fakeGitMirrorSyncStore
	calls    atomic.Int32
	seen     chan int32
	onSecond func()
}

type immediateMirrorRecoveryStore struct {
	*fakeGitMirrorSyncStore
	calls atomic.Int32
	seen  chan struct{}
}

func (s *immediateMirrorRecoveryStore) ExpireGithubMirrorSyncRuns(ctx context.Context, repositoryID int64) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if repositoryID != 0 {
		return 0, fmt.Errorf("expected global recovery, got repository %d", repositoryID)
	}
	s.calls.Add(1)
	s.seen <- struct{}{}
	return 1, nil
}

func TestMirrorStartRecoverySweepsImmediatelyAndHonorsCancellation(t *testing.T) {
	store := &immediateMirrorRecoveryStore{fakeGitMirrorSyncStore: newFakeGitMirrorSyncStore(), seen: make(chan struct{}, 2)}
	svc := NewGitMirrorSyncService(store)
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	svc.StartRecovery(canceled)
	require.Zero(t, store.calls.Load())

	ctx, stop := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		svc.StartRecovery(ctx)
		close(done)
	}()
	select {
	case <-store.seen:
		stop()
	case <-time.After(time.Second):
		stop()
		t.Fatal("StartRecovery did not sweep immediately")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("StartRecovery did not stop after cancellation")
	}
	require.Equal(t, int32(1), store.calls.Load())
}

func TestMirrorCommandCancellationStopsTransportDescendants(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("shell unavailable")
	}
	heartbeat := filepath.Join(t.TempDir(), "transport-heartbeat")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := mirrorCommand(ctx, "sh", "-c", `while :; do printf x >> "$1"; sleep 0.02; done & wait`, "mirror-transport", heartbeat)
	done := make(chan error, 1)
	go func() {
		_, err := cmd.CombinedOutput()
		done <- err
	}()
	deadline := time.After(5 * time.Second)
	for {
		info, err := os.Stat(heartbeat)
		if err == nil && info.Size() > 0 {
			break
		}
		select {
		case <-deadline:
			cancel()
			t.Fatal("transport descendant never started")
		case <-time.After(10 * time.Millisecond):
		}
	}
	started := time.Now()
	cancel()
	select {
	case err := <-done:
		require.Error(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("mirror command did not return after cancellation")
	}
	require.Less(t, time.Since(started), 5*time.Second)
	before, err := os.Stat(heartbeat)
	require.NoError(t, err)
	time.Sleep(150 * time.Millisecond)
	after, err := os.Stat(heartbeat)
	require.NoError(t, err)
	require.Equal(t, before.Size(), after.Size(), "transport descendant kept running after cancellation")
}

func TestMirrorCommandCancelLifecycleAndSanitizedGitEnvironment(t *testing.T) {
	t.Setenv("GIT_CONFIG_COUNT", "99")
	t.Setenv("GIT_CONFIG_KEY_0", "http.secret.extraHeader")
	t.Setenv("GIT_CONFIG_VALUE_0", "Authorization: stale")
	t.Setenv("GIT_TERMINAL_PROMPT", "1")
	ctx, cancel := context.WithCancel(context.Background())
	cmd := mirrorCommand(ctx, "sh", "-c", "exit 0")
	require.Contains(t, cmd.Env, "GIT_CONFIG_COUNT=0")
	require.Contains(t, cmd.Env, "GIT_TERMINAL_PROMPT=0")
	require.NotContains(t, cmd.Env, "GIT_CONFIG_COUNT=99")
	require.NotContains(t, cmd.Env, "GIT_CONFIG_KEY_0=http.secret.extraHeader")
	require.NotContains(t, cmd.Env, "GIT_CONFIG_VALUE_0=Authorization: stale")
	require.NotContains(t, cmd.Env, "GIT_TERMINAL_PROMPT=1")
	require.NoError(t, cmd.Cancel(), "cancellation before Start has no process to kill")
	require.NoError(t, cmd.Run())
	require.ErrorIs(t, cmd.Cancel(), os.ErrProcessDone)
	cancel()
}

type expiredAtAdmissionMirrorStore struct{ *fakeGitMirrorSyncStore }

type futureCreatedMirrorStore struct{ *fakeGitMirrorSyncStore }

func (s *futureCreatedMirrorStore) CreateGithubMirrorSyncRun(ctx context.Context, params db.CreateGithubMirrorSyncRunParams) (db.GithubMirrorSyncRun, error) {
	run, err := s.fakeGitMirrorSyncStore.CreateGithubMirrorSyncRun(ctx, params)
	if err != nil {
		return run, err
	}
	run.CreatedAt = time.Now().Add(24 * time.Hour)
	s.mu.Lock()
	s.run.CreatedAt = run.CreatedAt
	s.mu.Unlock()
	return run, nil
}

func TestMirrorWorkerDeadlineUsesLocalAdmissionEvenWithFutureDatabaseClock(t *testing.T) {
	for _, mode := range []string{"full", "retry"} {
		t.Run(mode, func(t *testing.T) {
			store := &futureCreatedMirrorStore{fakeGitMirrorSyncStore: newFakeGitMirrorSyncStore()}
			if mode == "retry" {
				store.seed(db.GithubMirrorSyncRefResult{Name: "refs/heads/main", ToRevision: strings.Repeat("a", 40), Status: gitMirrorRefFailed})
			}
			svc := NewGitMirrorSyncService(store)
			svc.resolveRemotes = func(context.Context, int64, int64, string, string) (gitMirrorRemotes, error) {
				return gitMirrorRemotes{sourceURL: "source", targetURL: "target"}, nil
			}
			svc.launch = func(_ string, run func()) { run() }
			beforeAdmission := time.Now()
			observed := false
			svc.listRemoteRefs = func(ctx context.Context, remote string) (map[string]string, error) {
				deadline, ok := ctx.Deadline()
				require.True(t, ok)
				require.False(t, deadline.After(beforeAdmission.Add(gitMirrorSyncTimeout+time.Second)))
				require.True(t, deadline.After(beforeAdmission.Add(gitMirrorSyncTimeout-time.Second)))
				observed = true
				if remote == "source" {
					return map[string]string{"refs/heads/main": strings.Repeat("a", 40)}, nil
				}
				return map[string]string{"refs/heads/main": strings.Repeat("a", 40)}, nil
			}
			var err error
			if mode == "retry" {
				_, err = svc.RetryMirrorRef(context.Background(), 7, 101, "owner", "repo", "refs/heads/main")
			} else {
				_, err = svc.StartGitHubReconcile(context.Background(), 7, 101, "owner", "repo")
			}
			require.NoError(t, err)
			require.True(t, observed)
		})
	}
}

type fencedMirrorRefStore struct {
	*fakeGitMirrorSyncStore
	writeErr error
}

func (s *fencedMirrorRefStore) UpsertGithubMirrorSyncRefResult(context.Context, db.UpsertGithubMirrorSyncRefResultParams) (int64, error) {
	return 0, s.writeErr
}

func TestMirrorFencedPendingWritePreventsExternalPush(t *testing.T) {
	for _, mode := range []string{"full", "retry"} {
		for _, writeErr := range []error{nil, errors.New("temporary PostgreSQL failure")} {
			name := mode + "/zero-rows"
			if writeErr != nil {
				name = mode + "/database-error"
			}
			t.Run(name, func(t *testing.T) {
				store := &fencedMirrorRefStore{fakeGitMirrorSyncStore: newFakeGitMirrorSyncStore(), writeErr: writeErr}
				if mode == "retry" {
					store.seed(db.GithubMirrorSyncRefResult{Name: "refs/heads/main", ToRevision: strings.Repeat("a", 40), Status: gitMirrorRefFailed})
				}
				svc := NewGitMirrorSyncService(store)
				svc.resolveRemotes = func(context.Context, int64, int64, string, string) (gitMirrorRemotes, error) {
					return gitMirrorRemotes{sourceURL: "source", targetURL: "target"}, nil
				}
				svc.launch = func(_ string, run func()) { run() }
				svc.listRemoteRefs = func(_ context.Context, remote string) (map[string]string, error) {
					if remote == "source" {
						return map[string]string{"refs/heads/main": strings.Repeat("a", 40)}, nil
					}
					return map[string]string{}, nil
				}
				gitTouched := false
				svc.runGitSync = func(context.Context, string, string, []gitMirrorRefChange) error {
					gitTouched = true
					return nil
				}
				svc.runGitRefSync = func(context.Context, string, string, string, string, string) error {
					gitTouched = true
					return nil
				}
				var err error
				if mode == "retry" {
					_, err = svc.RetryMirrorRef(context.Background(), 7, 101, "owner", "repo", "refs/heads/main")
				} else {
					_, err = svc.StartMirrorSync(context.Background(), 7, 101, "owner", "repo")
				}
				require.NoError(t, err)
				require.False(t, gitTouched)
				require.Equal(t, gitMirrorRunFailed, store.run.State)
			})
		}
	}
}

func (s *expiredAtAdmissionMirrorStore) CreateGithubMirrorSyncRun(ctx context.Context, params db.CreateGithubMirrorSyncRunParams) (db.GithubMirrorSyncRun, error) {
	run, err := s.fakeGitMirrorSyncStore.CreateGithubMirrorSyncRun(ctx, params)
	if err != nil {
		return run, err
	}
	run.CreatedAt = time.Now().Add(-11 * time.Minute)
	s.mu.Lock()
	s.run.CreatedAt = run.CreatedAt
	s.mu.Unlock()
	return run, nil
}

func (s *expiredAtAdmissionMirrorStore) MarkGithubMirrorSyncRunRunning(ctx context.Context, id int64) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if time.Since(s.run.CreatedAt) >= gitMirrorSyncTimeout {
		return 0, nil // PostgreSQL refuses an expired queued claim.
	}
	return s.fakeGitMirrorSyncStore.MarkGithubMirrorSyncRunRunning(ctx, id)
}

func TestMirrorDelayedLaunchPastFixedDeadlineDoesNotReadOrTransfer(t *testing.T) {
	for _, mode := range []string{"full", "retry"} {
		t.Run(mode, func(t *testing.T) {
			store := &expiredAtAdmissionMirrorStore{fakeGitMirrorSyncStore: newFakeGitMirrorSyncStore()}
			if mode == "retry" {
				store.seed(db.GithubMirrorSyncRefResult{Name: "refs/heads/main", ToRevision: strings.Repeat("a", 40), Status: gitMirrorRefFailed})
			}
			svc := NewGitMirrorSyncService(store)
			svc.resolveRemotes = func(context.Context, int64, int64, string, string) (gitMirrorRemotes, error) {
				return gitMirrorRemotes{sourceURL: "source", targetURL: "target"}, nil
			}
			var worker func()
			svc.launch = func(_ string, run func()) { worker = run }
			gitTouched := false
			svc.listRemoteRefs = func(context.Context, string) (map[string]string, error) {
				gitTouched = true
				return nil, nil
			}
			svc.runGitSync = func(context.Context, string, string, []gitMirrorRefChange) error {
				gitTouched = true
				return nil
			}
			svc.runGitRefSync = func(context.Context, string, string, string, string, string) error {
				gitTouched = true
				return nil
			}
			var err error
			if mode == "retry" {
				_, err = svc.RetryMirrorRef(context.Background(), 7, 101, "owner", "repo", "refs/heads/main")
			} else {
				_, err = svc.StartGitHubReconcile(context.Background(), 7, 101, "owner", "repo")
			}
			require.NoError(t, err)
			require.NotNil(t, worker)
			worker()
			require.False(t, gitTouched)
			require.Equal(t, "queued", store.run.State)
		})
	}
}

func (s *transientMirrorRecoveryStore) ExpireGithubMirrorSyncRuns(ctx context.Context, repositoryID int64) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if repositoryID != 0 {
		return 0, fmt.Errorf("expected global recovery, got repository %d", repositoryID)
	}
	call := s.calls.Add(1)
	s.seen <- call
	if call == 1 {
		return 0, errors.New("temporary PostgreSQL failure")
	}
	if s.onSecond != nil {
		s.onSecond()
	}
	return 1, nil
}

func TestMirrorRecoveryRetriesTransientFailureAndStopsOnCancellation(t *testing.T) {
	store := &transientMirrorRecoveryStore{fakeGitMirrorSyncStore: newFakeGitMirrorSyncStore(), seen: make(chan int32, 3)}
	svc := NewGitMirrorSyncService(store)
	ctx, cancel := context.WithCancel(context.Background())
	store.onSecond = cancel
	done := make(chan struct{})
	go func() {
		svc.runRecovery(ctx, time.Millisecond)
		close(done)
	}()
	for _, expected := range []int32{1, 2} {
		select {
		case got := <-store.seen:
			require.Equal(t, expected, got)
		case <-time.After(time.Second):
			t.Fatal("recovery did not retry a transient database failure")
		}
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("recovery did not stop on cancellation")
	}
	require.Equal(t, int32(2), store.calls.Load())
}

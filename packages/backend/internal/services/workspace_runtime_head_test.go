package services

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	processruntime "github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type runtimeHeadQuerier struct {
	*runtimeRepositoryQuerier
	mu          sync.Mutex
	headTokenID int64
	// beforeSwap runs before the compare, as a concurrent replica would.
	beforeSwap func()
	// revoke deletes an access token, as the swap statement does.
	revoke func(int64)
	// afterSwap runs after a won swap, as a later replica's swap would.
	afterSwap func()
}

func (q *runtimeHeadQuerier) SwapWorkspaceHeadPushTokenID(_ context.Context, _ string, _ int64, expected, next pgtype.Int8) (bool, error) {
	if q.beforeSwap != nil {
		q.beforeSwap()
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	recorded := pgtype.Int8{Int64: q.headTokenID, Valid: q.headTokenID != 0}
	if recorded != expected {
		return false, nil
	}
	q.headTokenID = 0
	if next.Valid {
		q.headTokenID = next.Int64
	}
	if expected.Valid {
		q.revoke(expected.Int64)
	}
	if q.afterSwap != nil {
		defer q.afterSwap()
	}
	return true, nil
}

func (q *runtimeHeadQuerier) SetWorkspaceHeadPushTokenID(_ context.Context, arg db.SetWorkspaceHeadPushTokenIDParams) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.headTokenID = 0
	if arg.HeadPushTokenID.Valid {
		q.headTokenID = arg.HeadPushTokenID.Int64
	}
	return nil
}

func (q *runtimeHeadQuerier) recordedHeadTokenID() int64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.headTokenID
}

// liveTokens is the fixture's access-token table: a Git request is accepted
// only with a token that was issued and not yet revoked, like production.
type liveTokens struct {
	mu        sync.Mutex
	next      int64
	byHash    map[string]int64
	presented map[string]bool
}

func (l *liveTokens) issue(arg db.CreateAccessTokenParams) db.AccessToken {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.next++
	l.byHash[arg.TokenHash] = l.next
	return db.AccessToken{ID: l.next}
}

func (l *liveTokens) revoke(id int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for hash, live := range l.byHash {
		if live == id {
			delete(l.byHash, hash)
		}
	}
}

func (l *liveTokens) accept(secret string) bool {
	sum := sha256.Sum256([]byte(secret))
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.byHash[hex.EncodeToString(sum[:])]; !ok {
		return false
	}
	l.presented[secret] = true
	return true
}

func (l *liveTokens) secrets() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, 0, len(l.presented))
	for secret := range l.presented {
		out = append(out, secret)
	}
	return out
}

func presentedSecret(request *http.Request) string {
	authorization := request.Header.Get("Authorization")
	if bearer, ok := strings.CutPrefix(authorization, "Bearer "); ok {
		return strings.TrimSpace(bearer)
	}
	if basic, ok := strings.CutPrefix(authorization, "Basic "); ok {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(basic))
		if err != nil {
			return ""
		}
		_, password, _ := strings.Cut(string(decoded), ":")
		return password
	}
	return ""
}

// runtimeGit bounds each request, so a stalled Git transport fails the test
// instead of stalling the package.
func runtimeGit(ctx context.Context, runtime *processruntime.Runtime, workspaceID string, args ...string) (workspaceapi.CommandResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return runtime.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{
		Args:        append([]string{"git"}, args...),
		Environment: map[string]string{"GIT_TERMINAL_PROMPT": "0"},
	})
}

func eventuallyListsMain(t *testing.T, runtime *processruntime.Runtime, workspaceID, want string) {
	t.Helper()
	var last workspaceapi.CommandResult
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		result, err := runtimeGit(context.Background(), runtime, workspaceID, "ls-remote", "origin", "refs/heads/main")
		require.NoError(t, err)
		if result.ExitCode == 0 && strings.HasPrefix(result.Stdout, want) {
			return
		}
		last = result
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("workspace could not read its origin: exit %d: %s", last.ExitCode, last.Stderr)
}

func reporterPidfile(home string) string {
	return filepath.Join(home, ".cache", "smithers", "git-credential", "reporter.pid")
}

// reporterRecord is the publisher's pidfile: pid, token id, token expiry.
func reporterRecord(t *testing.T, home string) (int, int64, int64) {
	t.Helper()
	contents, err := os.ReadFile(reporterPidfile(home))
	require.NoError(t, err)
	fields := strings.Fields(string(contents))
	require.Len(t, fields, 3, "pidfile %q", contents)
	pid, err := strconv.Atoi(fields[0])
	require.NoError(t, err)
	tokenID, err := strconv.ParseInt(fields[1], 10, 64)
	require.NoError(t, err)
	expires, err := strconv.ParseInt(fields[2], 10, 64)
	require.NoError(t, err)
	return pid, tokenID, expires
}

func reporterPID(t *testing.T, home string) int {
	t.Helper()
	pid, _, _ := reporterRecord(t, home)
	return pid
}

func requireRevoked(t *testing.T, tokens *liveTokens, id int64) {
	t.Helper()
	tokens.mu.Lock()
	defer tokens.mu.Unlock()
	for _, live := range tokens.byHash {
		require.NotEqual(t, id, live, "token %d must be revoked", id)
	}
}

func processAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }

// A runtime workspace must reach its own private repository for as long as it
// runs: the product keeps one workspace-bound credential in the guest's
// in-memory Git cache, replaces it when the publisher is gone, and never
// writes the token to workspace files.
func TestRuntimeWorkspaceKeepsRepositoryCredentialWhileRunning(t *testing.T) {
	requireExecutable(t, "git")
	requireExecutable(t, "jj")
	requireExecutable(t, "bash")

	const owner, repo = "alice", "private"
	gitRoot := t.TempDir()
	seedBareRepository(t, filepath.Join(gitRoot, "api", owner, repo+".git"), "main")
	mainCommit := strings.Fields(runGitFixture(t, filepath.Join(gitRoot, "api", owner, repo+".git"), nil, "rev-parse", "refs/heads/main"))[0]

	tokens := &liveTokens{byHash: map[string]int64{}, presented: map[string]bool{}}
	gitExecutable, err := exec.LookPath("git")
	require.NoError(t, err)
	backend := &cgi.Handler{
		Path: gitExecutable, Args: []string{"http-backend"}, Dir: gitRoot,
		Env: []string{"GIT_PROJECT_ROOT=" + gitRoot, "GIT_HTTP_EXPORT_ALL=1"},
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if !tokens.accept(presentedSecret(request)) {
			response.Header().Set("WWW-Authenticate", `Basic realm="smithers"`)
			http.Error(response, "authentication required", http.StatusUnauthorized)
			return
		}
		backend.ServeHTTP(response, request)
	}))
	t.Cleanup(server.Close)

	row := sampleDBWorkspace("runtime-head-credential")
	row.Status = "starting"
	row.VmID = ""
	current := row
	mock := &mockWorkspaceQuerier{}
	var queries *runtimeHeadQuerier
	mock.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) {
		current.HeadPushTokenID = pgtype.Int8{}
		if id := queries.recordedHeadTokenID(); id != 0 {
			current.HeadPushTokenID = pgtype.Int8{Int64: id, Valid: true}
		}
		return current, nil
	}
	mock.updateWorkspaceStatusFn = func(_ context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
		current.Status = arg.Status
		return current, nil
	}
	mock.createAccessTokenFn = func(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
		return tokens.issue(arg), nil
	}
	mock.deleteAccessTokenFn = func(_ context.Context, arg db.DeleteAccessTokenParams) error {
		tokens.revoke(arg.ID)
		return nil
	}
	queries = &runtimeHeadQuerier{runtimeRepositoryQuerier: &runtimeRepositoryQuerier{mockWorkspaceQuerier: mock, owner: owner, repo: repo},
		revoke: tokens.revoke}
	// Unix socket paths are short (104 bytes on Darwin); keep the root shallow.
	root, err := os.MkdirTemp("/tmp", "smrt")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	// A guest has no host keychain; the host's system Git config would add one.
	runtime, err := processruntime.New(processruntime.Config{Root: root, MaxConcurrent: 4,
		Environment: map[string]string{"GIT_CONFIG_NOSYSTEM": "1"}})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	service := newWorkspaceServiceForTests(queries, WithWorkspaceRuntime(runtime), WithWorkspaceGitBaseURL(server.URL+"/api"))

	running, err := service.ensureRuntimeWorkspaceRunningLocked(context.Background(), row, row.UserID)
	require.NoError(t, err)
	require.Equal(t, "running", running.Status)
	firstToken := queries.recordedHeadTokenID()
	require.NotZero(t, firstToken, "the workspace credential is recorded so suspend, stop and delete revoke it")
	eventuallyListsMain(t, runtime, row.ID, mainCommit)

	observed, err := runtime.InspectWorkspace(context.Background(), row.ID)
	require.NoError(t, err)
	firstPID := reporterPID(t, observed.Home)

	// A later transition with a live publisher keeps its credential.
	again, err := service.ensureRuntimeWorkspaceRunningLocked(context.Background(), running, row.UserID)
	require.NoError(t, err)
	require.Equal(t, firstToken, queries.recordedHeadTokenID())
	require.Equal(t, firstPID, reporterPID(t, observed.Home))

	firstRecordPID, firstRecordToken, firstExpires := reporterRecord(t, observed.Home)
	require.Equal(t, firstPID, firstRecordPID)
	require.Equal(t, firstToken, firstRecordToken)
	require.Greater(t, firstExpires, time.Now().Add(workspaceHeadTokenTTL/2).Unix())

	ensure := func() {
		t.Helper()
		_, err := service.ensureRuntimeWorkspaceRunningLocked(context.Background(), again, row.UserID)
		require.NoError(t, err)
	}

	// A guest that lost its publisher gets a fresh credential; the old one is
	// revoked, so only the replacement can reach the repository.
	require.NoError(t, syscall.Kill(firstPID, syscall.SIGKILL))
	require.Eventually(t, func() bool { return !processAlive(firstPID) }, 5*time.Second, 20*time.Millisecond)
	ensure()
	secondToken := queries.recordedHeadTokenID()
	require.NotEqual(t, firstToken, secondToken)
	requireRevoked(t, tokens, firstToken)
	eventuallyListsMain(t, runtime, row.ID, mainCommit)

	// A failed suspend revokes the token, then rolls the row back to running
	// with the publisher still alive. The next transition replaces it.
	secondPID := reporterPID(t, observed.Home)
	suspended := current
	suspended.HeadPushTokenID = pgtype.Int8{Int64: secondToken, Valid: true}
	service.revokeWorkspaceHeadToken(context.Background(), suspended)
	require.Zero(t, queries.recordedHeadTokenID())
	ensure()
	thirdToken := queries.recordedHeadTokenID()
	require.NotZero(t, thirdToken)
	require.NotEqual(t, secondToken, thirdToken)
	require.Eventually(t, func() bool { return !processAlive(secondPID) }, 10*time.Second, 20*time.Millisecond,
		"the replacement retires the publisher holding the revoked token")
	eventuallyListsMain(t, runtime, row.ID, mainCommit)

	// A token past half its lifetime is renewed before it can expire.
	thirdPID, _, _ := reporterRecord(t, observed.Home)
	require.NoError(t, os.WriteFile(reporterPidfile(observed.Home),
		[]byte(fmt.Sprintf("%d %d %d\n", thirdPID, thirdToken, time.Now().Add(time.Hour).Unix())), 0o600))
	ensure()
	fourthToken := queries.recordedHeadTokenID()
	require.NotEqual(t, thirdToken, fourthToken)
	requireRevoked(t, tokens, thirdToken)
	eventuallyListsMain(t, runtime, row.ID, mainCommit)

	// A pidfile naming a live process that is not the publisher, as after a
	// restart or pid reuse, starts a publisher and leaves that process alone.
	fourthPID := reporterPID(t, observed.Home)
	require.NoError(t, syscall.Kill(fourthPID, syscall.SIGKILL))
	require.Eventually(t, func() bool { return !processAlive(fourthPID) }, 5*time.Second, 20*time.Millisecond)
	unrelated := exec.Command("sleep", "300")
	require.NoError(t, unrelated.Start())
	t.Cleanup(func() { _ = unrelated.Process.Kill(); _, _ = unrelated.Process.Wait() })
	require.NoError(t, os.WriteFile(reporterPidfile(observed.Home),
		[]byte(fmt.Sprintf("%d %d %d\n", unrelated.Process.Pid, fourthToken, time.Now().Add(workspaceHeadTokenTTL).Unix())), 0o600))
	ensure()
	require.NotEqual(t, fourthToken, queries.recordedHeadTokenID())
	require.True(t, processAlive(unrelated.Process.Pid), "an unrelated process must never be signalled")
	eventuallyListsMain(t, runtime, row.ID, mainCommit)

	// A replica that recorded its own publisher first wins; this one revokes
	// the token it minted instead of leaving it live and unrecorded.
	fifthPID := reporterPID(t, observed.Home)
	require.NoError(t, syscall.Kill(fifthPID, syscall.SIGKILL))
	require.Eventually(t, func() bool { return !processAlive(fifthPID) }, 5*time.Second, 20*time.Millisecond)
	const otherReplicaToken = int64(1 << 40)
	issued := func() int64 { tokens.mu.Lock(); defer tokens.mu.Unlock(); return tokens.next }
	issuedBefore := issued()
	queries.beforeSwap = func() {
		queries.mu.Lock()
		queries.headTokenID = otherReplicaToken
		queries.mu.Unlock()
	}
	ensure()
	queries.beforeSwap = nil
	require.Equal(t, otherReplicaToken, queries.recordedHeadTokenID())
	require.Equal(t, issuedBefore+1, issued(), "this replica minted one token")
	requireRevoked(t, tokens, issued())
	// The next transition converges on a publisher holding the recorded token.
	ensure()
	require.NotEqual(t, otherReplicaToken, queries.recordedHeadTokenID())
	eventuallyListsMain(t, runtime, row.ID, mainCommit)

	// The reported symptom: jj in the colocated checkout fetches through Git.
	fetchCtx, cancelFetch := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelFetch()
	fetched, err := runtime.ExecuteCommand(fetchCtx, row.ID, workspaceapi.Command{
		Args: []string{"jj", "git", "fetch"}, Environment: map[string]string{"GIT_TERMINAL_PROMPT": "0"}})
	require.NoError(t, err)
	require.Zerof(t, fetched.ExitCode, "jj git fetch: %s", fetched.Stderr)

	// A replica that swaps after this one owns the workspace: this replica
	// stops the publisher it started, and the next transition converges.
	sixthPID := reporterPID(t, observed.Home)
	require.NoError(t, syscall.Kill(sixthPID, syscall.SIGKILL))
	require.Eventually(t, func() bool { return !processAlive(sixthPID) }, 5*time.Second, 20*time.Millisecond)
	const laterReplicaToken = int64(1 << 41)
	// Runs inside the swap's critical section, as a replica that swaps next.
	queries.afterSwap = func() {
		queries.afterSwap = nil
		queries.headTokenID = laterReplicaToken
	}
	ensure()
	require.Equal(t, laterReplicaToken, queries.recordedHeadTokenID())
	require.Eventually(t, func() bool {
		pid, err := os.ReadFile(reporterPidfile(observed.Home))
		if err != nil {
			return true
		}
		fields := strings.Fields(string(pid))
		if len(fields) == 0 {
			return true
		}
		stale, _ := strconv.Atoi(fields[0])
		return !processAlive(stale)
	}, 10*time.Second, 20*time.Millisecond, "the superseded replica stops its publisher")
	ensure()
	require.NotEqual(t, laterReplicaToken, queries.recordedHeadTokenID())
	eventuallyListsMain(t, runtime, row.ID, mainCommit)

	// The box host's repair runs on a replica that also holds a sandbox
	// client; with a runtime composed it restores the runtime publisher and
	// never starts the sandbox one beside it.
	seventhPID := reporterPID(t, observed.Home)
	require.NoError(t, syscall.Kill(seventhPID, syscall.SIGKILL))
	require.Eventually(t, func() bool { return !processAlive(seventhPID) }, 5*time.Second, 20*time.Millisecond)
	sandboxOnly := &mockWorkspaceSandboxVMClient{
		execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			t.Error("a runtime workspace's publisher is never probed through the sandbox client")
			return sandbox.ExecResult{}, errors.New("unexpected sandbox exec")
		},
		createSystemdServiceFn: func(context.Context, string, sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			t.Error("a runtime workspace never gets a sandbox publisher")
			return sandbox.CreateServiceResult{}, errors.New("unexpected sandbox service")
		},
	}
	boxHostReplica := newWorkspaceServiceForTests(queries, WithWorkspaceRuntime(runtime),
		WithWorkspaceGitBaseURL(server.URL+"/api"), WithWorkspaceSandboxClient(sandboxOnly))
	beforeRepair := queries.recordedHeadTokenID()
	repaired, err := boxHostReplica.ensureWorkspaceHeadReporter(context.Background(), again)
	require.NoError(t, err)
	require.NotEqual(t, beforeRepair, queries.recordedHeadTokenID())
	require.Equal(t, pgtype.Int8{Int64: queries.recordedHeadTokenID(), Valid: true}, repaired.HeadPushTokenID)
	requireRevoked(t, tokens, beforeRepair)
	eventuallyListsMain(t, runtime, row.ID, mainCommit)

	// A publisher that exits before seeding is stopped, the install fails,
	// and the next install starts a working publisher.
	eighthPID := reporterPID(t, observed.Home)
	require.NoError(t, syscall.Kill(eighthPID, syscall.SIGKILL))
	require.Eventually(t, func() bool { return !processAlive(eighthPID) }, 5*time.Second, 20*time.Millisecond)
	failing := &unseededPublisherRuntime{WorkspaceRuntime: runtime}
	failingReplica := newWorkspaceServiceForTests(queries, WithWorkspaceRuntime(failing), WithWorkspaceGitBaseURL(server.URL+"/api"))
	_, err = failingReplica.installRuntimeWorkspaceHeadReporter(context.Background(), queries, again, row.UserID, observed)
	require.ErrorContains(t, err, "exited before seeding")
	require.Equal(t, 1, failing.stopsAfterStart, "the unseeded publisher is stopped")
	_, err = service.installRuntimeWorkspaceHeadReporter(context.Background(), queries, again, row.UserID, observed)
	require.NoError(t, err)
	eventuallyListsMain(t, runtime, row.ID, mainCommit)

	secrets := tokens.secrets()
	require.NotEmpty(t, secrets)
	require.NoError(t, filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || !entry.Type().IsRegular() {
			return walkErr
		}
		contents, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, secret := range secrets {
			require.NotContains(t, string(contents), secret, "token written to %s", path)
		}
		return nil
	}))
}

// Two publishers that start together can both read an empty pidfile, so
// neither retires the other. The one that wrote the pidfile last owns the
// guest: the other exits at its next poll and leaves the owner's credential.
func TestWorkspaceHeadReporterBesideAnotherExitsAndKeepsTheOwnersCredential(t *testing.T) {
	requireExecutable(t, "bash")
	dir := t.TempDir()
	cache := filepath.Join(dir, "credential")
	fakeGit := `#!/usr/bin/env bash
case "${!#}" in
  store) cat > "$TEST_CACHE" ;;
  exit) rm -f "$TEST_CACHE" ;;
esac
`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "git"), []byte(fakeGit), 0o755))
	socket := filepath.Join(dir, "cache", "socket")
	pidfile := filepath.Join(dir, "cache", "reporter.pid")
	start := func(token string, id int) *exec.Cmd {
		cmd := exec.Command("bash", "-c", workspaceHeadReporterScript)
		cmd.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"),
			"SMITHERS_WORKSPACE_PATH="+filepath.Join(dir, "absent"),
			"SMITHERS_WORKSPACE_ID=test", "SMITHERS_API_BASE_URL=https://example.invalid/api",
			"SMITHERS_WORKSPACE_REPO=test/repo", "SMITHERS_WORKSPACE_GIT_URL=https://example.invalid/test/repo.git",
			"SMITHERS_WORKSPACE_GIT_CREDENTIAL_SOCKET="+socket, "SMITHERS_WORKSPACE_HEAD_POLL_SECONDS=0.1",
			"SMITHERS_WORKSPACE_TOKEN="+token, fmt.Sprintf("SMITHERS_WORKSPACE_TOKEN_ID=%d", id), "TEST_CACHE="+cache)
		require.NoError(t, cmd.Start())
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
		return cmd
	}
	owner := func() string {
		contents, _ := os.ReadFile(pidfile)
		return strings.SplitN(string(contents), " ", 2)[0]
	}
	cached := func() string {
		contents, _ := os.ReadFile(cache)
		return string(contents)
	}

	first := start("token-first", 1)
	require.Eventually(t, func() bool {
		return owner() == strconv.Itoa(first.Process.Pid) && strings.Contains(cached(), "password=token-first")
	}, 10*time.Second, 20*time.Millisecond)
	// The second publisher read the pidfile before the first wrote it.
	require.NoError(t, os.Remove(pidfile))
	second := start("token-second", 2)
	require.Eventually(t, func() bool { return owner() == strconv.Itoa(second.Process.Pid) }, 10*time.Second, 20*time.Millisecond)

	exited := make(chan error, 1)
	go func() { exited <- first.Wait() }()
	select {
	case err := <-exited:
		require.NoError(t, err, "the publisher beside the owner exits cleanly")
	case <-time.After(10 * time.Second):
		t.Fatal("the publisher beside the owner kept running")
	}
	require.Eventually(t, func() bool { return strings.Contains(cached(), "password=token-second") }, 5*time.Second, 20*time.Millisecond)
	time.Sleep(500 * time.Millisecond)
	require.Contains(t, cached(), "password=token-second", "the exited publisher never clears or overwrites the owner's credential")
	require.True(t, processAlive(second.Process.Pid))
}

// unseededPublisherRuntime starts a publisher that exits before seeding.
type unseededPublisherRuntime struct {
	workspaceapi.WorkspaceRuntime
	started         bool
	stopsAfterStart int
}

func (r *unseededPublisherRuntime) StartService(ctx context.Context, workspaceID string, spec workspaceapi.ServiceSpec) (workspaceapi.Service, error) {
	r.started = true
	spec.Command.Args = []string{"/bin/sh", "-c", "exit 3"}
	return r.WorkspaceRuntime.StartService(ctx, workspaceID, spec)
}

func (r *unseededPublisherRuntime) StopService(ctx context.Context, workspaceID, name string) error {
	if r.started {
		r.stopsAfterStart++
	}
	return r.WorkspaceRuntime.StopService(ctx, workspaceID, name)
}

// Suspend, stop and delete clear the token the row records now, not the one
// the caller read: a token another replica swapped in is revoked too.
func TestRevokeWorkspaceHeadTokenClearsATokenSwappedInAfterTheRead(t *testing.T) {
	row := sampleDBWorkspace("runtime-head-revoke")
	stale := int64(7)
	row.HeadPushTokenID = pgtype.Int8{Int64: stale, Valid: true}
	var revoked []int64
	mock := &mockWorkspaceQuerier{}
	queries := &runtimeHeadQuerier{runtimeRepositoryQuerier: &runtimeRepositoryQuerier{mockWorkspaceQuerier: mock},
		revoke: func(id int64) { revoked = append(revoked, id) }, headTokenID: 8}
	mock.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) {
		current := row
		current.HeadPushTokenID = pgtype.Int8{Int64: queries.recordedHeadTokenID(), Valid: queries.recordedHeadTokenID() != 0}
		return current, nil
	}
	service := newWorkspaceServiceForTests(queries)

	service.revokeWorkspaceHeadToken(context.Background(), row)

	require.Zero(t, queries.recordedHeadTokenID())
	require.Equal(t, []int64{8}, revoked, "the recorded token is revoked; the stale one was already superseded")
}

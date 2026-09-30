package services

import (
	"context"
	"errors"
	"io"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/require"
)

// A real guest filesystem and real shell/process locks exercise the transfer
// commit and detached bootstrap protocol. VM allocation is outside this test;
// failures are injected only at its existing WriteFile transport boundary.
type artifactGuestClient struct {
	*mockWorkspaceSandboxVMClient
	root, script          string
	writeCount, failWrite int
	cancel                context.CancelFunc
	losePublishResponse   bool
	publishStarted        chan struct{}
	restrictedPath        bool
}

func (c *artifactGuestClient) scriptContent(t *testing.T) string {
	t.Helper()
	content, err := os.ReadFile(c.script)
	require.NoError(t, err)
	return string(content)
}

func (c *artifactGuestClient) local(p string) string {
	return strings.NewReplacer(workspaceArtifactRoot, c.root, workspaceClaudeScriptPath, c.script).Replace(p)
}
func (c *artifactGuestClient) WriteFile(ctx context.Context, _ string, p string, r sandbox.WriteFileRequest) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	c.writeCount++
	if c.writeCount == c.failWrite {
		return errors.New("interrupted guest RPC")
	}
	p = c.local(p)
	if e := os.MkdirAll(filepath.Dir(p), 0700); e != nil {
		return e
	}
	if e := os.WriteFile(p, []byte(r.Content), 0600); e != nil {
		return e
	}
	if c.cancel != nil {
		c.cancel()
		c.cancel = nil
	}
	return nil
}
func (c *artifactGuestClient) Execute(ctx context.Context, _ string, r sandbox.ExecRequest) (sandbox.ExecResult, error) {
	if c.publishStarted != nil && strings.Contains(r.Command, "mv -Tf") {
		close(c.publishStarted)
		c.publishStarted = nil
	}
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", c.local(r.Command))
	if c.restrictedPath {
		cmd.Env = []string{"PATH=/no-such-directory"}
	}
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	e := cmd.Run()
	if e == nil && c.losePublishResponse && strings.Contains(r.Command, "mv -Tf") {
		c.losePublishResponse = false
		return sandbox.ExecResult{}, errors.New("publish response lost")
	}
	code := int32(0)
	if e != nil {
		var status *exec.ExitError
		if !errors.As(e, &status) {
			return sandbox.ExecResult{}, e
		}
		code = int32(status.ExitCode())
	}
	return sandbox.ExecResult{Stdout: stdout.String(), Stderr: stderr.String(), StatusCode: &code}, nil
}
func artifactGuestFixture(t *testing.T) *artifactGuestClient {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("Linux guest tools: run with artifact Linux memory campaign")
	}
	for _, tool := range []string{"flock", "setsid", "ln", "cat", "gzip", "base64"} {
		_, e := exec.LookPath(tool)
		require.NoError(t, e, tool)
	}
	dir := t.TempDir()
	root := filepath.Join(dir, "artifacts")
	script := filepath.Join(dir, "bootstrap.sh")
	source := filepath.Join(dir, "cli.tar")
	file, e := os.Create(source)
	require.NoError(t, e)
	_, e = io.CopyN(file, rand.NewChaCha8([32]byte{1}), 3<<20)
	require.NoError(t, e)
	require.NoError(t, file.Close())
	t.Setenv(workspaceCLIPackageEnv, source)
	t.Setenv(workspaceCodingHostBinaryEnv, filepath.Join(dir, "missing-host"))
	t.Setenv(workspaceJJExportBinaryEnv, filepath.Join(dir, "missing-helper"))
	command := "#!/bin/sh\nprintf x >> " + shellQuote(root+"/started") + "\nwhile test ! -f " + shellQuote(root+"/release") + "; do sleep 0.05; done\n"
	require.NoError(t, os.WriteFile(script, []byte(command), 0700))
	t.Cleanup(func() { _ = os.WriteFile(root+"/release", nil, 0600) })
	return &artifactGuestClient{mockWorkspaceSandboxVMClient: &mockWorkspaceSandboxVMClient{}, root: root, script: script}
}
func TestWorkspaceArtifactInterruptedReplayGuest(t *testing.T) {
	client := artifactGuestFixture(t)
	client.failWrite = 2
	e := finishWorkspaceArtifacts(t.Context(), client, "guest", client.scriptContent(t))
	require.ErrorContains(t, e, "interrupted guest RPC")
	entries, e := os.ReadDir(client.root)
	require.NoError(t, e)
	require.Len(t, entries, 1, "only the stable lock remains after failed transfer")
	require.Equal(t, "bootstrap.lock", entries[0].Name())
	client.failWrite = 0
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", client.scriptContent(t)))
	require.Eventually(t, func() bool { b, e := os.ReadFile(client.root + "/started"); return e == nil && string(b) == "x" }, 3*time.Second, 10*time.Millisecond)
	published, e := os.Readlink(client.root + "/current")
	require.NoError(t, e)
	writes := client.writeCount
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", client.scriptContent(t)))
	time.Sleep(100 * time.Millisecond)
	started, e := os.ReadFile(client.root + "/started")
	require.NoError(t, e)
	require.Equal(t, "x", string(started), "replayed bootstrap cannot run while earlier bootstrap holds flock")
	require.Equal(t, writes, client.writeCount, "replay never replaces a published payload")
	again, e := os.Readlink(client.root + "/current")
	require.NoError(t, e)
	require.Equal(t, published, again)
	require.NoError(t, os.WriteFile(client.root+"/release", nil, 0600))
	require.Eventually(t, func() bool { _, e := os.Stat(client.root + "/current/bootstrap.done"); return e == nil }, 3*time.Second, 10*time.Millisecond)
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", client.scriptContent(t)))
	time.Sleep(100 * time.Millisecond)
	started, e = os.ReadFile(client.root + "/started")
	require.NoError(t, e)
	require.Equal(t, "x", string(started), "completed bootstrap is not relaunched")
}
func TestWorkspaceArtifactCanceledGuestTransferCleansWithoutPublishing(t *testing.T) {
	client := artifactGuestFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	client.cancel = cancel
	require.ErrorIs(t, finishWorkspaceArtifacts(ctx, client, "guest", client.scriptContent(t)), context.Canceled)
	entries, e := os.ReadDir(client.root)
	require.NoError(t, e)
	require.Len(t, entries, 1)
	require.Equal(t, "bootstrap.lock", entries[0].Name())
	require.Equal(t, 1, client.writeCount)
}

func TestWorkspaceArtifactSnapshotReusesMatchingInstalledBundle(t *testing.T) {
	client := artifactGuestFixture(t)
	require.NoError(t, os.MkdirAll(client.root, 0700))
	require.NoError(t, os.WriteFile(client.root+"/release", nil, 0600))
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", client.scriptContent(t)))
	require.NoError(t, waitForWorkspaceArtifactBootstrap(t.Context(), client, "guest"))
	source, err := os.Readlink(client.root + "/current")
	require.NoError(t, err)
	writes := client.writeCount
	require.NoError(t, os.WriteFile(client.root+"/owner", []byte(workspaceArtifactOwner("restored-workspace")), 0600))
	userData := filepath.Join(filepath.Dir(client.root), "persisted-user-file")
	require.NoError(t, os.WriteFile(userData, []byte("keep"), 0600))
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", client.scriptContent(t)))
	require.NoError(t, waitForWorkspaceArtifactBootstrap(t.Context(), client, "guest"))
	published, err := os.Readlink(client.root + "/current")
	require.NoError(t, err)
	require.Equal(t, source, published, "identical installed bytes remain reusable after fork")
	require.Equal(t, writes, client.writeCount, "fork must not transfer the full archive again")
	started, err := os.ReadFile(client.root + "/started")
	require.NoError(t, err)
	require.Equal(t, "x", string(started), "matching bootstrap is not re-run")
	b, err := os.ReadFile(userData)
	require.NoError(t, err)
	require.Equal(t, "keep", string(b))
}

func TestWorkspaceArtifactConcurrentSameKeyPublishesOnce(t *testing.T) {
	first := artifactGuestFixture(t)
	second := &artifactGuestClient{mockWorkspaceSandboxVMClient: &mockWorkspaceSandboxVMClient{}, root: first.root, script: first.script}
	require.NoError(t, os.MkdirAll(first.root, 0700))
	require.NoError(t, os.WriteFile(first.root+"/release", nil, 0600))
	script := first.scriptContent(t)
	finished := make(chan error, 2)
	go func() { finished <- finishWorkspaceArtifacts(t.Context(), first, "guest", script) }()
	go func() { finished <- finishWorkspaceArtifacts(t.Context(), second, "guest", script) }()
	require.NoError(t, <-finished)
	require.NoError(t, <-finished)
	require.NoError(t, waitForWorkspaceArtifactBootstrap(t.Context(), first, "guest"))
	started, err := os.ReadFile(first.root + "/started")
	require.NoError(t, err)
	require.Equal(t, "x", string(started), "identical concurrent attempts install once")
	current, err := os.Readlink(first.root + "/current")
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		entries, e := os.ReadDir(filepath.Dir(current))
		return e == nil && len(entries) == 1
	}, 3*time.Second, 10*time.Millisecond, "losing staged attempt must be cleaned")
}

func TestWorkspaceArtifactLostPublishResponsePreservesCommittedBundle(t *testing.T) {
	client := artifactGuestFixture(t)
	client.losePublishResponse = true
	require.ErrorContains(t, finishWorkspaceArtifacts(t.Context(), client, "guest", client.scriptContent(t)), "publish response lost")
	published, err := os.Readlink(client.root + "/current")
	require.NoError(t, err)
	_, err = os.Stat(published)
	require.NoError(t, err, "ambiguous successful publication must survive cleanup")
	writes := client.writeCount
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", client.scriptContent(t)))
	require.Equal(t, writes, client.writeCount)
	require.Eventually(t, func() bool { b, e := os.ReadFile(client.root + "/started"); return e == nil && string(b) == "x" }, 3*time.Second, 10*time.Millisecond)
}

func TestWorkspaceArtifactPublicationWaitsForEarlierBootstrap(t *testing.T) {
	client := artifactGuestFixture(t)
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", client.scriptContent(t)))
	require.Eventually(t, func() bool { b, e := os.ReadFile(client.root + "/started"); return e == nil && string(b) == "x" }, 3*time.Second, 10*time.Millisecond)
	old, err := os.Readlink(client.root + "/current")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(client.root+"/owner", []byte(workspaceArtifactOwner("child")), 0600))
	require.NoError(t, os.WriteFile(os.Getenv(workspaceCLIPackageEnv), []byte("new deployment package"), 0600))
	started := make(chan struct{})
	client.publishStarted = started
	done := make(chan error, 1)
	script := client.scriptContent(t)
	go func() { done <- finishWorkspaceArtifacts(t.Context(), client, "guest", script) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("replacement publication never started")
	}
	select {
	case e := <-done:
		t.Fatalf("publication bypassed active bootstrap lock: %v", e)
	case <-time.After(100 * time.Millisecond):
	}
	current, err := os.Readlink(client.root + "/current")
	require.NoError(t, err)
	require.Equal(t, old, current, "running bootstrap keeps its immutable bundle")
	require.NoError(t, os.WriteFile(client.root+"/release", nil, 0600))
	select {
	case e := <-done:
		require.NoError(t, e)
	case <-time.After(3 * time.Second):
		t.Fatal("publication did not resume after bootstrap completion")
	}
	current, err = os.Readlink(client.root + "/current")
	require.NoError(t, err)
	require.NotEqual(t, old, current)
	_, err = os.Stat(old)
	require.True(t, os.IsNotExist(err), "superseded bundle must be removed after publish")
	require.Eventually(t, func() bool { b, e := os.ReadFile(client.root + "/started"); return e == nil && string(b) == "xx" }, 3*time.Second, 10*time.Millisecond)
}

func TestWorkspaceArtifactFailedBootstrapIsVisibleAndRetryable(t *testing.T) {
	client := artifactGuestFixture(t)
	first := client.root + "/failed-once"
	script := "#!/bin/sh\nif ! test -f " + shellQuote(first) + "; then touch " + shellQuote(first) + "; exit 9; fi\nprintf x >> " + shellQuote(client.root+"/started") + "\n"
	require.NoError(t, os.WriteFile(client.script, []byte(script), 0700))
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", client.scriptContent(t)))
	require.ErrorContains(t, waitForWorkspaceArtifactBootstrap(t.Context(), client, "guest"), "bootstrap failed")
	status, err := os.ReadFile(client.root + "/current/bootstrap.failed")
	require.NoError(t, err)
	require.True(t, strings.HasSuffix(string(status), ":9\n"), "failure marker records the launch identity and exit code")
	writes := client.writeCount
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", client.scriptContent(t)))
	require.NoError(t, waitForWorkspaceArtifactBootstrap(t.Context(), client, "guest"))
	require.Equal(t, writes, client.writeCount, "retry must reuse the complete bundle")
	_, err = os.Stat(client.root + "/current/bootstrap.failed")
	require.True(t, os.IsNotExist(err))
	started, err := os.ReadFile(client.root + "/started")
	require.NoError(t, err)
	require.Equal(t, "x", string(started))
}

func TestWorkspaceArtifactQueuedRetryIgnoresEarlierFailure(t *testing.T) {
	client := artifactGuestFixture(t)
	first := client.root + "/first-attempt"
	script := "#!/bin/sh\nif ! test -f " + shellQuote(first) + "; then touch " + shellQuote(first) + "; while test ! -f " + shellQuote(client.root+"/release") + "; do sleep 0.05; done; exit 9; fi\nprintf x >> " + shellQuote(client.root+"/started") + "\n"
	require.NoError(t, os.WriteFile(client.script, []byte(script), 0700))
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", script))
	require.Eventually(t, func() bool { _, err := os.Stat(first); return err == nil }, 3*time.Second, 10*time.Millisecond)
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", script))
	require.NoError(t, os.WriteFile(client.root+"/release", nil, 0600))
	require.NoError(t, waitForWorkspaceArtifactBootstrap(t.Context(), client, "guest"))
	started, err := os.ReadFile(client.root + "/started")
	require.NoError(t, err)
	require.Equal(t, "x", string(started), "queued retry should finish after the first attempt fails")
}

func TestWorkspaceArtifactRefreshesScriptOnReusedDisk(t *testing.T) {
	client := artifactGuestFixture(t)
	require.NoError(t, os.MkdirAll(client.root, 0700))
	require.NoError(t, os.WriteFile(client.root+"/release", nil, 0600))
	first, err := os.ReadFile(client.script)
	require.NoError(t, err)
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", string(first)))
	require.NoError(t, waitForWorkspaceArtifactBootstrap(t.Context(), client, "guest"))
	old, err := os.Readlink(client.root + "/current")
	require.NoError(t, err)
	second := "#!/bin/sh\nprintf y >> " + shellQuote(client.root+"/started") + "\n"
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", second))
	require.NoError(t, waitForWorkspaceArtifactBootstrap(t.Context(), client, "guest"))
	started, err := os.ReadFile(client.root + "/started")
	require.NoError(t, err)
	require.Equal(t, "xy", string(started), "new script must run after a deployment recipe change")
	_, err = os.Stat(old)
	require.True(t, os.IsNotExist(err), "old recipe bundle must be collected")
	writes := client.writeCount
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", second))
	require.NoError(t, waitForWorkspaceArtifactBootstrap(t.Context(), client, "guest"))
	require.Equal(t, writes, client.writeCount, "same recipe reuses the immutable bundle")
}

func TestWorkspaceArtifactGuestCommandsRestoreNixPath(t *testing.T) {
	client := artifactGuestFixture(t)
	client.restrictedPath = true
	require.NoError(t, os.MkdirAll(client.root, 0700))
	require.NoError(t, os.WriteFile(client.root+"/release", nil, 0600))
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", client.scriptContent(t)))
	require.NoError(t, waitForWorkspaceArtifactBootstrap(t.Context(), client, "guest"))
	_, err := os.Stat(client.root + "/current/bootstrap.done")
	require.NoError(t, err)
}

func TestWorkspaceCreateWaitsForBootstrapBeforeEnvironmentSetup(t *testing.T) {
	client := artifactGuestFixture(t)
	client.createVMFn = func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
		return sandbox.CreateResult{ID: "guest"}, nil
	}
	script, err := os.ReadFile(client.script)
	require.NoError(t, err)
	req := sandbox.CreateRequest{Files: map[string]sandbox.SandboxFile{workspaceClaudeScriptPath: {Content: string(script)}}}
	created := make(chan error, 1)
	go func() { _, err := createWorkspaceSandbox(t.Context(), client, req); created <- err }()
	require.Eventually(t, func() bool { b, err := os.ReadFile(client.root + "/started"); return err == nil && string(b) == "x" }, 3*time.Second, 10*time.Millisecond)
	select {
	case err := <-created:
		t.Fatalf("create returned before toolchain bootstrap finished: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	require.NoError(t, os.WriteFile(client.root+"/release", nil, 0600))
	select {
	case err := <-created:
		require.NoError(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("create did not finish after bootstrap completed")
	}
}

// holdArtifactLock holds the guest bootstrap lock from another process, as a
// long toolchain install does, until the returned release is called.
func holdArtifactLock(t *testing.T, root string) func() {
	t.Helper()
	require.NoError(t, os.MkdirAll(root, 0700))
	// One process owns the lock descriptor, so killing it releases the lock.
	holder := exec.Command("/bin/sh", "-c", "exec 9>"+shellQuote(root+"/bootstrap.lock")+"; flock 9; exec sleep 60")
	require.NoError(t, holder.Start())
	require.Eventually(t, func() bool {
		return exec.Command("flock", "-n", root+"/bootstrap.lock", "true").Run() != nil
	}, 3*time.Second, 10*time.Millisecond)
	released := false
	release := func() {
		if released {
			return
		}
		released = true
		_ = holder.Process.Kill()
		_ = holder.Wait()
	}
	t.Cleanup(release)
	return release
}

func TestWorkspaceArtifactOrphanSurvivesLongLockAndIsSweptLater(t *testing.T) {
	client := artifactGuestFixture(t)
	require.NoError(t, os.MkdirAll(client.root, 0700))
	require.NoError(t, os.WriteFile(client.root+"/release", nil, 0600))
	client.failWrite = 2
	release := holdArtifactLock(t, client.root)
	require.ErrorContains(t, finishWorkspaceArtifacts(t.Context(), client, "guest", client.scriptContent(t)), "interrupted guest RPC")
	staged, err := filepath.Glob(client.root + "/*/*")
	require.NoError(t, err)
	require.Len(t, staged, 1, "the bounded cleanup cannot take a lock a long install holds")
	release()

	// Age the orphan past the sweep bound; a fresh concurrent attempt stays.
	old := time.Now().Add(-2 * workspaceArtifactOrphanAge)
	require.NoError(t, os.Chtimes(staged[0], old, old))
	active := filepath.Join(filepath.Dir(staged[0]), "active-attempt")
	require.NoError(t, os.MkdirAll(active, 0700))

	client.failWrite = 0
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", client.scriptContent(t)))
	require.NoError(t, waitForWorkspaceArtifactBootstrap(t.Context(), client, "guest"))
	_, err = os.Stat(staged[0])
	require.True(t, os.IsNotExist(err), "the next bootstrap sweeps the stale attempt")
	_, err = os.Stat(active)
	require.NoError(t, err, "an attempt still being transferred is kept")
	current, err := os.Readlink(client.root + "/current")
	require.NoError(t, err)
	_, err = os.Stat(current + "/bootstrap.done")
	require.NoError(t, err, "the published winner is kept")
}

func TestWorkspaceArtifactPublicationOutwaitsBusyLockWithinDeadline(t *testing.T) {
	client := artifactGuestFixture(t)
	require.NoError(t, os.MkdirAll(client.root, 0700))
	require.NoError(t, os.WriteFile(client.root+"/release", nil, 0600))
	previous := workspaceArtifactPublishLockWait
	workspaceArtifactPublishLockWait = time.Second
	t.Cleanup(func() { workspaceArtifactPublishLockWait = previous })
	release := holdArtifactLock(t, client.root)
	go func() { time.Sleep(2500 * time.Millisecond); release() }()
	start := time.Now()
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", client.scriptContent(t)))
	require.GreaterOrEqual(t, time.Since(start), 2*time.Second, "publication waited past one bounded lock wait")
	require.NoError(t, waitForWorkspaceArtifactBootstrap(t.Context(), client, "guest"))

	// A deadline still ends the wait.
	release = holdArtifactLock(t, client.root)
	defer release()
	require.NoError(t, os.WriteFile(os.Getenv(workspaceCLIPackageEnv), []byte("next deployment"), 0600))
	ctx, cancel := context.WithTimeout(t.Context(), 1500*time.Millisecond)
	defer cancel()
	require.Error(t, finishWorkspaceArtifacts(ctx, client, "guest", client.scriptContent(t)))
}

func TestWorkspaceArtifactFailedGuestScriptReportsRedactedLog(t *testing.T) {
	client := artifactGuestFixture(t)
	script := "#!/bin/sh\necho 'resolving toolchain'\necho 'NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz0123456789'\necho 'error: attribute nodejs missing' >&2\nexit 3\n"
	require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "guest", script))
	err := waitForWorkspaceArtifactBootstrap(t.Context(), client, "guest")
	require.ErrorContains(t, err, "workspace bootstrap failed (exit 3): resolving toolchain | NPM_TOKEN=[redacted] | error: attribute nodejs missing")
	require.NotContains(t, err.Error(), "npm_abcdefghijklmnopqrstuvwxyz0123456789")
}

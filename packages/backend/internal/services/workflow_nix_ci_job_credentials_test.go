package services

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestNixCITaskCommand_RestoresBeforeStepsAndSavesAfterThem(t *testing.T) {
	t.Parallel()
	script, err := nixCITaskCommand(nixCITask{Job: "build", Steps: []StepConfig{{Run: "make build"}}, Cache: []WorkflowCacheDescriptor{
		{Action: "restore", Key: "deps", HashFiles: []string{"lock.txt"}},
		{Action: "save", Key: "deps", Paths: []string{"deps"}},
	}})
	require.NoError(t, err)
	source := strings.Index(script, ". '"+nixCIJobEnvPath+"'")
	cd := strings.Index(script, "cd '"+nixCITaskWorkdir+"'")
	restore := strings.Index(script, "smithers-ci cache restore")
	step := strings.Index(script, "make build")
	save := strings.Index(script, "smithers-ci cache save")
	require.True(t, source >= 0 && cd > source && restore > cd && step > restore && save > step, script)
	assert.Contains(t, script, "export PATH='"+nixCIToolBinDir+"'")

	plain, err := nixCITaskCommand(nixCITask{Job: "build", Steps: []StepConfig{{Run: "make build"}}})
	require.NoError(t, err)
	assert.NotContains(t, plain, "smithers-ci cache")

	start := nixCIStartCommand(nixCITask{Cache: []WorkflowCacheDescriptor{{Action: "save", Key: "k'ey", Paths: []string{"a"}}}}, script, nil)
	assert.Contains(t, start, "printf '%s' '' > '"+nixCIJobEnvPath+"'", "an empty job environment is still written, so sourcing it succeeds")
	assert.Contains(t, start, "cat > '"+nixCIToolHelperPath+"' <<'SMITHERS_CI_HELPER_EOF'")
	assert.Contains(t, start, `[{"action":"save","key":"k'ey","paths":["a"]}]`)
	assert.NotContains(t, nixCIGuestHelper, "\nSMITHERS_CI_HELPER_EOF\n", "the helper cannot end its own heredoc")
}

type fakeCIJobCredentials struct {
	mu       sync.Mutex
	issued   []db.IssueWorkflowTaskGuestTokenParams
	revoked  []int64
	issueErr error
	issued0  bool
	onIssue  func()
	onRevoke func(taskID int64)
}

func (f *fakeCIJobCredentials) IssueWorkflowTaskGuestToken(_ context.Context, arg db.IssueWorkflowTaskGuestTokenParams) (int64, error) {
	if f.onIssue != nil {
		f.onIssue()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.issueErr != nil {
		return 0, f.issueErr
	}
	f.issued = append(f.issued, arg)
	if f.issued0 {
		return 0, nil
	}
	return 1, nil
}

func (f *fakeCIJobCredentials) RevokeWorkflowTaskGuestToken(_ context.Context, taskID int64) error {
	if f.onRevoke != nil {
		f.onRevoke(taskID)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revoked = append(f.revoked, taskID)
	return nil
}

// jobTokenGuest is a one-job guest whose egress proxy received the job token.
// It echoes the real value into its log, as a job could by reflecting a
// substituted response, so the test also proves redaction.
func jobTokenGuest(client *mockWorkflowSandboxVMClient) *string {
	var token string
	var mu sync.Mutex
	polls := 0
	client.createVMFn = func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
		mu.Lock()
		defer mu.Unlock()
		if req.EgressProxy != nil {
			for _, secret := range req.EgressProxy.Secrets {
				if secret.Name == "SMITHERS_CI_JOB_TOKEN" {
					token = secret.Value
				}
			}
		}
		return sandbox.CreateResult{ID: "vm-1"}, nil
	}
	client.execAwaitFn = func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		mu.Lock()
		defer mu.Unlock()
		ok := int32(0)
		if strings.Contains(req.Command, "SMITHERS_CI_EOF") {
			return sandbox.ExecResult{StatusCode: &ok}, nil
		}
		polls++
		if polls == 1 {
			return sandbox.ExecResult{Stdout: "leak " + token + "\n", StatusCode: &ok}, nil
		}
		return sandbox.ExecResult{Stderr: nixCITaskExitMarker + "0", StatusCode: &ok}, nil
	}
	return &token
}

func cachedNixCITaskRow() db.WorkflowTask {
	payload, _ := json.Marshal(map[string]any{
		"job":   "build",
		"steps": []StepConfig{{Name: "build", Run: "make build"}},
		"cache": []WorkflowCacheDescriptor{{Action: "restore", Key: "deps"}},
	})
	return db.WorkflowTask{ID: 1, WorkflowRunID: 42, WorkflowStepID: 11, RepositoryID: 100, Status: "pending", Payload: payload}
}

func TestNixCIRun_JobTokenReachesOnlyItsGuestAndDiesWithTheJob(t *testing.T) {
	queries := nixCIQuerier([]db.WorkflowTask{cachedNixCITaskRow()})
	guests := &fakeNixCIGuests{polls: map[string]int{}}
	client := guests.client(t)
	token := jobTokenGuest(client)
	creds := &fakeCIJobCredentials{}
	creds.onIssue = func() {
		client.mu.Lock()
		assert.Empty(t, client.createCalls, "the token is minted before the guest boots")
		client.mu.Unlock()
	}
	creds.onRevoke = func(int64) {
		assert.Equal(t, "done", nixCITaskStatuses(queries)[1], "the task is terminal before its token is revoked")
		client.mu.Lock()
		assert.Empty(t, client.deleteCalls, "the token is revoked before the guest is destroyed")
		client.mu.Unlock()
	}
	worker := NewWorkflowSandboxSchedulerWorker(queries, client,
		WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"),
		WithWorkflowSandboxSchedulerCIGuests(guests),
		WithWorkflowSandboxSchedulerCIPollInterval(time.Millisecond),
		WithWorkflowSandboxSchedulerCIJobCredentials(creds, "https://api.example.test/internal/"),
	)

	require.NoError(t, worker.PollOnce(context.Background()))

	require.Len(t, creds.issued, 1)
	issued := creds.issued[0]
	assert.Equal(t, int64(1), issued.WorkflowTaskID)
	assert.Equal(t, int64(42), issued.WorkflowRunID)
	assert.Equal(t, int64(100), issued.RepositoryID)
	assert.True(t, issued.ExpiresAt.After(time.Now()))
	require.True(t, middleware.IsCIJobTokenSyntax(*token), *token)
	assert.Equal(t, middleware.HashCIJobToken(*token), issued.TokenHash, "only the hash is stored")
	assert.Equal(t, []int64{1}, creds.revoked)

	require.Len(t, client.createCalls, 1)
	created := client.createCalls[0]
	require.NotNil(t, created.EgressProxy)
	require.True(t, created.EgressProxy.Enabled)
	assert.Equal(t, []sandbox.EgressProxySecret{{
		Name: "SMITHERS_CI_JOB_TOKEN", Value: *token, Hosts: []string{"api.example.test"}, MatchHeaders: []string{"authorization"},
	}}, created.EgressProxy.Secrets, "the token travels only as the guest's egress binding")
	created.EgressProxy = nil
	raw, _ := json.Marshal(created)
	assert.NotContains(t, string(raw), *token, "no other part of the create request carries the token")
	start := nixCIStartExec(t, client)
	for _, req := range client.execCalls {
		assert.Empty(t, req.Secrets, "no exec carries a secret")
		assert.NotContains(t, req.Command, *token, "the token never appears in a command")
	}
	assert.Contains(t, start.Command, `export SMITHERS_CI_JOB_TOKEN='\''SMITHERS_CI_JOB_TOKEN'\''`, "the guest holds only the placeholder")
	assert.Contains(t, start.Command, `export SMITHERS_CI_API_URL='\''https://api.example.test/internal'\''`)
	assert.Contains(t, start.Command, `export SMITHERS_WORKFLOW_RUN_ID='\''42'\''`)
	assert.Equal(t, []string{"leak ********"}, nixCILogEntriesForStep(queries, 11), "the token is redacted from the log")
	assert.Equal(t, []int64{42}, queries.markSuccessIDs)
}

func TestNixCIRun_JobTokenFailureStillRunsTheJob(t *testing.T) {
	queries := nixCIQuerier([]db.WorkflowTask{cachedNixCITaskRow()})
	guests := &fakeNixCIGuests{polls: map[string]int{}}
	client := guests.client(t)
	token := jobTokenGuest(client)
	creds := &fakeCIJobCredentials{issueErr: errors.New("db down")}
	worker := NewWorkflowSandboxSchedulerWorker(queries, client,
		WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"),
		WithWorkflowSandboxSchedulerCIGuests(guests),
		WithWorkflowSandboxSchedulerCIPollInterval(time.Millisecond),
		WithWorkflowSandboxSchedulerCIJobCredentials(creds, "https://api.example.test/internal"),
	)
	require.NoError(t, worker.PollOnce(context.Background()))
	assert.Empty(t, *token)
	assert.Equal(t, []int64{42}, queries.markSuccessIDs, "cache is best-effort; the job's own result decides the run")
	queries.mu.Lock()
	defer queries.mu.Unlock()
	var system []string
	for _, insert := range queries.logInserts {
		if insert.Stream == "system" {
			system = append(system, insert.Entry)
		}
	}
	assert.Contains(t, system, "[cache] unavailable")
}

// plue#621: the hosted provider refuses the exec-environment secret channel
// (the mock does exactly what the Microsandbox worker does), so a plain job
// with a job token and a per-run API token must reach its first command and
// succeed with every credential on the egress proxy.
func TestNixCIRun_HostedCredentialChannelStartsPlainJob(t *testing.T) {
	queries := newSandboxSchedulerRunQuerier(77, 31)
	guests := sandboxSchedulerGuests("0", "ok\n")
	client := guests.client(t)
	creds := &fakeCIJobCredentials{}
	worker := newSandboxSchedulerNixCIWorker(queries, client,
		WithWorkflowSandboxSchedulerCIGuests(guests),
		WithWorkflowSandboxSchedulerAPIBaseURL("https://api.smithers.test/api"),
		WithWorkflowSandboxSchedulerCIJobCredentials(creds, "https://api.smithers.test/internal"),
	)

	require.NoError(t, worker.PollOnce(context.Background()))

	assert.Equal(t, map[int64]string{1: "done"}, nixCITaskStatuses(queries))
	assert.Equal(t, []int64{77}, queries.markSuccessIDs)
	require.Len(t, client.createCalls, 1)
	assert.Equal(t, []string{"SMITHERS_CI_JOB_TOKEN", "SMITHERS_JJHUB_TOKEN"}, client.createCalls[0].EgressProxy.SecretNames())
	for _, req := range client.execCalls {
		assert.Empty(t, req.Secrets)
	}
	assert.Equal(t, []int64{1}, creds.revoked, "the job token dies with the job")
	assert.Equal(t, []string{"vm-1"}, client.deleteCalls)
}

// A control plane URL the proxy cannot bind (a dotless development host)
// gets no job token: the refusal is typed and logged, nothing is minted, and
// the job still runs without its cache.
func TestNixCIRun_UnbindableInternalHostWithholdsTheJobToken(t *testing.T) {
	queries := nixCIQuerier([]db.WorkflowTask{cachedNixCITaskRow()})
	guests := &fakeNixCIGuests{polls: map[string]int{}}
	client := guests.client(t)
	token := jobTokenGuest(client)
	creds := &fakeCIJobCredentials{}
	worker := NewWorkflowSandboxSchedulerWorker(queries, client,
		WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"),
		WithWorkflowSandboxSchedulerCIGuests(guests),
		WithWorkflowSandboxSchedulerCIPollInterval(time.Millisecond),
		WithWorkflowSandboxSchedulerCIJobCredentials(creds, "http://localhost:4000/internal"),
	)
	require.NoError(t, worker.PollOnce(context.Background()))

	assert.Empty(t, creds.issued, "no token is minted that could not be delivered")
	assert.Empty(t, *token)
	assert.Equal(t, []int64{42}, queries.markSuccessIDs)
	assert.Equal(t, []string{
		`SMITHERS_CI_JOB_TOKEN cannot reach the NixOS CI guest: host "localhost" cannot be bound to the egress proxy`,
		"[cache] unavailable",
	}, nixCISystemLogs(queries))

	_, _, err := worker.issueNixCIJobToken(context.Background(), nixCITask{ID: 1}, 100)
	assert.ErrorIs(t, err, ErrCISecretChannelUnavailable)
}

// A guest request without an egress proxy has no channel for a bound
// credential: the job fails before any guest boots, and its token is revoked.
func TestNixCIRun_GuestWithoutEgressProxyRefusesBoundCredentials(t *testing.T) {
	queries := nixCIQuerier([]db.WorkflowTask{cachedNixCITaskRow()})
	client := &mockWorkflowSandboxVMClient{}
	creds := &fakeCIJobCredentials{}
	worker := NewWorkflowSandboxSchedulerWorker(queries, client,
		WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"),
		WithWorkflowSandboxSchedulerCIGuests(artifactCIGuests{req: sandbox.CreateRequest{Kind: "vm"}}),
		WithWorkflowSandboxSchedulerCIPollInterval(time.Millisecond),
		WithWorkflowSandboxSchedulerCIJobCredentials(creds, "https://api.example.test/internal"),
	)
	require.NoError(t, worker.PollOnce(context.Background()))

	assert.Empty(t, client.createCalls)
	assert.Equal(t, map[int64]string{1: "failed"}, nixCITaskStatuses(queries))
	assert.Equal(t, []int64{42}, queries.markFailureIDs)
	assert.Equal(t, []int64{1}, creds.revoked)
	assert.Equal(t, []string{"SMITHERS_CI_JOB_TOKEN cannot reach the NixOS CI guest: the guest has no egress proxy"}, nixCISystemLogs(queries))
}

// A task that stopped being runnable before its guest booted gets no token
// and boots no guest with one.
func TestNixCIRun_TokenForAnUnrunnableTaskIsNotBound(t *testing.T) {
	queries := nixCIQuerier([]db.WorkflowTask{cachedNixCITaskRow()})
	guests := &fakeNixCIGuests{polls: map[string]int{}}
	client := guests.client(t)
	token := jobTokenGuest(client)
	creds := &fakeCIJobCredentials{issued0: true}
	worker := NewWorkflowSandboxSchedulerWorker(queries, client,
		WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"),
		WithWorkflowSandboxSchedulerCIGuests(guests),
		WithWorkflowSandboxSchedulerCIPollInterval(time.Millisecond),
		WithWorkflowSandboxSchedulerCIJobCredentials(creds, "https://api.example.test/internal"),
	)
	require.NoError(t, worker.PollOnce(context.Background()))
	assert.Empty(t, *token)
	assert.Empty(t, client.createCalls[0].EgressProxy.Secrets)
	assert.Equal(t, []string{"[cache] unavailable"}, nixCISystemLogs(queries))
}

// Secrets the repository bound to hosts for its workspaces are on the CI
// guest's egress proxy too; the job environment exports their placeholders.
func TestNixCIRun_ExportsPlaceholdersForRepositoryBoundSecrets(t *testing.T) {
	queries := nixCIQuerier([]db.WorkflowTask{cachedNixCITaskRow()})
	client := &mockWorkflowSandboxVMClient{}
	guests := artifactCIGuests{req: sandbox.CreateRequest{Kind: "vm", EgressProxy: &sandbox.EgressProxyPolicy{Enabled: true, Secrets: []sandbox.EgressProxySecret{
		{Name: "NPM_TOKEN", Value: "npm-real-value", Hosts: []string{"registry.npmjs.org"}, MatchHeaders: []string{"authorization"}},
	}}}}
	client.execAwaitFn = func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		ok := int32(0)
		return sandbox.ExecResult{Stderr: nixCITaskExitMarker + "0", StatusCode: &ok}, nil
	}
	worker := NewWorkflowSandboxSchedulerWorker(queries, client,
		WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"),
		WithWorkflowSandboxSchedulerCIGuests(guests),
		WithWorkflowSandboxSchedulerCIPollInterval(time.Millisecond),
		WithWorkflowSandboxSchedulerCIJobCredentials(&fakeCIJobCredentials{}, "https://api.example.test/internal"),
	)
	require.NoError(t, worker.PollOnce(context.Background()))
	assert.Equal(t, []int64{42}, queries.markSuccessIDs)
	require.Len(t, client.createCalls, 1)
	assert.Equal(t, []string{"NPM_TOKEN", "SMITHERS_CI_JOB_TOKEN"}, client.createCalls[0].EgressProxy.SecretNames())
	start := nixCIStartExec(t, client)
	assert.Contains(t, start.Command, `export NPM_TOKEN='\''NPM_TOKEN'\''`)
	assert.NotContains(t, start.Command, "npm-real-value")
}

// The job environment file must hand every value to the job verbatim, however
// it is quoted, and no value can end its assignment early.
func TestNixCIJobEnvFile_RoundTripsThroughBash(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash unavailable")
	}
	env := map[string]string{
		"PLAIN":  "value",
		"QUOTED": "it's \"quoted\" $HOME `id` \\",
		"MULTI":  "line one\nexport PLAIN=hijacked\n'",
		"EMPTY":  "",
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "job.env")
	start := "set -euo pipefail\nprintf '%s' " + shellQuote(nixCIJobEnvFile(env)) + " > " + shellQuote(path)
	out, err := exec.Command(bash, "-c", start).CombinedOutput()
	require.NoError(t, err, string(out))
	for name, want := range env {
		got, err := exec.Command(bash, "-c", "set -euo pipefail; . "+shellQuote(path)+"; printf '%s' \"$"+name+"\"").Output()
		require.NoError(t, err, name)
		assert.Equal(t, want, string(got), name)
	}
	assert.Equal(t, "", nixCIJobEnvFile(nil))
}

func nixCISystemLogs(queries *mockWorkflowSandboxSchedulerQuerier) []string {
	queries.mu.Lock()
	defer queries.mu.Unlock()
	var system []string
	for _, insert := range queries.logInserts {
		if insert.Stream == "system" {
			system = append(system, insert.Entry)
		}
	}
	return system
}

// The guest helper's restore must stay inside the checkout, whatever the
// archive says.
func TestNixCIGuestHelper_ArchiveSafety(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	dir := t.TempDir()
	helper := filepath.Join(dir, "smithers_ci.py")
	require.NoError(t, os.WriteFile(helper, []byte(nixCIGuestHelper), 0o755))
	script := `
import io, os, sys, tarfile, gzip, importlib.util
spec = importlib.util.spec_from_file_location("ci", sys.argv[1])
ci = importlib.util.module_from_spec(spec); spec.loader.exec_module(ci)
work = sys.argv[2]

def archive(entries):
    raw = io.BytesIO()
    with gzip.GzipFile(fileobj=raw, mode="wb") as z, tarfile.open(fileobj=z, mode="w|") as t:
        for name, kind, data in entries:
            info = tarfile.TarInfo(name)
            if kind == "sym":
                info.type = tarfile.SYMTYPE; info.linkname = data; t.addfile(info)
            else:
                info.size = len(data); t.addfile(info, io.BytesIO(data))
    raw.seek(0)
    return raw

def refused(root, entries):
    try:
        ci.extract_archive(root, archive(entries))
    except ci.CIError:
        return True
    return False

# Round trip: save then restore reproduces files and modes, skipping symlinks.
src = os.path.join(work, "src"); os.makedirs(os.path.join(src, "deps/sub"))
open(os.path.join(src, "deps/sub/a.txt"), "w").write("A")
open(os.path.join(src, "deps/run.sh"), "w").write("#!/bin/sh"); os.chmod(os.path.join(src, "deps/run.sh"), 0o755)
os.symlink("/etc/passwd", os.path.join(src, "deps/link"))
tgz = os.path.join(work, "c.tgz")
assert ci.create_archive(src, ["deps", "missing/**"], tgz) > 0
dst = os.path.join(work, "dst"); os.makedirs(dst)
with open(tgz, "rb") as f:
    ci.extract_archive(dst, f)
assert open(os.path.join(dst, "deps/sub/a.txt")).read() == "A"
assert os.stat(os.path.join(dst, "deps/run.sh")).st_mode & 0o111
assert not os.path.lexists(os.path.join(dst, "deps/link"))
assert ci.create_archive(src, ["nothing-here"], os.path.join(work, "e.tgz")) == 0
for bad in ["../x", "/abs"]:
    try:
        ci.create_archive(src, [bad], os.path.join(work, "bad.tgz"))
        raise SystemExit("create accepted " + bad)
    except ci.CIError:
        pass

# Escapes are refused.
root = os.path.join(work, "root"); os.makedirs(root)
assert refused(root, [("../escape.txt", "file", b"x")])
assert refused(root, [("/etc/escape.txt", "file", b"x")])
assert not os.path.exists(os.path.join(work, "escape.txt"))
# A symlinked directory in the checkout is never followed.
outside = os.path.join(work, "outside"); os.makedirs(outside)
os.symlink(outside, os.path.join(root, "linked"))
assert refused(root, [("linked/pwn.txt", "file", b"x")])
assert os.listdir(outside) == []
# A symlink entry is not materialized, and a file never writes through one.
ci.extract_archive(root, archive([("evil", "sym", "/etc/passwd")]))
assert not os.path.lexists(os.path.join(root, "evil"))
os.symlink(os.path.join(outside, "target"), os.path.join(root, "trap"))
assert refused(root, [("trap", "file", b"x")])
assert not os.path.exists(os.path.join(outside, "target"))
# Entry-count and byte limits bound a restore.
ci.RESTORE_MAX_ENTRIES = 2
assert refused(root, [("a", "file", b"1"), ("b", "file", b"2"), ("c", "file", b"3")])
ci.RESTORE_MAX_ENTRIES = 100000
ci.RESTORE_MAX_BYTES = 4096
assert refused(root, [("big", "file", b"x" * 20000)])
# Cache versions hash matched files; no match is "static".
assert ci.hash_files_version(src, ["deps/**/*.txt"]) != "static"
assert ci.hash_files_version(src, ["none/*.lock"]) == "static"
print("ok")
`
	out, err := exec.Command(python, "-c", script, helper, dir).CombinedOutput()
	require.NoError(t, err, string(out))
	assert.Equal(t, "ok\n", string(out))
}

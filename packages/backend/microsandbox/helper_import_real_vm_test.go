package microsandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/cgi"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/installbundle"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func hostGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_AUTHOR_NAME=Source", "GIT_AUTHOR_EMAIL=source@example.invalid", "GIT_COMMITTER_NAME=Source", "GIT_COMMITTER_EMAIL=source@example.invalid")
	output, err := command.CombinedOutput()
	require.NoError(t, err, "git %v: %s", args, output)
	return strings.TrimSpace(string(output))
}

// In a real microVM booted by an assembled bundle's own msb, the bundle's
// Linux helper imports a retained source the way a lane's base import does:
// over the bridge to the backend's port, with the workspace binding and the
// credential in the guest's git credential cache, using the bundle's jj. Its
// stdout is exactly one JSON receipt; Git's own reports never precede it.
func TestRealMicroVMApprovedBundleHelperImportsRetainedSource(t *testing.T) {
	bundle := installedBundleCopy(t)
	workspaceID := uuid.NewString()
	const token = "import-receipt-token"
	root := t.TempDir()
	projects := filepath.Join(root, "projects")
	bare := filepath.Join(projects, "acme", "widgets.git")
	require.NoError(t, os.MkdirAll(filepath.Dir(bare), 0o755))
	hostGit(t, root, "init", "-q", "--bare", bare)
	seed := filepath.Join(root, "seed")
	hostGit(t, root, "init", "-q", "-b", "main", seed)
	require.NoError(t, os.WriteFile(filepath.Join(seed, "code.txt"), []byte("retained\n"), 0o644))
	hostGit(t, seed, "add", "code.txt")
	hostGit(t, seed, "commit", "-q", "-m", "retained source")
	commit := hostGit(t, seed, "rev-parse", "HEAD")
	ref := "refs/smithers/workspaces/" + workspaceID + "/sources/" + commit
	hostGit(t, seed, "push", "-q", bare, "HEAD:"+ref)
	backend := filepath.Join(hostGit(t, root, "--exec-path"), "git-http-backend")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	port := listener.Addr().(*net.TCPAddr).Port
	var mu sync.Mutex
	var served []string
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		mu.Lock()
		served = append(served, r.Method+" "+r.URL.Path)
		mu.Unlock()
		if !ok || password != token {
			w.Header().Set("WWW-Authenticate", `Basic realm="smithers"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		(&cgi.Handler{Path: backend, Env: []string{"GIT_PROJECT_ROOT=" + projects, "GIT_HTTP_EXPORT_ALL=1", "REMOTE_USER=" + user}}).ServeHTTP(w, r)
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })

	installed, err := installbundle.OpenRunning(filepath.Join(bundle, "bin", "smithers-backend"))
	require.NoError(t, err)
	runtime, err := New(context.Background(), Config{Bundle: installed, HostPorts: []uint16{uint16(port)},
		Root: t.TempDir(), CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 1})
	require.NoError(t, err)
	t.Cleanup(func() { sweepOwner(t, runtime) })
	ctx := operation("helper-import")
	_, err = runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: workspaceID})
	require.NoError(t, err)
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	require.NoError(t, runtime.InstallWorkspaceCodingBinding(ctx, workspaceID, workspaceapi.WorkspaceCodingBinding{
		ActorID: 1, RepositoryID: 1, RepositorySlug: "acme/widgets", APIBaseURL: base + "/api", GitURL: base + "/acme/widgets.git"}))
	request, err := json.Marshal(map[string]any{"operation": "import_source", "repositoryPath": guestRoot,
		"requestId": uuid.NewString(), "commits": []map[string]string{{"commitId": commit, "ref": ref}}})
	require.NoError(t, err)
	socket := guestHome + "/.cache/smithers/git-credential/socket"
	// The credential cache lives as long as the command's cgroup, as the head
	// reporter's does for a lane.
	script := strings.Join([]string{
		"cd " + guestRoot, "jj git init --colocate . >/dev/null 2>&1", "echo saved > user.txt", "jj status >/dev/null",
		"mkdir -p " + filepath.Dir(socket), "chmod 0700 " + filepath.Dir(socket),
		fmt.Sprintf("printf 'protocol=http\\nhost=127.0.0.1:%d\\npath=acme/widgets.git\\nusername=x-access-token\\npassword=%s\\n\\n' | git -c credential.helper='cache --socket %s' -c credential.useHttpPath=true credential approve", port, token, socket),
		"printf '%s' " + shellQuote(string(request)) + " | /usr/local/bin/smithers-jj-export --local",
	}, " && ")
	result, err := runtime.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{Args: []string{"/bin/bash", "-c", script}})
	require.NoError(t, err)
	mu.Lock()
	requests := append([]string(nil), served...)
	mu.Unlock()
	t.Logf("import receipt (exit %d; host saw %v):\n%s\n--- stderr\n%s", result.ExitCode, requests, result.Stdout, result.Stderr)
	require.Zero(t, result.ExitCode, result.Stderr)
	var receipt struct {
		Status      string `json:"status"`
		WorkspaceID string `json:"workspaceId"`
		Revisions   []struct {
			CommitID string `json:"commitId"`
		} `json:"revisions"`
	}
	decoder := json.NewDecoder(strings.NewReader(result.Stdout))
	require.NoError(t, decoder.Decode(&receipt), "stdout starts with the receipt")
	require.False(t, decoder.More(), "stdout holds exactly one JSON receipt")
	require.Equal(t, "imported", receipt.Status)
	require.Equal(t, workspaceID, receipt.WorkspaceID)
	require.Len(t, receipt.Revisions, 1)
	require.Equal(t, commit, receipt.Revisions[0].CommitID)
	require.Contains(t, requests, "POST /acme/widgets.git/git-upload-pack", "the guest fetched over the bridge")
	if evidence := os.Getenv("SMITHERS_FLOW_ISOLATION_EVIDENCE_DIR"); evidence != "" {
		body, _ := json.MarshalIndent(map[string]any{"commit": commit, "ref": ref, "stdout": result.Stdout, "served": requests}, "", "  ")
		require.NoError(t, os.MkdirAll(evidence, 0o700))
		require.NoError(t, os.WriteFile(filepath.Join(evidence, "helper-import.json"), body, 0o600))
	}
}

package microsandbox

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// A lane machine booted from a Node repository's layers carries bubblewrap,
// and its unprivileged agent can confine a command the way the coding host
// does on Linux: new user, PID, network and mount namespaces, a read-only
// view of the machine and one writable directory. Without bubblewrap the
// coding host refuses every confined command in the guest.
func TestRealMicroVMLaneConfinement(t *testing.T) {
	runtime := detectedFixtureRuntime(t)
	manifest, err := json.Marshal(map[string]any{"name": "demo", "version": "1.0.0", "private": true, "packageManager": "pnpm@9",
		"scripts": map[string]string{"test": "node --test"}, "dependencies": map[string]string{"is-number": "7.0.0"}})
	require.NoError(t, err)
	files := map[string]string{
		".node-version":  "22\n",
		"package.json":   string(manifest),
		"pnpm-lock.yaml": "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    dependencies:\n      is-number:\n        specifier: 7.0.0\n        version: 7.0.0\npackages:\n  is-number@7.0.0:\n    resolution: {integrity: sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==}\n    engines: {node: '>=0.12.0'}\nsnapshots:\n  is-number@7.0.0: {}\n",
	}
	repo := t.TempDir()
	for name, content := range files {
		require.NoError(t, os.WriteFile(filepath.Join(repo, name), []byte(content), 0o644))
	}
	reader := diskFixtureSources{root: repo, revision: digest("lane-confinement")[:40]}
	runtime.BindSourceFiles(reader)
	ctx := operation("lane-confinement")
	id := "lane-confinement"
	source := &workspaceapi.WorkspaceSource{Repository: "fixtures/lane-confinement", Revision: "main"}
	_, err = runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id, Source: source})
	require.NoError(t, err)
	defer func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete-lane-confinement"), id)) }()
	confined := strings.Join([]string{
		"echo uid_map=$(cat /proc/self/uid_map | tr -s ' ' | sed 's/^ //')",
		"echo net=$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | tr '\\n' ' ')",
		"echo inside > /workspace/out/file && echo inside=written",
		"(echo outside > /workspace/escape) 2>/dev/null && echo outside=written || echo outside=denied",
	}, "; ")
	result, err := runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/bin/bash", "-ec",
		"echo bwrap=$(command -v bwrap); echo host_uid_map=$(cat /proc/self/uid_map | tr -s ' ' | sed 's/^ //'); mkdir -p /workspace/out; " +
			"bwrap --unshare-all --new-session --die-with-parent --ro-bind / / --bind /workspace/out /workspace/out --proc /proc --dev /dev --tmpfs /tmp -- /bin/sh -c " + shellQuote(confined) +
			"; cat /workspace/out/file; test ! -e /workspace/escape"}})
	require.NoError(t, err)
	t.Logf("lane confinement receipt:\n%s%s", result.Stdout, result.Stderr)
	require.Equal(t, 0, result.ExitCode, result.Stdout+result.Stderr)
	require.Contains(t, result.Stdout, "bwrap=/usr/bin/bwrap\n")
	require.Contains(t, result.Stdout, "host_uid_map=0 0 4294967295\n")
	// Unprivileged bubblewrap nests the command in a second user namespace
	// below the one it set up as root, so the parent ID it reads is 0.
	require.Contains(t, result.Stdout, "uid_map="+strconv.Itoa(guestUID)+" 0 1\n", "the confined command runs in a new user namespace")
	require.Contains(t, result.Stdout, "net=lo\n", "the confined command sees only its own loopback")
	require.Contains(t, result.Stdout, "inside=written\n")
	require.Contains(t, result.Stdout, "outside=denied\n")
	require.True(t, strings.HasSuffix(result.Stdout, "inside\n"))
}

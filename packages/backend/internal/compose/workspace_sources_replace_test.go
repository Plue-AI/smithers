package compose

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/repository"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// The machine layer builder reads main through repositorySourceFiles. A
// replacement ref in the install's mirror does not change what it reads:
// the native reader returns main's original bytes, where plain git would
// return the replacement's.
func TestSourceReaderReadsMainPastReplacementRefs(t *testing.T) {
	ffi := strings.TrimSpace(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	if ffi == "" {
		t.Skip("SMITHERS_FFI_LIBRARY_PATH is required for the real repository engine")
	}
	ctx := context.Background()
	cfg := repository.Config{StoragePath: t.TempDir(), AuthToken: "reader-engine", FFILibraryPath: ffi, InstallMainMirror: true}
	local, err := repository.OpenLocal(cfg)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
	client := local.Client()
	require.NoError(t, client.InitRepo(ctx, "owner", "app", "main", false))

	work := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = work
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.test",
			"GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.test")
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "git %v: %s", args, out)
		return strings.TrimSpace(string(out))
	}
	commit := func(content string) string {
		require.NoError(t, os.MkdirAll(filepath.Join(work, ".smithers"), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(work, ".smithers", "machine.json"), []byte(content), 0o644))
		git("add", "-A")
		git("commit", "-q", "-m", content)
		return git("rev-parse", "HEAD")
	}
	push := func(kind middleware.CredentialKind, commit, ref string) {
		t.Helper()
		line := fmt.Sprintf("%s %s %s\x00report-status\n", strings.Repeat("0", 40), commit, ref)
		body := bytes.NewBufferString(fmt.Sprintf("%04x%s0000", len(line)+4, line))
		pack := exec.Command("git", "pack-objects", "--revs", "--stdout", "-q")
		pack.Dir = work
		pack.Stdin = strings.NewReader(commit + "\n")
		data, err := pack.Output()
		require.NoError(t, err)
		body.Write(data)
		require.NoError(t, client.ProxyReceivePack(ctx, "owner", "app", body, io.Discard, repohost.ReceivePackMetadata{PusherCredential: kind}))
	}
	git("init", "-q", "-b", "main")
	original := commit(`{"packages":["original"]}`)
	push(middleware.CredentialSync, original, "refs/heads/main")
	git("checkout", "-q", "--orphan", "other")
	replaced := commit(`{"packages":["replaced"]}`)
	push(middleware.CredentialPerson, replaced, "refs/heads/carrier")
	gitDir := cfg.GitBackendPath("owner", "app")
	git("--git-dir", gitDir, "update-ref", "refs/replace/"+original, replaced)
	require.Equal(t, `{"packages":["replaced"]}`, git("--git-dir", gitDir, "show", "main:.smithers/machine.json"), "the fixture's replacement applies to plain git")

	reader := repositorySourceFiles{client: client}
	revision, err := reader.ResolveSourceRevision(ctx, "owner/app", "main")
	require.NoError(t, err)
	require.Equal(t, original, revision)
	contents, err := reader.ReadSourceFile(ctx, workspaceapi.WorkspaceSource{Repository: "owner/app", Revision: revision}, ".smithers/machine.json")
	require.NoError(t, err)
	require.Equal(t, `{"packages":["original"]}`, string(contents))
}

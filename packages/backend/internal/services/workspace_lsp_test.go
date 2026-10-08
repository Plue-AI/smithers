package services

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestWorkspaceSessionKind_DefaultsToTerminal(t *testing.T) {
	t.Parallel()

	var created []db.CreateWorkspaceSessionParams
	q := &mockWorkspaceQuerier{
		createWorkspaceSessionFn: func(ctx context.Context, arg db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error) {
			created = append(created, arg)
			return db.WorkspaceSession{ID: "sess-1", WorkspaceID: arg.WorkspaceID, Status: "running", Cols: arg.Cols, Rows: arg.Rows}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	resp, err := svc.CreateSession(context.Background(), CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
		WorkspaceID:  "ws-1",
	})
	require.NoError(t, err)
	require.Len(t, created, 1)
	assert.Equal(t, WorkspaceSessionKindTerminal, resp.Kind, "an empty kind is a terminal session, unchanged for every existing caller")
	assert.Empty(t, resp.Language)
}

// Sessions start only as terminals: the File card's language server opens at
// /api/branches/{b}/lsp as a member daemon exec session, never as a row here.
func TestWorkspaceSessionKind_RefusesEveryKindButTerminal(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	cases := []struct {
		name  string
		input CreateWorkspaceSessionInput
		want  string
	}{
		{"unknown kind", CreateWorkspaceSessionInput{Kind: "shell"}, "kind must be terminal"},
		{"retired lsp kind", CreateWorkspaceSessionInput{Kind: "lsp"}, "code intelligence opens at /api/branches/{b}/lsp"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q.createWorkspaceSessionFn = func(context.Context, db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error) {
				t.Fatal("a refused kind writes no session")
				return db.WorkspaceSession{}, nil
			}
			tc.input.RepositoryID = 101
			tc.input.UserID = 1
			tc.input.WorkspaceID = "ws-1"
			_, err := svc.CreateSession(context.Background(), tc.input)
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			assert.Equal(t, http.StatusBadRequest, apiErr.Status)
			assert.Contains(t, apiErr.Message, tc.want)
		})
	}
}

func TestLanguageServerMissing_Is409WithInstallLineVerbatim(t *testing.T) {
	t.Parallel()

	spec, ok := LanguageServerFor("typescript")
	require.True(t, ok)
	err := LanguageServerMissing(spec)
	assert.Equal(t, http.StatusConflict, err.Status)
	assert.Equal(t, CodeLanguageServerMissing, err.Code)
	assert.Equal(t, "npm i -g typescript-language-server typescript", err.Message, "the message is the install line, verbatim")
	details, ok := err.Details.(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "typescript", details["language"])
	assert.Equal(t, spec.Install, details["install"])
}

func TestLanguageServerLaunchArgv_IsTheTrustedShellOverTheLaunchScript(t *testing.T) {
	t.Parallel()

	spec, ok := LanguageServerFor("typescript")
	require.True(t, ok)
	argv := spec.LaunchArgv(defaultWorkspaceClonePath)
	require.Len(t, argv, 3)
	assert.Equal(t, []string{"/bin/sh", "-c"}, argv[:2])
	script := argv[2]
	assert.Contains(t, script, "cd '/workspace'")
	assert.Contains(t, script, "node_modules/.bin:$HOME/.local/bin:/run/current-system/sw/bin")
	assert.Contains(t, script, "printf 'missing %s\\n' 'typescript-language-server'; exit 127")
	assert.Contains(t, script, "printf 'ready\\n'; exec 'typescript-language-server' '--stdio'")
}

// TestLanguageServerLaunchArgv_RunsUnderSh executes the real launch argv with
// a scratch checkout, so the ready/missing handshake the relay depends on is
// proven, not assumed.
func TestLanguageServerLaunchArgv_RunsUnderSh(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("bash launch script")
	}

	spec := LanguageServerSpec{Language: "fake", Bin: "fake-language-server", Args: []string{"--stdio"}, Install: "install fake"}
	checkout := t.TempDir()
	home := t.TempDir()

	run := func() (string, int) {
		t.Helper()
		argv := spec.LaunchArgv(checkout)
		cmd := exec.Command(argv[0], argv[1:]...)
		cmd.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin"}
		out, err := cmd.Output()
		code := 0
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		} else if err != nil {
			t.Fatalf("run launch: %v", err)
		}
		return string(out), code
	}

	out, code := run()
	assert.Equal(t, LanguageServerMissingExitCode, code)
	assert.Equal(t, "missing fake-language-server\n", out, "a missing binary prints the missing line before exit 127")

	binDir := filepath.Join(checkout, "node_modules", ".bin")
	require.NoError(t, os.MkdirAll(binDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(binDir, spec.Bin), []byte("#!/bin/sh\nprintf 'argv=%s cwd=%s\\n' \"$*\" \"$PWD\"\n"), 0o755))

	out, code = run()
	assert.Equal(t, 0, code)
	lines := strings.Split(strings.TrimSpace(out), "\n")
	require.Len(t, lines, 2, out)
	assert.Equal(t, LanguageServerReadyLine, lines[0], "the ready line precedes the server's own stdout")
	assert.Equal(t, "argv=--stdio cwd="+checkout, lines[1], "the checkout's node_modules/.bin wins and is the working directory")
}

func TestLSPLanguages_AdvertisedOnWorkspaceDTO(t *testing.T) {
	t.Parallel()

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{})
	resp := svc.toWorkspaceResponse(sampleDBWorkspace("ws-1"))
	assert.Equal(t, []string{"typescript"}, resp.LSP.Languages)
	assert.Equal(t, LSPLanguages(), resp.LSP.Languages)
}

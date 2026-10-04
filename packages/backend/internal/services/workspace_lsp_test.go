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

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func sampleDBLSPSession(id, workspaceID, language string) db.WorkspaceSession {
	return db.WorkspaceSession{
		ID:              id,
		WorkspaceID:     workspaceID,
		RepositoryID:    101,
		UserID:          1,
		Status:          "running",
		Kind:            WorkspaceSessionKindLSP,
		Language:        language,
		Cols:            80,
		Rows:            24,
		IdleTimeoutSecs: workspaceLSPIdleTimeoutSecs,
	}
}

func TestWorkspaceSessionKind_DefaultsToTerminal(t *testing.T) {
	t.Parallel()

	var created []db.CreateWorkspaceSessionParams
	q := &mockWorkspaceQuerier{
		createWorkspaceSessionFn: func(ctx context.Context, arg db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error) {
			created = append(created, arg)
			return db.WorkspaceSession{ID: "sess-1", WorkspaceID: arg.WorkspaceID, Status: "running", Cols: arg.Cols, Rows: arg.Rows}, nil
		},
		createWorkspaceLSPSessionFn: func(ctx context.Context, arg db.CreateWorkspaceLSPSessionParams) (db.WorkspaceSession, error) {
			t.Fatalf("terminal create must not use the lsp insert: %+v", arg)
			return db.WorkspaceSession{}, nil
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

func TestWorkspaceSessionKind_RejectsUnknownKindAndLanguage(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	cases := []struct {
		name  string
		input CreateWorkspaceSessionInput
		want  string
	}{
		{"unknown kind", CreateWorkspaceSessionInput{Kind: "shell"}, "kind must be terminal or lsp"},
		{"lsp without language", CreateWorkspaceSessionInput{Kind: "lsp"}, "language is required for kind lsp"},
		{"lsp unknown language", CreateWorkspaceSessionInput{Kind: "lsp", Language: "cobol"}, "language must be one of: typescript"},
		{"terminal with language", CreateWorkspaceSessionInput{Language: "typescript"}, "language is only accepted with kind lsp"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
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

func TestWorkspaceSessionKind_LSPInsertCarriesLanguageAndIdleBudget(t *testing.T) {
	t.Parallel()

	var inserted []db.CreateWorkspaceLSPSessionParams
	q := &mockWorkspaceQuerier{
		getActiveWorkspaceLSPSessionFn: func(ctx context.Context, arg db.GetActiveWorkspaceLSPSessionParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, pgx.ErrNoRows
		},
		createWorkspaceLSPSessionFn: func(ctx context.Context, arg db.CreateWorkspaceLSPSessionParams) (db.WorkspaceSession, error) {
			inserted = append(inserted, arg)
			return sampleDBLSPSession("lsp-1", arg.WorkspaceID, arg.Language), nil
		},
		createWorkspaceSessionFn: func(ctx context.Context, arg db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error) {
			t.Fatalf("lsp create must not use the terminal insert: %+v", arg)
			return db.WorkspaceSession{}, nil
		},
		// RETURNING * carries kind and language back on the CAS to running; the
		// stateless mock has to say so explicitly.
		markWorkspaceSessionRunningFn: func(ctx context.Context, id string) (db.WorkspaceSession, error) {
			return sampleDBLSPSession(id, "ws-1", "typescript"), nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	resp, err := svc.CreateSession(context.Background(), CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
		WorkspaceID:  "ws-1",
		Kind:         "LSP",
		Language:     " TypeScript ",
	})
	require.NoError(t, err)
	require.Len(t, inserted, 1)
	assert.Equal(t, "typescript", inserted[0].Language, "language is normalized to the registry id")
	assert.Equal(t, workspaceLSPIdleTimeoutSecs, inserted[0].IdleTimeoutSecs, "LSP rows carry the 10-minute idle budget")
	assert.Equal(t, WorkspaceSessionKindLSP, resp.Kind)
	assert.Equal(t, "typescript", resp.Language)
}

func TestWorkspaceSessionKind_SecondLSPCreateReturnsExisting(t *testing.T) {
	t.Parallel()

	touched := 0
	q := &mockWorkspaceQuerier{
		getActiveWorkspaceLSPSessionFn: func(ctx context.Context, arg db.GetActiveWorkspaceLSPSessionParams) (db.WorkspaceSession, error) {
			assert.Equal(t, "ws-1", arg.WorkspaceID)
			assert.Equal(t, "typescript", arg.Language)
			return sampleDBLSPSession("lsp-existing", "ws-1", "typescript"), nil
		},
		createWorkspaceLSPSessionFn: func(ctx context.Context, arg db.CreateWorkspaceLSPSessionParams) (db.WorkspaceSession, error) {
			t.Fatalf("a live lsp session must be reused, not duplicated: %+v", arg)
			return db.WorkspaceSession{}, nil
		},
		touchWorkspaceSessionActivityFn: func(ctx context.Context, id string) error {
			touched++
			assert.Equal(t, "lsp-existing", id)
			return nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	resp, err := svc.CreateSession(context.Background(), CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
		WorkspaceID:  "ws-1",
		Kind:         "lsp",
		Language:     "typescript",
	})
	require.NoError(t, err)
	assert.Equal(t, "lsp-existing", resp.ID)
	assert.Equal(t, 1, touched, "reusing a session refreshes its activity so the idle sweeper keeps it")
}

func TestWorkspaceSessionKind_LSPInsertRaceAnswersWinner(t *testing.T) {
	t.Parallel()

	lookups := 0
	q := &mockWorkspaceQuerier{
		getActiveWorkspaceLSPSessionFn: func(ctx context.Context, arg db.GetActiveWorkspaceLSPSessionParams) (db.WorkspaceSession, error) {
			lookups++
			if lookups == 1 {
				return db.WorkspaceSession{}, pgx.ErrNoRows
			}
			return sampleDBLSPSession("lsp-winner", "ws-1", "typescript"), nil
		},
		createWorkspaceLSPSessionFn: func(ctx context.Context, arg db.CreateWorkspaceLSPSessionParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, &pgconn.PgError{Code: "23505", ConstraintName: "idx_workspace_sessions_active_lsp"}
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	resp, err := svc.CreateSession(context.Background(), CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
		WorkspaceID:  "ws-1",
		Kind:         "lsp",
		Language:     "typescript",
	})
	require.NoError(t, err)
	assert.Equal(t, "lsp-winner", resp.ID)
	assert.Equal(t, 2, lookups)
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

func TestResolveLanguageServer_TerminalSessionIsKindMismatch(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(ctx context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{ID: arg.ID, WorkspaceID: "ws-1", RepositoryID: arg.RepositoryID, UserID: 1, Status: "running", Kind: WorkspaceSessionKindTerminal}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	_, err := svc.ResolveLanguageServer(context.Background(), "term-1", 101, 1)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusConflict, apiErr.Status)
	assert.Equal(t, CodeWorkspaceSessionKindMismatch, apiErr.Code)
}

func TestResolveLanguageServer_AnswersLaunchForLSPSession(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(ctx context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return sampleDBLSPSession(arg.ID, "ws-1", "typescript"), nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	launch, err := svc.ResolveLanguageServer(context.Background(), "lsp-1", 101, 1)
	require.NoError(t, err)
	assert.Equal(t, "typescript", launch.Language)
	assert.Equal(t, "ws-1", launch.WorkspaceID)
	assert.Equal(t, "typescript-language-server", launch.Spec.Bin)
	assert.True(t, strings.HasPrefix(launch.Command, "bash -c '"), launch.Command)
	script := launch.Spec.LaunchScript(defaultWorkspaceClonePath)
	assert.Equal(t, "bash -c "+shellQuote(script), launch.Command)
	assert.Contains(t, script, "cd '/workspace'")
	assert.Contains(t, script, "node_modules/.bin:$HOME/.local/bin:/run/current-system/sw/bin")
	assert.Contains(t, script, "printf 'missing %s\\n' 'typescript-language-server'; exit 127")
	assert.Contains(t, script, "printf 'ready\\n'; exec 'typescript-language-server' '--stdio'")
}

// TestLanguageServerLaunchCommand_RunsUnderBash executes the real launch
// script under bash with a scratch checkout, so the ready/missing handshake
// the relay depends on is proven, not assumed.
func TestLanguageServerLaunchCommand_RunsUnderBash(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("bash launch script")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not installed")
	}

	spec := LanguageServerSpec{Language: "fake", Bin: "fake-language-server", Args: []string{"--stdio"}, Install: "install fake"}
	checkout := t.TempDir()
	home := t.TempDir()

	run := func() (string, int) {
		t.Helper()
		cmd := exec.Command("sh", "-c", spec.LaunchCommand(checkout))
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

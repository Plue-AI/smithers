package microsandbox

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// Real guest CAS for host-owned S1 credentials. A host credential cannot open
// a member terminal. The composed member terminal proof lives in compose's
// TestInstalledMemberTerminalAndSSHChain and requires its approved bundle.
func TestRealMicroVMHostSessionTokenCAS(t *testing.T) {
	runtime := realRuntime(t, t.TempDir())
	ctx := operation("session-token")
	id := "microvm-session-token"
	_, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
	require.NoError(t, err)
	defer func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete-session-token"), id)) }()

	session := "5e55a0b1-0000-4000-8000-000000000001"
	path, err := runtime.PutSessionToken(ctx, id, session, []byte("smithers_first"), "")
	require.NoError(t, err)
	require.Equal(t, "/run/smithers/sessions/"+session+"/token", path)
	run := func(script string) string {
		t.Helper()
		result, err := runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/bin/sh", "-c", script, "sh", path}})
		require.NoError(t, err)
		require.Equal(t, 0, result.ExitCode, result.Stdout+result.Stderr)
		return result.Stdout
	}
	inspect := `stat -c '%U %a' "$1" "${1%/token}"; cat "$1"; ls -A "${1%/token}"`
	require.Equal(t, "agent 600\nroot 755\nsmithers_first\ntoken\n", run(inspect))
	_, err = runtime.PutSessionToken(ctx, id, session, []byte("smithers_second"), workspaceapi.SessionCredentialIdentity([]byte("smithers_first")))
	require.NoError(t, err)
	require.Equal(t, "agent 600\nroot 755\nsmithers_second\ntoken\n", run(inspect), "rotation replaces the file and leaves no temporary")

	// A stale replica and a foreign credential cannot replace or remove the successor.
	_, err = runtime.PutSessionToken(ctx, id, session, []byte("smithers_stale"), workspaceapi.SessionCredentialIdentity([]byte("smithers_first")))
	require.Error(t, err)
	require.Error(t, runtime.DeleteSessionToken(ctx, id, session, workspaceapi.SessionCredentialIdentity([]byte("smithers_first"))))
	_, err = runtime.PutSessionToken(ctx, id, session, []byte("smithers_create"), "")
	require.Error(t, err, "create cannot replace a retained bearer")
	require.Equal(t, "agent 600\nroot 755\nsmithers_second\ntoken\n", run(inspect))

	require.Equal(t, "pinned\nkept\n", run(`mv "$1" "$1.moved" 2>/dev/null && echo moved || echo pinned; rm -f "$1" 2>/dev/null; test -e "$1" && echo kept || echo removed`))

	terminal, err := runtime.OpenWorkspaceTerminal(ctx, id, workspaceapi.Command{Args: []string{"/bin/sh"}, Environment: map[string]string{"SMITHERS_TOKEN_FILE": path, "SMITHERS_URL": "http://127.0.0.1:4000"}})
	require.ErrorIs(t, err, ErrUnavailable, "host credentials cannot bypass current member admission")
	require.Nil(t, terminal)

	// Separate host calls enter separate privileged helper processes. Only one
	// concurrent compare-and-swap may consume the same retained credential.
	results := make(chan error, 2)
	expected := workspaceapi.SessionCredentialIdentity([]byte("smithers_second"))
	for _, candidate := range []string{"smithers_third", "smithers_fourth"} {
		go func(token string) {
			_, err := runtime.PutSessionToken(ctx, id, session, []byte(token), expected)
			results <- err
		}(candidate)
	}
	succeeded := 0
	for range 2 {
		if <-results == nil {
			succeeded++
		}
	}
	require.Equal(t, 1, succeeded, "guest lock serializes independent helper writers")
	winner := strings.TrimSpace(run(`cat "$1"`))
	require.Contains(t, []string{"smithers_third", "smithers_fourth"}, winner)
	require.Error(t, runtime.DeleteSessionToken(ctx, id, session, expected), "old close cannot delete the CAS winner")
	finalIdentity := workspaceapi.SessionCredentialIdentity([]byte(winner))

	require.NoError(t, runtime.DeleteSessionToken(ctx, id, session, finalIdentity))
	require.Equal(t, "gone\n", run(`test -e "${1%/token}" && echo present || echo gone`))
	require.NoError(t, runtime.DeleteSessionToken(ctx, id, session, finalIdentity), "a second close is a no-op")
	_, err = runtime.PutSessionToken(ctx, id, "../escape", []byte("smithers_x"), "")
	require.Error(t, err)
	_, err = runtime.PutSessionToken(ctx, id, session, []byte("two words"), "")
	require.Error(t, err)
	_, err = runtime.PutSessionToken(context.Background(), "no-such-workspace", session, []byte("smithers_x"), "")
	require.Error(t, err)
}

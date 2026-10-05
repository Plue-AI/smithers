package microsandbox

import (
	"bytes"
	"context"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// A signed-in terminal in a real guest (T-TRM-02, C-J6-01 S1): the helper
// writes the session's credential to /run/smithers/sessions/<id>/token, owned
// by the guest's single user with mode 0600 in a root-owned directory; a
// rotation replaces it; the user can read it but neither move nor remove it;
// a terminal started with SMITHERS_TOKEN_FILE reads it as that user; and the
// session's close removes it.
func TestRealMicroVMTerminalSessionToken(t *testing.T) {
	runtime := realRuntime(t, t.TempDir())
	ctx := operation("session-token")
	id := "microvm-session-token"
	_, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
	require.NoError(t, err)
	defer func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete-session-token"), id)) }()

	session := "5e55a0b1-0000-4000-8000-000000000001"
	path, err := runtime.PutSessionToken(ctx, id, session, []byte("smithers_first"))
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
	_, err = runtime.PutSessionToken(ctx, id, session, []byte("smithers_second"))
	require.NoError(t, err)
	require.Equal(t, "agent 600\nroot 755\nsmithers_second\ntoken\n", run(inspect), "rotation replaces the file and leaves no temporary")
	require.Equal(t, "pinned\nkept\n", run(`mv "$1" "$1.moved" 2>/dev/null && echo moved || echo pinned; rm -f "$1" 2>/dev/null; test -e "$1" && echo kept || echo removed`))

	terminal, err := runtime.OpenWorkspaceTerminal(ctx, id, workspaceapi.Command{Args: []string{"/bin/sh"},
		Environment: map[string]string{"SMITHERS_TOKEN_FILE": path, "SMITHERS_URL": "http://127.0.0.1:4000"}})
	require.NoError(t, err)
	var printed bytes.Buffer
	var mu sync.Mutex
	go func() {
		buffer := make([]byte, 4096)
		for {
			n, err := terminal.Read(buffer)
			mu.Lock()
			printed.Write(buffer[:n])
			mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	_, err = io.WriteString(terminal, `printf '%s %s %s %s\n' J6""TOKEN "$(cat "$SMITHERS_TOKEN_FILE")" "${SMITHERS_TOKEN:-unset}" "$(id -un)"`+"\n")
	require.NoError(t, err)
	deadline := time.Now().Add(time.Minute)
	for {
		mu.Lock()
		out := printed.String()
		mu.Unlock()
		if strings.Contains(out, "J6TOKEN smithers_second unset agent") {
			break
		}
		require.True(t, time.Now().Before(deadline), "terminal printed %q", out)
		time.Sleep(100 * time.Millisecond)
	}
	require.NoError(t, terminal.Close())

	require.NoError(t, runtime.DeleteSessionToken(ctx, id, session))
	require.Equal(t, "gone\n", run(`test -e "${1%/token}" && echo present || echo gone`))
	require.NoError(t, runtime.DeleteSessionToken(ctx, id, session), "a second close is a no-op")
	_, err = runtime.PutSessionToken(ctx, id, "../escape", []byte("smithers_x"))
	require.Error(t, err)
	_, err = runtime.PutSessionToken(ctx, id, session, []byte("two words"))
	require.Error(t, err)
	_, err = runtime.PutSessionToken(context.Background(), "no-such-workspace", session, []byte("smithers_x"))
	require.Error(t, err)
}

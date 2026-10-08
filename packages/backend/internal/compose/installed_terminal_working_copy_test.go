package compose

import (
	"context"
	"fmt"
	"io"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The owner swaps a branch executable's directory while the installed broker
// opens sessions. All filesystem operations run through the owner's retained
// HTTP/WebSocket terminal. Neither the broker nor the host reads branch code.
const installedTerminalWorkingCopySwaps = `import os, pathlib, sys, time
root = pathlib.Path(sys.argv[1])
current, saved = root / "current", root / "saved"
count = 0
while not (root / "stop").exists():
    current.rename(saved)
    current.symlink_to("/home/alice/.trm-working-sentinel")
    count += 1
    if count >= 1000:
        (root / "ready").write_text(str(count))
    time.sleep(.001)
    current.unlink()
    saved.rename(current)
    time.sleep(.001)
(root / "done").write_text(str(count))
assert count >= 1000
`

func installedTerminalCommandOutput(t *testing.T, ctx context.Context, terminal workspaceapi.Terminal) ([]byte, error) {
	t.Helper()
	defer terminal.Close()
	done := make(chan struct{})
	var output []byte
	var err error
	go func() { output, err = io.ReadAll(terminal); close(done) }()
	select {
	case <-done:
		return output, err
	case <-ctx.Done():
		_ = terminal.Close()
		<-done
		t.Fatal("broker session did not settle before deadline")
		return nil, ctx.Err()
	}
}

func testInstalledTerminalWorkingCopySwaps(t *testing.T, writer microsandbox.MemberSessionCredentials, branch string, observer *rehearsalTerminal, phase string) {
	t.Helper()
	t.Run(phase+"/concurrent working copy directory changes", func(t *testing.T) {
		prefix := "/workspace/trm-working-" + uuid.NewString()
		installedShell(t, observer, fmt.Sprintf(`mkdir -p %q/current; printf '#!/bin/sh\ntest "$(id -u)" = 20001 || exit 91\ntest "$(id -g)" = 20001 || exit 92\nprintf WORKING_COPY_OWNER\n' > %q/current/start; chmod 755 %q/current/start`, prefix, prefix, prefix))
		installedShell(t, observer, "cat > "+prefix+"/swap.py <<'TRMSWAPS'\n"+installedTerminalWorkingCopySwaps+"\nTRMSWAPS\n"+fmt.Sprintf("python3 %q/swap.py %q > %q/output 2>&1 &", prefix, prefix, prefix))
		defer func() {
			installedShell(t, observer, fmt.Sprintf(`touch %q/stop; for i in $(seq 1 200); do test -s %q/done && break; sleep .02; done; test -s %q/done && test ! -s %q/output && test -d %q/current && test ! -L %q/current && rm -rf %q`, prefix, prefix, prefix, prefix, prefix, prefix, prefix))
		}()
		installedShell(t, observer, fmt.Sprintf(`for i in $(seq 1 300); do test -s %q/ready && break; sleep .02; done; test -s %q/ready`, prefix, prefix))
		successes := 0
		for i := 0; i < 32; i++ {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			session := uuid.NewString()
			token := []byte("smithers_working_copy_acceptance")
			digest := workspaceapi.SessionCredentialIdentity(token)
			path, err := writer.PutSessionToken(ctx, branch, session, token, "")
			require.NoError(t, err)
			terminal, err := writer.OpenTerminal(ctx, branch, session, digest, workspaceapi.Command{Args: []string{prefix + "/current/start"}, Environment: map[string]string{"SMITHERS_TOKEN_FILE": path, "SMITHERS_URL": "http://127.0.0.1:4000"}})
			if err == nil {
				output, readErr := installedTerminalCommandOutput(t, ctx, terminal)
				if readErr == nil {
					require.Equal(t, "WORKING_COPY_OWNER", string(output))
					successes++
				} else {
					require.NotContains(t, string(output), "WORKING_COPY_OWNER")
					require.NotContains(t, string(output), "FOREIGN_COPY_EXECUTED")
				}
			} else {
				require.Nil(t, terminal)
			}
			require.NoError(t, writer.DeleteSessionToken(t.Context(), branch, session, digest))
			cancel()
		}
		t.Logf("working copy changes: attempts=32 successful_owner_executions=%d", successes)
		// Restore the same executable and prove it can run after the swaps.
		installedShell(t, observer, fmt.Sprintf(`touch %q/stop; for i in $(seq 1 200); do test -s %q/done && break; sleep .02; done; test -s %q/done`, prefix, prefix, prefix))
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		session := uuid.NewString()
		token := []byte("smithers_working_copy_restored")
		digest := workspaceapi.SessionCredentialIdentity(token)
		path, err := writer.PutSessionToken(ctx, branch, session, token, "")
		require.NoError(t, err)
		defer func() { require.NoError(t, writer.DeleteSessionToken(t.Context(), branch, session, digest)) }()
		terminal, err := writer.OpenTerminal(ctx, branch, session, digest, workspaceapi.Command{Args: []string{prefix + "/current/start"}, Environment: map[string]string{"SMITHERS_TOKEN_FILE": path, "SMITHERS_URL": "http://127.0.0.1:4000"}})
		require.NoError(t, err)
		output, err := installedTerminalCommandOutput(t, ctx, terminal)
		require.NoError(t, err)
		require.Equal(t, "WORKING_COPY_OWNER", string(output))
	})
}

// Exited sessions leave broker bookkeeping until explicit cleanup. Reopening
// that credential must start one new process, never replay an ended process.
func testInstalledTerminalEmptyProcessSessions(t *testing.T, writer microsandbox.MemberSessionCredentials, branch string, observer *rehearsalTerminal, phase string) {
	t.Helper()
	t.Run(phase+"/session bookkeeping after process exit", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
		defer cancel()
		session := uuid.NewString()
		token := []byte("smithers_empty_process_acceptance")
		digest := workspaceapi.SessionCredentialIdentity(token)
		path, err := writer.PutSessionToken(ctx, branch, session, token, "")
		require.NoError(t, err)
		defer func() { require.NoError(t, writer.DeleteSessionToken(t.Context(), branch, session, digest)) }()
		prefix := "/workspace/trm-empty-" + session
		installedTerminalInventory(t, observer, prefix, "save")
		defer installedShell(t, observer, fmt.Sprintf("rm -f %q %q", prefix+".inventory", prefix+".runs"))
		for i := 1; i <= 3; i++ {
			terminal, err := writer.OpenTerminal(ctx, branch, session, digest, workspaceapi.Command{Args: []string{"/bin/sh", "-c", fmt.Sprintf(`test "$(id -u)" = 20001 && printf 'run\n' >> %q && printf EMPTY_PROCESS_EXIT`, prefix+".runs")}, Environment: map[string]string{"SMITHERS_TOKEN_FILE": path, "SMITHERS_URL": "http://127.0.0.1:4000"}})
			require.NoError(t, err)
			output, err := installedTerminalCommandOutput(t, ctx, terminal)
			require.NoError(t, err)
			require.Equal(t, "EMPTY_PROCESS_EXIT", string(output))
			installedTerminalInventory(t, observer, prefix, "0")
			installedShell(t, observer, fmt.Sprintf(`test "$(wc -l < %q)" = %d && test -r %q`, prefix+".runs", i, path))
		}
	})
}

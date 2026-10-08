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

// Member-written token leaves are branch-controlled inputs even though their
// parent is a fixed /run path. Every probe uses the installed admission/broker,
// with an independent production HTTP/WebSocket observer. No root setup runs.
func testInstalledTerminalTokenPaths(t *testing.T, writer microsandbox.MemberSessionCredentials, branch string, observer *rehearsalTerminal, phase string) {
	t.Helper()
	for _, cell := range []struct{ name, mutation string }{
		{"symlink leaf", `mv "$p" "$p.saved"; ln -s "$p.saved" "$p"`},
		{"symlink session directory", `mv "$(dirname "$p")" "$(dirname "$p").saved"; ln -s "$(dirname "$p").saved" "$(dirname "$p")`},
		{"hardlink leaf", `ln "$p" "$p.link"`},
		{"directory leaf", `mv "$p" "$p.saved"; mkdir "$p"`},
		{"FIFO leaf", `mv "$p" "$p.saved"; mkfifo "$p"; chmod 600 "$p"`},
		{"missing leaf", `mv "$p" "$p.saved"`},
		{"unreadable leaf", `chmod 000 "$p"`},
		{"empty leaf", `cp "$p" "$p.saved"; : > "$p"`},
		{"missing newline", `cp "$p" "$p.saved"; printf smithers_path_acceptance > "$p"`},
		{"world readable leaf", `chmod 644 "$p"`},
		{"oversized leaf", `cp "$p" "$p.saved"; python3 -c 'import sys; open(sys.argv[1],"wb").write(b"x"*1026)' "$p"`},
		{"foreign credential bytes", `cp "$p" "$p.saved"; printf 'foreign_session_token\n' > "$p"`},
	} {
		t.Run(phase+"/token path/"+cell.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()
			session := uuid.NewString()
			token := []byte("smithers_path_acceptance")
			digest := workspaceapi.SessionCredentialIdentity(token)
			path, err := writer.PutSessionToken(ctx, branch, session, token, "")
			require.NoError(t, err)
			prefix := "/workspace/trm-path-" + session
			installedTerminalInventory(t, observer, prefix, "save")
			// Restore the exact inode/bytes before asking the production CAS to delete.
			// These operations stay in Ben's shell, including failure cleanup.
			restore := fmt.Sprintf(`p=%q; d=$(dirname "$p"); if test -L "$d"; then rm "$d"; mv "$d.saved" "$d"; fi; if test -e "$p.saved"; then rm -rf "$p"; mv "$p.saved" "$p"; fi; rm -f "$p.link"; chmod 600 "$p"`, path)
			defer func() {
				installedShell(t, observer, restore)
				cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
				defer stop()
				require.NoError(t, writer.DeleteSessionToken(cleanup, branch, session, digest))
				installedShell(t, observer, fmt.Sprintf("rm -f %q %q", prefix+".inventory", prefix+".executed"))
			}()
			installedShell(t, observer, fmt.Sprintf("p=%q; ", path)+cell.mutation)
			terminal, openErr := writer.OpenTerminal(ctx, branch, session, digest, workspaceapi.Command{
				Args:        []string{"/bin/sh", "-c", fmt.Sprintf("touch %q; printf TOKEN_PATH_EXECUTED", prefix+".executed")},
				Environment: map[string]string{"SMITHERS_TOKEN_FILE": path, "SMITHERS_URL": "http://127.0.0.1:4000"},
			})
			if openErr == nil {
				require.NotNil(t, terminal)
				defer terminal.Close()
				done := make(chan struct{})
				var output []byte
				var readErr error
				go func() { output, readErr = io.ReadAll(terminal); close(done) }()
				select {
				case <-done:
					require.Error(t, readErr)
					require.NotContains(t, string(output), "TOKEN_PATH_EXECUTED")
				case <-ctx.Done():
					_ = terminal.Close()
					<-done
					t.Fatal("invalid token path retained a broker session")
				}
			} else {
				require.Nil(t, terminal)
			}
			installedShell(t, observer, fmt.Sprintf("test ! -e %q", prefix+".executed"))
			installedTerminalInventory(t, observer, prefix, "0")
			installedShell(t, observer, restore)
			// The same admission must work once its hostile input is restored. This
			// catches broad member/session revocation masquerading as validation.
			terminal, err = writer.OpenTerminal(ctx, branch, session, digest, workspaceapi.Command{
				Args:        []string{"/bin/sh", "-c", "test \"$(id -u)\" = 20001 && printf TOKEN_PATH_RESTORED"},
				Environment: map[string]string{"SMITHERS_TOKEN_FILE": path, "SMITHERS_URL": "http://127.0.0.1:4000"},
			})
			require.NoError(t, err)
			defer terminal.Close()
			done := make(chan struct{})
			var output []byte
			var readErr error
			go func() { output, readErr = io.ReadAll(terminal); close(done) }()
			select {
			case <-done:
				require.NoError(t, readErr)
				require.Equal(t, "TOKEN_PATH_RESTORED", string(output))
			case <-ctx.Done():
				_ = terminal.Close()
				<-done
				t.Fatal("restored token admission did not complete")
			}
			installedTerminalInventory(t, observer, prefix, "0")
		})
	}
}

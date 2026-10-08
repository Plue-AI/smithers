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

// Inspect kernel membership, independently of host manager counts and output.
// Count every live broker session, including erroneous root-only or foreign-user
// groups. New groups must contain only permanently dropped Ben processes.
// Empty/reaped groups do not count as valid sessions.
const installedTerminalSessionInventory = `import json, pathlib, sys, time
root = pathlib.Path("/sys/fs/cgroup/smithers/sessions")
assert root.is_dir() and (root / "cgroup.procs").is_file(), root
def inventory():
    groups = {}
    for group in root.glob("s[0-9]*"):
        try:
            rows = []
            for pid in (group / "cgroup.procs").read_text().split():
                try:
                    status = pathlib.Path("/proc", pid, "status").read_text()
                except FileNotFoundError:
                    continue
                fields = dict(line.split(":", 1) for line in status.splitlines() if ":" in line)
                rows.append(([int(x) for x in fields["Uid"].split()], [int(x) for x in fields["Gid"].split()], [int(x) for x in fields["Groups"].split()]))
            if rows:
                groups[group.name] = rows
        except FileNotFoundError:
            continue
    return groups
p = pathlib.Path(sys.argv[1])
if sys.argv[2] == "save":
    p.write_text(json.dumps(inventory()))
else:
    baseline = set(json.loads(p.read_text()))
    expected = int(sys.argv[2])
    uid = int(sys.argv[3])
    deadline = time.monotonic() + 5
    while True:
        rows = inventory()
        current = set(rows)
        if baseline <= current and len(current - baseline) == expected:
            for group in current - baseline:
                assert all(row == ([uid]*4, [uid]*4, [20000]) for row in rows[group]), (group, rows[group])
            break
        assert time.monotonic() < deadline, (baseline, current, expected)
        time.sleep(.02)
`

func installedTerminalInventory(t *testing.T, observer *rehearsalTerminal, prefix, mode string, ownerUID ...uint32) {
	t.Helper()
	uid := uint32(20001)
	if len(ownerUID) > 0 {
		uid = ownerUID[0]
	}
	installedShell(t, observer, "python3 - "+fmt.Sprintf("%q %q %d", prefix+".inventory", mode, uid)+" <<'TRMINVENTORY'\n"+installedTerminalSessionInventory+"\nTRMINVENTORY\n")
}

// Coordinate at the guest executable's startup boundary, after the real broker
// has dropped uid and validated its binding. No RPC transport or launcher is
// replaced: the independent composed HTTP/WebSocket terminal observes startup
// and releases it only after the production token CAS finishes.
func testInstalledTerminalOpeningReplacement(t *testing.T, writer microsandbox.MemberSessionCredentials, branch string, observer *rehearsalTerminal, phase string) {
	t.Helper()
	t.Run(phase+"/credential replacement during startup", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
		defer cancel()
		session := uuid.NewString()
		oldToken, newToken := []byte("smithers_opening_old"), []byte("smithers_opening_new")
		oldDigest := workspaceapi.SessionCredentialIdentity(oldToken)
		newDigest := workspaceapi.SessionCredentialIdentity(newToken)
		path, err := writer.PutSessionToken(ctx, branch, session, oldToken, "")
		require.NoError(t, err)
		defer func() {
			cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			require.NoError(t, writer.DeleteSessionToken(cleanup, branch, session, newDigest))
			require.NoError(t, writer.DeleteSessionToken(cleanup, branch, session, oldDigest))
		}()
		prefix := "/workspace/trm-opening-" + session
		installedTerminalInventory(t, observer, prefix, "save")
		command := workspaceapi.Command{
			Args:        []string{"/bin/sh", "-c", fmt.Sprintf(`test "$(id -u)" = 20001 || exit 91; touch %q; while test ! -e %q; do sleep .02; done; test "$(cat "$SMITHERS_TOKEN_FILE")" = smithers_opening_new || exit 92; printf 'valid\n' >> %q; printf OPENING_REPLACED_ONCE`, prefix+".ready", prefix+".release", prefix+".sessions")},
			Environment: map[string]string{"SMITHERS_TOKEN_FILE": path, "SMITHERS_URL": "http://127.0.0.1:4000"},
		}
		terminal, err := writer.OpenTerminal(ctx, branch, session, oldDigest, command)
		require.NoError(t, err)
		defer terminal.Close()
		done := make(chan struct{})
		var output []byte
		var readErr error
		go func() { output, readErr = io.ReadAll(terminal); close(done) }()
		installedShell(t, observer, fmt.Sprintf(`for i in $(seq 1 200); do test -e %q && break; sleep .02; done; test -e %q && test ! -e %q`, prefix+".ready", prefix+".ready", prefix+".sessions"))
		select {
		case <-done:
			t.Fatal("startup session exited before replacement")
		default:
		}
		installedTerminalInventory(t, observer, prefix, "1")
		replacedPath, err := writer.PutSessionToken(ctx, branch, session, newToken, oldDigest)
		require.NoError(t, err)
		require.Equal(t, path, replacedPath)
		// A late cleanup from the old lifecycle cannot delete the new token.
		require.NoError(t, writer.DeleteSessionToken(ctx, branch, session, oldDigest))
		// The retired digest must not admit a second executable, even though
		// it names the same session and the token file remains present.
		stale, staleErr := writer.OpenTerminal(ctx, branch, session, oldDigest, command)
		if staleErr == nil {
			require.NotNil(t, stale)
			defer stale.Close()
			staleDone := make(chan struct{})
			var staleOutput []byte
			var staleReadErr error
			go func() { staleOutput, staleReadErr = io.ReadAll(stale); close(staleDone) }()
			select {
			case <-staleDone:
				require.Error(t, staleReadErr)
				require.NotContains(t, string(staleOutput), "OPENING_REPLACED_ONCE")
			case <-ctx.Done():
				_ = stale.Close()
				<-staleDone
				t.Fatal("retired credential left another live startup session")
			}
		} else {
			require.Nil(t, stale)
		}
		installedTerminalInventory(t, observer, prefix, "1")
		installedShell(t, observer, fmt.Sprintf(`test -r %q && test ! -e %q && touch %q`, path, prefix+".sessions", prefix+".release"))
		select {
		case <-done:
			require.NoError(t, readErr)
			require.Equal(t, "OPENING_REPLACED_ONCE", string(output))
		case <-ctx.Done():
			_ = terminal.Close()
			<-done
			t.Fatal("replacement session failed to complete")
		}
		installedTerminalInventory(t, observer, prefix, "0")
		installedShell(t, observer, fmt.Sprintf(`test "$(cat %q)" = valid && test "$(wc -l < %q)" = 1 && rm %q %q %q`, prefix+".sessions", prefix+".sessions", prefix+".ready", prefix+".release", prefix+".sessions"))
		installedShell(t, observer, fmt.Sprintf("rm %q", prefix+".inventory"))
	})
}

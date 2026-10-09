package microsandbox

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// startAgentRun opens script as an admitted coding run (agent, registered run
// binding), as startNativeHost admits the coding host, and starts it.
func startAgentRun(t *testing.T, ctx context.Context, runtime *Runtime, id, script string) (*lockedBuffer, *lockedBuffer) {
	t.Helper()
	ws, err := runtime.runningWorkspace(id)
	require.NoError(t, err)
	registry := runtime.MachinedRegistry()
	link, err := registry.Current(id)
	require.NoError(t, err)
	actor := make([]byte, 16)
	_, err = rand.Read(actor)
	require.NoError(t, err)
	actor[0] |= 1
	run := uuid.NewString()
	token := []byte(strings.ReplaceAll(uuid.NewString(), "-", ""))
	tokenPath, err := runtime.PutSessionToken(ctx, id, run, token, "")
	require.NoError(t, err)
	binding, err := json.Marshal(map[string]any{
		"login": "agent", "uid": 19999, "session": run,
		"token_sha256": workspaceapi.SessionCredentialIdentity(token),
		"environment":  map[string]string{"SMITHERS_TOKEN_FILE": tokenPath, "SMITHERS_URL": "http://127.0.0.1:9"},
	})
	require.NoError(t, err)
	_, err = runtime.guest(ctx, ws.Machine, binding, "put-session-binding", "agent", "19999")
	require.NoError(t, err)
	coding := machined.NewSessions(link.Connection, id, registry.Sessions(id)).WithActor(actor, run)
	e, err := coding.OpenExec(ctx, machined.SessionUser{Login: "agent", UID: 19999}, []string{"/bin/sh", "-c", script})
	require.NoError(t, err)
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = e.Kill(cleanup)
	})
	var stdout, stderr lockedBuffer
	go func() { _, _ = io.Copy(&stdout, e.Stdout()) }()
	go func() { _, _ = io.Copy(&stderr, e.Stderr()) }()
	require.NoError(t, coding.RegisterRun(ctx, run, e.ID()))
	_, err = e.Write([]byte("start\n"))
	require.NoError(t, err)
	require.NoError(t, e.CloseWrite())
	return &stdout, &stderr
}

// An agent's jj operation inside its coding run must stay readable by the
// machine daemon, which runs as another UID in the team group. Run 9's wiki
// run wrote its op head 0600; the daemon then failed every repository load,
// exited on the next redial and could never restart (#3385).
func TestRealMicroVMAgentJJWriteKeepsDaemonServing(t *testing.T) {
	runtime := realRuntime(t, t.TempDir())
	if runtime.config.Bundle == nil {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("SMITHERS_CHECK_BUNDLE is required: agent runs reach only the bundle's daemon")
		}
		t.Skip("SMITHERS_CHECK_BUNDLE is not set: agent runs reach only the bundle's daemon")
	}
	id := uuid.NewString()
	ctx, cancel := context.WithTimeout(operation("agent-jj"), 5*time.Minute)
	defer cancel()
	_, err := preparedRuntime{runtime}.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
	require.NoError(t, err)
	defer func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete-agent-jj"), id)) }()
	ws, err := runtime.runningWorkspace(id)
	require.NoError(t, err)
	require.NoError(t, runtime.EnsureMachined(ctx, id))

	// The coding run's jj call inside a confinement user namespace, as the
	// guarded spawner runs it once a toolchain layer supplies bubblewrap: there
	// root and the team group read as the overflow IDs.
	stdout, stderr := startAgentRun(t, ctx, runtime, id, `read -r _
/usr/bin/python3 -I -S -c '
import os
uid, gid = os.getuid(), os.getgid()
os.unshare(os.CLONE_NEWUSER)
open("/proc/self/setgroups", "w").write("deny")
open("/proc/self/uid_map", "w").write("%d %d 1" % (uid, uid))
open("/proc/self/gid_map", "w").write("%d %d 1" % (gid, gid))
root = os.stat("/workspace")
print("confined /workspace %d:%d" % (root.st_uid, root.st_gid), flush=True)
os.execv("/usr/local/bin/jj", ["jj", "-R", "/workspace", "--no-pager", "--color=never", "new", "-m", "B"])
' 2>&1; echo "jj=$?"
echo done=1`)
	require.Eventually(t, func() bool { return strings.Contains(stdout.String(), "done=1") }, 90*time.Second, 100*time.Millisecond,
		"stdout:\n%s\nstderr:\n%s", stdout.String(), stderr.String())
	t.Logf("agent run:\n%s", stdout.String())
	require.Contains(t, stdout.String(), "jj=0")

	guest := func(script string) string {
		out, _ := runtime.cli.run(context.Background(), nil, "exec", ws.Machine, "--", "timeout", "20", "/bin/sh", "-c", script)
		return string(out)
	}
	unreadable := guest(`find /workspace/.jj /workspace/.git -xdev -type f ! -perm -g=r -printf '%m %u:%g %p\n' 2>/dev/null`)
	// The daemon must survive a redial: the host closes the link after an
	// unconfirmed cancel, then dials again and pushes the roster.
	link, err := runtime.MachinedRegistry().Current(id)
	require.NoError(t, err)
	_ = link.Close()
	var redial error
	deadline := time.Now().Add(60 * time.Second)
	for {
		call, stop := context.WithTimeout(ctx, 20*time.Second)
		redial = runtime.EnsureMachined(call, id)
		stop()
		if redial == nil || time.Now().After(deadline) {
			break
		}
		time.Sleep(time.Second)
	}
	if redial == nil {
		call, stop := context.WithTimeout(ctx, 3*time.Second)
		redial = runtime.MachinedRegistry().SetRoster(call, id, nil)
		stop()
	}
	t.Logf("daemon log:\n%s", guest(`tail -c 4096 /var/lib/smithers-machined/daemon.log 2>&1`))
	require.Empty(t, unreadable, "agent jj files the daemon cannot read")
	require.NoError(t, redial, "daemon after redial")

	// A daemon that dies leaves its exit status in daemon.log, the broker
	// restarts it, and the host logs the broker's record.
	killed := guest(`/usr/bin/python3 -I -S -c '
import os, signal
for pid in os.listdir("/proc"):
    try: argv = open("/proc/%s/cmdline" % pid, "rb").read().split(b"\0")
    except (OSError, ValueError): continue
    if argv[0].endswith(b"smithers-machined") and argv[1:2] == [b"daemon"]:
        os.kill(int(pid), signal.SIGKILL)
        print("killed", pid)
'`)
	require.Contains(t, killed, "killed")
	require.Eventually(t, func() bool {
		return strings.Contains(guest(`cat /var/lib/smithers-machined/daemon.log`), `"signal":9`)
	}, 10*time.Second, 200*time.Millisecond, "the broker records the exit")
	var logs lockedBuffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	runtime.logDaemonReport(ws)
	runtime.logDaemonReport(ws)
	slog.SetDefault(previous)
	require.Equal(t, 1, strings.Count(logs.String(), "machine daemon report"), logs.String())
	require.Contains(t, logs.String(), `\"signal\":9`)
	// The host must still notice: it closes the link and redials.
	if link, err := runtime.MachinedRegistry().Current(id); err == nil {
		_ = link.Close()
	}
	require.Eventually(t, func() bool {
		call, stop := context.WithTimeout(ctx, 10*time.Second)
		defer stop()
		return runtime.EnsureMachined(call, id) == nil
	}, 60*time.Second, time.Second, "the broker restarts a daemon that died")
}

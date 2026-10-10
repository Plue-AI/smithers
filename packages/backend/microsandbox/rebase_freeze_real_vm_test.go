package microsandbox

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// rebaseTargetKey carries the target a rebase admitted, as compose's
// machineRebaseExport does: only that call may export a non-head commit.
type rebaseTargetKey struct{}

// T-STK-08 S2 on a real guest: an awake branch rebases through the installed
// daemon's rebase(onto) under the root broker's cgroup-v2 freeze. A member
// writer in a broker session stops while the kernel reports the session
// parent frozen and resumes after thaw; the freeze lasts under 2 s; the daemon
// does the jj work as uid 19998; nothing reaches the broker except the
// daemon's private socketpair. Linux lane hosts cannot run this: it needs
// SMITHERS_CHECK_BUNDLE and msb on an Apple Silicon Mac.
func TestRealMicroVMRebaseFreezesSessionWriters(t *testing.T) {
	runtime := realRuntime(t, t.TempDir())
	if runtime.config.Bundle == nil {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("SMITHERS_CHECK_BUNDLE is required: only the bundle's broker freezes sessions")
		}
		t.Skip("SMITHERS_CHECK_BUNDLE is not set: only the bundle's broker freezes sessions")
	}
	host := machineHost(t, runtime)
	git := func(stdin string, args ...string) string {
		t.Helper()
		cmd := hostexec.Git(t.Context(), append([]string{"-C", host.path, "-c", "user.name=Smithers", "-c", "user.email=smithers@example.invalid"}, args...)...)
		cmd.Stdin = strings.NewReader(stdin)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "git %v: %s", args, out)
		return strings.TrimSpace(string(out))
	}
	// Bound before the link exists: each link copies the registry's exporter.
	resolve := func(context.Context, string) (string, error) { return host.path, nil }
	runtime.MachinedRegistry().BindObjectExporter(func(ctx context.Context, branch, head string, stream uint32) (io.ReadCloser, error) {
		if target, ok := ctx.Value(rebaseTargetKey{}).(string); ok && target == head {
			return machined.GitRebaseBundleExporter(resolve, target)(ctx, branch, head, stream)
		}
		return machined.GitBundleExporter(resolve)(ctx, branch, head, stream)
	})

	id := uuid.NewString()
	ctx, cancel := context.WithTimeout(operation("rebase-freeze"), 8*time.Minute)
	defer cancel()
	_, err := preparedRuntime{runtime}.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
	require.NoError(t, err)
	defer func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete-rebase-freeze"), id)) }()
	ws, err := runtime.runningWorkspace(id)
	require.NoError(t, err)
	require.NoError(t, runtime.EnsureMachined(ctx, id))
	registry := runtime.MachinedRegistry()
	link, err := registry.Current(id)
	require.NoError(t, err)
	require.NoError(t, link.RequireReady(id))
	guest := func(timeout time.Duration, args ...string) string {
		t.Helper()
		call, stop := context.WithTimeout(ctx, timeout+30*time.Second)
		defer stop()
		argv := append([]string{"exec", ws.Machine, "--", "timeout", strconv.Itoa(int(timeout.Seconds()))}, args...)
		out, err := runtime.cli.run(call, nil, argv...)
		require.NoError(t, err, "guest %v: %s", args, out)
		return string(out)
	}
	// peek never fails the test: it runs inside Eventually's goroutine.
	peek := func(args ...string) string {
		call, stop := context.WithTimeout(ctx, 30*time.Second)
		defer stop()
		out, _ := runtime.cli.run(call, nil, append([]string{"exec", ws.Machine, "--", "timeout", "20"}, args...)...)
		return string(out)
	}

	// main moved on the host: one commit on the seed adds upstream.txt.
	blob := git("upstream\n", "hash-object", "-w", "--stdin")
	tree := git("100644 blob "+blob+"\tupstream.txt\n", "mktree")
	onto := git("", "commit-tree", tree, "-p", host.seed, "-m", "main moved")

	// A member writer in a broker session cgroup: an admitted agent run that
	// prints the guest's CLOCK_MONOTONIC every 5 ms.
	writer := startAgentRun(t, ctx, runtime, id, `read -r _
exec /usr/bin/python3 -I -S -u -c 'import time
print("writer=started", flush=True)
end = time.monotonic() + 420
while time.monotonic() < end:
    print("tick", time.monotonic_ns(), flush=True)
    time.sleep(0.005)'`)
	require.Eventually(t, func() bool { return len(writerTicks(writer.stdout.String())) >= 20 },
		60*time.Second, 50*time.Millisecond, "writer never ran: %s %s", writer.stdout.String(), writer.stderr.String())

	// A root observer outside the session subtree records every interval in
	// which the kernel reports the session parent frozen, on the same clock.
	observed := make(chan string, 1)
	go func() {
		call, stop := context.WithTimeout(context.Background(), 5*time.Minute)
		defer stop()
		out, err := runtime.cli.run(call, nil, "exec", ws.Machine, "--", "timeout", "280", "/usr/bin/python3", "-I", "-S", "-c", freezeObserver)
		if err != nil {
			out = append(out, []byte("\nobserver: "+err.Error())...)
		}
		observed <- string(out)
	}()
	require.Eventually(t, func() bool {
		return strings.Contains(peek("/bin/sh", "-c", "test -e /run/smithers-rebase-observer.ready && echo ready"), "ready")
	}, 60*time.Second, 200*time.Millisecond, "observer never started")

	// A direct connection is refused: a member cannot open the daemon's local
	// socket, the agent outside a session gets no reply to a broker freeze
	// packet, and the daemon's descriptors (its broker socketpair end) are
	// unreachable. The daemon runs without root.
	var direct struct {
		Member              int      `json:"member"`
		AgentOutsideSession int      `json:"agent_outside_session"`
		AgentDaemonFDs      int      `json:"agent_daemon_fds"`
		DaemonUID           []string `json:"daemon_uid"`
		DaemonGID           []string `json:"daemon_gid"`
	}
	report := guest(60*time.Second, "/usr/bin/python3", "-I", "-S", "-c", directConnections)
	require.NoError(t, json.Unmarshal([]byte(lastLine(report)), &direct), report)
	require.Equal(t, 13, direct.Member, report)
	require.Equal(t, 0, direct.AgentOutsideSession, report)
	require.Equal(t, 13, direct.AgentDaemonFDs, report)
	require.Equal(t, []string{"19998", "19998", "19998", "19998"}, direct.DaemonUID, report)
	require.Equal(t, []string{"19998", "19998", "19998", "19998"}, direct.DaemonGID, report)

	actor := []byte("rebase-freeze-qualification")
	// A target the guest does not have refuses before any freeze.
	_, err = registry.Rebase(ctx, id, actor, strings.Repeat("ab", 20))
	var refusal *machined.SessionError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, "not_found", refusal.Code)

	call := context.WithValue(ctx, rebaseTargetKey{}, onto)
	result, err := registry.RebaseWithObjects(call, id, actor, onto, "", func(rewrite func() error) error { return rewrite() })
	require.NoError(t, err)
	head, err := hex.DecodeString(result.Head)
	require.NoError(t, err)
	require.Len(t, head, 20)
	require.Empty(t, result.Paths)

	// Let the writer run after thaw, then stop the observer.
	time.Sleep(500 * time.Millisecond)
	guest(20*time.Second, "/bin/sh", "-c", "touch /run/smithers-rebase-observer.stop")
	var observation struct {
		Intervals [][3]*int64 `json:"intervals"`
		Polls     int         `json:"polls"`
		Freeze    string      `json:"freeze"`
	}
	var out string
	select {
	case out = <-observed:
	case <-time.After(2 * time.Minute):
		t.Fatal("observer did not stop")
	}
	require.NoError(t, json.Unmarshal([]byte(lastLine(out)), &observation), out)
	t.Logf("freeze observation: %s", lastLine(out))
	require.Greater(t, observation.Polls, 100)
	require.Equal(t, "0", observation.Freeze, "the session parent stays thawed")
	// Exactly one freeze: the refused target and the direct connections froze
	// nothing; the rebase froze once and thawed.
	require.Len(t, observation.Intervals, 1, out)
	interval := observation.Intervals[0]
	require.NotNil(t, interval[0])
	require.NotNil(t, interval[1])
	require.NotNil(t, interval[2], "the rebase left the sessions frozen")
	start, lastFrozen, thawed := *interval[0], *interval[1], *interval[2]
	require.Less(t, time.Duration(thawed-start), 2*time.Second, "freeze and rewrite hold (C-PERF-06)")

	ticks := writerTicks(writer.stdout.String())
	var before, during, after int
	for _, tick := range ticks {
		switch {
		case tick < start:
			before++
		case tick <= lastFrozen:
			during++
		case tick >= thawed:
			after++
		}
	}
	require.Positive(t, before)
	require.Zero(t, during, "a member writer ran while the kernel reported its sessions frozen")
	require.Positive(t, after, "the writer did not resume after thaw")
	select {
	case <-writer.ended:
		t.Fatalf("the writer exited: %v\n%s", writer.exit, writer.stderr.String())
	default:
	}

	// The rebased working copy holds main's file, read through the daemon.
	file, err := registry.ReadFile(ctx, id, "upstream.txt", "")
	require.NoError(t, err)
	require.Equal(t, []byte("upstream\n"), file.Content)

	// The daemon's own lock-hold receipt for each rebase job stays under 2 s.
	require.Eventually(t, func() bool {
		return len(rebaseHolds(peek("/bin/cat", "/var/lib/smithers-machined/mutation-holds.jsonl"))) > 0
	}, 10*time.Second, 200*time.Millisecond)
	for _, hold := range rebaseHolds(guest(20*time.Second, "/bin/cat", "/var/lib/smithers-machined/mutation-holds.jsonl")) {
		require.Less(t, time.Duration(hold), 2*time.Second)
	}
}

// writerTicks parses complete lines only: the last one may still be arriving.
func writerTicks(stdout string) []int64 {
	var ticks []int64
	lines := strings.Split(stdout, "\n")
	for _, line := range lines[:len(lines)-1] {
		if value, ok := strings.CutPrefix(strings.TrimSpace(line), "tick "); ok {
			if tick, err := strconv.ParseInt(value, 10, 64); err == nil {
				ticks = append(ticks, tick)
			}
		}
	}
	return ticks
}

func rebaseHolds(log string) []int64 {
	var holds []int64
	for _, line := range strings.Split(strings.TrimSpace(log), "\n") {
		var record struct {
			Event     string `json:"event"`
			Operation string `json:"operation"`
			HoldNS    int64  `json:"hold_ns"`
		}
		if line == "" || json.Unmarshal([]byte(line), &record) != nil {
			continue
		}
		if record.Event == "mutation_hold" && record.Operation == "rebase" {
			holds = append(holds, record.HoldNS)
		}
	}
	return holds
}

func lastLine(out string) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	return lines[len(lines)-1]
}

// freezeObserver runs as guest root, outside /sys/fs/cgroup/smithers/sessions.
// Each interval is [first frozen poll, last frozen poll, first thawed poll].
const freezeObserver = `import json, os, time
events = "/sys/fs/cgroup/smithers/sessions/cgroup.events"
stop = "/run/smithers-rebase-observer.stop"
open("/run/smithers-rebase-observer.ready", "w").close()
intervals, start, seen, polls = [], None, None, 0
deadline = time.monotonic() + 270
while time.monotonic() < deadline and not os.path.exists(stop):
    now = time.monotonic_ns()
    with open(events) as f:
        frozen = "frozen 1" in f.read().splitlines()
    polls += 1
    if frozen:
        if start is None:
            start = now
        seen = now
    elif start is not None:
        intervals.append([start, seen, now])
        start = None
    time.sleep(0.0002)
if start is not None:
    intervals.append([start, seen, None])
with open("/sys/fs/cgroup/smithers/sessions/cgroup.freeze") as f:
    freeze = f.read().strip()
print(json.dumps({"intervals": intervals, "polls": polls, "freeze": freeze}))
`

// directConnections runs as guest root and drops to each identity in a child.
// The packet is a well-formed broker freeze request: id 1, op 1, 1000 ms.
const directConnections = `import json, os, pwd, socket
FREEZE = bytes.fromhex("00000001" "01" "00000005" "01" "000003e8")
def as_user(uid, gid, groups, action):
    pid = os.fork()
    if pid == 0:
        code = 99
        try:
            os.setgroups(groups)
            os.setresgid(gid, gid, gid)
            os.setresuid(uid, uid, uid)
            code = action()
        finally:
            os._exit(code)
    return os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
def connect():
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect("/run/smithers/machined.sock")
    except PermissionError:
        return 13
    s.settimeout(5)
    try:
        s.sendall(FREEZE)
        return 0 if s.recv(65536) == b"" else 1
    except (ConnectionResetError, BrokenPipeError):
        return 0
    except socket.timeout:
        return 2
daemon = None
for pid in os.listdir("/proc"):
    if not pid.isdigit():
        continue
    try:
        argv = open("/proc/%s/cmdline" % pid, "rb").read().split(b"\0")
    except OSError:
        continue
    if argv[0].endswith(b"smithers-machined") and argv[1:2] == [b"daemon"]:
        daemon = pid
def descriptors():
    try:
        os.listdir("/proc/%s/fd" % daemon)
    except PermissionError:
        return 13
    return 0
try:
    agent = pwd.getpwuid(19999)
    agent_gid, agent_groups = agent.pw_gid, os.getgrouplist(agent.pw_name, agent.pw_gid)
except KeyError:
    agent_gid, agent_groups = 19999, [19999]
status = {}
for line in open("/proc/%s/status" % daemon):
    key, _, value = line.partition(":")
    if key in ("Uid", "Gid"):
        status[key] = value.split()
print(json.dumps({
    "member": as_user(20000, 20000, [], connect),
    "agent_outside_session": as_user(19999, agent_gid, agent_groups, connect),
    "agent_daemon_fds": as_user(19999, agent_gid, agent_groups, descriptors),
    "daemon_uid": status["Uid"],
    "daemon_gid": status["Gid"],
}))
`

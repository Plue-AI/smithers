package microsandbox

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// A coding run's first edit goes through the installed local client, then its
// quick checks stream output. Neither may stop the machine daemon: the backend
// pushes the roster every second with a 3 s budget (compose/machine_roster.go)
// and fails the run once those pushes stop answering.
func TestRealMicroVMAgentWriteKeepsDaemonAnswering(t *testing.T) {
	runtime := realRuntime(t, t.TempDir())
	if runtime.config.Bundle == nil {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("SMITHERS_CHECK_BUNDLE is required: agent writes reach only the bundle's daemon")
		}
		t.Skip("SMITHERS_CHECK_BUNDLE is not set: agent writes reach only the bundle's daemon")
	}
	id := uuid.NewString()
	ctx, cancel := context.WithTimeout(operation("agent-write"), 5*time.Minute)
	defer cancel()
	_, err := preparedRuntime{runtime}.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
	require.NoError(t, err)
	defer func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete-agent-write"), id)) }()
	ws, err := runtime.runningWorkspace(id)
	require.NoError(t, err)
	require.NoError(t, runtime.EnsureMachined(ctx, id))
	registry := runtime.MachinedRegistry()
	link, err := registry.Current(id)
	require.NoError(t, err)
	require.NoError(t, link.RequireReady(id))

	// The backend's roster reconciliation: one push per second, 3 s each.
	type push struct {
		latency time.Duration
		err     error
	}
	var pushesMu sync.Mutex
	var pushes []push
	rosterCtx, stopRoster := context.WithCancel(ctx)
	rosterDone := make(chan struct{})
	go func() {
		defer close(rosterDone)
		for rosterCtx.Err() == nil {
			call, stop := context.WithTimeout(rosterCtx, 3*time.Second)
			start := time.Now()
			err := registry.SetRoster(call, id, nil)
			stop()
			pushesMu.Lock()
			pushes = append(pushes, push{time.Since(start), err})
			pushesMu.Unlock()
			select {
			case <-rosterCtx.Done():
			case <-time.After(time.Second):
			}
		}
	}()

	// An admitted coding run: its first edit through the local client, then
	// quick checks that stream output, as the coding flow's T1 did.
	run := startAgentRun(t, ctx, runtime, id, `read -r _
printf 'first edit\n' | timeout 40 /opt/smithers/bin/smithers-machined client write-file EDIT.md --base absent
echo "write=$?"
i=0
while [ $i -lt 200 ]; do echo "check $i"; ls -la /workspace >/dev/null; sleep 0.02; i=$((i+1)); done
echo checks=done`)

	// Its end proves the write's reply and the checks' output came back
	// through the daemon: Exec.Wait returns at the exit the broker sends after
	// both outputs end (#3761).
	err = run.wait(90 * time.Second)
	// Two more pushes after the run, so a wedge left behind is also caught.
	time.Sleep(2500 * time.Millisecond)
	stopRoster()
	<-rosterDone

	stalls, _ := runtime.cli.run(context.Background(), nil, "exec", ws.Machine, "--", "timeout", "20",
		"cat", "/var/lib/smithers-machined/executor-stalls.jsonl")
	t.Logf("executor stalls:\n%s", stalls)
	pushesMu.Lock()
	defer pushesMu.Unlock()
	var failed []push
	var slowest time.Duration
	for _, p := range pushes {
		slowest = max(slowest, p.latency)
		if p.err != nil {
			failed = append(failed, p)
		}
	}
	t.Logf("roster pushes: %d, failed: %d, slowest: %s", len(pushes), len(failed), slowest)
	if len(failed) > 0 || err != nil {
		view, _ := runtime.cli.run(context.Background(), nil, "exec", ws.Machine, "--", "timeout", "20",
			"/usr/bin/python3", "-I", "-S", "-c", daemonThreadView)
		t.Logf("daemon threads:\n%s", view)
	}
	require.NoError(t, err, "agent run did not finish; stdout:\n%s\nstderr:\n%s", run.stdout.String(), run.stderr.String())
	require.Contains(t, run.stdout.String(), "write=0", "stderr:\n%s", run.stderr.String())
	require.Contains(t, run.stdout.String(), "checks=done")
	require.Empty(t, failed, "roster pushes failed during or after the agent run")
	require.Less(t, slowest, 3*time.Second)
	require.GreaterOrEqual(t, len(pushes), 3)
}

type lockedBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

// daemonThreadView prints the machine daemon's threads as the kernel sees
// them, and the kernel stack of its mutation executor ("machined-lock").
const daemonThreadView = `import os
for pid in os.listdir('/proc'):
    if not pid.isdigit(): continue
    try: argv=open('/proc/%s/cmdline'%pid,'rb').read().split(b'\0')
    except OSError: continue
    if len(argv)<2 or not argv[0].endswith(b'smithers-machined') or argv[1]!=b'daemon': continue
    tasks=sorted(os.listdir('/proc/%s/task'%pid),key=int)
    print('daemon pid',pid,'threads',len(tasks))
    for tid in tasks:
        base='/proc/%s/task/%s/'%(pid,tid)
        read=lambda name: open(base+name).read().strip()
        try: print(tid,read('comm'),read('wchan'),read('syscall').split(' ')[0])
        except OSError as e: print(tid,e)
        if read('comm')=='machined-lock':
            try: print(read('stack'))
            except OSError as e: print('stack',e)
`

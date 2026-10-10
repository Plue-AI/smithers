package microsandbox

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func stormRuntime(t *testing.T, deadRelay bool) (*Runtime, *workspace, string) {
	t.Helper()
	bundle, files := approvedBundleFixture(t)
	for _, name := range []string{machinedBundlePath, sftpBundlePath} {
		approveBundleFile(t, bundle, name, files["bin/linux-arm64/smthrs"], 0755)
	}
	directory := t.TempDir()
	binary, log := filepath.Join(directory, "msb"), filepath.Join(directory, "starts")
	fail := "sleep 0.2; exit 1"
	if deadRelay {
		fail = "echo current; exit 0"
	}
	script := fmt.Sprintf(`#!/bin/sh
printf '%%s\n' "$*" >> %s
case "$*" in
 *managed-artifact-check*) %s;;
 *machined-check*) echo current;;
 *machined-start*) cat >/dev/null; echo current;;
 *relay*) exit 1;;
 *) exit 1;;
esac
`, shellQuote(log), fail)
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	ws := newWorkspace(metadata{ID: "branch", Machine: "machine", State: "running"}, "")
	r := &Runtime{config: Config{Bundle: pinned(t, bundle)}, cli: &cli{binary: binary, home: directory}, workspaces: map[string]*workspace{"branch": ws}}
	r.BindMachinedHost(func(context.Context, string) (string, error) { return strings.Repeat("a", 40), nil })
	r.BindMachinedItem(func(context.Context, string) (machined.ItemBinding, error) { return machined.ItemBinding{}, nil })
	stop, err := r.machined.ConsumeEvents(t.Context(), func(context.Context, *machined.Link, string, machined.Event) (machined.Acknowledgement, error) {
		return machined.Acknowledgement{}, nil
	})
	require.NoError(t, err)
	t.Cleanup(stop)
	return r, ws, log
}

func TestStormEnsureSingleFlightAndFailureBackoff(t *testing.T) {
	r, ws, log := stormRuntime(t, false)
	batch := func() {
		var group sync.WaitGroup
		errors := make(chan error, 32)
		for range 32 {
			group.Add(1)
			go func() { defer group.Done(); errors <- r.EnsureMachined(t.Context(), "branch") }()
		}
		group.Wait()
		close(errors)
		for err := range errors {
			require.Error(t, err)
		}
	}
	batch()
	body, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Equal(t, 1, strings.Count(string(body), "managed-artifact-check"))
	batch()
	same, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Equal(t, string(body), string(same))
	ws.daemonAttemptMu.Lock()
	retryAt := ws.daemonRetryAt
	require.Equal(t, time.Second, ws.daemonBackoff)
	ws.daemonAttemptMu.Unlock()
	time.Sleep(time.Until(retryAt) + 10*time.Millisecond)
	batch()
	body, err = os.ReadFile(log)
	require.NoError(t, err)
	require.Equal(t, 2, strings.Count(string(body), "managed-artifact-check"))
	ws.daemonAttemptMu.Lock()
	require.Equal(t, 2*time.Second, ws.daemonBackoff)
	ws.daemonAttemptMu.Unlock()
	for previous, want := range map[time.Duration]time.Duration{0: time.Second, time.Second: 2 * time.Second, 16 * time.Second: 30 * time.Second, 30 * time.Second: 30 * time.Second} {
		require.Equal(t, want, nextDaemonBackoff(previous))
	}
}

func TestStormDialStartBound(t *testing.T) {
	r, ws, log := stormRuntime(t, true)
	started := time.Now()
	require.Error(t, r.EnsureMachined(t.Context(), "branch"))
	require.GreaterOrEqual(t, time.Since(started), 10*time.Second)
	body, err := os.ReadFile(log)
	require.NoError(t, err)
	// t=0,.25,.75,1.75,3.75,5.75,7.75,9.75: at most eight
	// relay starts in ten seconds, plus the three startup helpers.
	count := strings.Count(string(body), "relay 970")
	require.GreaterOrEqual(t, count, 2)
	require.LessOrEqual(t, count, 8)
	ws.daemonAttemptMu.Lock()
	require.False(t, ws.daemonReconnect)
	ws.daemonAttemptMu.Unlock()
	// A failed dial reads the daemon's report in the background. It runs msb
	// in this test's directory, so wait for it: a report still running when
	// the test returns writes into a directory being removed, and its fork can
	// hold the next test's new msb open (text file busy).
	require.Eventually(t, func() bool {
		body, err := os.ReadFile(log)
		return err == nil && strings.Contains(string(body), "daemon-log")
	}, 15*time.Second, 10*time.Millisecond)
}

func TestStormTermBeforeKillGrace(t *testing.T) {
	for _, ignores := range []bool{false, true} {
		t.Run(fmt.Sprint(ignores), func(t *testing.T) {
			directory := t.TempDir()
			binary, log := filepath.Join(directory, "msb"), filepath.Join(directory, "signals")
			action := "exit 0"
			if ignores {
				action = ":"
			}
			require.NoError(t, os.WriteFile(binary, []byte(fmt.Sprintf("#!/bin/sh\ntrap 'echo TERM >> %s; %s' TERM\necho ready >> %s\nwhile :; do sleep 0.05; done\n", shellQuote(log), action, shellQuote(log))), 0700))
			c := &cli{binary: binary, home: directory}
			cmd := c.command("exec")
			require.NoError(t, cmd.Start())
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			require.Eventually(t, func() bool { body, _ := os.ReadFile(log); return strings.Contains(string(body), "ready") }, time.Second, 10*time.Millisecond)
			start := time.Now()
			killGroup(cmd)
			err := <-done
			body, readErr := os.ReadFile(log)
			require.NoError(t, readErr)
			require.Contains(t, string(body), "TERM")
			if ignores {
				require.Error(t, err)
				require.GreaterOrEqual(t, time.Since(start), 2*time.Second)
				require.Equal(t, syscall.SIGKILL, cmd.ProcessState.Sys().(syscall.WaitStatus).Signal())
			} else {
				require.NoError(t, err)
				require.Less(t, time.Since(start), time.Second)
			}
		})
	}
}

func TestStormWorkspaceReconnectOwnership(t *testing.T) {
	r, ws, log := stormRuntime(t, false)
	link, _ := environmentLink(t, &r.machined)
	for range 32 {
		r.startDaemonReconnect("branch", ws, link)
	}
	t.Cleanup(func() { r.mu.Lock(); ws.State = "stopped"; r.mu.Unlock() })
	stack := make([]byte, 1<<20)
	require.Eventually(t, func() bool {
		n := runtime.Stack(stack, true)
		return strings.Count(string(stack[:n]), ".startDaemonReconnect.func1(") == 1
	}, time.Second, 10*time.Millisecond)
	require.NoError(t, link.Close())
	require.Eventually(t, func() bool {
		body, _ := os.ReadFile(log)
		return strings.Count(string(body), "managed-artifact-check") >= 3
	}, 8*time.Second, 20*time.Millisecond)
	ws.daemonAttemptMu.Lock()
	require.True(t, ws.daemonReconnect)
	ws.daemonAttemptMu.Unlock()
	body, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Equal(t, 3, strings.Count(string(body), "managed-artifact-check"))
	r.mu.Lock()
	ws.State = "stopped"
	r.mu.Unlock()
	require.Eventually(t, func() bool { ws.daemonAttemptMu.Lock(); defer ws.daemonAttemptMu.Unlock(); return !ws.daemonReconnect }, 5*time.Second, 20*time.Millisecond)
}

func TestStormCancelledWaiterDoesNotCancelMachineAttempt(t *testing.T) {
	r, ws, log := stormRuntime(t, false)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- r.EnsureMachined(ctx, "branch") }()
	require.Eventually(t, func() bool { _, err := os.Stat(log); return err == nil }, time.Second, 5*time.Millisecond)
	cancel()
	require.ErrorIs(t, <-done, context.Canceled)
	require.Error(t, r.EnsureMachined(t.Context(), "branch"))
	body, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Equal(t, 1, strings.Count(string(body), "managed-artifact-check"))
	ws.daemonAttemptMu.Lock()
	require.Nil(t, ws.daemonAttempt)
	require.NotNil(t, ws.daemonFailure)
	ws.daemonAttemptMu.Unlock()
}

func TestStormRelayEOFCompletesWithoutSignal(t *testing.T) {
	directory := t.TempDir()
	binary, log := filepath.Join(directory, "msb"), filepath.Join(directory, "signals")
	// Model slow startup reconciliation followed by a relay reading EOF.
	// SIGTERM here would bypass the normal cleanup, as in msb 0.6.16.
	script := fmt.Sprintf("#!/bin/sh\ntrap 'echo TERM >> %s; exit 1' TERM\nsleep 0.2\ncat >/dev/null\necho cleared >> %s\n", shellQuote(log), shellQuote(log))
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	r := &Runtime{cli: &cli{binary: binary, home: directory}, workspaces: map[string]*workspace{"branch": newWorkspace(metadata{ID: "branch", Machine: "machine", State: "running"}, "")}}
	conn, err := r.DialWorkspacePort(t.Context(), "branch", workspaceapi.PortRequest{Port: 970})
	require.NoError(t, err)
	require.NoError(t, conn.Close())
	body, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Equal(t, "cleared\n", string(body))
}

package microsandbox

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// relayRuntime is a Runtime over a fake msb whose relay subcommand runs body
// (sh, with $last set to the guest port) and logs one line per relay process.
// Workspaces "branch" and "other" run on separate VMs.
func relayRuntime(t *testing.T, body string) (*Runtime, string) {
	t.Helper()
	directory := t.TempDir()
	binary, log := filepath.Join(directory, "msb"), filepath.Join(directory, "relays")
	writeRelayMSB(t, binary, log, body)
	r := &Runtime{cli: &cli{binary: binary, home: directory}, workspaces: map[string]*workspace{
		"branch": newWorkspace(metadata{ID: "branch", Machine: "machine", State: "running"}, ""),
		"other":  newWorkspace(metadata{ID: "other", Machine: "other-machine", State: "running"}, ""),
	}}
	return r, log
}

func writeRelayMSB(t *testing.T, binary, log, body string) {
	t.Helper()
	script := fmt.Sprintf("#!/bin/sh\nfor last; do :; done\ncase \"$*\" in\n *\" relay \"*) echo relay >> %s; %s;;\n *) exit 1;;\nesac\n", shellQuote(log), body)
	temporary := binary + ".tmp"
	require.NoError(t, os.WriteFile(temporary, []byte(script), 0700))
	require.NoError(t, os.Rename(temporary, binary))
}

func relayStarts(t *testing.T, log string) int {
	t.Helper()
	body, err := os.ReadFile(log)
	if errors.Is(err, fs.ErrNotExist) {
		return 0
	}
	require.NoError(t, err)
	return strings.Count(string(body), "relay\n")
}

// relayPump is the guest helper's relay without its privilege drop: stdin and
// stdout bridged to 127.0.0.1:argv[1].
const relayPump = `import socket, sys, threading
c = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
def up():
    while True:
        b = sys.stdin.buffer.raw.read(65536)
        if not b:
            break
        c.sendall(b)
    try:
        c.shutdown(socket.SHUT_WR)
    except OSError:
        pass
threading.Thread(target=up, daemon=True).start()
while True:
    b = c.recv(65536)
    if not b:
        break
    sys.stdout.buffer.raw.write(b)
`

func pumpBody(t *testing.T) string {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed")
	}
	return "exec " + shellQuote(python) + " -c " + shellQuote(relayPump) + ` "$last"`
}

// identityServer answers every request and counts the TCP connections it saw.
func identityServer(t *testing.T) (uint16, *atomic.Int32) {
	t.Helper()
	var opened atomic.Int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			opened.Add(1)
		}
	}
	server.Start()
	t.Cleanup(server.Close)
	return uint16(server.Listener.Addr().(*net.TCPAddr).Port), &opened
}

var relayIdentity = workspaceapi.ManagedHostIdentity{Protocol: "smithers.flow-runtime/v1", ArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40), OwnerGeneration: 1}

// relayProbeSpec probes like the flow host: one GET through the runtime's client.
func relayProbeSpec() workspaceapi.ManagedHostSpec {
	return workspaceapi.ManagedHostSpec{Expected: relayIdentity, Probe: workspaceapi.ManagedHostProbeFunc(func(ctx context.Context, connection workspaceapi.ManagedHostConnection) (workspaceapi.ManagedHostIdentity, error) {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, connection.Endpoint+"/runtime/v1/identity", nil)
		if err != nil {
			return workspaceapi.ManagedHostIdentity{}, err
		}
		response, err := connection.HTTPClient.Do(request)
		if err != nil {
			return workspaceapi.ManagedHostIdentity{}, err
		}
		defer response.Body.Close()
		if _, err := io.ReadAll(response.Body); err != nil {
			return workspaceapi.ManagedHostIdentity{}, err
		}
		return relayIdentity, nil
	})}
}

// Real install run 13 (2026-10-09): one VM's relays filled the 128 clients
// msb's agent relay admits, and every later exec failed "handshake: early
// eof". Dials past the per-VM cap wait for a relay to exit instead of
// spawning another.
func TestRelayDialsWaitAtTheMachineCap(t *testing.T) {
	r, log := relayRuntime(t, "cat >/dev/null")
	var held []net.Conn
	t.Cleanup(func() {
		for _, conn := range held {
			_ = conn.Close()
		}
	})
	dial := func(ctx context.Context, workspace string) (net.Conn, error) {
		return r.DialWorkspacePort(ctx, workspace, workspaceapi.PortRequest{Port: 970})
	}
	for range maxRelaysPerMachine {
		conn, err := dial(t.Context(), "branch")
		require.NoError(t, err)
		held = append(held, conn)
	}
	require.Equal(t, maxRelaysPerMachine, r.relaysInUse("machine"))
	short, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	_, err := dial(short, "branch")
	require.ErrorIs(t, err, context.DeadlineExceeded, "a dial past the cap waits, bounded by its context")
	// Another VM has its own agent relay and its own cap.
	other, err := dial(t.Context(), "other")
	require.NoError(t, err)
	held = append(held, other)
	waited := make(chan net.Conn, 1)
	go func() {
		conn, err := dial(t.Context(), "branch")
		if err != nil {
			t.Error(err)
		}
		waited <- conn
	}()
	select {
	case <-waited:
		t.Fatal("a dial past the cap did not wait")
	case <-time.After(150 * time.Millisecond):
	}
	require.NoError(t, held[0].Close())
	select {
	case conn := <-waited:
		require.NotNil(t, conn)
		held = append(held, conn)
	case <-time.After(5 * time.Second):
		t.Fatal("a waiting dial did not take the freed relay")
	}
	require.Eventually(t, func() bool { return relayStarts(t, log) == maxRelaysPerMachine+2 }, 5*time.Second, 10*time.Millisecond)
	require.Equal(t, maxRelaysPerMachine, r.relaysInUse("machine"))
}

func TestRelayWaitIsBounded(t *testing.T) {
	r, _ := relayRuntime(t, "cat >/dev/null")
	releases := make([]func(), 0, maxRelaysPerMachine)
	for range maxRelaysPerMachine {
		release, err := r.acquireRelay(t.Context(), "machine", time.Second)
		require.NoError(t, err)
		releases = append(releases, release)
	}
	started := time.Now()
	_, err := r.acquireRelay(t.Context(), "machine", 50*time.Millisecond)
	require.ErrorIs(t, err, ErrUnavailable)
	require.Less(t, time.Since(started), time.Second)
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = r.acquireRelay(cancelled, "machine", time.Second)
	require.ErrorIs(t, err, context.Canceled)
	releases[0]()
	releases[0]()
	require.Equal(t, maxRelaysPerMachine-1, r.relaysInUse("machine"), "a release frees exactly one slot")
	release, err := r.acquireRelay(t.Context(), "machine", 50*time.Millisecond)
	require.NoError(t, err)
	release()
	for _, release := range releases[1:] {
		release()
	}
	require.Zero(t, r.relaysInUse("machine"))
}

// Each probe used to build its own HTTP transport, so every flow host
// resolve opened a relay that then idled 90 s holding an agent client (run
// 13: about 880 relays alive against one VM). Probes now share one client.
func TestManagedHostProbesReuseOneRelay(t *testing.T) {
	port, opened := identityServer(t)
	r, log := relayRuntime(t, pumpBody(t))
	for range 20 {
		_, err := r.probeManagedHost(t.Context(), "branch", relayProbeSpec(), port)
		require.NoError(t, err)
	}
	require.Equal(t, 1, relayStarts(t, log), "sequential probes reuse one relay")
	require.EqualValues(t, 1, opened.Load())
	require.Same(t, r.httpClient("branch", port), r.httpClient("branch", port))
	require.NotSame(t, r.httpClient("branch", port), r.httpClient("other", port))
	// A stopped workspace drops its clients; a restart starts fresh.
	before := r.httpClient("branch", port)
	r.mu.Lock()
	r.detachProcessesLocked(r.workspaces["branch"])
	r.mu.Unlock()
	require.NotSame(t, before, r.httpClient("branch", port))
}

// Run 13 re-probed an unreachable host about twice a second, each probe a
// new relay. A failed probe now backs off exponentially, to a ceiling, and
// probes inside the window return the failure without dialing.
func TestManagedHostProbeBacksOffAfterAFailure(t *testing.T) {
	r, log := relayRuntime(t, "echo 'agent client error: handshake: early eof' >&2; exit 1")
	spec := relayProbeSpec()
	for range 10 {
		_, err := r.probeManagedHost(t.Context(), "branch", spec, 4000)
		require.ErrorContains(t, err, "probe managed host identity")
	}
	require.Equal(t, 1, relayStarts(t, log), "probes inside the backoff do not dial")
	host := r.relayHost("branch", 4000)
	expire := func() time.Duration {
		host.mu.Lock()
		defer host.mu.Unlock()
		backoff := host.backoff
		host.retryAt = time.Now()
		return backoff
	}
	require.Equal(t, nextProbeBackoff(0), expire())
	_, err := r.probeManagedHost(t.Context(), "branch", spec, 4000)
	require.Error(t, err)
	require.Equal(t, 2, relayStarts(t, log))
	require.Equal(t, nextProbeBackoff(nextProbeBackoff(0)), expire())
	// Concurrent failures after the window grow the backoff once, not per caller.
	var group sync.WaitGroup
	for range 16 {
		group.Go(func() { _, _ = r.probeManagedHost(t.Context(), "branch", spec, 4000) })
	}
	group.Wait()
	require.Equal(t, nextProbeBackoff(nextProbeBackoff(nextProbeBackoff(0))), expire())
	for previous, want := range map[time.Duration]time.Duration{0: 500 * time.Millisecond, 500 * time.Millisecond: time.Second, 16 * time.Second: 30 * time.Second, 30 * time.Second: 30 * time.Second} {
		require.Equal(t, want, nextProbeBackoff(previous))
	}
	// A caller's own cancellation is not the host's failure.
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = r.probeManagedHost(cancelled, "branch", spec, 4001)
	require.Error(t, err)
	fresh := r.relayHost("branch", 4001)
	fresh.mu.Lock()
	require.Zero(t, fresh.backoff)
	fresh.mu.Unlock()
	// A success clears the backoff.
	port, _ := identityServer(t)
	writeRelayMSB(t, r.cli.binary, log, pumpBody(t))
	healthy := r.relayHost("branch", port)
	healthy.mu.Lock()
	healthy.failure, healthy.backoff, healthy.retryAt = errors.New("earlier"), time.Second, time.Now()
	healthy.mu.Unlock()
	_, err = r.probeManagedHost(t.Context(), "branch", spec, port)
	require.NoError(t, err)
	healthy.mu.Lock()
	require.Zero(t, healthy.backoff)
	require.NoError(t, healthy.failure)
	healthy.mu.Unlock()
}

// msb refuses a relay past its client cap with "handshake: early eof" and
// exits. Its request fails at once and its slot is free, with no idle wait.
func TestRefusedRelayIsReapedPromptly(t *testing.T) {
	r, log := relayRuntime(t, "echo 'agent client error: handshake: early eof' >&2; exit 1")
	started := time.Now()
	_, err := r.httpClient("branch", 4000).Get("http://127.0.0.1:4000/runtime/v1/identity")
	require.Error(t, err)
	require.Eventually(t, func() bool { return r.relaysInUse("machine") == 0 }, time.Second, 5*time.Millisecond)
	require.Less(t, time.Since(started), 2*time.Second)
	require.Equal(t, 1, relayStarts(t, log))
}

// A relay that never answers is ended when its request's context ends: EOF
// first, then SIGTERM to its process group, and its slot is freed.
func TestStalledRelayIsKilledOnCancellation(t *testing.T) {
	signals := filepath.Join(t.TempDir(), "signals")
	r, _ := relayRuntime(t, fmt.Sprintf("trap 'echo TERM >> %s; exit 1' TERM; while :; do sleep 0.05; done", shellQuote(signals)))
	ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:4000/runtime/v1/identity", nil)
	require.NoError(t, err)
	_, err = r.httpClient("branch", 4000).Do(request)
	require.ErrorIs(t, err, context.DeadlineExceeded)
	require.Eventually(t, func() bool { return r.relaysInUse("machine") == 0 }, 8*time.Second, 20*time.Millisecond)
	body, err := os.ReadFile(signals)
	require.NoError(t, err)
	require.Contains(t, string(body), "TERM")
}

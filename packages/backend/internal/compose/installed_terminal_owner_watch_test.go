package compose

import (
	"context"
	"fmt"
	"net/http"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"
)

// Every assertion enters the install's HTTP/WebSocket doors and observes the
// approved guest shell. In particular, the watcher transport is not an echo PTY.
func testInstalledTerminalOwnerWatch(t *testing.T, h *rootLayerHarness, branch string, ben, alice http.CookieJar) {
	t.Helper()
	owner := installedMemberTerminal(t, h, branch, ben)
	code, tokenPath, err := owner.capture(`printf '%s' "$SMITHERS_TOKEN_FILE"`, "TRMSESSION", 30*time.Second)
	require.NoError(t, err)
	require.Equal(t, "0", code)
	session := path.Base(path.Dir(string(tokenPath)))
	require.Regexp(t, `^[a-f0-9-]{36}$`, session)
	r := &rehearsal{ctx: t.Context(), origin: h.origin, jar: alice}
	watcher, err := r.openTerminal(session)
	require.NoError(t, err)
	defer watcher.close()
	readDrops := func() int {
		code, body := h.request("GET", "/api/install/metrics", "", "")
		require.Equal(t, 200, code, string(body))
		m := regexp.MustCompile(`(?m)^smithers_terminal_input_dropped_total(?:\{[^\n]*\})?\s+(\d+)`).FindSubmatch(body)
		require.Len(t, m, 2)
		n, err := strconv.Atoi(string(m[1]))
		require.NoError(t, err)
		return n
	}
	testInstalledTerminalEchoSamples(t, owner)
	before := readDrops()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	installedShell(t, owner, `stty rows 24 cols 80`)
	require.NoError(t, watcher.conn.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":1,"rows":1,"owner":true}`)))
	require.NoError(t, watcher.conn.Write(ctx, websocket.MessageText, []byte(`{"type":"close","owner":true}`)))
	for i := 0; i < 1000; i++ {
		require.NoError(t, watcher.conn.Write(ctx, websocket.MessageBinary, []byte("touch /workspace/trm-watcher-created\n")))
	}
	require.Eventually(t, func() bool { return readDrops() >= before+1000 }, 5*time.Second, 10*time.Millisecond)
	installedShell(t, owner, `test ! -e /workspace/trm-watcher-created && test "$(stty size)" = '24 80' && test "$(id -u)" = 20001`)
	// Overflow the real ring. A fresh attachment must retain its tail and lose
	// its head, independently of any size reported by the manager.
	installedShell(t, owner, `printf 'TRM''REPLAYHEAD\n'; python3 -c 'import sys; sys.stdout.write("R" * 614400)'; printf '\nTRM''REPLAYTAIL\n'`)
	watcher.close()
	replay, err := r.openTerminal(session)
	require.NoError(t, err)
	defer replay.close()
	require.Eventually(t, func() bool {
		replay.mu.Lock()
		defer replay.mu.Unlock()
		return strings.Contains(replay.output.String(), "TRMREPLAYTAIL") && strings.HasSuffix(replay.output.String(), `{"type":"replay-complete"}`)
	}, 5*time.Second, 10*time.Millisecond)
	replay.mu.Lock()
	data := replay.output.String()
	replay.mu.Unlock()
	require.NotContains(t, data, "TRMREPLAYHEAD")
	require.LessOrEqual(t, len(strings.TrimSuffix(data, `{"type":"replay-complete"}`)), 512*1024)
	aliceOwner := installedMemberTerminal(t, h, branch, alice)
	installedShell(t, aliceOwner, `test "$(id -u)" = 20002 && test "$HOME" = /home/alice`)
	// Removing Alice must close both her watching attachment and her own PTY;
	// Ben's session must continue with the same identity.
	removedAt := time.Now()
	deadline := time.NewTimer(5 * time.Second)
	h.expect("DELETE", "/api/members/alice", "", 204)
	defer deadline.Stop()
	for _, term := range []*rehearsalTerminal{replay, aliceOwner} {
		select {
		case <-term.closed:
			require.LessOrEqual(t, time.Since(removedAt), 5*time.Second)
		case <-deadline.C:
			t.Fatal("member removal failed to revoke terminal within 5 seconds")
		}
	}
	installedShell(t, owner, `test "$(id -u)" = 20001 && test ! -e /workspace/trm-watcher-created`)
}

// Measure transport echo directly, outside rehearsalTerminal.run's 100 ms
// command polling. Ten warmups are excluded; all 100 sequential observations
// are retained in go test output. Reference-host msb exec -t baseline comparison
// is still required before treating the ticket's +50 ms limit as passing.
func testInstalledTerminalEchoSamples(t *testing.T, owner *rehearsalTerminal) {
	t.Helper()
	installedShell(t, owner, `stty echo`)
	samples := make([]int64, 0, 100)
	for i := 0; i < 110; i++ {
		marker := fmt.Sprintf("TRMECHO%06d", i)
		owner.mu.Lock()
		offset := owner.output.Len()
		owner.mu.Unlock()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		started := time.Now()
		err := owner.conn.Write(ctx, websocket.MessageBinary, []byte(marker))
		require.NoError(t, err)
		for {
			owner.mu.Lock()
			received := strings.Contains(owner.output.String()[offset:], marker)
			owner.mu.Unlock()
			if received {
				break
			}
			select {
			case <-owner.closed:
				t.Fatal("terminal closed during echo sample")
			case <-ctx.Done():
				t.Fatal("terminal echo sample timed out")
			case <-time.After(time.Millisecond):
			}
		}
		elapsed := time.Since(started).Nanoseconds()
		// Kill the unexecuted input line; timing never includes command execution.
		require.NoError(t, owner.conn.Write(ctx, websocket.MessageBinary, []byte{21}))
		cancel()
		if i >= 10 {
			samples = append(samples, elapsed)
		}
	}
	installedShell(t, owner, `test "$(id -u)" = 20001`)
	ordered := slices.Clone(samples)
	slices.Sort(ordered)
	t.Logf("terminal echo: transport=retained-websocket/open_session samples_ns=%v p95_ns=%d warmups=10 n=100 polling_resolution_ns=1000000 baseline_comparison=pending", samples, ordered[94])
}

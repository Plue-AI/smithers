package compose

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
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
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
)

// Every assertion enters the install's HTTP/WebSocket doors and observes the
// approved guest shell. In particular, the watcher transport is not an echo PTY.
func testInstalledTerminalOwnerWatch(t *testing.T, h *rootLayerHarness, branch string, ben, alice http.CookieJar, sshAddress, sshLogin string) {
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
	// Include a detached descendant, not just the foreground PTY. Record its
	// kernel cgroup before revocation so another member can inspect drainage.
	code, group, err := aliceOwner.capture(`nohup sleep 120 >/dev/null 2>&1 </dev/null & cat /proc/self/cgroup`, "TRMDRAIN", 30*time.Second)
	require.NoError(t, err)
	require.Equal(t, "0", code)
	cgroup := strings.TrimSpace(strings.TrimPrefix(string(group), "0::"))
	require.Regexp(t, `^/smithers/sessions/s[1-9][0-9]*$`, cgroup)
	// Keep a real gateway exec channel and another detached descendant open
	// under the same member; terminal-only cancellation is insufficient.
	var aliceID int64
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT id FROM users WHERE username='alice'`).Scan(&aliceID))
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	_, err = db.New(h.pool).CreateSSHKey(t.Context(), db.CreateSSHKeyParams{UserID: aliceID, Name: "native-revocation", PublicKey: string(gossh.MarshalAuthorizedKey(signer.PublicKey())), Fingerprint: gossh.FingerprintSHA256(signer.PublicKey()), KeyType: "ssh-ed25519"})
	require.NoError(t, err)
	sshClient, err := gossh.Dial("tcp", sshAddress, &gossh.ClientConfig{User: sshLogin, Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: 5 * time.Second})
	require.NoError(t, err)
	defer sshClient.Close()
	sshSession, err := sshClient.NewSession()
	require.NoError(t, err)
	defer sshSession.Close()
	stdout, err := sshSession.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, sshSession.Start("nohup sleep 120 >/dev/null 2>&1 </dev/null & id -u; cat /proc/self/cgroup; exec sleep 120"))
	reader := bufio.NewReader(stdout)
	type sshObservation struct {
		identity, group string
		err             error
	}
	observed := make(chan sshObservation, 1)
	go func() {
		identity, err := reader.ReadString('\n')
		group := ""
		if err == nil {
			group, err = reader.ReadString('\n')
		}
		observed <- sshObservation{identity, group, err}
	}()
	var observation sshObservation
	select {
	case observation = <-observed:
	case <-time.After(30 * time.Second):
		t.Fatal("SSH revocation fixture did not reach the installed member process")
	case <-t.Context().Done():
		t.Fatal(t.Context().Err())
	}
	require.NoError(t, observation.err)
	require.Equal(t, "20002\n", observation.identity)
	sshGroup := strings.TrimSpace(strings.TrimPrefix(observation.group, "0::"))
	require.Regexp(t, `^/smithers/sessions/s[1-9][0-9]*$`, sshGroup)
	require.NotEqual(t, cgroup, sshGroup)
	sshClosed := make(chan error, 1)
	go func() { sshClosed <- sshSession.Wait() }()
	installedShell(t, owner, `pgrep -u 20002 >/dev/null`)
	// Removing Alice must close both her watching attachment and her own PTY;
	// Ben's session must continue with the same identity.
	started := time.Now()
	h.expect("DELETE", "/api/members/alice", "", 204)
	remaining := 5*time.Second - time.Since(started)
	require.Positive(t, remaining, "member removal itself exceeded five seconds")
	deadline := time.NewTimer(remaining)
	defer deadline.Stop()
	for _, term := range []*rehearsalTerminal{replay, aliceOwner} {
		select {
		case <-term.closed:
			require.LessOrEqual(t, time.Since(started), 5*time.Second)
		case <-deadline.C:
			t.Fatal("member removal failed to revoke terminal within 5 seconds")
		}
	}
	select {
	case err := <-sshClosed:
		require.Error(t, err, "revoked sleeping SSH process must not exit successfully")
	case <-deadline.C:
		t.Fatal("member removal failed to revoke SSH within five seconds")
	}
	// The request, both socket closures, and the independent guest observation
	// share one deadline. A fresh five-second timer after HTTP would hide a slow
	// revocation. Check all uid processes, including reparented descendants.
	remaining = 5*time.Second - time.Since(started)
	require.Positive(t, remaining)
	code, drained, err := owner.capture(fmt.Sprintf(`python3 -c 'import pathlib, subprocess, time
end=time.monotonic()+%.6f
events=[pathlib.Path("/sys/fs/cgroup"+g+"/cgroup.events") for g in ("%s","%s")]
while True:
 p=subprocess.run(["pgrep","-u","20002"],stdout=subprocess.PIPE)
 assert p.returncode in (0,1), p.returncode
 if p.returncode==1 and all(not e.exists() or "populated 0" in e.read_text().splitlines() for e in events):
  print("drained"); break
 assert time.monotonic()<end, "revoked uid or populated cgroup remains"
 time.sleep(.01)'`, remaining.Seconds(), cgroup, sshGroup), "TRMREVOKED", remaining)
	require.NoError(t, err)
	require.Equal(t, "0", code)
	require.Equal(t, "drained", strings.TrimSpace(string(drained)))
	require.Less(t, time.Since(started), 5*time.Second)
	late, err := sshClient.NewSession()
	if late != nil {
		_ = late.Close()
	}
	require.Error(t, err, "retained SSH transport cannot open after removal")
	reconnect, err := gossh.Dial("tcp", sshAddress, &gossh.ClientConfig{User: sshLogin, Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: 5 * time.Second})
	if reconnect != nil {
		_ = reconnect.Close()
	}
	require.Error(t, err, "same previously admitted key cannot reconnect after removal")
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

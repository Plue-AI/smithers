package machined

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// T-TRM-05 on the installed guest (spec §8.11.2a, §9.5.3): the coding agent's
// `bash` runs through `smithers-machined client pty` inside its registered run.
// These run only against an exclusively reserved installed guest
// (SMITHERS_SESSION_ACCEPTANCE_CONFIG); elsewhere they skip, or fail under
// SMITHERS_REQUIRE_SESSION_ACCEPTANCE=1.

const agentClient = "/opt/smithers/bin/smithers-machined"

// agentRun is the harness link with an agent exec session admitted to run.
func agentRun(t *testing.T, run string) (*nativeSessionHarness, *nativeSessionHarness) {
	t.Helper()
	h := nativeSessions(t)
	// The composed install binds durable spawn receipts; without them no
	// watcher is ever admitted (ObserveAgentTerminal refuses ErrNotReady).
	h.link.identities = &agentIdentities{opened: map[uint32]SessionUser{}}
	agent := *h
	agent.sessions = h.sessions.WithActor(h.sessions.actor, run)
	return h, &agent
}

// clientPty runs one Bash call exactly as the coding host does.
func clientPty(t *testing.T, agent *nativeSessionHarness, request string) (string, map[string]any, *Exec) {
	t.Helper()
	e, out, stderr := agent.exec(SessionUser{"agent", 19999}, agentClient, "client", "pty")
	_, err := e.Write([]byte(request))
	require.NoError(t, err)
	require.NoError(t, e.CloseWrite())
	require.NoError(t, e.Wait())
	lines := strings.Split(strings.TrimSpace(string(<-stderr)), "\n")
	var status map[string]any
	require.NoError(t, json.Unmarshal([]byte(lines[len(lines)-1]), &status))
	return strings.ReplaceAll(string(<-out), "\r\n", "\n"), status, e
}

// AgentPtyDropsPrivilegesBeforePayload: the branch-selected argv, env and cwd
// run only in the unprivileged agent session, never as root, and the
// coding host's own credentials do not reach the command.
func TestAgentPtyDropsPrivilegesBeforePayload(t *testing.T) {
	_, agent := agentRun(t, "trm05-privilege")
	request := `{"argv":["/bin/sh","-c","id -u; id -g; id -G; grep -E '^(CapPrm|CapEff|CapAmb|NoNewPrivs):' /proc/self/status; umask; pwd; echo key=${SMITHERS_API_KEY-unset} pager=$PAGER ci=$CI; test -t 0 && echo tty || echo notty; cat /proc/self/cgroup"],` +
		`"cwd":"/tmp","env":{"LD_PRELOAD":"/nonexistent-trm05.so","BASH_ENV":"/nonexistent-trm05"},"display":"id"}`
	output, status, e := clientPty(t, agent, request)
	require.Equal(t, map[string]any{"exit": float64(0)}, status)
	lines := strings.Split(strings.TrimSpace(output), "\n")
	require.Len(t, lines, 12, output)
	require.Equal(t, []string{"19999", "19999", "19999 20000"}, lines[:3], "uid, gid and groups dropped before the payload")
	require.Equal(t, "CapPrm:\t0000000000000000", lines[3])
	require.Equal(t, "CapEff:\t0000000000000000", lines[4])
	require.Equal(t, "CapAmb:\t0000000000000000", lines[5])
	require.Equal(t, "NoNewPrivs:\t1", lines[6])
	require.Equal(t, []string{"0002", "/tmp", "key=unset pager=cat ci=1", "notty"}, lines[7:11])
	// Its own command cgroup, not the client's: one session per Bash call.
	require.Regexp(t, `^0::/smithers/sessions/s[1-9][0-9]*$`, lines[11])
	require.NotEqual(t, fmt.Sprintf("0::/smithers/sessions/s%d", e.ID()), lines[11])
}

// AgentPtyRootInputsValidated: malformed identity, kind, admission, size and
// argv on the local socket, and malformed signal, resize and stream ids on an
// open terminal, are refused before any privileged use; none starts a process.
func TestAgentPtyRootInputsValidated(t *testing.T) {
	h, agent := agentRun(t, "trm05-root-inputs")
	observer := nativeCensus(t, h)
	user := func(login string, uid uint32) []byte {
		return wire.Field(1, wire.Struct(wire.Field(1, wire.String(login)), wire.Field(2, wire.U32(uid))))
	}
	argv := func(values ...string) []byte {
		list := wire.U16(uint16(len(values)))
		for _, v := range values {
			list = append(list, wire.String(v)...)
		}
		return wire.Field(3, list)
	}
	open := func(fields ...[]byte) string {
		frame, err := wire.Encode(wire.Frame{Kind: wire.Control, Payload: wire.Union(1, wire.Field(1, wire.U32(43)), wire.Field(2, wire.Union(6, fields...)))})
		require.NoError(t, err)
		return hex.EncodeToString(frame)
	}
	runner := argv(agentClient, "agent-run", `{"argv":["/bin/sh","-c","touch /tmp/trm05-root-input-ran"],"echo":"$ touch"}`)
	refusals := []string{
		open(user("ben", 20001), wire.Field(2, []byte{1}), runner),
		open(user("root", 0), wire.Field(2, []byte{1}), runner),
		open(user("agent", 20001), wire.Field(2, []byte{1}), runner),
		open(user("agent", 19999), wire.Field(2, []byte{2}), runner),
		open(user("agent", 19999), wire.Field(2, []byte{3})),
		open(user("agent", 19999), wire.Field(2, []byte{1}), runner, wire.Field(5, bytes.Repeat([]byte{7}, 16)), wire.Field(6, wire.String("other-run"))),
		open(user("agent", 19999), wire.Field(2, []byte{1}), runner, wire.Field(4, wire.Struct(wire.Field(1, wire.U16(0)), wire.Field(2, wire.U16(24))))),
		open(user("agent", 19999), wire.Field(2, []byte{1}), argv("", "agent-run")),
	}
	const script = `import socket,struct,sys
def exchange(s,data):
    s.sendall(data); b=b''
    while len(b)<9:
        c=s.recv(9-len(b))
        if not c: return b''
        b+=c
    n=int.from_bytes(b[:4],'big'); r=b''
    while len(r)<n:
        c=s.recv(n-len(r))
        if not c: return b''
        r+=c
    return b+r
def connect():
    s=socket.socket(socket.AF_UNIX); s.settimeout(5); s.connect('/run/smithers/machined.sock'); return s
mode=sys.argv[1]
if mode=='open':
    for req in sys.argv[2:]:
        s=connect()
        try: print(exchange(s,bytes.fromhex(req)).hex() or 'closed',flush=True)
        except (BrokenPipeError,ConnectionResetError,socket.timeout): print('closed',flush=True)
        s.close()
else:
    s=connect(); reply=exchange(s,bytes.fromhex(sys.argv[2])); sid=int.from_bytes(reply[-4:],'big')
    bad={'signal':struct.pack('>IBI',2,5,sid)+bytes([4,9]),'resize':struct.pack('>IBI',5,5,sid)+bytes([3,0,0,0,24]),'foreign':struct.pack('>IBI',3,5,sid+1000)+bytes([1,0,0x78])}[mode]
    try:
        s.sendall(bad); print('open' if s.recv(1) else 'closed',flush=True)
    except (BrokenPipeError,ConnectionResetError): print('closed',flush=True)
    except socket.timeout: print('open',flush=True)
`
	before := observer()
	e, out, stderr := agent.exec(SessionUser{"agent", 19999}, append([]string{"/usr/bin/python3", "-c", script, "open"}, refusals...)...)
	require.NoError(t, e.CloseWrite())
	require.NoError(t, e.Wait())
	require.Empty(t, <-stderr)
	replies := strings.Split(strings.TrimSpace(string(<-out)), "\n")
	require.Len(t, replies, len(refusals))
	for i, reply := range replies {
		if reply == "closed" {
			continue
		}
		raw, err := hex.DecodeString(reply)
		require.NoError(t, err)
		frame, err := wire.Read(bytes.NewReader(raw))
		require.NoError(t, err)
		fields, err := wire.Fields("response", frame.Payload[1:])
		require.NoError(t, err)
		require.Equal(t, byte(255), fields[2][0], "refusal %d must be a typed error, never a session", i)
	}
	require.Equal(t, before, observer(), "a refused local open started a process")
	require.Equal(t, "missing\n", h.output(nativeBen, "test -e /tmp/trm05-root-input-ran && echo ran || echo missing"))

	// A valid open, then a malformed control on its stream: the daemon drops
	// the socket and the broker reaps the paused command before it ever runs.
	valid := open(user("agent", 19999), wire.Field(2, []byte{1}), runner)
	for _, mode := range []string{"signal", "resize", "foreign"} {
		e, out, stderr := agent.exec(SessionUser{"agent", 19999}, "/usr/bin/python3", "-c", script, mode, valid)
		require.NoError(t, e.CloseWrite())
		require.NoError(t, e.Wait())
		require.Empty(t, <-stderr)
		require.Equal(t, "closed\n", string(<-out), mode)
		require.Eventually(t, func() bool { return observer() == before }, 10*time.Second, 100*time.Millisecond, mode)
	}
	require.Equal(t, "missing\n", h.output(nativeBen, "test -e /tmp/trm05-root-input-ran && echo ran || echo missing"))

	// The positive control: a valid uid-19999 terminal runs its command.
	output, status, _ := clientPty(t, agent, `{"argv":["/bin/sh","-c","id -u"],"display":"id -u"}`)
	require.Equal(t, map[string]any{"exit": float64(0)}, status)
	require.Equal(t, "19999\n", output)
}

// C-J3-10 on the guest: the host's watcher, admitted from presence, receives
// the echo and the output from the first byte, and the tool result equals the
// watched bytes without the echo line.
func TestAgentPtyHostWatcherSeesTheCommandFromItsFirstByte(t *testing.T) {
	h, agent := agentRun(t, "trm05-watch")
	type result struct {
		output string
		status map[string]any
	}
	done := make(chan result, 1)
	go func() {
		output, status, _ := clientPty(t, agent, `{"argv":["/bin/sh","-c","printf '\\033[32mAGENT_TERMINAL_FIRST\\033[0m\\n'; sleep 1; printf AGENT_TERMINAL_LAST; exit 7"],"display":"pnpm test"}`)
		done <- result{output, status}
	}()
	terminal := NewAgentTerminal(func() bool { return true })
	t.Cleanup(func() { _ = terminal.Close() })
	deadline := time.Now().Add(agentGateWait)
	var attached time.Time
	for attached.IsZero() {
		require.True(t, time.Now().Before(deadline), "no paused agent command appeared in presence")
		frame, err := h.link.ReceivePresence(h.ctx, h.config.Branch)
		require.NoError(t, err)
		locations, err := frame.PresenceSnapshot()
		require.NoError(t, err)
		for _, location := range locations {
			if h.link.HasSession(location.Session) {
				continue
			}
			stream, err := h.link.ObserveAgentTerminal(h.ctx, h.config.Branch, location.Session, "trm05-watch")
			if err == nil {
				require.True(t, terminal.Append(stream))
				attached = time.Now()
				break
			}
		}
	}
	var watched bytes.Buffer
	buf := make([]byte, 4096)
	firstByte := time.Time{}
	for !strings.Contains(watched.String(), "AGENT_TERMINAL_LAST") {
		n, err := terminal.Read(buf)
		require.NoError(t, err)
		if firstByte.IsZero() {
			firstByte = time.Now()
		}
		watched.Write(buf[:n])
	}
	require.Less(t, firstByte.Sub(attached), time.Second, "the watcher starts the command")
	require.True(t, strings.HasPrefix(watched.String(), "$ pnpm test\r\n\x1b[32mAGENT_TERMINAL_FIRST\x1b[0m\r\n"), watched.String())
	got := <-done
	require.Equal(t, map[string]any{"exit": float64(7)}, got.status)
	require.Equal(t, "\x1b[32mAGENT_TERMINAL_FIRST\x1b[0m\nAGENT_TERMINAL_LAST", got.output)
	require.Equal(t, strings.TrimPrefix(strings.ReplaceAll(watched.String(), "\r\n", "\n"), "$ pnpm test\n"), got.output)
}

// agentGateWait bounds how long a test waits for a paused command to appear: the
// broker's own deadline (crates/smithers-machined supervisor GATE_DEADLINE).
const agentGateWait = 3 * time.Second

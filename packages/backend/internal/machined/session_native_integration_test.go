package machined

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// This harness attaches to an exclusively reserved, already reconciled installed
// guest. It never builds, installs or starts root code, substitutes a kernel, or
// uses a test-only ready flag. The credential file belongs to the host operator.
type nativeSessionConfig struct {
	Endpoint   string
	Branch     string
	Machine    string
	BootID     string
	Secret     string
	Credential string
	Principal  string
	Head       string
}
type nativeSessionHarness struct {
	t        *testing.T
	ctx      context.Context
	config   nativeSessionConfig
	registry *Registry
	link     *Link
	sessions *Sessions
}

func nativeSessions(t *testing.T) *nativeSessionHarness {
	t.Helper()
	path := os.Getenv("SMITHERS_SESSION_ACCEPTANCE_CONFIG")
	if path == "" {
		if os.Getenv("SMITHERS_REQUIRE_SESSION_ACCEPTANCE") == "1" {
			t.Fatal("required production session acceptance has no installed guest authority; set SMITHERS_SESSION_ACCEPTANCE_CONFIG")
		}
		t.Skip("requires an exclusively reserved installed guest; set SMITHERS_SESSION_ACCEPTANCE_CONFIG")
	}
	file, err := os.Open(path)
	require.NoError(t, err)
	defer file.Close()
	info, err := file.Stat()
	require.NoError(t, err)
	require.True(t, info.Mode().IsRegular() && info.Mode().Perm()&0077 == 0, "authority file must be private")
	var config nativeSessionConfig
	decoder := json.NewDecoder(io.LimitReader(file, 8193))
	decoder.DisallowUnknownFields()
	require.NoError(t, decoder.Decode(&config))
	require.ErrorIs(t, decoder.Decode(new(any)), io.EOF)
	require.NotEmpty(t, config.Endpoint)
	require.NotEmpty(t, config.Branch)
	require.NotEmpty(t, config.Machine)
	id, err := hex.DecodeString(config.BootID)
	require.NoError(t, err)
	require.Len(t, id, 16)
	secret, err := hex.DecodeString(config.Secret)
	require.NoError(t, err)
	require.Len(t, secret, 32)
	principal, err := hex.DecodeString(config.Principal)
	require.NoError(t, err)
	require.Len(t, principal, 16)
	var boot [16]byte
	copy(boot[:], id)
	var key [32]byte
	copy(key[:], secret)
	registry := new(Registry)
	require.NoError(t, registry.bindBoot(config.Branch, config.Machine, boot, []byte(config.Credential), key))
	t.Cleanup(func() { _ = registry.Close() })
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Minute)
	t.Cleanup(cancel)
	h := &nativeSessionHarness{t: t, ctx: ctx, config: config, registry: registry}
	h.connect()
	h.sessions = NewSessions(h.link.Connection, config.Branch, registry.Sessions(config.Branch)).WithActor(principal, "").WithPresenceVia("ssh")
	return h
}
func (h *nativeSessionHarness) connect() {
	h.t.Helper()
	socket, err := (&net.Dialer{}).DialContext(h.ctx, "tcp", h.config.Endpoint)
	require.NoError(h.t, err)
	h.link, err = h.registry.Connect(h.ctx, h.config.Branch, socket)
	require.NoError(h.t, err)
	// Every authenticated reconnect fences the old roster. Synchronize the
	// installed fixture accounts through the host-only production RPC before
	// observing readiness; an old connection's ready state is not admission.
	if h.config.Head != "" {
		head, err := hex.DecodeString(h.config.Head)
		require.NoError(h.t, err)
		require.Len(h.t, head, 20)
		_, err = h.link.call(h.ctx, h.config.Branch, wire.WakeReconcile, wire.Field(1, head))
		require.NoError(h.t, err)
	}
	require.NoError(h.t, synchronizeNativeRoster(h.ctx, h.link, h.config.Branch))
	// This is an observed production Status response, not fixture admission.
	status, err := h.link.call(h.ctx, h.config.Branch, wire.Status)
	require.NoError(h.t, err)
	require.Equal(h.t, []byte{3}, status[1], "guest must have completed real wake reconciliation and roster installation")
	require.NoError(h.t, h.link.Reconciled())
}

func synchronizeNativeRoster(ctx context.Context, link *Link, branch string) error {
	users := append(wire.U16(2), wire.Struct(wire.Field(1, wire.String("ben")), wire.Field(2, wire.U32(20001)))...)
	users = append(users, wire.Struct(wire.Field(1, wire.String("alice")), wire.Field(2, wire.U32(20002)))...)
	_, err := link.call(ctx, branch, wire.SetRoster, wire.Field(1, users))
	return err
}

var nativeBen = SessionUser{"ben", 20001}
var nativeAlice = SessionUser{"alice", 20002}

func (h *nativeSessionHarness) exec(user SessionUser, argv ...string) (*Exec, <-chan []byte, <-chan []byte) {
	h.t.Helper()
	e, err := h.sessions.OpenExec(h.ctx, user, argv)
	require.NoError(h.t, err)
	context.AfterFunc(h.ctx, func() { _ = e.Close() })
	h.t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = e.Kill(ctx)
	})
	out, stderr := make(chan []byte, 1), make(chan []byte, 1)
	go func() {
		b, err := io.ReadAll(io.LimitReader(e.Stdout(), 2<<20))
		if err != nil {
			b = append(b, []byte(err.Error())...)
		}
		out <- b
	}()
	go func() {
		b, err := io.ReadAll(io.LimitReader(e.Stderr(), 2<<20))
		if err != nil {
			b = append(b, []byte(err.Error())...)
		}
		stderr <- b
	}()
	return e, out, stderr
}
func (h *nativeSessionHarness) output(user SessionUser, command string) string {
	h.t.Helper()
	e, out, stderr := h.exec(user, "/bin/sh", "-c", command)
	require.NoError(h.t, e.CloseWrite())
	require.NoError(h.t, e.Wait())
	require.Empty(h.t, <-stderr)
	return string(<-out)
}

func TestSessionProductionDispatchAcceptance(t *testing.T) {
	h := nativeSessions(t)
	t.Run("real identity and cgroup", func(t *testing.T) {
		hcopy := *h
		hcopy.t = t
		h := &hcopy
		output := h.output(nativeBen, "id -u; id -un; awk '/^Groups:/ {print $2; if (NF != 2) exit 1}' /proc/self/status; umask; pwd; cat /proc/self/cgroup")
		lines := strings.Split(strings.TrimSpace(output), "\n")
		require.Len(t, lines, 6)
		require.Equal(t, []string{"20001", "ben", "20000", "0002", "/workspace"}, lines[:5])
		require.Regexp(t, `^0::/smithers/sessions/s[1-9][0-9]*$`, lines[5])
	})
	for _, cell := range []struct {
		name, command string
		code          int32
		signal        byte
	}{
		{"exit seven", "exit 7", 7, 0}, {"TERM exit", "kill -TERM $$", 0, 2},
	} {
		t.Run(cell.name, func(t *testing.T) {
			hcopy := *h
			hcopy.t = t
			h := &hcopy
			e, out, stderr := h.exec(nativeBen, "/bin/sh", "-c", cell.command)
			require.NoError(t, e.CloseWrite())
			var exit *ExitError
			require.ErrorAs(t, e.Wait(), &exit)
			require.Equal(t, cell.code, exit.Code)
			require.Equal(t, cell.signal, exit.Signal)
			require.Empty(t, <-out)
			require.Empty(t, <-stderr)
		})
	}
	t.Run("one MiB half close", func(t *testing.T) {
		hcopy := *h
		hcopy.t = t
		h := &hcopy
		e, out, stderr := h.exec(nativeBen, "/usr/bin/wc", "-c")
		n, err := e.Write(bytes.Repeat([]byte{'x'}, 1048576))
		require.NoError(t, err)
		require.Equal(t, 1048576, n)
		require.NoError(t, e.CloseWrite())
		require.NoError(t, e.Wait())
		require.Equal(t, "1048576", strings.TrimSpace(string(<-out)))
		require.Empty(t, <-stderr)
	})
	t.Run("lingering descendant drainage", func(t *testing.T) {
		hcopy := *h
		hcopy.t = t
		h := &hcopy
		e, out, stderr := h.exec(nativeBen, "/bin/sh", "-c", "nohup sleep 120 >/dev/null 2>&1 </dev/null & echo $!; cat /proc/self/cgroup")
		require.NoError(t, e.CloseWrite())
		require.NoError(t, e.Wait())
		require.Empty(t, <-stderr)
		lines := strings.Fields(string(<-out))
		require.Len(t, lines, 2)
		var pid int
		_, err := fmt.Sscan(lines[0], &pid)
		require.NoError(t, err)
		require.Positive(t, pid)
		group := strings.TrimPrefix(lines[1], "0::")
		require.Regexp(t, `^/smithers/sessions/s[1-9][0-9]*$`, group)
		require.NoError(t, h.sessions.CloseSession(h.ctx, e.ID()))
		require.Equal(t, "live\n", h.output(nativeAlice, fmt.Sprintf("test -d /proc/%d && echo live", pid)))
		deadline, cancel := context.WithTimeout(h.ctx, 5*time.Second)
		defer cancel()
		started := time.Now()
		killed, err := h.sessions.KillUser(deadline, nativeBen)
		require.NoError(t, err)
		require.Positive(t, killed)
		require.Less(t, time.Since(started), 5*time.Second)
		// Independent OS observation, from a different real uid after the reply.
		require.Equal(t, "empty\n", h.output(nativeAlice, fmt.Sprintf("test ! -d /proc/%d && { test ! -d /sys/fs/cgroup%s || grep -qx 'populated 0' /sys/fs/cgroup%s/cgroup.events; } && echo empty", pid, group, group)))
	})
}

func TestSessionRootInputsValidatedNative(t *testing.T) {
	h := nativeSessions(t)
	for _, phase := range []string{"production RPC matrix", "retained RPC matrix after reconnect"} {
		t.Run(phase, func(t *testing.T) {
			if phase == "retained RPC matrix after reconnect" {
				require.NoError(t, h.link.Close())
				h.connect()
				h.sessions = NewSessions(h.link.Connection, h.config.Branch, h.registry.Sessions(h.config.Branch)).WithActor(h.sessions.actor, "").WithPresenceVia("ssh")
			}
			copy := *h
			copy.t = t
			testSessionNativeRPCMatrix(t, &copy)
		})
	}
	for _, user := range []SessionUser{{"root", 0}, {"ben", 19999}, {"alice", 20001}, {"../ben", 20001}, {"ben", 20002}} {
		t.Run(fmt.Sprintf("rpc/%s/%d", user.Login, user.UID), func(t *testing.T) {
			hcopy := *h
			hcopy.t = t
			h := &hcopy
			// Bypass the host convenience validator: the production daemon and root
			// broker must independently reject a syntactically valid hostile envelope.
			_, err := h.link.call(h.ctx, h.config.Branch, wire.OpenSession,
				wire.Field(1, wire.Struct(wire.Field(1, wire.String(user.Login)), wire.Field(2, wire.U32(user.UID)))),
				wire.Field(2, []byte{2}), wire.Field(3, append(wire.U16(1), wire.String("/usr/bin/id")...)),
				wire.Field(5, bytes.Repeat([]byte{1}, 16)))
			require.Error(t, err)
			var refusal *SessionError
			require.ErrorAs(t, err, &refusal)
			// This bypasses the Go validator. The installed broker's typed
			// identity/roster refusal is malformed, not the host adapter's
			// unauthorized error. Keep the literal production expectation.
			require.Equal(t, "malformed", refusal.Code)
		})
	}
	// Keep a real process alive across each hostile request. Refusal must not
	// resize, close, kill or rebind this independently admitted session.
	t.Run("semantic input refusals preserve a live session", func(t *testing.T) {
		hcopy := *h
		hcopy.t = t
		h := &hcopy
		e, out, stderr := h.exec(nativeBen, "/bin/cat")
		user := wire.Field(1, wire.Struct(wire.Field(1, wire.String("ben")), wire.Field(2, wire.U32(20001))))
		principal := wire.Field(5, h.sessions.actor)
		for _, cell := range []struct {
			name   string
			method wire.Method
			fields [][]byte
		}{
			{"zero columns", wire.OpenSession, [][]byte{user, wire.Field(2, []byte{1}), principal, wire.Field(4, wire.Struct(wire.Field(1, wire.U16(0)), wire.Field(2, wire.U16(24))))}},
			{"zero rows", wire.OpenSession, [][]byte{user, wire.Field(2, []byte{1}), principal, wire.Field(4, wire.Struct(wire.Field(1, wire.U16(80)), wire.Field(2, wire.U16(0))))}},
			{"empty executable", wire.OpenSession, [][]byte{user, wire.Field(2, []byte{2}), principal, wire.Field(3, append(wire.U16(1), wire.String("")...))}},
			{"sftp branch executable", wire.OpenSession, [][]byte{user, wire.Field(2, []byte{3}), principal, wire.Field(3, append(wire.U16(1), wire.String("/workspace/payload")...))}},
			{"close root selector", wire.CloseSession, [][]byte{wire.Field(1, wire.U32(0))}},
			{"attach root selector", wire.AttachSession, [][]byte{wire.Field(1, wire.U32(0)), wire.Field(2, wire.U64(0))}},
			{"register member as run", wire.RegisterRun, [][]byte{wire.Field(1, wire.String("forged-run")), wire.Field(2, wire.U32(e.ID()))}},
		} {
			t.Run(cell.name, func(t *testing.T) {
				_, err := h.link.call(h.ctx, h.config.Branch, cell.method, cell.fields...)
				var refusal *SessionError
				require.ErrorAs(t, err, &refusal, "must receive a guest refusal, not a host encoder error")
			})
		}
		_, err := e.Write([]byte("survived-root-input-refusals\n"))
		require.NoError(t, err)
		require.NoError(t, e.CloseWrite())
		require.NoError(t, e.Wait())
		require.Equal(t, "survived-root-input-refusals\n", string(<-out))
		require.Empty(t, <-stderr)
	})
	t.Run("branch executable and hostile import environment", func(t *testing.T) {
		hcopy := *h
		hcopy.t = t
		h := &hcopy
		// All preparation is itself a broker member session. Nothing from this
		// checkout is planted in /opt or evaluated by a root helper.
		result := h.output(nativeBen, `d=$(mktemp -d /workspace/session-canary.XXXXXX) || exit; trap 'rm -rf "$d"' EXIT
printf 'import os\nprint("import-uid="+str(os.geteuid()))\n' > "$d/canary.py"
printf '#!/bin/sh\nid -u\nexec /usr/bin/python3 -c "import canary"\n' > "$d/payload"
chmod 700 "$d/payload"
PATH="$d:/usr/bin:/bin" PYTHONPATH="$d" ENV="$d/payload" BASH_ENV="$d/payload" "$d/payload"`)
		require.Equal(t, "20001\nimport-uid=20001\n", result)
	})
	t.Run("member local socket denied by real credentials", func(t *testing.T) {
		hcopy := *h
		hcopy.t = t
		h := &hcopy
		require.Equal(t, "denied\n", h.output(nativeBen, `/usr/bin/python3 -c 'import socket
s=socket.socket(socket.AF_UNIX)
try: s.connect("/run/smithers/machined.sock")
except PermissionError: print("denied")
else: raise SystemExit("member socket admitted")'`))
	})
	// A subsequent literal control proves the link survived refusals.
	require.Equal(t, "20001\n", h.output(nativeBen, "id -u"))
}

func TestSessionProductionReconnect(t *testing.T) {
	h := nativeSessions(t)
	id, err := h.sessions.OpenSession(h.ctx, nativeBen, SessionExec, []string{"/bin/cat"}, nil)
	require.NoError(t, err)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = h.registry.Sessions(h.config.Branch).CallSession(ctx, SessionCall{Method: "kill_sessions", Session: id})
	})
	stream, err := h.sessions.Stream(h.ctx, id)
	require.NoError(t, err)
	input := make([]byte, 131072)
	for i := range input {
		input[i] = byte(i % 251)
	}
	for i := 0; i < len(input); i += 65536 {
		require.NoError(t, stream.Send(h.ctx, append([]byte{1, 0}, input[i:i+65536]...)))
	}
	var output []byte
	for len(output) == 0 {
		frame, err := stream.Receive(h.ctx)
		require.NoError(t, err)
		if frame[0] == 1 {
			require.Equal(t, byte(1), frame[1])
			output = append(output, frame[2:]...)
			nativeReturnCredit(t, h.ctx, stream, len(frame)-2)
		}
	}
	require.NoError(t, h.link.Close())
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-h.ctx.Done():
		t.Fatal(h.ctx.Err())
	}
	h.connect()
	received, err := stream.Reattach(h.ctx)
	require.NoError(t, err)
	require.LessOrEqual(t, received, uint64(len(input)))
	suffix := []byte("\x00after-reconnect\xff\n")
	require.NoError(t, stream.Send(h.ctx, append([]byte{1, 0}, suffix...)))
	require.NoError(t, stream.Send(h.ctx, []byte{2, 0}))
	exited := false
	for {
		frame, err := stream.Receive(h.ctx)
		require.NoError(t, err)
		switch frame[0] {
		case 1:
			require.Equal(t, byte(1), frame[1])
			output = append(output, frame[2:]...)
			require.LessOrEqual(t, len(output), len(input)+len(suffix))
			nativeReturnCredit(t, h.ctx, stream, len(frame)-2)
		case 5:
			require.Equal(t, []byte{5, 0, 0, 0, 0, 0}, frame)
			exited = true
		case 7:
			require.True(t, exited)
			require.Equal(t, append(input, suffix...), output)
			return
		}
	}
}
func nativeReturnCredit(t *testing.T, ctx context.Context, stream *SessionStream, n int) {
	t.Helper()
	frame := []byte{6, 0, 0, 0, 0}
	binary.BigEndian.PutUint32(frame[1:], uint32(n))
	require.NoError(t, stream.Send(ctx, frame))
}
func TestSessionProductionStalledOneGiB(t *testing.T) {
	h := nativeSessions(t)
	rss := func() int64 {
		// Observe the installed broker, never the harness process or fixture RSS.
		value := h.output(nativeAlice, `p=$(pgrep -u root -f '^/opt/smithers/bin/smithers-machined broker$'); test "$(printf '%s\n' "$p" | wc -l)" = 1 && awk '/^VmRSS:/ {print $2}' /proc/$p/status`)
		var kb int64
		_, err := fmt.Sscan(value, &kb)
		require.NoError(t, err)
		require.Positive(t, kb)
		return kb
	}
	baseline := rss()
	e, err := h.sessions.OpenExec(h.ctx, nativeBen, []string{"/usr/bin/head", "-c", "1073741824", "/dev/zero"})
	require.NoError(t, err)
	context.AfterFunc(h.ctx, func() { _ = e.Close() })
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = e.Kill(ctx)
	})
	require.NoError(t, e.CloseWrite())
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-h.ctx.Done():
		t.Fatal(h.ctx.Err())
	}
	require.LessOrEqual(t, rss()-baseline, int64(32768), "stalled broker grew by more than 32 MiB")
	stderr := make(chan []byte, 1)
	go func() { b, _ := io.ReadAll(e.Stderr()); stderr <- b }()
	// Validate every byte as well as the count, without retaining a GiB.
	buffer := make([]byte, 65536)
	zero := make([]byte, 65536)
	var count int64
	for {
		n, err := e.Stdout().Read(buffer)
		require.True(t, bytes.Equal(buffer[:n], zero[:n]), "nonzero output at byte %d", count)
		count += int64(n)
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
	}
	require.Equal(t, int64(1073741824), count)
	require.NoError(t, e.Wait())
	require.Empty(t, <-stderr)
}

func TestSessionProductionAgentLocalSocket(t *testing.T) {
	h := nativeSessions(t)
	run := "b94bc92b-ad61-4209-8508-48eae0ef1007"
	agent := *h
	agent.sessions = h.sessions.WithActor(h.sessions.actor, run)
	request, err := os.ReadFile("../compose/testdata/cocontracts/local_write_with_actor.bin")
	require.NoError(t, err)
	// Literal protocol corpus, sent by a real uid 19999 process from the
	// host-registered cgroup. No injected SO_PEERCRED or synthetic OS registry.
	command := fmt.Sprintf(`import socket,sys
sys.stdin.buffer.readline()
s=socket.socket(socket.AF_UNIX)
s.settimeout(5)
s.connect("/run/smithers/machined.sock")
s.sendall(bytes.fromhex("%s"))
def read(n):
 b=b""
 while len(b)<n:
  c=s.recv(n-len(b))
  if not c: raise RuntimeError("short response")
  b+=c
 return b
h=read(9)
print((h+read(int.from_bytes(h[:4],"big"))).hex())`, hex.EncodeToString(request))
	e, out, stderr := agent.exec(SessionUser{"agent", 19999}, "/usr/bin/python3", "-c", command)
	require.NoError(t, agent.sessions.RegisterRun(h.ctx, run, e.ID()))
	_, err = e.Write([]byte("registered\n"))
	require.NoError(t, err)
	require.NoError(t, e.CloseWrite())
	require.NoError(t, e.Wait())
	require.Empty(t, <-stderr)
	response, err := hex.DecodeString(strings.TrimSpace(string(<-out)))
	require.NoError(t, err)
	frame, err := wire.Read(bytes.NewReader(response))
	require.NoError(t, err)
	require.Equal(t, byte(1), frame.Kind)
	fields, err := wire.Fields("response", frame.Payload[1:])
	require.NoError(t, err)
	require.Equal(t, byte(255), fields[2][0])
	failure, err := wire.Fields("error", fields[2][1:])
	require.NoError(t, err)
	require.Equal(t, []byte{1}, failure[1])
	require.Equal(t, []byte{7}, failure[6], "actor-bearing local request must fail unknown_field")
}

func TestSessionProductionPTYResizeSignal(t *testing.T) {
	h := nativeSessions(t)
	terminal, err := h.sessions.OpenTerminal(h.ctx, nativeBen, []string{"/bin/sh", "-c", "stty -echo; printf 'ready\\n'; read line; stty size; exec sleep 120"}, &SessionSize{80, 24})
	require.NoError(t, err)
	context.AfterFunc(h.ctx, func() { _ = terminal.Close() })
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = h.sessions.KillSession(ctx, terminal.stream.id)
		_ = terminal.Close()
	})
	reader := bufio.NewReader(terminal)
	line, err := reader.ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, "ready", strings.TrimSpace(line))
	require.NoError(t, terminal.Resize(h.ctx, 123, 41))
	_, err = terminal.Write([]byte("go\n"))
	require.NoError(t, err)
	line, err = reader.ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, "41 123", strings.TrimSpace(line))
	require.NoError(t, terminal.stream.Send(h.ctx, []byte{4, 1}))
	_, err = io.Copy(io.Discard, reader)
	var exit *ExitError
	require.ErrorAs(t, err, &exit)
	require.Equal(t, byte(1), exit.Signal)
}

func TestSessionAdmissionFailsClosedNative(t *testing.T) {
	h := nativeSessions(t)
	socket, err := (&net.Dialer{}).DialContext(h.ctx, "tcp", h.config.Endpoint)
	require.NoError(t, err)
	link, err := h.registry.Connect(h.ctx, h.config.Branch, socket)
	require.NoError(t, err)
	sessions := NewSessions(link.Connection, h.config.Branch, h.registry.Sessions(h.config.Branch)).WithActor(h.sessions.actor, "")
	// Even an authentic live daemon connection cannot spawn before the host has
	// observed its installed reconciliation/roster receipt.
	_, err = sessions.OpenSession(h.ctx, nativeBen, SessionExec, []string{"/usr/bin/id"}, nil)
	var refusal *SessionError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, "not_ready", refusal.Code)
	require.NoError(t, synchronizeNativeRoster(h.ctx, link, h.config.Branch))
	status, err := link.call(h.ctx, h.config.Branch, wire.Status)
	require.NoError(t, err)
	require.Equal(t, []byte{3}, status[1])
	require.NoError(t, link.Reconciled())
	for _, cell := range []struct {
		name      string
		user      SessionUser
		principal []byte
		run       string
	}{
		{"missing attribution", nativeBen, nil, ""},
		{"zero attribution", nativeBen, make([]byte, 16), ""},
		{"member forged run", nativeBen, h.sessions.actor, "forged-run"},
		{"agent absent run", SessionUser{"agent", 19999}, h.sessions.actor, ""},
		{"unprovisioned member", SessionUser{"outsider", 29999}, h.sessions.actor, ""},
	} {
		t.Run(cell.name, func(t *testing.T) {
			fields := [][]byte{
				wire.Field(1, wire.Struct(wire.Field(1, wire.String(cell.user.Login)), wire.Field(2, wire.U32(cell.user.UID)))),
				wire.Field(2, []byte{2}), wire.Field(3, append(wire.U16(1), wire.String("/usr/bin/id")...)),
			}
			if cell.principal != nil {
				fields = append(fields, wire.Field(5, cell.principal))
			}
			if cell.run != "" {
				fields = append(fields, wire.Field(6, wire.String(cell.run)))
			}
			_, err := link.call(h.ctx, h.config.Branch, wire.OpenSession, fields...)
			require.Error(t, err)
			var refusal *SessionError
			require.ErrorAs(t, err, &refusal)
			require.Equal(t, "malformed", refusal.Code)
		})
	}
}

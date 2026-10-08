package machined

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// This driver is installed as reviewed main-built test code, not executed from
// a checkout as root. The child reaches the real daemon's SO_PEERCRED socket
// from outside every registered session cgroup; no peer or ready flag is injected.
func TestSessionProductionOutsideRun(t *testing.T) {
	if os.Getenv("SMITHERS_SESSION_ACCEPTANCE_CONFIG") == "" {
		nativeSessions(t)
		return
	}
	require.Equal(t, 0, os.Geteuid(), "requires the reviewed installed guest test runner")
	executable, err := os.Executable()
	require.NoError(t, err)
	canonical, err := filepath.EvalSymlinks(executable)
	require.NoError(t, err)
	require.Equal(t, executable, canonical)
	require.True(t, strings.HasPrefix(canonical, "/opt/smithers/bundle/tests/"), "never execute checkout-built test code as root")
	for path := canonical; path != "/"; path = filepath.Dir(path) {
		info, err := os.Lstat(path)
		require.NoError(t, err)
		stat, ok := info.Sys().(*syscall.Stat_t)
		require.True(t, ok)
		require.Zero(t, stat.Uid)
		require.Zero(t, info.Mode().Perm()&0022)
	}
	h := nativeSessions(t)
	request, err := wire.Encode(wire.Frame{Kind: wire.Control, Payload: wire.Union(1, wire.Field(1, wire.U32(43)), wire.Field(2, wire.Union(6, wire.Field(1, wire.Struct(wire.Field(1, wire.String("agent")), wire.Field(2, wire.U32(19999)))), wire.Field(2, []byte{1}))))})
	require.NoError(t, err)
	script := fmt.Sprintf(`import os,socket
print(os.geteuid(),flush=True)
print(open('/proc/self/cgroup').read().strip(),flush=True)
s=socket.socket(socket.AF_UNIX)
s.settimeout(5)
s.connect('/run/smithers/machined.sock')
s.sendall(bytes.fromhex('%s'))
try:
 b=s.recv(9)
except ConnectionResetError:
 b=b''
print(b.hex() or 'closed',flush=True)
`, hex.EncodeToString(request))
	// Use the identical payload from an actually registered process first.
	positive := strings.Replace(script, "print(b.hex() or 'closed',flush=True)", `while len(b)<9:
 c=s.recv(9-len(b))
 if not c: raise RuntimeError('registered caller refused')
 b+=c
n=int.from_bytes(b[:4],'big')
r=b''
while len(r)<n:
 c=s.recv(n-len(r))
 if not c: raise RuntimeError('short registered response')
 r+=c
print((b+r).hex(),flush=True)
`, 1)
	agent := *h
	agent.sessions = h.sessions.WithActor(h.sessions.actor, "trm07-outside-control")
	e, out, stderr := agent.exec(SessionUser{"agent", 19999}, "/usr/bin/python3", "-c", positive)
	require.NoError(t, e.CloseWrite())
	require.NoError(t, e.Wait())
	require.Empty(t, <-stderr)
	lines := strings.Split(strings.TrimSpace(string(<-out)), "\n")
	require.Len(t, lines, 3)
	require.Equal(t, "19999", lines[0])
	require.Equal(t, fmt.Sprintf("0::/smithers/sessions/s%d", e.ID()), lines[1])
	response, err := hex.DecodeString(lines[2])
	require.NoError(t, err)
	frame, err := wire.Read(bytes.NewReader(response))
	require.NoError(t, err)
	fields, err := wire.Fields("response", frame.Payload[1:])
	require.NoError(t, err)
	require.Equal(t, []byte{0, 0, 0, 43}, fields[1])
	require.Equal(t, byte(6), fields[2][0])
	killed, err := h.sessions.KillRun(h.ctx, agent.sessions.run)
	require.NoError(t, err)
	require.GreaterOrEqual(t, killed, uint16(1))
	sibling, siblingOut, siblingErr := h.exec(nativeAlice, "/bin/cat")
	observer := nativeCensus(t, h)
	before := observer()
	ctx, cancel := context.WithTimeout(h.ctx, 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "/usr/bin/python3", "-c", script)
	command.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 19999, Gid: 19999, Groups: []uint32{20000}}}
	output, err := command.Output()
	require.NoError(t, err)
	lines = strings.Split(strings.TrimSpace(string(output)), "\n")
	require.Len(t, lines, 3)
	require.Equal(t, "19999", lines[0])
	require.NotContains(t, lines[1], "/smithers/sessions/")
	require.Equal(t, "closed", lines[2])
	require.Equal(t, before, observer(), "unregistered caller created a session")
	_, err = sibling.Write([]byte("outside-run-control-survived\n"))
	require.NoError(t, err)
	require.NoError(t, sibling.CloseWrite())
	require.NoError(t, sibling.Wait())
	require.Equal(t, "outside-run-control-survived\n", string(<-siblingOut))
	require.Empty(t, <-siblingErr)
}

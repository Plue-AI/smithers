package machined

import (
	"bufio"
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// The child enters through the installed agent socket, not OpenSession on the
// host or serve_peer with substituted credentials. The host only starts and
// registers its real agent parent. Closing the local socket must retain the
// child's cgroup and immutable run attribution until KillRun drains both.
func TestSessionProductionLocalLifecycle(t *testing.T) {
	h := nativeSessions(t)
	agent := *h
	agent.sessions = h.sessions.WithActor(h.sessions.actor, "724b1b7e-1040-4f56-8ae0-75e7a47f0705")
	command := "stty -echo; id -u; id -g; id -G; umask; pwd; cat /proc/self/cgroup; nohup sleep 120 >/dev/null 2>&1 </dev/null & p=$!; while test \"$(cat /proc/$p/comm)\" != sleep; do sleep .01; done; echo $p; exec cat"
	argv := wire.U16(3)
	for _, arg := range []string{"/bin/sh", "-c", command} {
		argv = append(argv, wire.String(arg)...)
	}
	request, err := wire.Encode(wire.Frame{Kind: wire.Control, Payload: wire.Union(1,
		wire.Field(1, wire.U32(42)), wire.Field(2, wire.Union(6,
			wire.Field(1, wire.Struct(wire.Field(1, wire.String("agent")), wire.Field(2, wire.U32(19999)))),
			wire.Field(2, []byte{1}), wire.Field(3, argv),
			wire.Field(4, wire.Struct(wire.Field(1, wire.U16(80)), wire.Field(2, wire.U16(24)))),
		)))})
	require.NoError(t, err)
	// Independent literal response/frame parsing in the guest. No production
	// decoder supplies the expected identity, stream ownership or exit behavior.
	probe := fmt.Sprintf(`import socket,struct,sys,os
sys.stdin.buffer.readline()
s=socket.socket(socket.AF_UNIX)
s.settimeout(5)
s.connect("/run/smithers/machined.sock")
s.sendall(bytes.fromhex("%s"))
def read(n):
 b=b""
 while len(b)<n:
  c=s.recv(n-len(b))
  if not c: raise RuntimeError("short local frame")
  b+=c
 return b
def frame():
 h=read(9)
 n,k,i=struct.unpack("!IBI",h)
 if n>262144: raise RuntimeError("oversized local frame")
 return k,i,read(n)
k,i,b=frame()
assert (k,i)==(1,0) and len(b)==21
assert b[:17]==bytes.fromhex("0200000010010000002a02060000000501")
child=struct.unpack("!I",b[17:])[0]
assert 0<child<2147483648
output=b""
while output.count(b"\n")<7:
 k,i,b=frame()
 assert k==5 and i==child
 if b[0]==1:
  assert b[1]==1
  output+=b[2:]
  credit=b"\x06"+struct.pack("!I",len(b)-2)
  s.sendall(struct.pack("!IBI",len(credit),5,child)+credit)
 else: assert b[0] in (2,6)
print(os.geteuid())
print(open("/proc/self/cgroup").read().strip())
print(child)
print(output.decode().replace("\r", ""),end="")
s.close()
print("local-closed",flush=True)
sys.stdin.buffer.readline()
`, hex.EncodeToString(request))
	parent, err := agent.sessions.OpenExec(h.ctx, SessionUser{"agent", 19999}, []string{"/usr/bin/python3", "-c", probe})
	require.NoError(t, err)
	context.AfterFunc(h.ctx, func() { _ = parent.Close() })
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = agent.sessions.KillRun(ctx, agent.sessions.run)
		_ = parent.Close()
	})
	require.NoError(t, agent.sessions.RegisterRun(h.ctx, agent.sessions.run, parent.ID()))
	_, err = parent.Write([]byte("registered\n"))
	require.NoError(t, err)
	reader := bufio.NewReader(parent.Stdout())
	var lines []string
	for range 11 {
		line, err := reader.ReadString('\n')
		require.NoError(t, err)
		lines = append(lines, strings.TrimSpace(line))
	}
	require.Equal(t, "19999", lines[0])
	require.Equal(t, fmt.Sprintf("0::/smithers/sessions/s%d", parent.ID()), lines[1])
	var child uint32
	_, err = fmt.Sscan(lines[2], &child)
	require.NoError(t, err)
	require.Positive(t, child)
	require.NotEqual(t, parent.ID(), child)
	require.Equal(t, []string{"19999", "19999", "19999 20000", "0002", "/workspace"}, lines[3:8])
	require.Equal(t, fmt.Sprintf("0::/smithers/sessions/s%d", child), lines[8])
	var lingering uint32
	_, err = fmt.Sscan(lines[9], &lingering)
	require.NoError(t, err)
	require.Positive(t, lingering)
	require.Equal(t, "local-closed", lines[10])
	// A different real user observes the detached descendant in the child's
	// kernel cgroup after socket close; merely seeing the parent is insufficient.
	require.Equal(t, "lingering\n", h.output(nativeAlice, fmt.Sprintf(
		"test -d /proc/%d && grep -qx '0::/smithers/sessions/s%d' /proc/%d/cgroup && echo lingering", lingering, child, lingering)))
	sibling, out, stderr := h.exec(nativeBen, "/bin/cat")
	ctx, cancel := context.WithTimeout(h.ctx, 5*time.Second)
	defer cancel()
	started := time.Now()
	killed, err := agent.sessions.KillRun(ctx, agent.sessions.run)
	require.NoError(t, err)
	require.Equal(t, uint16(2), killed, "local child must inherit its parent's run")
	require.Equal(t, "empty\n", h.output(nativeAlice, fmt.Sprintf(
		"test ! -d /proc/%d && { test ! -d /sys/fs/cgroup/smithers/sessions/s%d || grep -qx 'populated 0' /sys/fs/cgroup/smithers/sessions/s%d/cgroup.events; } && { test ! -d /sys/fs/cgroup/smithers/sessions/s%d || grep -qx 'populated 0' /sys/fs/cgroup/smithers/sessions/s%d/cgroup.events; } && echo empty", lingering, parent.ID(), parent.ID(), child, child)))
	require.Less(t, time.Since(started), 5*time.Second, "RPC and independent drainage observations share the deadline")
	require.Error(t, parent.Wait())
	remaining, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.Empty(t, remaining)
	errors, err := io.ReadAll(parent.Stderr())
	require.NoError(t, err)
	require.Empty(t, errors)
	_, err = sibling.Write([]byte("member-survived-local-drain\n"))
	require.NoError(t, err)
	require.NoError(t, sibling.CloseWrite())
	require.NoError(t, sibling.Wait())
	require.Equal(t, "member-survived-local-drain\n", string(<-out))
	require.Empty(t, <-stderr)
	killed, err = agent.sessions.KillRun(h.ctx, agent.sessions.run)
	require.NoError(t, err)
	require.Zero(t, killed)
}

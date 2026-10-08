package machined

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// These controls run through the authenticated dispatcher, real process groups
// and real kernel exits. A fixture Kernel cannot supply a passing result.
func TestSessionProductionSignalMatrix(t *testing.T) {
	h := nativeSessions(t)
	sibling, out, stderr := h.exec(nativeAlice, "/bin/cat")
	for _, cell := range []struct {
		name   string
		signal byte
	}{
		{"INT", 1}, {"TERM", 2}, {"HUP", 3}, {"KILL", 4}, {"QUIT", 5}, {"USR1", 6}, {"USR2", 7},
	} {
		t.Run(cell.name, func(t *testing.T) {
			e, err := h.sessions.OpenExec(h.ctx, nativeBen, []string{"/bin/sh", "-c", "ulimit -c 0; echo $$; exec sleep 120"})
			require.NoError(t, err)
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = e.Kill(ctx)
			})
			context.AfterFunc(h.ctx, func() { _ = e.Close() })
			reader := bufio.NewReader(e.Stdout())
			line, err := reader.ReadString('\n')
			require.NoError(t, err)
			var pid int
			_, err = fmt.Sscan(line, &pid)
			require.NoError(t, err)
			require.Positive(t, pid)
			// Do not race a shell's temporary signal dispositions before exec.
			copy := *h
			copy.t = t
			require.Equal(t, "ready\n", copy.output(nativeAlice, fmt.Sprintf(`for i in $(seq 1 100); do test "$(cat /proc/%d/comm)" = sleep && { echo ready; exit; }; sleep .01; done; exit 1`, pid)))
			require.NoError(t, e.stream.Send(h.ctx, []byte{4, cell.signal}))
			require.Empty(t, mustReadNative(t, reader))
			require.Empty(t, mustReadNative(t, e.Stderr()))
			var exit *ExitError
			require.ErrorAs(t, e.Wait(), &exit)
			require.Equal(t, int32(0), exit.Code)
			require.Equal(t, cell.signal, exit.Signal)
			require.Equal(t, "gone\n", copy.output(nativeAlice, fmt.Sprintf("test ! -d /proc/%d && echo gone", pid)))
		})
	}
	// Signals select only the broker-owned process group, never a sibling uid.
	_, err := sibling.Write([]byte("sibling-survived-seven-signals\n"))
	require.NoError(t, err)
	require.NoError(t, sibling.CloseWrite())
	require.NoError(t, sibling.Wait())
	require.Equal(t, "sibling-survived-seven-signals\n", string(<-out))
	require.Empty(t, <-stderr)
}

func mustReadNative(t *testing.T, r io.Reader) []byte {
	t.Helper()
	b, err := io.ReadAll(r)
	require.NoError(t, err)
	return b
}

// A real registered uid 19999 caller submits hostile local admission envelopes.
// The daemon obtains SO_PEERCRED and cgroup identity itself; no injected peer.
func TestSessionProductionLocalAdmissionMatrix(t *testing.T) {
	h := nativeSessions(t)
	agent := *h
	agent.sessions = h.sessions.WithActor(h.sessions.actor, "e2a2ae55-9459-4912-8273-6979c3d90703")
	for _, cell := range []struct {
		name, fixture string
		code          byte
		args          [][]byte
	}{
		{"host attribution on local open", "local_open_session_admitted", 11, nil},
		{"actor on local write", "local_write_with_actor", 1, nil},
		{"member identity on local open", "", 11, [][]byte{wire.Field(1, wire.Struct(wire.Field(1, wire.String("ben")), wire.Field(2, wire.U32(20001)))), wire.Field(2, []byte{1})}},
		{"root identity on local open", "", 11, [][]byte{wire.Field(1, wire.Struct(wire.Field(1, wire.String("root")), wire.Field(2, wire.U32(0)))), wire.Field(2, []byte{1})}},
		{"exec on local open", "", 11, [][]byte{wire.Field(1, wire.Struct(wire.Field(1, wire.String("agent")), wire.Field(2, wire.U32(19999)))), wire.Field(2, []byte{2}), wire.Field(3, append(wire.U16(1), wire.String("/usr/bin/id")...))}},
		{"sftp on local open", "", 11, [][]byte{wire.Field(1, wire.Struct(wire.Field(1, wire.String("agent")), wire.Field(2, wire.U32(19999)))), wire.Field(2, []byte{3})}},
		{"foreign run on local open", "", 11, [][]byte{wire.Field(1, wire.Struct(wire.Field(1, wire.String("agent")), wire.Field(2, wire.U32(19999)))), wire.Field(2, []byte{1}), wire.Field(6, wire.String("foreign-run"))}},
	} {
		t.Run(cell.name, func(t *testing.T) {
			var request []byte
			var err error
			if cell.fixture != "" {
				request, err = os.ReadFile("../compose/testdata/cocontracts/" + cell.fixture + ".bin")
			} else {
				// The ordinary codec only constructs the envelope. The real
				// local socket must enforce the narrower admission contract.
				request, err = wire.Encode(wire.Frame{Kind: wire.Control, Payload: wire.Union(1, wire.Field(1, wire.U32(42)), wire.Field(2, wire.Union(6, cell.args...)))})
			}
			require.NoError(t, err)
			command := fmt.Sprintf(`import socket,sys,os
sys.stdin.buffer.readline()
s=socket.socket(socket.AF_UNIX)
s.settimeout(5)
s.connect("/run/smithers/machined.sock")
s.sendall(bytes.fromhex("%s"))
def read(n):
 b=b""
 while len(b)<n:
  c=s.recv(n-len(b))
  if not c: raise RuntimeError("short refusal")
  b+=c
 return b
h=read(9)
print((h+read(int.from_bytes(h[:4],"big"))).hex())
s.close()
print(os.geteuid())
print(open("/proc/self/cgroup").read().strip())`, hex.EncodeToString(request))
			copy := agent
			copy.t = t
			e, out, stderr := copy.exec(SessionUser{"agent", 19999}, "/usr/bin/python3", "-c", command)
			require.NoError(t, agent.sessions.RegisterRun(h.ctx, agent.sessions.run, e.ID()))
			_, err = e.Write([]byte("registered\n"))
			require.NoError(t, err)
			require.NoError(t, e.CloseWrite())
			require.NoError(t, e.Wait())
			require.Empty(t, <-stderr)
			lines := strings.Split(strings.TrimSpace(string(<-out)), "\n")
			require.Len(t, lines, 3)
			require.Equal(t, "19999", lines[1])
			require.Equal(t, fmt.Sprintf("0::/smithers/sessions/s%d", e.ID()), lines[2])
			response, err := hex.DecodeString(lines[0])
			require.NoError(t, err)
			frame, err := wire.Read(bytes.NewReader(response))
			require.NoError(t, err)
			require.Equal(t, byte(1), frame.Kind)
			fields, err := wire.Fields("response", frame.Payload[1:])
			require.NoError(t, err)
			require.Equal(t, byte(255), fields[2][0])
			failure, err := wire.Fields("error", fields[2][1:])
			require.NoError(t, err)
			require.Equal(t, []byte{cell.code}, failure[1])
			if cell.code == 1 {
				require.Equal(t, []byte{7}, failure[6])
			}
		})
	}
	require.Equal(t, "20001\n", h.output(nativeBen, "id -u"))
}

// Zero dimensions are valid wire scalars but invalid privileged PTY controls.
// Bypass the host's size validator and observe the installed broker's refusal,
// then ask the same process for its actual kernel terminal size.
func TestSessionProductionResizeRefusalMatrix(t *testing.T) {
	h := nativeSessions(t)
	id, err := h.sessions.OpenSession(h.ctx, nativeBen, SessionPTY, []string{"/bin/sh", "-c", "stty -echo; echo ready; read go; stty size"}, &SessionSize{80, 24})
	require.NoError(t, err)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = h.sessions.KillSession(ctx, id)
	})
	stream, err := h.sessions.Stream(h.ctx, id)
	require.NoError(t, err)
	var ready []byte
	for !bytes.Contains(ready, []byte("ready\r\n")) {
		frame, err := stream.Receive(h.ctx)
		require.NoError(t, err)
		require.Equal(t, byte(1), frame[0])
		require.Equal(t, byte(1), frame[1])
		ready = append(ready, frame[2:]...)
		nativeReturnCredit(t, h.ctx, stream, len(frame)-2)
	}
	require.Equal(t, "ready\r\n", string(ready))
	for _, cell := range []struct {
		name    string
		payload []byte
	}{
		{"zero columns", []byte{3, 0, 0, 0, 24}},
		{"zero rows", []byte{3, 0, 80, 0, 0}},
		{"both zero", []byte{3, 0, 0, 0, 0}},
	} {
		t.Run(cell.name, func(t *testing.T) {
			// Construct the literal ADR header without calling the host frame encoder.
			packet := []byte{0, 0, 0, 5, 5, byte(id >> 24), byte(id >> 16), byte(id >> 8), byte(id)}
			packet = append(packet, cell.payload...)
			h.link.writeMu.Lock()
			err := h.link.stream.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err == nil {
				_, err = io.Copy(h.link.stream, bytes.NewReader(packet))
			}
			h.link.writeMu.Unlock()
			require.NoError(t, err)
			ctx, cancel := context.WithTimeout(h.ctx, 5*time.Second)
			defer cancel()
			frame, err := stream.Receive(ctx)
			require.NoError(t, err)
			require.Equal(t, byte(255), frame[0], "zero size must receive a broker refusal")
			failure, err := wire.Fields("error", frame[1:])
			require.NoError(t, err)
			require.Equal(t, []byte{1}, failure[1])
		})
	}
	require.NoError(t, stream.Send(h.ctx, []byte{1, 0, 'g', 'o', '\n'}))
	var output []byte
	exited := false
	for {
		frame, err := stream.Receive(h.ctx)
		require.NoError(t, err)
		switch frame[0] {
		case 1:
			require.Equal(t, byte(1), frame[1])
			output = append(output, frame[2:]...)
			nativeReturnCredit(t, h.ctx, stream, len(frame)-2)
		case 5:
			require.Equal(t, []byte{5, 0, 0, 0, 0, 0}, frame)
			exited = true
		case 7:
			require.True(t, exited)
			require.Equal(t, "24 80", strings.TrimSpace(string(output)))
			return
		case 2, 6:
		default:
			t.Fatalf("unexpected stream control: %x", frame)
		}
	}
}

// Invalid stream envelopes terminate only the authenticated transport. The
// original kernel session must survive and reattach within its existing grace;
// invalid controls cannot signal it or manufacture replay credit.
func TestSessionProductionMalformedStreamReconnectMatrix(t *testing.T) {
	for _, cell := range []struct {
		name    string
		payload []byte
	}{
		{"zero signal", []byte{4, 0}},
		{"unknown signal", []byte{4, 8}},
		{"maximum signal", []byte{4, 255}},
		{"signal trailing byte", []byte{4, 1, 0}},
		{"truncated resize", []byte{3, 0, 80}},
		{"zero credit", []byte{6, 0, 0, 0, 0}},
		{"excess credit", []byte{6, 0, 4, 0, 1}},
		{"oversized data", append([]byte{1, 0}, bytes.Repeat([]byte{'x'}, 65537)...)},
	} {
		t.Run(cell.name, func(t *testing.T) {
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
			packet := make([]byte, 9, len(cell.payload)+9)
			binary.BigEndian.PutUint32(packet, uint32(len(cell.payload)))
			packet[4] = 5
			binary.BigEndian.PutUint32(packet[5:], id)
			packet = append(packet, cell.payload...)
			h.link.writeMu.Lock()
			err = h.link.stream.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err == nil {
				_, err = io.Copy(h.link.stream, bytes.NewReader(packet))
			}
			h.link.writeMu.Unlock()
			require.NoError(t, err)
			select {
			case <-h.link.Done():
			case <-time.After(5 * time.Second):
				t.Fatal("installed daemon did not refuse malformed stream")
			}
			h.connect()
			received, err := stream.Reattach(h.ctx)
			require.NoError(t, err)
			require.Zero(t, received, "refused input must not advance the received offset")
			require.NoError(t, stream.Send(h.ctx, []byte{1, 0, 's', 'u', 'r', 'v', 'i', 'v', 'e', 'd', '\n'}))
			require.NoError(t, stream.Send(h.ctx, []byte{2, 0}))
			var output []byte
			exited := false
			for {
				frame, err := stream.Receive(h.ctx)
				require.NoError(t, err)
				switch frame[0] {
				case 1:
					require.Equal(t, byte(1), frame[1])
					output = append(output, frame[2:]...)
					nativeReturnCredit(t, h.ctx, stream, len(frame)-2)
				case 5:
					require.Equal(t, []byte{5, 0, 0, 0, 0, 0}, frame)
					exited = true
				case 7:
					require.True(t, exited)
					require.Equal(t, "survived\n", string(output))
					return
				case 2, 6:
				default:
					t.Fatalf("unexpected stream control after reconnect: %x", frame)
				}
			}
		})
	}
}

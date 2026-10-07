//go:build darwin || linux

package microsandbox

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os/exec"
	"slices"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// bridgeHarness runs the guest helper's real `bridge` on loopback. The helper
// listens on guest 127.0.0.1:PORT and dials host.microsandbox.internal:PORT;
// here the dial is redirected to the test's host listener, because one
// machine cannot listen twice on PORT. Every socket the bridge accepts or
// dials is recorded, and a "report" line on stdin prints each one's
// TCP_NODELAY as read back with getsockopt.
const bridgeHarness = `import importlib.util, json, socket, sys, threading
spec = importlib.util.spec_from_file_location("guest", sys.argv[1])
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
g.drop_to = lambda user: None
port, host_port = int(sys.argv[2]), int(sys.argv[3])
accepted, dialed = [], []
real_create, real_accept, real_listen = socket.create_connection, socket.socket.accept, socket.socket.listen
def create(address, *args, **kwargs):
    assert address == ("host.microsandbox.internal", port), address
    upstream = real_create(("127.0.0.1", host_port), *args, **kwargs)
    dialed.append(upstream)
    return upstream
def accept(self):
    client, address = real_accept(self)
    accepted.append(client)
    return client, address
def listen(self, backlog):
    real_listen(self, backlog)
    print("ready", flush=True)
socket.create_connection, socket.socket.accept, socket.socket.listen = create, accept, listen
def report():
    for _ in sys.stdin:
        nodelay = lambda sockets: [s.getsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY) for s in sockets]
        print(json.dumps({"accepted": nodelay(accepted), "dialed": nodelay(dialed)}), flush=True)
threading.Thread(target=report, daemon=True).start()
g.bridge(port, "host.microsandbox.internal")
`

type bridgeUnderTest struct {
	port   int
	host   net.Listener
	stdin  io.Writer
	stdout *bufio.Scanner
}

func startGuestBridge(t *testing.T) *bridgeUnderTest {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed")
	}
	host, err := net.Listen("tcp4", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { _ = host.Close() })
	free, err := net.Listen("tcp4", "127.0.0.1:0")
	require.NoError(t, err)
	port := free.Addr().(*net.TCPAddr).Port
	require.NoError(t, free.Close())
	cmd := exec.Command(python, "-B", "-c", bridgeHarness, "guest/smithers-guest.py",
		strconv.Itoa(port), strconv.Itoa(host.Addr().(*net.TCPAddr).Port))
	stdin, err := cmd.StdinPipe()
	require.NoError(t, err)
	stdout, err := cmd.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, cmd.Start())
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	lines := bufio.NewScanner(stdout)
	require.True(t, lines.Scan(), "bridge exited before listening: %v", lines.Err())
	require.Equal(t, "ready", lines.Text())
	return &bridgeUnderTest{port: port, host: host, stdin: stdin, stdout: lines}
}

// connect opens one guest stream through the bridge and returns both ends.
func (b *bridgeUnderTest) connect(t *testing.T) (guest, host net.Conn) {
	t.Helper()
	guest, err := net.Dial("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(b.port)))
	require.NoError(t, err)
	t.Cleanup(func() { _ = guest.Close() })
	require.NoError(t, b.host.(*net.TCPListener).SetDeadline(time.Now().Add(10*time.Second)))
	host, err = b.host.Accept()
	require.NoError(t, err)
	t.Cleanup(func() { _ = host.Close() })
	return guest, host
}

func tcpNoDelay(t *testing.T, conn net.Conn) int {
	t.Helper()
	raw, err := conn.(*net.TCPConn).SyscallConn()
	require.NoError(t, err)
	var value int
	var optErr error
	require.NoError(t, raw.Control(func(fd uintptr) {
		value, optErr = syscall.GetsockoptInt(int(fd), syscall.IPPROTO_TCP, syscall.TCP_NODELAY)
	}))
	require.NoError(t, optErr)
	return value
}

// Every socket the guest bridge accepts or dials disables Nagle. Without it a
// frame split across two sends waits for the peer's delayed ACK (#3749).
func TestGuestBridgeSocketsSetTCPNoDelay(t *testing.T) {
	bridge := startGuestBridge(t)
	guest, host := bridge.connect(t)
	// One byte each way proves both pump threads run, so serve has finished
	// configuring both sockets.
	_, err := guest.Write([]byte{1})
	require.NoError(t, err)
	_, err = io.ReadFull(host, make([]byte, 1))
	require.NoError(t, err)
	_, err = host.Write([]byte{2})
	require.NoError(t, err)
	_, err = io.ReadFull(guest, make([]byte, 1))
	require.NoError(t, err)

	_, err = io.WriteString(bridge.stdin, "report\n")
	require.NoError(t, err)
	require.True(t, bridge.stdout.Scan(), "bridge report: %v", bridge.stdout.Err())
	var report struct{ Accepted, Dialed []int }
	require.NoError(t, json.Unmarshal(bridge.stdout.Bytes(), &report))
	require.Len(t, report.Accepted, 1, "guest loopback sockets the bridge accepted")
	require.Len(t, report.Dialed, 1, "host sockets the bridge dialed")
	require.NotZero(t, report.Accepted[0], "TCP_NODELAY on the accepted guest loopback socket")
	require.NotZero(t, report.Dialed[0], "TCP_NODELAY on the socket to host.microsandbox.internal")
	// The Go peers keep net.TCPConn's default NoDelay.
	require.NotZero(t, tcpNoDelay(t, guest), "TCP_NODELAY on the guest client")
	require.NotZero(t, tcpNoDelay(t, host), "TCP_NODELAY on the host listener's connection")
}

const (
	bridgeFrame   = 4096
	bridgeSamples = 300
	// The Nagle/delayed-ACK stall is about 40-50 ms; loopback without Nagle is
	// well under 1 ms. 5 ms leaves a 10x margin on each side.
	bridgeP95Limit = 5 * time.Millisecond
)

// splitFrame sends a 4-byte length, waits until the peer has read it, then
// sends the body, so the bridge must forward the frame as two sends. That is
// the write-write-read pattern Nagle stalls; the guest network splits a
// single 4 KiB write into segments the same way. The handoff is a channel, so
// the split is deterministic and adds no sleep to the measurement.
func splitFrame(conn net.Conn, body []byte, peerHasHeader <-chan struct{}) error {
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(body)))
	if _, err := conn.Write(header[:]); err != nil {
		return err
	}
	<-peerHasHeader
	_, err := conn.Write(body)
	return err
}

// readSplitFrame reads a length, signals that it has, then reads the body.
func readSplitFrame(conn net.Conn, hasHeader chan<- struct{}) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(conn, header[:]); err != nil {
		return nil, err
	}
	hasHeader <- struct{}{}
	body := make([]byte, binary.BigEndian.Uint32(header[:]))
	_, err := io.ReadFull(conn, body)
	return body, err
}

// A 4 KiB request/response echo through the real guest bridge stays far
// below the ~50 ms Nagle/delayed-ACK plateau the T-COL-01 spike measured
// (#3749, #3441). Without TCP_NODELAY each direction stalls about 40 ms.
func TestGuestBridgeEchoesFourKiBFramesWithoutNagleStall(t *testing.T) {
	bridge := startGuestBridge(t)
	guest, host := bridge.connect(t)
	hostHasHeader, guestHasHeader := make(chan struct{}, 1), make(chan struct{}, 1)
	echoed := make(chan error, 1)
	go func() {
		for {
			frame, err := readSplitFrame(host, hostHasHeader)
			if err == nil {
				err = splitFrame(host, frame, guestHasHeader)
			}
			if err != nil {
				echoed <- err
				return
			}
		}
	}()
	body := make([]byte, bridgeFrame)
	samples := make([]time.Duration, 0, bridgeSamples)
	for seq := 0; seq < bridgeSamples; seq++ {
		binary.BigEndian.PutUint64(body, uint64(seq))
		require.NoError(t, guest.SetDeadline(time.Now().Add(10*time.Second)))
		start := time.Now()
		err := splitFrame(guest, body, hostHasHeader)
		var frame []byte
		if err == nil {
			frame, err = readSplitFrame(guest, guestHasHeader)
		}
		elapsed := time.Since(start)
		if err != nil {
			select {
			case echoErr := <-echoed:
				t.Fatalf("frame %d: %v (host echo: %v)", seq, err, echoErr)
			default:
				t.Fatalf("frame %d: %v", seq, err)
			}
		}
		require.Equal(t, body, frame, "frame %d", seq)
		samples = append(samples, elapsed)
	}
	slices.Sort(samples)
	rank := func(p int) time.Duration { return samples[(p*len(samples)+99)/100-1] }
	t.Logf("bridge 4 KiB echo n=%d p50=%s p95=%s p99=%s max=%s", len(samples), rank(50), rank(95), rank(99), samples[len(samples)-1])
	require.Less(t, rank(95), bridgeP95Limit, "bridge 4 KiB echo p95")
}

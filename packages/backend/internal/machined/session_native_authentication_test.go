package machined

import (
	"bytes"
	"context"
	"encoding/hex"
	"net"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// C-COL-04 step 6 must exercise the installed handshake listener while an
// existing authenticated stream is live. A fixture daemon accepting a proof
// cannot establish that a failed second proof preserves the actual session.
func TestSessionProductionAuthenticationIsolation(t *testing.T) {
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
	secret, err := hex.DecodeString(h.config.Secret)
	require.NoError(t, err)
	secret[0] ^= 1
	bootBytes, err := hex.DecodeString(h.config.BootID)
	require.NoError(t, err)
	var boot [16]byte
	copy(boot[:], bootBytes)
	var badKey [32]byte
	copy(badKey[:], secret)
	bad := new(Registry)
	require.NoError(t, bad.bindBoot(h.config.Branch, h.config.Machine, boot, []byte(h.config.Credential), badKey))
	t.Cleanup(func() { _ = bad.Close() })
	for attempt := 0; attempt < 2; attempt++ {
		socket, err := (&net.Dialer{}).DialContext(h.ctx, "tcp", h.config.Endpoint)
		require.NoError(t, err)
		_, err = bad.Connect(h.ctx, h.config.Branch, socket)
		require.Error(t, err, "installed daemon must refuse a bad HMAC")
		select {
		case <-h.link.Done():
			t.Fatal("bad proof replaced the original authenticated connection")
		default:
		}
		text := []byte{0, byte(attempt), 255, '\n'}
		require.NoError(t, stream.Send(h.ctx, append([]byte{1, 0}, text...)))
		var output []byte
		for len(output) < len(text) {
			frame, err := stream.Receive(h.ctx)
			require.NoError(t, err)
			if frame[0] == 1 {
				require.Equal(t, byte(1), frame[1])
				output = append(output, frame[2:]...)
				nativeReturnCredit(t, h.ctx, stream, len(frame)-2)
			}
		}
		require.Equal(t, text, output)
	}
	// Leave the old host transport open and idle. A valid proof must replace
	// it without waiting for its grace; the same kernel process is reattached.
	previous := h.link
	started := time.Now()
	h.connect()
	require.Less(t, time.Since(started), 5*time.Second)
	select {
	case <-previous.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("valid proof did not replace the old host transport")
	}
	received, err := stream.Reattach(h.ctx)
	require.NoError(t, err)
	require.Equal(t, uint64(8), received)
	text := []byte("same-session-after-valid-proof\n")
	require.NoError(t, stream.Send(h.ctx, append([]byte{1, 0}, text...)))
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
			require.LessOrEqual(t, len(output), len(text))
			nativeReturnCredit(t, h.ctx, stream, len(frame)-2)
		case 5:
			require.Equal(t, []byte{5, 0, 0, 0, 0, 0}, frame)
			exited = true
		case 7:
			require.True(t, exited)
			require.True(t, bytes.Equal(text, output), "replacement lost or duplicated session bytes")
			return
		case 2, 6:
		default:
			t.Fatalf("unexpected installed session frame: %x", frame)
		}
	}
}

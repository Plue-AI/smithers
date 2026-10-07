package wire

import (
	"github.com/stretchr/testify/require"
	"os"
	"testing"
)

func TestPresenceSnapshotGolden(t *testing.T) {
	raw, err := os.ReadFile("../../compose/testdata/cocontracts/presence_snapshot.bin")
	require.NoError(t, err)
	frame, err := Decode(raw)
	require.NoError(t, err)
	locations, err := frame.PresenceSnapshot()
	require.NoError(t, err)
	require.Equal(t, []PresenceLocation{{Session: 1, Path: "a"}, {Session: 2}}, locations)
	_, err = (Frame{Kind: Control}).PresenceSnapshot()
	require.Error(t, err)
	for n := 0; n < len(frame.Payload); n++ {
		_, err := (Frame{Kind: Presence, Payload: frame.Payload[:n]}).PresenceSnapshot()
		require.Error(t, err)
	}
	// Canonical framing permits a numeric session zero; presence does not.
	body := append([]byte(nil), frame.Payload...)
	copy(body[13:17], []byte{0, 0, 0, 0})
	_, err = (Frame{Kind: Presence, Payload: body}).PresenceSnapshot()
	require.Error(t, err)
}

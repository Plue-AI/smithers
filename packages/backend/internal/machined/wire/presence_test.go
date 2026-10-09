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

func TestPresenceProcessCensus(t *testing.T) {
	process := func(session uint32, id byte, agent byte) []byte {
		participant := make([]byte, 16)
		participant[0] = id
		return Struct(Field(1, U32(session)), Field(2, participant), Field(3, []byte{agent}))
	}
	snapshot := func(items ...[]byte) Frame {
		census := U16(uint16(len(items)))
		for _, item := range items {
			census = append(census, item...)
		}
		return Frame{Kind: Presence, Payload: Union(1, Field(1, append(U16(1), Struct(Field(1, U32(1)))...)), Field(2, census))}
	}
	rows, err := snapshot(process(1, 1, 1), process(1, 2, 2)).PresenceSnapshot()
	require.NoError(t, err)
	require.Equal(t, []PresenceLocation{{Session: 1}, {Session: 1, Participant: [16]byte{1}, Agent: "codex"}, {Session: 1, Participant: [16]byte{2}, Agent: "claude-code"}}, rows)
	for name, frame := range map[string]Frame{
		"unregistered session": snapshot(process(2, 1, 1)), "zero participant": snapshot(process(1, 0, 1)),
		"duplicate participant": snapshot(process(1, 1, 1), process(1, 1, 2)), "unsupported agent": snapshot(process(1, 1, 3)),
	} {
		t.Run(name, func(t *testing.T) { _, err := frame.PresenceSnapshot(); require.Error(t, err) })
	}
	tooMany := make([][]byte, 65)
	for i := range tooMany {
		tooMany[i] = process(1, byte(i+1), 1)
	}
	_, err = snapshot(tooMany...).PresenceSnapshot()
	require.Error(t, err)
	frame := snapshot(process(1, 1, 1))
	for n := 0; n < len(frame.Payload); n++ {
		_, err := (Frame{Kind: Presence, Payload: frame.Payload[:n]}).PresenceSnapshot()
		require.Error(t, err)
	}
}

func TestPresenceForegroundCommandValidation(t *testing.T) {
	for _, name := range []string{"presence_foreground_command", "presence_foreground_clear"} {
		raw, err := os.ReadFile("../../compose/testdata/cocontracts/" + name + ".bin")
		require.NoError(t, err)
		frame, err := Decode(raw)
		require.NoError(t, err)
		rows, err := frame.PresenceSnapshot()
		require.NoError(t, err)
		want := "sleep"
		if name == "presence_foreground_clear" {
			want = ""
		}
		require.Equal(t, []PresenceLocation{{Session: 1, Command: want}}, rows)
	}
	for _, command := range []string{"", "\n", "\x1b[31m", string(make([]byte, 65))} {
		frame := Frame{Kind: Presence, Payload: Union(1, Field(1, append(U16(1), Struct(Field(1, U32(1)), Field(3, String(command)))...)))}
		_, err := frame.PresenceSnapshot()
		require.Error(t, err)
	}
}

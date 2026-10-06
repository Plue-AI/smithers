package wire

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBurstEventGolden(t *testing.T) {
	raw, err := os.ReadFile("../../compose/testdata/cocontracts/ev_burst.bin")
	require.NoError(t, err)
	f, err := Decode(raw)
	require.NoError(t, err)
	b, err := f.BurstEvent()
	require.NoError(t, err)
	require.Equal(t, uint64(7), b.Sequence)
	require.Equal(t, byte(1), b.Actor.Kind)
	require.Equal(t, []byte("principal"), b.Actor.Principal)
	require.Equal(t, strings.Repeat("1", 40), b.VersionsCommit)
	require.Equal(t, []BurstFile{{Path: "src/a.ts", Change: "modified", BeforeBlob: strings.Repeat("1", 40), AfterBlob: strings.Repeat("2", 40), PostDigest: strings.Repeat("3", 64)}}, b.Files)
	raw, err = os.ReadFile("../../compose/testdata/cocontracts/ev_burst_rename_delete.bin")
	require.NoError(t, err)
	f, err = Decode(raw)
	require.NoError(t, err)
	b, err = f.BurstEvent()
	require.NoError(t, err)
	require.Equal(t, uint32(1), b.Actor.Session)
	require.Equal(t, "old", b.Files[0].Path)
	require.Equal(t, "new", b.Files[0].RenamedTo)
	require.Equal(t, "deleted", b.Files[1].Change)
	require.Empty(t, b.Files[1].PostDigest)
}
func TestBurstPartsGolden(t *testing.T) {
	raw, err := os.ReadFile("../../compose/testdata/cocontracts/ev_burst_part.bin")
	require.NoError(t, err)
	frame, err := Decode(raw)
	require.NoError(t, err)
	burst, err := frame.BurstEvent()
	require.NoError(t, err)
	require.Equal(t, uint16(1), burst.Part)
	require.Equal(t, uint16(2), burst.Parts)
}
func TestBurstEventRejectsOtherFrames(t *testing.T) {
	for _, name := range []string{"hint_file_written", "ev_captured", "ack_applied"} {
		raw, err := os.ReadFile("../../compose/testdata/cocontracts/" + name + ".bin")
		require.NoError(t, err)
		f, err := Decode(raw)
		require.NoError(t, err)
		_, err = f.BurstEvent()
		require.ErrorIs(t, err, UnknownMessage)
	}
	_, err := (Frame{Kind: Events, Payload: []byte{1}}).BurstEvent()
	require.Error(t, err)
}
func TestBurstAckBounds(t *testing.T) {
	_, err := BurstAck(1, 0, nil)
	require.Error(t, err)
	_, err = BurstAck(1, 3, []string{"bad"})
	require.Error(t, err)
	_, err = BurstAck(1, 3, make([]string, 65536))
	require.Error(t, err)
}

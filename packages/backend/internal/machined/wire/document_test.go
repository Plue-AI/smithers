package wire

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"github.com/stretchr/testify/require"
	"os"
	"testing"
)

func TestDocumentGoldenPayloads(t *testing.T) {
	raw, err := os.ReadFile("../../compose/testdata/cocontracts/doc-daemon.json")
	require.NoError(t, err)
	var fixtures struct {
		Frames []struct {
			Name, Hex, Actor, Data string
			Msg                    byte
		}
	}
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	for _, f := range fixtures.Frames {
		t.Run(f.Name, func(t *testing.T) {
			b, err := hex.DecodeString(f.Hex)
			require.NoError(t, err)
			require.Equal(t, uint32(len(b)-9), binary.BigEndian.Uint32(b[:4]))
			require.Equal(t, byte(4), b[4])
			require.Equal(t, uint32(9), binary.BigEndian.Uint32(b[5:9]))
			decodedFrame, err := Decode(b)
			require.NoError(t, err)
			encoded, err := Encode(decodedFrame)
			require.NoError(t, err)
			require.Equal(t, b, encoded)
			d, err := DecodeDocument(b[9:])
			require.NoError(t, err)
			require.Equal(t, f.Msg, d.Msg)
			require.Equal(t, f.Actor, hex.EncodeToString(d.Actor))
			require.Equal(t, f.Data, hex.EncodeToString(d.Data))
			if f.Msg == 5 {
				require.Equal(t, "00112233445566778899aabbccddeeff", hex.EncodeToString(d.Epoch[:]))
				require.Equal(t, uint32(42), d.ClientID)
			}
			if f.Msg == 7 {
				require.Equal(t, "Ben", d.GoneBy)
				if f.Name == "gone" {
					require.Equal(t, byte(1), d.GoneKind)
				} else {
					require.Equal(t, byte(2), d.GoneKind)
					require.Equal(t, "deliver.ts", d.GoneTo)
				}
			}
			if f.Msg == 6 {
				require.Equal(t, uint64(1791028800000), d.AtMS)
			}
			got, err := EncodeDocument(d)
			require.NoError(t, err)
			require.Equal(t, b[9:], got)
		})
	}
}

func TestDocumentPayloadBoundaries(t *testing.T) {
	for _, b := range [][]byte{nil, {0}, {8}, {1}, {1, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0}, {5}, {5, 0}, {6, 0}, {255, 0, 0, 0, 2, 1, 0}, {255, 0, 0, 0, 2, 2, 2}, make([]byte, 4<<20+1)} {
		_, err := DecodeDocument(b)
		require.Error(t, err)
	}
	for _, d := range []Document{{Msg: 0}, {Msg: 1}, {Msg: 1, Actor: make([]byte, 1025)}, {Msg: 5}, {Msg: 255}, {Msg: 3, Data: make([]byte, 4<<20)}} {
		_, err := EncodeDocument(d)
		require.Error(t, err)
	}
	b, err := EncodeDocument(Document{Msg: 1, Actor: make([]byte, 1024), Data: []byte{2}})
	require.NoError(t, err)
	d, err := DecodeDocument(b)
	require.NoError(t, err)
	require.Len(t, d.Actor, 1024)
	require.Equal(t, []byte{2}, d.Data)
	for n := 0; n < len(b)-1; n++ {
		_, err := DecodeDocument(b[:n])
		require.Error(t, err)
	}
}

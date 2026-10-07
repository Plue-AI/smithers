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

func TestSequencedDocumentGoldenPayloads(t *testing.T) {
	for _, tc := range []struct {
		name string
		seq  uint64
	}{
		{"doc-input-v2", 0x0102030405060708}, {"doc-saved-v2", 0x0102030405060708},
		{"doc-input-v2-zero", 0}, {"doc-saved-v2-max", ^uint64(0)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := os.ReadFile("../../compose/testdata/cocontracts/" + tc.name + ".bin")
			require.NoError(t, err)
			frame, err := Decode(raw)
			require.NoError(t, err)
			d, err := DecodeDocumentV2(frame.Payload)
			require.NoError(t, err)
			if tc.seq != 0 {
				_, err := EncodeDocument(d)
				require.Error(t, err)
			}
			offset := 9
			if d.Msg == DocumentInput {
				require.Equal(t, []byte("Be"), d.Actor)
				require.Equal(t, tc.seq, d.Seq)
				require.Equal(t, []byte{0, 2, 0}, d.Data)
				offset = 13
			} else {
				require.Equal(t, uint64(1791028800000), d.AtMS)
				require.Equal(t, tc.seq, d.ThroughSeq)
				require.Equal(t, []byte{1, 42, 1}, d.Data)
			}
			encoded, err := EncodeDocumentV2(d)
			require.NoError(t, err)
			require.Equal(t, frame.Payload, encoded)
			for n := 0; n < 8; n++ {
				_, err := DecodeDocumentV2(frame.Payload[:offset+n])
				require.Error(t, err)
			}
		})
	}
	// Unchanged message forms use the same codec and bytes in both versions.
	for _, name := range []string{"doc-awareness-input", "doc-sync", "doc-awareness", "doc-epoch", "doc-gone", "doc-renamed", "doc-unsupported-detail"} {
		raw, err := os.ReadFile("../../compose/testdata/cocontracts/" + name + ".bin")
		require.NoError(t, err)
		old, err := DecodeDocument(raw[9:])
		require.NoError(t, err)
		got, err := DecodeDocumentV2(raw[9:])
		require.NoError(t, err)
		require.Equal(t, old, got)
		encoded, err := EncodeDocumentV2(got)
		require.NoError(t, err)
		require.Equal(t, raw[9:], encoded)
	}
	for _, msg := range []byte{DocumentInput, DocumentSaved} {
		_, err := EncodeDocumentV2(Document{Msg: msg, Actor: []byte("Be"), Data: make([]byte, 4<<20-9)})
		require.Error(t, err)
	}
}

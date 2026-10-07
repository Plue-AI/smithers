package wire

import (
	"encoding/hex"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestProtocolThreeSessionAdmissionLiteral(t *testing.T) {
	raw, err := hex.DecodeString("00000047010000000001000000420100000009020600000037010000000d0100056167656e740200004e1f02020300010005636f646578050102030405060708090a0b0c0d0e0f1006000572756e2d31")
	require.NoError(t, err)
	frame, err := Decode(raw)
	require.NoError(t, err)
	id, method, body, err := frame.Request()
	require.NoError(t, err)
	require.Equal(t, uint32(9), id)
	require.Equal(t, byte(OpenSession), method)
	fields, err := Fields("args6", body)
	require.NoError(t, err)
	require.Equal(t, []byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}, fields[5])
	require.Equal(t, String("run-1"), fields[6])
	encoded, err := Encode(frame)
	require.NoError(t, err)
	require.Equal(t, raw, encoded)
}

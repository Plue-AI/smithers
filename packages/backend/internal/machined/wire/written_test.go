package wire

import (
	"github.com/stretchr/testify/require"
	"os"
	"strings"
	"testing"
)

func TestFileWrittenGoldenProjection(t *testing.T) {
	raw, err := os.ReadFile("../../compose/testdata/cocontracts/hint_file_written.bin")
	require.NoError(t, err)
	frame, err := Decode(raw)
	require.NoError(t, err)
	wrapper, err := Fields("hint_wrapper", frame.Payload[1:])
	require.NoError(t, err)
	hint, err := DecodeFileWritten(wrapper[1])
	require.NoError(t, err)
	require.Equal(t, "a", hint.Path)
	require.Equal(t, strings.Repeat("33", 32), hint.PostDigest)
	for n := 0; n < len(wrapper[1]); n++ {
		_, err := DecodeFileWritten(wrapper[1][:n])
		require.Error(t, err)
	}
	_, err = DecodeFileWritten(append(wrapper[1], 0))
	require.ErrorIs(t, err, TrailingBytes)
	deleted, err := DecodeFileWritten(Union(1, Field(1, String("gone.ts")), Field(2, Union(4))))
	require.NoError(t, err)
	require.Equal(t, "absent", deleted.PostDigest)
	require.Equal(t, byte(4), deleted.Actor.Kind)
}

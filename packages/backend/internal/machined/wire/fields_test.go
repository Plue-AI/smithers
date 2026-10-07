package wire

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestFieldsUsesCanonicalSchema(t *testing.T) {
	source := Struct(Field(1, Bytes([]byte("hello"))), Field(2, make([]byte, 32)), Field(3, U32(420)))
	fields, err := Fields("result2", source)
	require.NoError(t, err)
	require.Equal(t, Bytes([]byte("hello")), fields[1])
	require.Equal(t, U32(420), fields[3])
	for _, test := range []struct {
		name  string
		bytes []byte
		err   error
	}{
		{"missing", Struct(Field(1, Bytes(nil))), MissingField},
		{"unordered", Struct(Field(3, U32(1)), Field(1, Bytes(nil))), UnorderedField},
		{"unknown", Struct(Field(8, U32(1))), UnknownField},
		{"trailing", append(source, 0), TrailingBytes},
		{"truncated", source[:len(source)-1], Truncated},
	} {
		t.Run(test.name, func(t *testing.T) { _, err := Fields("result2", test.bytes); require.ErrorIs(t, err, test.err) })
	}
	_, err = Fields("invented", source)
	require.ErrorIs(t, err, BadValue)
}

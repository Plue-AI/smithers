package wire

import (
	"encoding/hex"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
)

func TestReconciledEventLiteralAndRefusals(t *testing.T) {
	raw, err := hex.DecodeString("030000002c01" + strings.Repeat("11", 20) + "02" + strings.Repeat("22", 20) + "0301")
	require.NoError(t, err)
	event, err := DecodeReconciled(raw)
	require.NoError(t, err)
	require.Equal(t, Reconciled{Old: strings.Repeat("11", 20), Onto: strings.Repeat("22", 20)}, event)
	for n := 0; n < len(raw); n++ {
		_, err := DecodeReconciled(raw[:n])
		require.Error(t, err, "truncation %d", n)
	}
	old, _ := hex.DecodeString(event.Old)
	onto, _ := hex.DecodeString(event.Onto)
	paths := append(U16(2), String("a.txt")...)
	paths = append(paths, String("dir/雪.txt")...)
	conflict := Union(3, Field(1, old), Field(2, onto), Field(3, []byte{2}), Field(4, paths))
	event, err = DecodeReconciled(conflict)
	require.NoError(t, err)
	require.True(t, event.Conflict)
	require.Equal(t, []string{"a.txt", "dir/雪.txt"}, event.Paths)
	for name, bad := range map[string][]byte{
		"trailing": append(raw, 0), "wrong variant": Union(6),
		"zero old":       Union(3, Field(1, make([]byte, 20)), Field(2, onto), Field(3, []byte{1})),
		"same heads":     Union(3, Field(1, old), Field(2, old), Field(3, []byte{1})),
		"empty conflict": Union(3, Field(1, old), Field(2, onto), Field(3, []byte{2}), Field(4, U16(0))),
		"missing paths":  Union(3, Field(1, old), Field(2, onto), Field(3, []byte{2})),
		"clean paths":    Union(3, Field(1, old), Field(2, onto), Field(3, []byte{1}), Field(4, paths)),
	} {
		t.Run(name, func(t *testing.T) { _, err := DecodeReconciled(bad); require.Error(t, err) })
	}
}

package machined

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBootItemBinding(t *testing.T) {
	a := BootAuthority{Credential: "fixture"}
	bytes, err := a.FileForItem(0, ItemBinding{Number: 2, Change: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"})
	require.NoError(t, err)
	require.True(t, strings.HasSuffix(string(bytes), "item_number=2\nitem_change=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n"))
	bytes, err = a.FileForItem(0, ItemBinding{Number: 2, Change: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", PreMoveCommit: "1234567890abcdef1234567890abcdef12345678"})
	require.NoError(t, err)
	require.True(t, strings.HasSuffix(string(bytes), "moved_off=1234567890abcdef1234567890abcdef12345678\n"))
	for _, target := range []string{"main", "1234567890ABCDEF1234567890abcdef12345678", "1234567890abcdef1234567890abcdef12345678\n"} {
		bytes, err = a.FileForItem(0, ItemBinding{Number: 2, Change: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", PreMoveCommit: target})
		require.Error(t, err)
		require.Nil(t, bytes)
	}
	bytes, err = a.FileForItem(0, ItemBinding{})
	require.NoError(t, err)
	require.True(t, strings.HasSuffix(string(bytes), "item_number=0\n"))
	for _, item := range []ItemBinding{{Number: 2}, {Number: 2, Change: "main"}, {Number: 2, Change: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n"}, {Change: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"}} {
		bytes, err = a.FileForItem(0, item)
		require.Error(t, err)
		require.Nil(t, bytes)
	}
}

package routes

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDecodeDocumentRestore(t *testing.T) {
	for _, value := range []string{"", "last live text\n", strings.Repeat("x", 1048576)} {
		raw, err := json.Marshal(map[string]any{"action": "restore-deleted", "version": strings.Repeat("a", 40), "base_digest": "absent", "text": value})
		require.NoError(t, err)
		input, command, err := DecodeFileRestore(strings.NewReader(string(raw)))
		require.NoError(t, err)
		require.Equal(t, "file.restore-deleted", command)
		require.NotNil(t, input.Text)
		require.Equal(t, value, *input.Text)
	}
	for _, raw := range []string{
		`{"action":"restore","text":"replacement"}`,
		`{"action":"restore-deleted","text":17}`,
		`{"action":"restore-deleted","text":"replacement","actor":"forged"}`,
		`{"action":"restore-deleted","text":"replacement"}{}`,
	} {
		_, _, err := DecodeFileRestore(strings.NewReader(raw))
		require.Error(t, err, raw)
	}
	raw, err := json.Marshal(map[string]any{"action": "restore-deleted", "text": strings.Repeat("x", 1048577)})
	require.NoError(t, err)
	_, _, err = DecodeFileRestore(strings.NewReader(string(raw)))
	require.Error(t, err)
	input, command, err := DecodeFileRestore(strings.NewReader(`{"action":"restore-deleted","version":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","base_digest":"absent"}`))
	require.NoError(t, err)
	require.Nil(t, input.Text, "S2 keeps the retained before-version")
	require.Equal(t, "file.restore-deleted", command)
}

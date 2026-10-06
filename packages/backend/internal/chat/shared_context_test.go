package chat

import (
	"encoding/json"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
)

func TestSharedContextOnlyCompletedSelection(t *testing.T) {
	for _, phase := range []string{"", "completed"} {
		raw := literalPreflight
		if phase != "" {
			raw = strings.Replace(raw, `"type":"context.preflight"`, `"type":"context.preflight","phase":"completed"`, 1)
		}
		require.Len(t, sharedContext(json.RawMessage(raw)), 1)
	}
	for _, raw := range []string{"{", `{"type":"done"}`, strings.Replace(literalPreflight, `"type":"context.preflight"`, `"type":"context.preflight","phase":"started"`, 1)} {
		require.Nil(t, sharedContext(json.RawMessage(raw)))
	}
	require.Empty(t, sharedContext(json.RawMessage(`{"type":"context.preflight","phase":"completed","result":{"context":[]}}`)))
	empty := []json.RawMessage{}
	encoded, err := json.Marshal(SharedTurn{Context: &empty})
	require.NoError(t, err)
	require.Contains(t, string(encoded), `"context":[]`)
	// Old entries still omit context rather than gaining a synthetic preflight.
	raw, err := json.Marshal(SharedTurn{Frames: []json.RawMessage{}})
	require.NoError(t, err)
	require.NotContains(t, string(raw), `"context"`)
}

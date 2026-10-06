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

func TestSharedPreflightPagesNeverExposePartialSelections(t *testing.T) {
	page := func(index, total int, phase, model string, ms int) json.RawMessage {
		raw, err := json.Marshal(map[string]any{"type": "context.preflight", "runId": "r", "phase": phase,
			"page": map[string]int{"index": index, "total": total}, "result": map[string]any{"model": model, "durationMs": ms, "candidates": []any{}, "context": []any{map[string]string{"kind": "todo", "label": "T1", "ref": "T1", "reason": "Selected", "private": "canary"}}}})
		require.NoError(t, err)
		return raw
	}
	var projection sharedPreflight
	require.NoError(t, projection.apply(page(0, 2, "completed", "fast", 4)))
	require.Nil(t, projection.context)
	for _, invalid := range []json.RawMessage{page(1, 3, "completed", "fast", 4), page(1, 2, "started", "fast", 4), page(1, 2, "completed", "other", 4), page(1, 2, "completed", "fast", 5)} {
		require.ErrorIs(t, projection.apply(invalid), ErrInvalidFrame)
		require.Nil(t, projection.context)
	}
	require.NoError(t, projection.apply(page(1, 2, "completed", "fast", 4)))
	require.Len(t, *projection.context, 2)
	require.NotContains(t, string((*projection.context)[0]), "canary")
	require.ErrorIs(t, projection.apply(page(1, 2, "completed", "fast", 4)), ErrInvalidFrame)
	require.NoError(t, projection.apply(page(0, 1, "started", "fast", 0)))
	require.Nil(t, projection.context)
	require.NoError(t, projection.apply(json.RawMessage(literalPreflight)))
	require.Len(t, *projection.context, 1)
	require.NoError(t, projection.apply(json.RawMessage(`{"type":"done"}`)))
	require.Len(t, *projection.context, 1)
	for _, invalid := range []json.RawMessage{json.RawMessage("{"), page(-1, 2, "completed", "fast", 1), page(0, 0, "completed", "fast", 1), page(0, 1, "", "fast", 1)} {
		require.ErrorIs(t, projection.apply(invalid), ErrInvalidFrame)
	}
}

func TestSharedEntryLabels(t *testing.T) {
	for _, test := range []struct {
		state State
		tone  string
	}{
		{StateAccepted, "live"}, {StateRunning, "live"}, {StateFailed, "failed"},
		{StateCompleted, "done"}, {StateCancelled, "quiet"}, {StateUncertain, "quiet"},
	} {
		require.Equal(t, test.tone, entryTone(test.state))
	}
	require.Equal(t, "Choose timeout", entryTitle("\n  Choose timeout  \nDetails"))
	require.Equal(t, "", entryTitle(" \n\t"))
}

package errors

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestUnknownCursorIsAConflictThatAsksForAResync(t *testing.T) {
	refusal := UnknownCursor("cursor is ahead of the journal")
	require.Equal(t, CodeConflict, refusal.Code)
	require.Equal(t, map[string]any{"reason": UnknownCursorReason, "resync": true}, refusal.Details)
	require.True(t, IsUnknownCursor(refusal))
	require.True(t, IsUnknownCursor(fmt.Errorf("replay: %w", refusal)), "a wrapped refusal stays recognisable")
}

func TestIsUnknownCursorRejectsEveryOtherError(t *testing.T) {
	plain := Conflict("the resource is busy")
	other := Conflict("x")
	other.Details = map[string]any{"reason": "something_else"}
	wrongCode := BadRequest("y")
	wrongCode.Details = map[string]any{"reason": UnknownCursorReason}
	for name, err := range map[string]error{
		"nil":                  nil,
		"not an API error":     fmt.Errorf("boom"),
		"plain conflict":       plain,
		"other reason":         other,
		"reason on wrong code": wrongCode,
	} {
		require.False(t, IsUnknownCursor(err), name)
	}
}

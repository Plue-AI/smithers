package compose

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestMonitorThrashMarksItsFailedReceiptOnly(t *testing.T) {
	var value map[string]any
	require.NoError(t, json.Unmarshal([]byte(`{"attempts":[
	{"phases":[{"step":"old","title":"Ran checks · 1 failed","tone":"fail"}]},
	{"steps":[{"key":"failing","output":"{\"checkId\":\"unit\",\"status\":\"failed\"}"},
	{"key":"passing","output":"{\"checkId\":\"other\",\"status\":\"passed\"}"}],
	"phases":[{"step":"failing","title":"Ran checks · 1 failed","tone":"fail"},
	{"step":"passing","title":"Ran checks","tone":"ok"}]}]}`), &value))
	markMonitorThrash(value, "unit")
	attempts := value["attempts"].([]any)
	old := attempts[0].(map[string]any)["phases"].([]any)[0].(map[string]any)
	current := attempts[1].(map[string]any)["phases"].([]any)
	require.Equal(t, "fail", old["tone"])
	require.NotContains(t, old, "indicator")
	require.Equal(t, "thrash", current[0].(map[string]any)["tone"])
	require.Equal(t, "Thrashing: unit failed 3×", current[0].(map[string]any)["indicator"])
	require.Equal(t, "ok", current[1].(map[string]any)["tone"])
	require.NotContains(t, current[1].(map[string]any), "indicator")
}

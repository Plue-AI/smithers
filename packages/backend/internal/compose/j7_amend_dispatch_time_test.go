package compose

import (
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestJ7AmendDispatchCutoff(t *testing.T) {
	admitted := time.Date(2026, 10, 8, 18, 0, 0, 0, time.UTC)
	turn := func(key string, offset time.Duration) map[string]any {
		return map[string]any{"hold": key, "dispatchAt": admitted.Add(offset).Format(time.RFC3339Nano)}
	}
	turns := []map[string]any{turn("t2", -time.Minute), turn("tn", time.Second), turn("t2", 0), turn("t2", time.Second)}
	index, err := firstHeldTurnAfterAdmission(turns, "t2", admitted)
	require.NoError(t, err)
	require.Equal(t, 2, index, "skip pre-admission retries and other TODOs; retain the very first post-admission dispatch")
	index, err = firstHeldTurnAfterAdmission(turns, "t2", admitted.Add(350*time.Microsecond))
	require.NoError(t, err)
	require.Equal(t, 2, index, "timestamp rounding must not skip the earliest possible post-admission dispatch")
	index, err = firstHeldTurnAfterAdmission(turns[:2], "t2", admitted)
	require.NoError(t, err)
	require.Equal(t, -1, index)
	for _, malformed := range []map[string]any{{"hold": "t2"}, {"hold": "t2", "dispatchAt": "not-a-time"}} {
		index, err = firstHeldTurnAfterAdmission([]map[string]any{malformed}, "t2", admitted)
		require.Error(t, err)
		require.Equal(t, -1, index, "missing evidence refuses qualification")
	}
}

package microsandbox

import (
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestTerminalManagerHoldOverridesStaleIdleObservation(t *testing.T) {
	r, p := admissionFixture()
	_, err := r.Request("todo", "A", "T1", "run")
	require.NoError(t, err)
	_, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	held := true
	r.SetTerminalHoldSource(func(holder string) bool { return holder == "A" && held })
	now := time.Now()
	observations := []AdmissionSafety{{Holder: "A", IdleSince: now.Add(-time.Hour), PresenceKnown: true, SessionsKnown: true, RunKnown: true}}
	require.Empty(t, r.AdmissionIdleRelease(now, now.Add(-time.Minute), observations))
	held = false
	require.Equal(t, "A", r.AdmissionIdleRelease(now, now.Add(-time.Minute), observations))
}

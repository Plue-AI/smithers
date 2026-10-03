package services

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestSetupPreRunObservationSafeStateAndLegacyTime(t *testing.T) {
	for _, state := range []jobs.State{jobs.StateAccepted, jobs.StateWaiting, jobs.StateCompleted, jobs.StateFailed, jobs.StateCancelled} {
		for _, timestamp := range []int64{-1, 0, 123} {
			before := time.Now().UnixMilli()
			observation := setupPreRunObservation(flowdispatch.RuntimeCheckpoint{FailureCode: "token=private host=http://internal", FailureObservedAt: timestamp}, state)
			require.NotNil(t, observation)
			if state.Terminal() {
				require.Equal(t, "failed", observation.State)
				require.Equal(t, "runtime_unrecoverable", observation.Code)
			} else {
				require.Equal(t, "blocked", observation.State)
				require.Equal(t, "runtime_unavailable", observation.Code)
			}
			if timestamp > 0 {
				require.Equal(t, timestamp, observation.ObservedAt)
			} else {
				require.GreaterOrEqual(t, observation.ObservedAt, before)
				require.LessOrEqual(t, observation.ObservedAt, time.Now().UnixMilli())
			}
			raw, err := json.Marshal(observation)
			require.NoError(t, err)
			require.NotContains(t, string(raw), "private")
			require.NotContains(t, string(raw), "internal")
		}
	}
	for _, checkpoint := range []flowdispatch.RuntimeCheckpoint{{}, {RunID: "run", FailureCode: "error"}, {Run: &flowruntime.Run{}, FailureCode: "error"}} {
		require.Nil(t, setupPreRunObservation(checkpoint, jobs.StateWaiting), "accepted run state owns its own receipt")
	}
}

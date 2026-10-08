package services

import (
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestMythicalSourceRefusalOutcome(t *testing.T) {
	for _, tc := range []struct{ output, suffix string }{
		{`{"message":"source_refused: reserved_live_tree_mismatch"}`, ": reserved_live_tree_mismatch"},
		{`{"message":"identity refused (source_refused: workspace_owner_mismatch)"}`, ": workspace_owner_mismatch"},
		{`{"message":"private-token"}`, ""},
		{`{"message":"source_refused: unsafe/value"}`, ""},
	} {
		run := &flowruntime.Run{FailureFault: "user", FailureTag: "coding/NativeCodingError/source_refused", FinalOutput: &tc.output}
		outcome := mythicalFailedOutcome(flowdispatch.ProjectionUpdate{Checkpoint: flowdispatch.RuntimeCheckpoint{Run: run}})
		require.Equal(t, mythicalStopped+"user: coding/NativeCodingError/source_refused"+tc.suffix, outcome)
	}
}

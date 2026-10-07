package flowdispatch

import (
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/stretchr/testify/require"
)

func TestRunMutationReceiptsStayBoundToTheirInput(t *testing.T) {
	for _, operation := range []string{"signal", "steer"} {
		for _, tag := range []string{"Accepted", "AlreadyApplied", "Terminal"} {
			t.Run(operation+"/"+tag, func(t *testing.T) {
				result := flowruntime.MutationResult{Operation: operation, ApplicationRequestID: "input-1",
					Receipt: flowruntime.Receipt{Tag: tag, ReceiptID: "receipt-1", RunID: "run-1"}}
				require.True(t, validRunMutationResult(result, operation, "input-1", "run-1"))
				require.False(t, validRunMutationResult(result, operation, "input-2", "run-1"))
				require.False(t, validRunMutationResult(result, operation, "input-1", "run-2"))
				require.False(t, validRunMutationResult(result, "other", "input-1", "run-1"))
				// Control's generic receipt schema makes runId optional; the
				// handler separately requires it on terminal refusals.
				result.Receipt.RunID = ""
				require.True(t, validRunMutationResult(result, operation, "input-1", "run-1"))
				result.Receipt.Tag = "Parked"
				require.False(t, validRunMutationResult(result, operation, "input-1", "run-1"))
			})
		}
	}
}

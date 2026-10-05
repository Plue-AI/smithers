//go:build smithers_preview

package services

import (
	"context"
	"testing"

	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestPreviewWorkflowAdmissionFailsClosed(t *testing.T) {
	for _, options := range [][]WorkflowRunServiceOption{nil, {WithWorkflowRunMachineRuntime(workspace.NewDisabled())}} {
		service := NewWorkflowRunService(nil, options...)
		ctx := context.Background()
		t.Run("dispatch", func(t *testing.T) {
			_, err := service.DispatchForEvent(ctx, DispatchForEventInput{})
			require.EqualError(t, err, "Machines are off in this preview.")
		})
		t.Run("rerun", func(t *testing.T) {
			_, err := service.RerunRun(ctx, RerunInput{})
			require.EqualError(t, err, "Machines are off in this preview.")
		})
		t.Run("resume", func(t *testing.T) {
			require.EqualError(t, service.ResumeRun(ctx, 1, 1), "Machines are off in this preview.")
		})
	}
}

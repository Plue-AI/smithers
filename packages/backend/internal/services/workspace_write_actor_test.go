package services

import (
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestWorkspaceRuntimeWriteActor(t *testing.T) {
	for _, automated := range []bool{false, true} {
		ctx := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{TokenSystemIssued: automated})
		s := &WorkspaceService{}
		bound, err := s.workspaceRuntimeContext(ctx, db.Workspace{UserID: 1}, 2, "write")
		require.NoError(t, err)
		op, ok := workspaceapi.OperationFromContext(bound)
		require.True(t, ok)
		require.Equal(t, workspaceapi.Operation{TenantID: "1", PrincipalID: "2", OperationID: "write", Automated: automated}, op)
	}
}

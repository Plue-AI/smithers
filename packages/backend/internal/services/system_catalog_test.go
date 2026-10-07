package services

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestSystemCatalogDescriptorsNeverGrantPersonAuthority(t *testing.T) {
	for _, command := range []string{"stack.candidate", "stack.propose", "workspace.head", "workspace.children.list", "workspace.children.spawn", "workspace.children.stop", "workspace.provider-pool"} {
		t.Run(command, func(t *testing.T) {
			policy, ok := OperationPolicy(command)
			require.True(t, ok)
			require.Equal(t, "hidden", policy.Visibility)
			require.Empty(t, policy.Actors)
			require.Equal(t, "never", policy.Agent)
			for _, info := range []*middleware.AuthInfo{
				{User: &db.User{ID: 1}, SessionHash: "session"},
				{User: &db.User{ID: 1}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "all,via:codex", Scopes: middleware.ParseTokenScopes("all,via:codex")},
			} {
				_, err := Authorize(middleware.ContextWithAuthInfo(context.Background(), info), nil, command, InstallSubject{RepositoryID: 1, WorkspaceID: "workspace", RunID: "run", PayloadDigest: "payload"})
				var denied *AccessError
				require.ErrorAs(t, err, &denied)
				require.Equal(t, 403, denied.Status)
			}
		})
	}
	// A future hidden system row has no fallback to owner/session handling.
	operationCatalog["test.unregistered-system"] = CatalogPolicy{Agent: "never", Visibility: "hidden", MinimumRole: "owner"}
	defer delete(operationCatalog, "test.unregistered-system")
	_, err := Authorize(middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: 1}, SessionHash: "session"}), nil, "test.unregistered-system")
	var denied *AccessError
	require.ErrorAs(t, err, &denied)
	require.Equal(t, 403, denied.Status)
}

// Absence of a descriptor cannot be bypassed by an execution-specialized path.
func TestExecutionCommandsRequireCatalogDescriptor(t *testing.T) {
	for _, command := range []string{"workspace.head", "workspace.children.list", "workspace.children.spawn", "workspace.children.stop", "workspace.provider-pool", "stack.candidate", "stack.propose", "flow.source-coedit", "branch.fork", "branch.read", "todo.read"} {
		t.Run(command, func(t *testing.T) {
			saved, exists := operationCatalog[command]
			require.True(t, exists)
			delete(operationCatalog, command)
			defer func() { operationCatalog[command] = saved }()
			_, err := Authorize(context.Background(), nil, command)
			var denied *AccessError
			require.ErrorAs(t, err, &denied)
			require.Equal(t, 403, denied.Status)
			require.Equal(t, "permission", denied.Code)
		})
	}
}

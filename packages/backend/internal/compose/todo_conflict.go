package compose

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// The same binding is used by the install and composed HTTP rehearsals.
func bindConflictValidator(todos *services.MythicalService, workspaces *services.WorkspaceService, inspect func(context.Context, string, string, string) ([]string, error)) {
	todos.SetConflictValidator(&services.WorkspaceConflictValidator{Workspaces: workspaces, Inspect: inspect})
}

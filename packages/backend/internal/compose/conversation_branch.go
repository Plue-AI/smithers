package compose

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// The installed repository's main conversation exists before any machine.
// Every other branch uses the same authorized workspace binding as presence
// and files; reading it neither wakes a machine nor executes repository code.
func conversationBranchResolver(branches *services.WorkspaceService) func(context.Context, chat.Scope, string) (string, error) {
	return func(ctx context.Context, scope chat.Scope, branch string) (string, error) {
		if branch == "main" {
			return "main", nil
		}
		row, err := branches.PresenceBranch(ctx, branch, scope.RepositoryID, scope.UserID)
		if err != nil {
			return "", err
		}
		if row.TargetBookmark == "main" {
			return "main", nil
		}
		return row.ID, nil
	}
}

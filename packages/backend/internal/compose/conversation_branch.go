package compose

import (
	"context"
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/internal/db"

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

// The live member topic and the install composition use the same persisted,
// credential-bound reader; resolving a view never launches a machine.
func conversationLiveViewState(queries *db.Queries, store *chat.Store, branches *services.WorkspaceService) func(context.Context, int64, string) (json.RawMessage, error) {
	resolveBranch := conversationBranchResolver(branches)
	return func(ctx context.Context, member int64, branch string) (json.RawMessage, error) {
		repository, _, err := installRepository(ctx, queries)
		if err != nil {
			return nil, err
		}
		canonical, err := resolveBranch(ctx, chat.Scope{RepositoryID: repository, UserID: member}, branch)
		if err != nil {
			return nil, err
		}
		return store.ReadMemberViewState(ctx, member, canonical)
	}
}

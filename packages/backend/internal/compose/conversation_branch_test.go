package compose

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// Run 12: `/review #2` named "branch-main" and the route answered a generic
// 503. The branch store's 4xx refusal keeps its status and cause for every
// door (the HTTP answer is in testInstallReviewHTTPAdmission); a fault stays
// a fault.
func TestConversationRefusalNamesTheCause(t *testing.T) {
	for _, tc := range []struct {
		name        string
		store       *pkgerrors.APIError
		status      int
		code, class string
		message     string
	}{
		{"unknown branch", pkgerrors.NotFound("branch not found"), 404, "conversation_not_found", "user", `Conversation "branch-main" not found`},
		{"unreadable branch", pkgerrors.Forbidden("workspace access denied"), 403, "conversation_refused", "permission", "workspace access denied"},
		{"invalid branch", pkgerrors.BadRequest("invalid branch"), 400, "conversation_refused", "user", "invalid branch"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := conversationRefusal("branch-main", tc.store)
			var typed *services.TodoControlError
			require.ErrorAs(t, err, &typed)
			require.Equal(t, []any{tc.status, tc.code, tc.class, tc.message}, []any{typed.Status, typed.Code, typed.Class, typed.Message})
			var store *pkgerrors.APIError
			require.ErrorAs(t, err, &store, "the chat routes still write the store's own refusal")
			require.Same(t, tc.store, store)
		})
	}
	for _, fault := range []error{pkgerrors.Internal("database unavailable"), pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch store unavailable"), errors.New("connection reset")} {
		require.Same(t, fault, conversationRefusal("branch-main", fault), "a fault is never typed as the person's refusal")
	}
}

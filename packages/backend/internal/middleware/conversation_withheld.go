package middleware

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// OutsiderWorkspaces reports whether a workspace ever ran work started from
// an outsider's text (the permanent outsider_workspaces mark).
type OutsiderWorkspaces interface {
	IsOutsiderWorkspace(ctx context.Context, workspaceID string) (bool, error)
}

type conversationWithheldKey struct{}

// ConversationWithheld reports whether the request's credential belongs to a
// box that ran work started from an outsider's approved text. That work reads
// the approved copy pinned in its inputs, never the live issue, comments or
// pull request conversation, which the outsider may have edited since. The
// box's credentials name their workspace (landing-workspace: on the coding
// host's landing token, workspace: on the others), and an SSE ticket keeps
// its minting token's scopes, so the binding is read from the raw scopes
// whoever issued them. The check runs per request because a box's token can
// predate the box's first outsider run. The platform's sync credential never
// runs in a box.
func ConversationWithheld(ctx context.Context, store OutsiderWorkspaces) (bool, error) {
	info := AuthInfoFromContext(ctx)
	if store == nil || info == nil || !info.IsTokenAuth || info.CredentialKind() == CredentialSync {
		return false, nil
	}
	for _, workspace := range []string{ParseTokenLandingWorkspace(info.RawScopes), ParseTokenWorkspaceRestriction(info.RawScopes)} {
		if workspace == "" {
			continue
		}
		marked, err := store.IsOutsiderWorkspace(ctx, workspace)
		if err != nil || marked {
			return marked, err
		}
	}
	return false, nil
}

// WithholdConversation refuses issue and conversation routes to a request
// ConversationWithheld names. It fails closed when the mark cannot be read.
func WithholdConversation(store OutsiderWorkspaces) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			withheld, err := ConversationWithheld(r.Context(), store)
			if err != nil {
				errors.WriteError(w, errors.Internal("could not verify the credential's workspace").WithCause(err))
				return
			}
			if withheld {
				errors.WriteError(w, errors.Forbidden("a run started from an outsider's text works from its approved copy, not the live conversation"))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ResolveConversationWithheld records ConversationWithheld for a route that
// withholds part of its answer itself (the GitHub proxy). It fails closed
// when the mark cannot be read.
func ResolveConversationWithheld(store OutsiderWorkspaces) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			withheld, err := ConversationWithheld(r.Context(), store)
			if err != nil {
				errors.WriteError(w, errors.Internal("could not verify the credential's workspace").WithCause(err))
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), conversationWithheldKey{}, withheld)))
		})
	}
}

// ConversationWithheldFromContext is ResolveConversationWithheld's verdict.
func ConversationWithheldFromContext(ctx context.Context) bool {
	withheld, _ := ctx.Value(conversationWithheldKey{}).(bool)
	return withheld
}

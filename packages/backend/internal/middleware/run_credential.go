package middleware

import (
	"context"
	"net/http"
	"strings"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// CredentialKind says who holds an access token.
type CredentialKind string

const (
	// CredentialPerson is a token a person created (a personal access token
	// or the one behind an OAuth2 grant).
	CredentialPerson CredentialKind = "person"
	// CredentialAgentRun is a system-issued token handed to a computer that
	// runs code or instructions nobody has reviewed: an agent computer, a
	// workspace, a workflow job, a gateway. It is the kind every
	// system-issued token has unless it is issued as CredentialSync.
	CredentialAgentRun CredentialKind = "run"
	// CredentialSync is a system-issued token only the platform's own
	// GitHub import and mirror code holds, on the server, to copy a GitHub
	// repository's refs. No agent or workflow ever receives one.
	CredentialSync CredentialKind = "sync"
	// CredentialPlatform is not a token: it marks the API's own verified
	// write of the default bookmark, the GitHub main pull's fast-forward to
	// GitHub's reviewed tip.
	CredentialPlatform CredentialKind = "platform"
)

// syncCredentialScope marks a system-issued token as CredentialSync. Like the
// other binding entries it grants no permission (ParseTokenScopes drops it),
// and a person cannot request it (it is not a TokenScope). It counts only on a
// system-issued token.
const syncCredentialScope = "credential:sync"

// SyncCredentialScope returns the scopes-list entry that issues a
// system token as CredentialSync.
func SyncCredentialScope() string { return syncCredentialScope }

// TokenCredentialKind classifies an access token from its stored fields.
func TokenCredentialKind(systemIssued bool, rawScopes string) CredentialKind {
	if !systemIssued {
		return CredentialPerson
	}
	for _, part := range tokenScopeEntries(rawScopes) {
		if strings.EqualFold(strings.TrimSpace(part), syncCredentialScope) {
			return CredentialSync
		}
	}
	return CredentialAgentRun
}

// ParseCredentialKind reads a kind another service recorded. Empty stays
// empty (unattributed); an unknown value is read as an agent run's, the most
// restricted kind.
func ParseCredentialKind(raw string) CredentialKind {
	switch kind := CredentialKind(strings.TrimSpace(raw)); kind {
	case "", CredentialPerson, CredentialAgentRun, CredentialSync, CredentialPlatform:
		return kind
	default:
		return CredentialAgentRun
	}
}

// Reviewed reports whether a write with this kind is a person's or the
// API's own verified one. Every other kind, unattributed included, runs no
// cache-saving workflow and applies no administrator setting.
func (k CredentialKind) Reviewed() bool {
	return k == CredentialPerson || k == CredentialPlatform
}

// CredentialKind reports who holds the request's credential. A session, and
// any request without a token, is a person's.
func (a *AuthInfo) CredentialKind() CredentialKind {
	if a == nil || !a.IsTokenAuth {
		return CredentialPerson
	}
	return TokenCredentialKind(a.TokenSystemIssued, a.RawScopes)
}

// IsRunCredential reports whether the request authenticated with a
// system-issued credential of either kind: an agent run's token, or the
// platform's sync token. It acts as the user who owns the run or the import,
// but no person is making the request.
func (a *AuthInfo) IsRunCredential() bool {
	return a != nil && a.IsTokenAuth && a.TokenSystemIssued
}

// RequirePerson refuses a run credential on a decision only a person may
// take: one that clears a landing blocker or satisfies a human requirement
// (acknowledging a review comment, dismissing a person's review, landing or
// queueing someone else's landing, reporting a commit status, deciding an
// approval), and the person-owned routes behind RefuseRunCredentials. It is
// the one check for that rule. action completes "a run credential cannot ...".
func RequirePerson(ctx context.Context, action string) error {
	if AuthInfoFromContext(ctx).IsRunCredential() {
		return apierrors.Forbidden("a run credential cannot " + action)
	}
	return nil
}

// RefuseRunCredentials applies RequirePerson to a whole route: managing build
// cache read tokens (a run could revoke the committed read token or mint one
// for itself), clearing workflow caches, starting, rerunning or resuming
// workflow runs (a run could start the default bookmark's workflows with
// inputs it chooses, and their caches are what every later run restores),
// deciding human approvals, and reporting commit statuses.
func RefuseRunCredentials(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := RequirePerson(r.Context(), "use this endpoint"); err != nil {
			apierrors.WriteError(w, err.(*apierrors.APIError))
			return
		}
		next.ServeHTTP(w, r)
	})
}

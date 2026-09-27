package middleware

import (
	"net/http"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// IsRunCredential reports whether the request authenticated with a
// system-issued run credential: the per-run token an agent computer holds, or
// a clone or landing credential. It acts as the user who owns the run, but
// the run executes code and instructions nobody has reviewed.
func (a *AuthInfo) IsRunCredential() bool {
	return a != nil && a.IsTokenAuth && a.TokenSystemIssued
}

// RefuseRunCredentials refuses a run credential on routes that belong to a
// person: managing build cache read tokens (a run could revoke the committed
// read token or mint one for itself), clearing workflow caches, and starting,
// rerunning or resuming workflow runs (a run could start the default
// bookmark's workflows with inputs it chooses, and their caches are what
// every later run restores).
func RefuseRunCredentials(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if AuthInfoFromContext(r.Context()).IsRunCredential() {
			apierrors.WriteError(w, apierrors.Forbidden("a run credential cannot use this endpoint"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

package compose

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// delegatedAttribution records every request a delegated credential makes
// once the auth loader admitted it (spec §5.3.0, T-ACC-04): the person, the
// stored kind, and the via it is attributed to, so an agent's read or write
// shows as "Claude Code for Ben". The Smithers-Via hint picks only that via
// (middleware.EffectiveVia); it selects no person, branch or scope.
func delegatedAttribution(audit *services.AuditService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			info := middleware.AuthInfoFromContext(r.Context())
			delegation, ok := info.Delegation()
			if !ok || audit == nil || info.User == nil {
				next.ServeHTTP(w, r)
				return
			}
			actor := info.User.ID
			metadata := map[string]any{
				"kind":       string(middleware.CredentialDelegated),
				"via":        middleware.EffectiveVia(delegation.Via, r.Header.Get("Smithers-Via")),
				"stored_via": delegation.Via,
				"token_id":   info.TokenID,
			}
			for name, value := range map[string]string{"branch": delegation.Branch, "profile": delegation.Profile, "session": delegation.Session} {
				if value != "" {
					metadata[name] = value
				}
			}
			audit.Log(context.WithoutCancel(r.Context()), services.AuditEvent{
				EventType: "delegated.request", ActorID: &actor, ActorName: info.User.Username,
				TargetType: "route", TargetName: r.URL.Path, Action: r.Method, Metadata: metadata,
			})
			next.ServeHTTP(w, r)
		})
	}
}

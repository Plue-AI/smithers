package middleware

import (
	"context"
	"net/http"
)

type terminalTokenLookupKey struct{}
type TerminalTokenLookup func(context.Context, string) (*AuthInfo, error)

// WithTerminalTokenLookup binds an install-local authority before AuthLoader.
// S1 SQL validation remains available for persisted history and older sessions.
func WithTerminalTokenLookup(lookup TerminalTokenLookup) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), terminalTokenLookupKey{}, lookup)))
		})
	}
}

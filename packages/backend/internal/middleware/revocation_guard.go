package middleware

import (
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// RevocationChecker is the cheap per-request view of recent revocations, kept
// in memory by the revocation bus and invalidated by its fan-out.
type RevocationChecker interface {
	IsTokenRevoked(tokenHash string) bool
	IsUserDisabled(userID int64) bool
	IsBrowserSessionRevoked(sessionHash string) bool
}

// RevocationGuard refuses a request whose credential was revoked after the
// AuthLoader resolved it. The database already refuses a deleted token on the
// next lookup; this closes the window for anything the loader cached or that
// arrives through a ticket minted from a token that no longer exists, and it
// refuses a disabled user on every credential path with one rule. It must run
// after AuthLoader and before any handler.
func RevocationGuard(checker RevocationChecker) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if checker == nil {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authInfo := AuthInfoFromContext(r.Context())
			if authInfo != nil {
				if authInfo.IsTokenAuth && authInfo.TokenHash != "" && checker.IsTokenRevoked(authInfo.TokenHash) {
					errors.WriteError(w, errors.Unauthorized("token revoked"))
					return
				}
				if authInfo.SessionHash != "" && checker.IsBrowserSessionRevoked(authInfo.SessionHash) {
					errors.WriteError(w, errors.Unauthorized("session revoked"))
					return
				}
				if authInfo.User != nil && checker.IsUserDisabled(authInfo.User.ID) {
					errors.WriteError(w, errors.Forbidden("account is suspended"))
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

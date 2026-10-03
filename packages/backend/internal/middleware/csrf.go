package middleware

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// CSRFCookieName is the double-submit cookie name shared by the CSRF
// middleware and every route/middleware that mints or clears it.
const CSRFCookieName = "__csrf"

// NewCSRFToken generates a cryptographically secure random CSRF token,
// hex-encoded from 32 random bytes (same entropy as the session key).
func NewCSRFToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("NewCSRFToken: failed to read random bytes: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// SetCSRFCookie sets the double-submit CSRF cookie, scoped to expire at the
// same time as the auth session cookie it accompanies. HttpOnly is
// deliberately false so client-side JS can read the value and echo it back
// in the X-CSRF-Token header.
func SetCSRFCookie(w http.ResponseWriter, token string, secure bool, expiresAt time.Time, requests ...*http.Request) {
	sameSite := http.SameSiteStrictMode
	if len(requests) > 0 && EffectiveOrigin(requests[0].Context()) != "" {
		sameSite = http.SameSiteLaxMode
		secure = CookieSecure(requests[0], secure)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     CSRFCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: false,
		Secure:   secure,
		SameSite: sameSite,
		Expires:  expiresAt,
		MaxAge:   int(time.Until(expiresAt).Seconds()),
	})
}

// CSRF returns middleware that validates CSRF tokens for session-authenticated
// state-changing requests. Token-authenticated requests and anonymous requests
// are exempt from CSRF validation.
//
// According to the spec middleware stack (position #9), CSRF runs after
// AuthLoader (position #8) and checks:
// 1. Safe methods (GET, HEAD, OPTIONS) bypass CSRF
// 2. Token-authenticated requests (AuthInfo.IsTokenAuth == true) bypass CSRF
// 3. Anonymous requests (no AuthInfo or no User) bypass CSRF
// 4. Session-authenticated state-changing requests require X-CSRF-Token header
func CSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Safe methods bypass CSRF protection
		if isSafeMethod(r.Method) {
			next.ServeHTTP(w, r)
			return
		}
		enforceCSRF(w, r, next)
	})
}

// enforceCSRF validates the double-submit token for session-authenticated
// requests and forwards to next; anonymous and token-authenticated requests
// are exempt (no ambient cookie credential to forge).
func enforceCSRF(w http.ResponseWriter, r *http.Request, next http.Handler) {
	// Check if request is authenticated
	authInfo := AuthInfoFromContext(r.Context())
	if authInfo == nil || authInfo.User == nil {
		// Anonymous request - no session to protect
		next.ServeHTTP(w, r)
		return
	}

	// Token-authenticated requests bypass CSRF (stateless auth)
	if authInfo.IsTokenAuth {
		next.ServeHTTP(w, r)
		return
	}

	if !CheckInstallCookieOrigin(w, r) {
		return
	}

	// Session-authenticated state-changing request - validate CSRF token
	csrfToken := r.Header.Get("X-CSRF-Token")
	if csrfToken == "" {
		errors.WriteError(w, csrfError(r, "csrf token missing"))
		return
	}

	csrfCookie, err := r.Cookie(CSRFCookieName)
	if err != nil || csrfCookie.Value == "" {
		errors.WriteError(w, csrfError(r, "csrf token mismatch"))
		return
	}

	if subtle.ConstantTimeCompare([]byte(csrfCookie.Value), []byte(csrfToken)) != 1 {
		errors.WriteError(w, csrfError(r, "csrf token mismatch"))
		return
	}

	next.ServeHTTP(w, r)
}

// isSafeMethod returns true for HTTP methods that are safe (read-only)
// and do not require CSRF protection per RFC 7231.
func isSafeMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	default:
		return false
	}
}

func csrfError(r *http.Request, message string) *errors.APIError {
	if EffectiveOrigin(r.Context()) != "" {
		return errors.New(errors.CodeCSRF, message)
	}
	return errors.Forbidden(message)
}

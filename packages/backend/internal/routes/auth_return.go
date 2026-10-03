package routes

import (
	"crypto/subtle"
	"encoding/base64"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const browserReturnCookieName = "smithers_return_to"

// The API's public origin also serves Git and runtime clients and can differ
// from the browser callback origin. Session cookies belong to the latter.
func (h *AuthHandler) githubBrowserOrigin() string {
	callback, err := url.Parse(strings.TrimSpace(h.AuthConfig.GitHubRedirectURL))
	if err == nil && callback.Host != "" && callback.User == nil && (callback.Scheme == "http" || callback.Scheme == "https") {
		return callback.Scheme + "://" + callback.Host
	}
	return strings.TrimRight(strings.TrimSpace(h.PublicOrigin), "/")
}

// Only a path on the origin receiving the callback is eligible. Check decoded
// characters too, so URL normalization cannot turn a backslash or leading slash
// escape into a network-path redirect.
func validBrowserReturn(target string) bool {
	if target == "" || len(target) > 1536 || !strings.HasPrefix(target, "/") || strings.HasPrefix(target, "//") {
		return false
	}
	decoded, err := url.PathUnescape(target)
	if err != nil || strings.HasPrefix(decoded, "//") {
		return false
	}
	for _, c := range decoded {
		if c == '\\' || c < 32 || c == 127 {
			return false
		}
	}
	parsed, err := url.Parse(target)
	return err == nil && !parsed.IsAbs() && parsed.Host == "" && parsed.User == nil
}

func browserReturnCookie(value string, secure bool, maxAge int) *http.Cookie {
	expires := time.Now().UTC().Add(time.Duration(maxAge) * time.Second)
	if maxAge < 0 {
		expires = time.Unix(0, 0).UTC()
	}
	return &http.Cookie{Name: browserReturnCookieName, Value: value, Path: "/", HttpOnly: true,
		Secure: secure, SameSite: http.SameSiteLaxMode, MaxAge: maxAge, Expires: expires}
}

func setBrowserReturnCookie(w http.ResponseWriter, r *http.Request, target, verifier string, secure bool) {
	if target == "" {
		if _, err := r.Cookie(browserReturnCookieName); err == nil {
			http.SetCookie(w, browserReturnCookie("", secure, -1))
		}
		return
	}
	value := verifier + "." + base64.RawURLEncoding.EncodeToString([]byte(target))
	http.SetCookie(w, browserReturnCookie(value, secure, 600))
}

// Consumed even on a failed callback. A retained cookie from an abandoned flow
// cannot redirect a later login because it is bound to that flow's verifier.
func consumeBrowserReturnCookie(w http.ResponseWriter, r *http.Request, secure bool) string {
	cookie, err := r.Cookie(browserReturnCookieName)
	if err != nil {
		return ""
	}
	http.SetCookie(w, browserReturnCookie("", secure, -1))
	bound, encoded, ok := strings.Cut(cookie.Value, ".")
	verifier := oauthStateVerifierFromRequest(r)
	if !ok || verifier == "" || subtle.ConstantTimeCompare([]byte(bound), []byte(verifier)) != 1 {
		return ""
	}
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || !validBrowserReturn(string(decoded)) {
		return ""
	}
	return string(decoded)
}

func (h *AuthHandler) requestBrowserOrigin(r *http.Request) string {
	if origin := middleware.EffectiveOrigin(r.Context()); origin != "" {
		return origin
	}
	return h.githubBrowserOrigin()
}

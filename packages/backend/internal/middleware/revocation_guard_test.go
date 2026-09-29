package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type fakeRevocationChecker struct {
	tokens   map[string]bool
	sessions map[string]bool
	users    map[int64]bool
}

func (f fakeRevocationChecker) IsBrowserSessionRevoked(hash string) bool { return f.sessions[hash] }

func (f fakeRevocationChecker) IsTokenRevoked(hash string) bool { return f.tokens[hash] }
func (f fakeRevocationChecker) IsUserDisabled(id int64) bool    { return f.users[id] }

func serveGuard(t *testing.T, checker RevocationChecker, info *AuthInfo) *httptest.ResponseRecorder {
	t.Helper()
	handler := RevocationGuard(checker)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if info != nil {
		req = req.WithContext(ContextWithAuthInfo(req.Context(), info))
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestRevocationGuard_RefusesRevokedToken(t *testing.T) {
	checker := fakeRevocationChecker{tokens: map[string]bool{"h1": true}}
	rec := serveGuard(t, checker, &AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true, TokenHash: "h1"})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestRevocationGuard_RefusesDisabledUserOnAnyPath(t *testing.T) {
	checker := fakeRevocationChecker{users: map[int64]bool{7: true}}
	rec := serveGuard(t, checker, &AuthInfo{User: &db.User{ID: 7}})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestRevocationGuard_PassesLiveCredentialsAndAnonymous(t *testing.T) {
	checker := fakeRevocationChecker{tokens: map[string]bool{"other": true}, users: map[int64]bool{9: true}}
	if rec := serveGuard(t, checker, &AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true, TokenHash: "h1"}); rec.Code != http.StatusNoContent {
		t.Fatalf("live token: status = %d", rec.Code)
	}
	if rec := serveGuard(t, checker, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("anonymous: status = %d", rec.Code)
	}
	if rec := serveGuard(t, nil, &AuthInfo{User: &db.User{ID: 9}}); rec.Code != http.StatusNoContent {
		t.Fatalf("nil checker: status = %d", rec.Code)
	}
}

func TestRevocationGuard_RefusesRevokedBrowserSessionOnly(t *testing.T) {
	checker := fakeRevocationChecker{sessions: map[string]bool{"s1": true}}
	if rec := serveGuard(t, checker, &AuthInfo{User: &db.User{ID: 3}, SessionHash: "s1"}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session: status = %d, want 401", rec.Code)
	}
	if rec := serveGuard(t, checker, &AuthInfo{User: &db.User{ID: 3}, SessionHash: "s2"}); rec.Code != http.StatusNoContent {
		t.Fatalf("other session of the same user: status = %d, want 204", rec.Code)
	}
}

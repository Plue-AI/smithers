package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A session cookie that names no live session is a dead credential (spec
// §5.2.1). On a repository route it is refused with 401 unauthenticated
// before the next handler, which is where the repository would be resolved;
// elsewhere it continues anonymously so sign-in and public pages still work,
// and RequireAuth refuses it as dead.
func TestAuthLoader_DeadSessionCookie(t *testing.T) {
	t.Parallel()

	noSession := func() *mockAuthLoaderQuerier {
		return &mockAuthLoaderQuerier{
			getAuthSessionBySessionKeyFn: func(context.Context, string) (db.AuthSession, error) {
				return db.AuthSession{}, pgx.ErrNoRows
			},
		}
	}
	serve := func(path string, inner http.Handler) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "dead-session-key"})
		AuthLoader(noSession(), config.AuthConfig{})(inner).ServeHTTP(rec, req)
		return rec
	}
	unreachable := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("a dead cookie on a repository route must not reach repository resolution")
	})

	for _, path := range []string{
		"/api/repos/acme/private",
		"/api/repos/acme/private/secrets",
		"/api/repos/acme/missing/contents/README.md",
		"/acme/private.git/info/lfs/objects/batch",
	} {
		rec := serve(path, unreachable)
		require.Equal(t, http.StatusUnauthorized, rec.Code, path)
		assert.JSONEq(t, `{"code":"unauthenticated","class":"permission","fault":"user","message":"Sign in again"}`, rec.Body.String(), path)
		assert.Empty(t, rec.Header().Values("Set-Cookie"), "the dead cookie is not cleared: %s", path)
	}

	// Not repository routes: the request continues anonymously, marked dead.
	for _, path := range []string{"/api/auth/github", "/api/health", "/api/repos/from-template", "/api/user"} {
		var reached, dead bool
		rec := serve(path, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			reached = true
			dead = carriedDeadSession(r.Context())
			assert.Nil(t, UserFromContext(r.Context()))
			w.WriteHeader(http.StatusNoContent)
		}))
		require.Equal(t, http.StatusNoContent, rec.Code, path)
		assert.True(t, reached && dead, path)
	}

	// RequireAuth refuses the marked request as dead, not as anonymous.
	rec := serve("/api/user", RequireAuth(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("RequireAuth admitted a dead cookie")
	})))
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Equal(t, "unauthenticated", apiErrorCode(t, rec))

	// With no cookie at all, RequireAuth keeps its anonymous refusal.
	anonymous := httptest.NewRecorder()
	AuthLoader(noSession(), config.AuthConfig{})(RequireAuth(http.NotFoundHandler())).
		ServeHTTP(anonymous, httptest.NewRequest(http.MethodGet, "/api/user", nil))
	require.Equal(t, http.StatusUnauthorized, anonymous.Code)
	assert.Equal(t, "unauthorized", apiErrorCode(t, anonymous))

	// An SSE ticket is a credential of its own; its gate decides.
	var reached bool
	rec = serve("/api/repos/acme/private/runs/1/events?ticket=abc", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusNoContent)
	}))
	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.True(t, reached)
}

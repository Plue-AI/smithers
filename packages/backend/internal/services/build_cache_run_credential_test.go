package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// A run of unreviewed code holds a system-issued credential. The build cache
// reports a hit as green, so a publisher decides later verdicts for its key:
// such a credential reads the repository's cache and publishes nothing, not
// under trunk's bare keys, not under its own namespace, not under another
// run's. A user's own write token still publishes. Real tokens over product
// SQL, through the same AuthLoader and access middleware the router mounts.
func TestBuildCacheRunCredentialsNeverPublishPostgres(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "cache-owner", LowerUsername: "cache-owner", DisplayName: "Cache owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)

	agentRun, err := issueTemporaryAgentRepoAPIToken(ctx, q, owner.ID, repo.ID, "sandbox-run-1", "session-1")
	require.NoError(t, err)
	boundRun, err := issueTemporaryRepoAPIToken(ctx, q, owner.ID, repo.ID, "sandbox-run-2")
	require.NoError(t, err)
	push, err := issueTemporarySyncPushToken(ctx, q, owner.ID, repo.ID, "github-import")
	require.NoError(t, err)
	personal, err := issueTemporarySyncPushToken(ctx, q, owner.ID, repo.ID, "personal")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET system_issued = false WHERE id = $1`, personal.ID)
	require.NoError(t, err)

	var reached []string
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(q, config.AuthConfig{}))
	router.Route("/api/repos/{owner}/{repo}/build-cache", func(r chi.Router) {
		r.Use(middleware.BuildCacheAccess(q, nil))
		r.Use(middleware.RequireBuildCacheWrite)
		handle := func(w http.ResponseWriter, r *http.Request) {
			reached = append(reached, r.Method+" "+string(middleware.BuildCacheCredentialFromContext(r.Context())))
			w.WriteHeader(http.StatusOK)
		}
		r.HandleFunc("/ac/{keyDigest}", handle)
		r.HandleFunc("/cas/{digest}", handle)
	})
	serve := func(method, path, token string) int {
		request := httptest.NewRequest(method, "/api/repos/cache-owner/app/build-cache"+path, strings.NewReader(`{}`))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder.Code
	}
	trunk := strings.Repeat("a", 64)
	keys := map[string]string{
		"trunk":       "/ac/" + trunk,
		"own run":     "/ac/" + url.PathEscape("pr-1/"+trunk),
		"another run": "/ac/" + url.PathEscape("pr-2/"+trunk),
		"main":        "/ac/" + url.PathEscape("main/"+trunk),
		"artifact":    "/cas/" + strings.Repeat("b", 64),
	}

	for name, run := range map[string]temporaryRepoCloneToken{"agent run": agentRun, "bound run": boundRun, "push": push} {
		reached = nil
		require.Equal(t, http.StatusOK, serve(http.MethodGet, keys["trunk"], run.Plaintext), name)
		require.Equal(t, []string{"GET read"}, reached, "%s reads as a reader", name)
		for key, path := range keys {
			for _, method := range []string{http.MethodPut, http.MethodDelete} {
				reached = nil
				assert.Equal(t, http.StatusForbidden, serve(method, path, run.Plaintext), "%s %s %s", name, method, key)
				assert.Empty(t, reached, "%s %s %s reached the cache", name, method, key)
			}
		}
	}

	reached = nil
	require.Equal(t, http.StatusOK, serve(http.MethodPut, keys["trunk"], personal.Plaintext))
	require.Equal(t, []string{"PUT write"}, reached, "the owner's own write token publishes")
}

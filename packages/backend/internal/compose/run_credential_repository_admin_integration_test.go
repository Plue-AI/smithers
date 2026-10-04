package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

type staticRepoHostURL string

func (u staticRepoHostURL) ResolveURL(context.Context, string, string) (string, error) {
	return string(u), nil
}

// A system-issued credential acts as the repository owner but is never the
// owner's administrator: through the assembled router, neither an agent run's
// token (bound to the repository or not) nor the platform's sync token can
// drop bookmark protection, change the default bookmark or any other
// repository setting, or add a deploy key (an SSH door around every push
// rule). The bookmark API refuses an agent run the default bookmark. The
// owner's own token does all of it.
func TestRunCredentialCannotAdministerRepositoryPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "admin-owner", LowerUsername: "admin-owner", DisplayName: "Admin owner"})
	require.NoError(t, err)
	repoID := ciTestRepo(t, pool, owner.ID, "app")

	token := func(name, scopes string, systemIssued bool) string {
		plaintext := "smithers_" + hex.EncodeToString([]byte(name + "-token-padding-bytes-xx"))[:40]
		sum := sha256.Sum256([]byte(plaintext))
		hash := hex.EncodeToString(sum[:])
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{
			UserID: owner.ID, Name: name, TokenHash: hash, TokenLastEight: hash[len(hash)-8:],
			SystemIssued: systemIssued, Scopes: scopes,
			ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
		})
		require.NoError(t, err)
		return plaintext
	}
	write := string(middleware.ScopeWriteRepository)
	boundRun := token("sandbox-run", write+","+middleware.RepositoryRestrictionScope(repoID)+","+middleware.AgentSessionRestrictionScope("s1"), true)
	unboundRun := token("unbound-run", write, true)
	sync := token("github-sync", write+","+middleware.SyncCredentialScope(), true)
	person := token("personal", write, false)

	repoHostCalls := 0
	repoHostServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		repoHostCalls++
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"name":"feature","target_change_id":"abc","target_commit_id":"def"}`))
	}))
	t.Cleanup(repoHostServer.Close)

	router := buildRouter(
		testConfigAllFlagsOn(), q, pool,
		&routes.RepoHandler{Service: services.NewRepoService(q, nil, "")},
		nil,
		&routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{},
		&routes.DeployKeyHandler{Service: services.NewDeployKeyService(q)},
		&routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{},
		nil, nil,
		&routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil,
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil,
		&routes.ProtectedBookmarkHandler{Service: services.NewProtectedBookmarkService(q)},
		nil, nil,
		&routes.JJVCSHandler{RepoHost: repohost.NewClient(staticRepoHostURL(repoHostServer.URL), "test"), RepoResolver: q},
		&routes.AgentInternalHandler{},
		nil, nil, nil, nil,
		nil,
		nil, nil,
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
	)
	serve := func(bearer, method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/repos/admin-owner/app"+path, bytes.NewBufferString(body))
		req.Header.Set("Authorization", "Bearer "+bearer)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	defaultBookmark := func() string {
		var name string
		require.NoError(t, pool.QueryRow(ctx, `SELECT default_bookmark FROM repositories WHERE id = $1`, repoID).Scan(&name))
		return name
	}

	rec := serve(person, http.MethodPost, "/protected-bookmarks", `{"pattern":"main"}`)
	require.Less(t, rec.Code, 300, rec.Body.String())

	for name, bearer := range map[string]string{"bound agent run": boundRun, "unbound agent run": unboundRun, "sync": sync} {
		for _, attempt := range []struct{ method, path, body string }{
			{http.MethodDelete, "/protected-bookmarks/main", ``},
			{http.MethodPost, "/protected-bookmarks", `{"pattern":"release"}`},
			{http.MethodPatch, "/", `{"default_bookmark":"feature"}`},
			{http.MethodPatch, "/", `{"description":"changed by a run"}`},
			{http.MethodPost, "/keys", `{"title":"run","key":"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl run","read_only":false}`},
			{http.MethodPost, "/archive", ``},
			{http.MethodDelete, "/", ``},
		} {
			rec := serve(bearer, attempt.method, attempt.path, attempt.body)
			assert.Equal(t, http.StatusForbidden, rec.Code, "%s %s %s: %s", name, attempt.method, attempt.path, rec.Body.String())
		}
	}
	var protected int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM protected_bookmarks WHERE repository_id = $1`, repoID).Scan(&protected))
	assert.Equal(t, 1, protected, "a run credential changed bookmark protection")
	assert.Equal(t, "main", defaultBookmark())
	var deployKeys int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM deploy_keys WHERE repository_id = $1`, repoID).Scan(&deployKeys))
	assert.Zero(t, deployKeys, "a run credential added a deploy key")

	// The bookmark API: an agent run never moves or deletes the default
	// bookmark (nor mythical), and still manages its own bookmarks.
	for _, bearer := range []string{boundRun, unboundRun} {
		rec := serve(bearer, http.MethodPost, "/bookmarks", `{"name":"main","target_change_id":"abc"}`)
		assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
		rec = serve(bearer, http.MethodDelete, "/bookmarks/main", ``)
		assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
		rec = serve(bearer, http.MethodPost, "/bookmarks", `{"name":"mythical","target_change_id":"abc"}`)
		assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	}
	// Bookmark names compare without case: a case variant of the default
	// bookmark, of mythical or of a protected bookmark is that bookmark.
	rec = serve(person, http.MethodPost, "/protected-bookmarks", `{"pattern":"release"}`)
	require.Less(t, rec.Code, 300, rec.Body.String())
	for _, bearer := range []string{boundRun, unboundRun} {
		for _, name := range []string{"Main", "Mythical", "MYTHICAL", "Release", "RELEASE"} {
			rec := serve(bearer, http.MethodPost, "/bookmarks", `{"name":"`+name+`","target_change_id":"abc"}`)
			assert.Equal(t, http.StatusForbidden, rec.Code, "create %s: %s", name, rec.Body.String())
			rec = serve(bearer, http.MethodDelete, "/bookmarks/"+name, ``)
			assert.Equal(t, http.StatusForbidden, rec.Code, "delete %s: %s", name, rec.Body.String())
		}
	}
	for _, name := range []string{"Mythical", "Release"} {
		rec := serve(person, http.MethodPost, "/bookmarks", `{"name":"`+name+`","target_change_id":"abc"}`)
		assert.Equal(t, http.StatusForbidden, rec.Code, "person create %s: %s", name, rec.Body.String())
	}
	assert.Zero(t, repoHostCalls, "a refused bookmark write reached repo-host")
	rec = serve(boundRun, http.MethodPost, "/bookmarks", `{"name":"feature","target_change_id":"abc"}`)
	assert.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	// The owner's own token administers the repository.
	rec = serve(person, http.MethodPatch, "/", `{"description":"changed by the owner"}`)
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = serve(person, http.MethodDelete, "/protected-bookmarks/main", ``)
	assert.Less(t, rec.Code, 300, rec.Body.String())
	rec = serve(person, http.MethodPost, "/bookmarks", `{"name":"main","target_change_id":"abc"}`)
	assert.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.True(t, strings.Contains(rec.Body.String(), "feature"), "fake repo-host answered")
}

package routes

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/repository"
)

// installMainHarness serves the public push door and bookmark routes over an
// install's repository engine, composed as compose does: every door reads the
// install fact from the engine's client.
type installMainHarness struct {
	pool   *pgxpool.Pool
	client *repohost.Client
	server *httptest.Server
	engine *httptest.Server
	repo   processWorkspaceRepo
	user   processWorkspaceUser
	work   string
}

func newInstallMainHarness(t *testing.T, defaultBookmark string) *installMainHarness {
	t.Helper()
	ffi := strings.TrimSpace(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	if ffi == "" {
		t.Skip("SMITHERS_FFI_LIBRARY_PATH is required for the real repository engine")
	}
	pool := setupProcessWorkspacePool(t)
	queries := db.New(pool)
	user := processWorkspaceCreateUser(t, pool, "install_owner")
	repo := processWorkspaceCreateRepo(t, pool, user, "install_repo", false)
	_, err := pool.Exec(context.Background(), `UPDATE repositories SET default_bookmark = $1 WHERE id = $2`, defaultBookmark, repo.ID)
	require.NoError(t, err)
	local, err := repository.OpenLocal(repository.Config{StoragePath: t.TempDir(), AuthToken: "install-main-engine", FFILibraryPath: ffi, InstallMainMirror: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
	client := local.Client()
	require.True(t, client.InstallMainMirror())
	require.NoError(t, client.InitRepo(context.Background(), repo.Owner, repo.Name, defaultBookmark, true))
	engine := httptest.NewServer(local.Handler())
	t.Cleanup(engine.Close)

	gitHandler := &GitSmartHandler{
		Service: services.NewGitHTTPProxyService(queries, services.NewSSHAuthorizationService(queries), client,
			services.WithGitHTTPInstallMainMirror(client.InstallMainMirror())),
		Metrics: NewSmithersMetrics(),
	}
	bookmarks := &JJVCSHandler{RepoHost: client, RepoResolver: queries}
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(queries, config.AuthConfig{}))
	router.Get("/{owner}/{repo}/info/refs", gitHandler.InfoRefs)
	router.Post("/{owner}/{repo}/git-upload-pack", gitHandler.UploadPack)
	router.Post("/{owner}/{repo}/git-receive-pack", gitHandler.ReceivePack)
	router.Route("/api/repos/{owner}/{repo}", func(router chi.Router) {
		router.Use(middleware.LoadRepoContext(queries))
		write := []func(http.Handler) http.Handler{
			middleware.RequireAuth,
			middleware.RequireScope(middleware.ScopeWriteRepository),
			middleware.RequireRepoPermission(middleware.PermissionWrite),
		}
		router.With(write...).Post("/bookmarks", bookmarks.CreateBookmark)
		router.With(write...).Delete("/bookmarks/{name}", bookmarks.DeleteBookmark)
	})
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)

	h := &installMainHarness{pool: pool, client: client, server: server, engine: engine, repo: repo, user: user, work: filepath.Join(t.TempDir(), "work")}
	checkoutGit(t, "", "install-main-engine", "clone", "-q", engine.URL+"/git/"+repo.Owner+"/"+repo.Name+".git", h.work)
	return h
}

// token mints an access token of the user with scopes; systemIssued marks an
// agent run's or the sync's.
func (h *installMainHarness) token(t *testing.T, scopes string, systemIssued bool) string {
	t.Helper()
	var entropy [20]byte
	_, err := rand.Read(entropy[:])
	require.NoError(t, err)
	raw := "smithers_" + hex.EncodeToString(entropy[:])
	sum := sha256.Sum256([]byte(raw))
	hash := hex.EncodeToString(sum[:])
	_, err = db.New(h.pool).CreateAccessToken(context.Background(), db.CreateAccessTokenParams{
		UserID: h.user.ID, Name: "install-main", TokenHash: hash, TokenLastEight: hash[len(hash)-8:], Scopes: scopes,
		ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}, SystemIssued: systemIssued,
	})
	require.NoError(t, err)
	return raw
}

func (h *installMainHarness) commit(t *testing.T, name string) string {
	t.Helper()
	require.NoError(t, os.WriteFile(filepath.Join(h.work, name+".txt"), []byte(name+"\n"), 0o644))
	checkoutGit(t, h.work, "", "add", "-A")
	checkoutGit(t, h.work, "", "-c", "user.name=Member", "-c", "user.email=member@example.test", "commit", "-q", "-m", name)
	return strings.TrimSpace(checkoutGit(t, h.work, "", "rev-parse", "HEAD"))
}

// push runs git push through the public door and returns its error output.
func (h *installMainHarness) push(t *testing.T, token string, refspecs ...string) (string, error) {
	t.Helper()
	remote := h.server.URL + "/" + h.repo.Owner + "/" + h.repo.Name + ".git"
	args := append([]string{"-c", "http.extraHeader=Authorization: Bearer " + token, "push", "--atomic", "--porcelain", remote}, refspecs...)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = h.work
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (h *installMainHarness) bookmark(t *testing.T, name string) repohost.Bookmark {
	t.Helper()
	bookmark, found, err := repohost.LookupBookmark(context.Background(), h.client, h.repo.Owner, h.repo.Name, name)
	require.NoError(t, err)
	if !found {
		return repohost.Bookmark{}
	}
	return bookmark
}

func (h *installMainHarness) api(t *testing.T, token, method, path, body string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, h.server.URL+"/api/repos/"+h.repo.Owner+"/"+h.repo.Name+path, bytes.NewBufferString(body))
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := h.server.Client().Do(req)
	require.NoError(t, err)
	defer res.Body.Close()
	var envelope map[string]any
	_ = json.NewDecoder(res.Body).Decode(&envelope)
	return res.StatusCode, envelope
}

// On an install a person's credential cannot create, move or delete main
// through the public push door or the public bookmark routes, in any
// spelling and alongside other refs, and the engine refuses the same writes
// for a caller that skips those doors. The person's other refs still land.
func TestInstallMainPublicDoorsRefuseMainWithRealRefs(t *testing.T) {
	h := newInstallMainHarness(t, "main")
	person := h.token(t, "write:repository", false)
	initial := h.bookmark(t, "main").TargetCommitID
	require.NotEmpty(t, initial)
	feature := h.commit(t, "feature")

	out, err := h.push(t, person, "HEAD:refs/heads/feature")
	require.NoError(t, err, out)
	require.Equal(t, feature, h.bookmark(t, "feature").TargetCommitID)
	for _, refspecs := range [][]string{
		{"HEAD:refs/heads/main"}, {"HEAD:refs/heads/MAIN"}, {"HEAD:refs/heads/ma‌in"},
		{":refs/heads/main"}, {"HEAD:refs/heads/other", "HEAD:refs/heads/main"},
	} {
		out, err := h.push(t, person, refspecs...)
		require.Error(t, err, "%v: %s", refspecs, out)
		assert.Contains(t, out, "403", "%v", refspecs)
		assert.Equal(t, initial, h.bookmark(t, "main").TargetCommitID, "%v moved main", refspecs)
		assert.Empty(t, h.bookmark(t, "other").TargetCommitID, "%v wrote part of a refused push", refspecs)
	}

	change := h.bookmark(t, "feature").TargetChangeID
	for _, name := range []string{"main", "MAIN", "ma‌in"} {
		status, envelope := h.api(t, person, http.MethodPost, "/bookmarks", fmt.Sprintf(`{"name":%q,"target_change_id":%q}`, name, change))
		require.Equal(t, http.StatusForbidden, status, "%s: %v", name, envelope)
		assert.Equal(t, "permission", envelope["code"], name)
		assert.Equal(t, "permission", envelope["class"], name)
		status, envelope = h.api(t, person, http.MethodDelete, "/bookmarks/"+url.PathEscape(name), ``)
		require.Equal(t, http.StatusForbidden, status, "%s: %v", name, envelope)
		assert.Equal(t, "permission", envelope["code"], name)
	}
	assert.Equal(t, initial, h.bookmark(t, "main").TargetCommitID)
	status, envelope := h.api(t, person, http.MethodPost, "/bookmarks", fmt.Sprintf(`{"name":"release","target_change_id":%q}`, change))
	require.Equal(t, http.StatusCreated, status, "%v", envelope)
	assert.Equal(t, feature, h.bookmark(t, "release").TargetCommitID)

	// The engine refuses a caller that skips the public doors.
	ctx := context.Background()
	var refused *repohost.StatusError
	_, err = h.client.CreateBookmark(ctx, h.repo.Owner, h.repo.Name, repohost.CreateBookmarkRequest{Name: "main", TargetChangeID: change})
	require.True(t, errors.As(err, &refused) && refused.StatusCode == http.StatusForbidden, "engine create of main: %v", err)
	err = h.client.DeleteBookmark(ctx, h.repo.Owner, h.repo.Name, "main")
	require.True(t, errors.As(err, &refused) && refused.StatusCode == http.StatusForbidden, "engine delete of main: %v", err)
	_, err = h.client.LandChanges(ctx, h.repo.Owner, h.repo.Name, repohost.LandRequest{ChangeIDs: []string{change}, TargetBookmark: "main"})
	require.True(t, errors.As(err, &refused) && refused.StatusCode == http.StatusForbidden, "engine land onto main: %v", err)
	// The import's create-if-absent never moves an existing main.
	bookmark, err := h.client.CreateBookmark(ctx, h.repo.Owner, h.repo.Name, repohost.CreateBookmarkRequest{Name: "main", TargetChangeID: change, IfAbsent: true})
	require.NoError(t, err)
	assert.Equal(t, initial, bookmark.TargetCommitID)
	assert.Equal(t, initial, h.bookmark(t, "main").TargetCommitID)
}

// Lead ruling: on an install whose default bookmark is not main, both the
// canonical main and the default are the sync's. An agent run's token is
// refused for either at the bookmark routes and at the push door.
func TestInstallMainCoversTheDefaultBookmarkForAgentRuns(t *testing.T) {
	h := newInstallMainHarness(t, "trunk")
	agent := h.token(t, fmt.Sprintf("write:repository,repo:%d,agent-session:s1", h.repo.ID), true)
	person := h.token(t, "write:repository", false)
	h.commit(t, "agent")
	out, err := h.push(t, person, "HEAD:refs/heads/feature")
	require.NoError(t, err, out)
	change := h.bookmark(t, "feature").TargetChangeID
	initial := h.bookmark(t, "trunk").TargetCommitID
	require.NotEmpty(t, initial)
	for _, token := range []string{agent, person} {
		for _, name := range []string{"main", "trunk", "Trunk"} {
			status, envelope := h.api(t, token, http.MethodPost, "/bookmarks", fmt.Sprintf(`{"name":%q,"target_change_id":%q}`, name, change))
			require.Equal(t, http.StatusForbidden, status, "%s: %v", name, envelope)
			assert.Equal(t, "permission", envelope["code"], name)
		}
		for _, ref := range []string{"main", "trunk"} {
			out, err := h.push(t, token, "HEAD:refs/heads/"+ref)
			require.Error(t, err, "%s: %s", ref, out)
		}
	}
	assert.Equal(t, initial, h.bookmark(t, "trunk").TargetCommitID)
	assert.Empty(t, h.bookmark(t, "main").TargetCommitID)
}

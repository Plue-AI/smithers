package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	processruntime "github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/productstore"
)

// A hosted deployment composes its workspace store by embedding
// productstore.Product, never *db.Queries. Through that store, a runtime
// workspace must reach its private repository after create and after resume
// (smithers#3112). PostgreSQL, authenticated smart HTTP, Git, Jujutsu and the
// process runtime are real.
func TestHostedRuntimeWorkspaceReachesRepositoryAfterCreateAndResume(t *testing.T) {
	requireExecutable(t, "git")
	requireExecutable(t, "jj")
	requireExecutable(t, "bash")
	pool := newProductTestPool(t)
	ctx := context.Background()
	userID, repositoryID := setupTestUserAndRepo(t, pool)
	queries := db.New(pool)
	slug, err := queries.GetRepoOwnerSlugAndNameByID(ctx, repositoryID)
	require.NoError(t, err)
	gitRoot := t.TempDir()
	bare := filepath.Join(gitRoot, slug.OwnerSlug, slug.RepoName+".git")
	seedBareRepository(t, bare, "main")
	mainCommit := strings.Fields(runGitFixture(t, bare, nil, "rev-parse", "refs/heads/main"))[0]

	// Like repo-host, Git answers only a token that is issued and not revoked.
	gitExecutable, err := exec.LookPath("git")
	require.NoError(t, err)
	backend := &cgi.Handler{Path: gitExecutable, Args: []string{"http-backend"}, Dir: gitRoot,
		Env: []string{"GIT_PROJECT_ROOT=" + gitRoot, "GIT_HTTP_EXPORT_ALL=1"}}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		sum := sha256.Sum256([]byte(presentedSecret(request)))
		var live bool
		if err := pool.QueryRow(request.Context(), `SELECT EXISTS (SELECT 1 FROM access_tokens WHERE token_hash = $1)`,
			hex.EncodeToString(sum[:])).Scan(&live); err != nil || !live {
			response.Header().Set("WWW-Authenticate", `Basic realm="smithers"`)
			http.Error(response, "authentication required", http.StatusUnauthorized)
			return
		}
		backend.ServeHTTP(response, request)
	}))
	t.Cleanup(server.Close)

	id := uuid.NewString()
	_, err = pool.Exec(ctx, `INSERT INTO workspaces(id, repository_id, user_id, name, kind, status, target_bookmark)
		VALUES ($1, $2, $3, $4, 'container', 'starting', 'main')`, id, repositoryID, userID, id)
	require.NoError(t, err)
	// Unix socket paths are short (104 bytes on Darwin); keep the root shallow.
	root, err := os.MkdirTemp("/tmp", "smrt")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	// A guest has no host keychain; the host's system Git config would add one.
	runtime, err := processruntime.New(processruntime.Config{Root: root, MaxConcurrent: 4,
		Environment: map[string]string{"GIT_CONFIG_NOSYSTEM": "1"}})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	service := newWorkspaceServiceForTests(hostedLeaseWorkspaceStore{productstore.New(pool)},
		WithWorkspaceRuntime(runtime), WithWorkspaceGitBaseURL(server.URL))
	headToken := func() pgtype.Int8 {
		t.Helper()
		row, err := queries.GetWorkspace(ctx, id)
		require.NoError(t, err)
		return row.HeadPushTokenID
	}
	tokenLive := func(tokenID int64) bool {
		t.Helper()
		var live bool
		require.NoError(t, pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM access_tokens WHERE id = $1)`, tokenID).Scan(&live))
		return live
	}

	row, err := queries.GetWorkspace(ctx, id)
	require.NoError(t, err)
	running, err := service.ensureRuntimeWorkspaceRunning(ctx, row, userID)
	require.NoError(t, err)
	require.Equal(t, "running", running.Status)
	eventuallyListsMain(t, runtime, id, mainCommit)
	created := headToken()
	require.True(t, created.Valid, "create records the workspace credential so suspend, stop and delete revoke it")

	_, err = service.SuspendWorkspace(ctx, id, repositoryID, userID)
	require.NoError(t, err)
	require.False(t, headToken().Valid)
	require.False(t, tokenLive(created.Int64), "suspend revokes the workspace credential")

	resumed, err := service.ResumeWorkspace(ctx, id, repositoryID, userID)
	require.NoError(t, err)
	require.Equal(t, "running", resumed.Status)
	eventuallyListsMain(t, runtime, id, mainCommit)
	replacement := headToken()
	require.True(t, replacement.Valid, "resume records a fresh workspace credential")
	require.NotEqual(t, created.Int64, replacement.Int64)
}

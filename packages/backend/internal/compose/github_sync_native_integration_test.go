package compose

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// A successful PollOnce return alone is not a successful read: the worker
// persists individual failures. Exercise the composed providers, GitHub's real
// Git transport and the native install mirror, then inspect their receipts.
func TestInstallSyncMissingReadersStillFastForwardsNativeMirror(t *testing.T) {
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if ffi == "" {
		t.Skip("SMITHERS_FFI_LIBRARY_PATH is required for the native repository engine")
	}
	ctx := t.Context()
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "poll-native", LowerUsername: "poll-native"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE repositories SET mirror_destination='acme/app' WHERE id=$1`, repo.ID)
	require.NoError(t, err)
	storage := t.TempDir()
	local, err := repository.OpenLocal(repository.Config{StoragePath: storage, AuthToken: "sync-native", FFILibraryPath: ffi, InstallMainMirror: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
	require.NoError(t, local.Client().InitRepo(ctx, user.Username, "app", "main", true))
	base, err := local.Client().GetBookmark(ctx, user.Username, "app", "main")
	require.NoError(t, err)
	require.NotEmpty(t, base.TargetCommitID)

	// Give GitHub a separate object store, seeded from the install's initial
	// commit. Fixture authorship uses jj; the worker uses its shipped transport.
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	jj := func(args ...string) string {
		t.Helper()
		out, err := exec.CommandContext(ctx, "jj", args...).CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	source := filepath.Join(t.TempDir(), "github")
	jj("git", "clone", "--colocate", filepath.Join(storage, user.Username, "app", ".jj", "repo", "store", "git"), source)
	jj("-R", source, "new", base.TargetCommitID, "-m", "Merged on GitHub")
	require.NoError(t, os.WriteFile(filepath.Join(source, "merged.txt"), []byte("merged on GitHub\n"), 0600))
	jj("-R", source, "describe", "-m", "Merged on GitHub")
	jj("-R", source, "bookmark", "set", "main", "-r", "@")
	head := jj("-R", source, "log", "-r", "@", "--no-graph", "-T", "commit_id")
	require.NotEqual(t, base.TargetCommitID, head)
	gitRoot := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(gitRoot, "acme"), 0700))
	require.NoError(t, os.Symlink(filepath.Join(source, ".git"), filepath.Join(gitRoot, "acme", "app.git")))
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	sealed := services.GitHubAppCredentials{ID: 710, Slug: "native-poll", OwnerLogin: "acme", OwnerKind: "org", ClientID: "client", ClientSecret: "secret", WebhookSecret: "hook", InstallationID: 91, PEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))}
	upstream, err := githubfake.New(githubfake.Config{AppID: sealed.ID, Slug: sealed.Slug, OwnerLogin: sealed.OwnerLogin, OwnerKind: sealed.OwnerKind, ClientID: sealed.ClientID, ClientSecret: sealed.ClientSecret, WebhookSecret: sealed.WebhookSecret, PrivateKeyPEM: sealed.PEM, ConversionCode: "code", GitRoot: gitRoot, Installations: []githubfake.Installation{{ID: 91, Repositories: []githubfake.Repository{{ID: 100, FullName: "acme/app"}}}}})
	require.NoError(t, err)
	t.Cleanup(upstream.Close)
	response, err := http.Post(upstream.URL+"/app-manifests/code/conversions", "application/json", nil)
	require.NoError(t, err)
	require.Equal(t, http.StatusCreated, response.StatusCode)
	require.NoError(t, response.Body.Close())
	var requests atomic.Int32
	transport := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		upstream.Handler().ServeHTTP(w, r)
	}))
	t.Cleanup(transport.Close)
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", transport.URL)
	t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", transport.URL)
	codec, err := webhook.NewSecretCodec("native-poll-key")
	require.NoError(t, err)
	credentials := services.NewGitHubAppCredentialStore(pool, codec)
	require.NoError(t, credentials.Save(ctx, sealed))
	assembled, err := composeGitHubSync(pool, credentials, nil, topology{}, newGitHubBudget(topology{}))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO github_app_installations(installation_id) VALUES(91)`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO github_app_installation_repositories(installation_id,github_repository_id) VALUES(91,100)`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO repo_connections(user_id,repo_owner,repo_name,repo_owner_lower,repo_name_lower,license_spdx_id,github_repository_id) VALUES($1,'acme','app','acme','app','MIT',100)`, user.ID)
	require.NoError(t, err)
	_, err = assembled.synced.EnrollGitHubRepo(ctx, services.EnrollGitHubRepoInput{Owner: "acme", Repo: "app", InstallationID: 91, GitHubRepositoryID: 100, MetadataOnly: true})
	require.NoError(t, err)
	main := services.NewGitHubMainPullService(q, local.Client(), assembled.connections, assembled.connections)
	main.UseInstallPolicy()
	composeGitHubTodoPolling(services.NewMythicalService(pool, local.Client()), main, assembled.synced, topology{})
	before := requests.Load()
	composeGitHubInstallAuthority(assembled.synced, credentials, false)
	require.Error(t, main.RetrySync(ctx), "an unqualified runtime cannot queue reads")
	require.Error(t, main.PollOnce(ctx))
	require.Equal(t, before, requests.Load())
	var queued int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM github_main_pulls WHERE repository_id=$1`, repo.ID).Scan(&queued))
	require.Zero(t, queued)
	composeGitHubInstallAuthority(assembled.synced, credentials, true)
	require.NoError(t, main.RetrySync(ctx))
	require.NoError(t, main.PollOnce(ctx))
	observed, err := q.GetGithubMainPull(ctx, repo.ID)
	require.NoError(t, err)
	require.Equal(t, "synced", observed.State, observed.LastError)
	require.Equal(t, head, observed.GithubHead)
	require.Equal(t, head, observed.SmithersHead)
	require.True(t, observed.LastSyncedAt.Valid)
	mirror, err := local.Client().GetBookmark(ctx, user.Username, "app", "main")
	require.NoError(t, err)
	require.Equal(t, head, mirror.TargetCommitID)
	var deliveries int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE principal_id='refs' AND state='accepted' AND payload->'object'->'refs'->>'refs/heads/main'=$1`, head).Scan(&deliveries))
	require.Equal(t, 1, deliveries, "missing downstream consumers retain the actual observation")
	health, err := main.SyncHealth(ctx)
	require.NoError(t, err)
	require.Equal(t, "stale", health.State, "successful main sync cannot make absent check/review readers fresh")
	var transferred bool
	for _, write := range upstream.Writes() {
		if write.Path == "/acme/app.git/git-upload-pack" && write.Status == http.StatusOK {
			transferred = true
		}
	}
	require.True(t, transferred, "real Git objects crossed the GitHub transport")

	// A changed sealed installation must revoke admission before queuing or
	// contacting GitHub, while preserving the last successful observation.
	require.NoError(t, credentials.SetInstallation(ctx, 92))
	before = requests.Load()
	require.Error(t, main.RetrySync(ctx))
	require.Error(t, main.PollOnce(ctx))
	require.Equal(t, before, requests.Load())
	after, err := q.GetGithubMainPull(ctx, repo.ID)
	require.NoError(t, err)
	require.Equal(t, observed, after)
}

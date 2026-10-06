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
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
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

	// Fixture authorship uses Git only; the worker still uses the native mirror.
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	git := func(args ...string) string {
		t.Helper()
		out, err := exec.CommandContext(ctx, "git", args...).CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	source := filepath.Join(t.TempDir(), "github")
	git("clone", filepath.Join(storage, user.Username, "app", ".jj", "repo", "store", "git"), source)
	git("-C", source, "checkout", "-B", "main", base.TargetCommitID)
	require.NoError(t, os.WriteFile(filepath.Join(source, "merged.txt"), []byte("merged on GitHub\n"), 0600))
	git("-C", source, "add", "merged.txt")
	git("-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Merged on GitHub")
	head := git("-C", source, "rev-parse", "HEAD")
	require.NotEqual(t, base.TargetCommitID, head)
	require.NotZero(t, os.Geteuid(), "native polling must run as the installing user")
	marker := filepath.Join(t.TempDir(), "executed")
	hooks := filepath.Join(source, ".git", "hooks")
	require.NoError(t, os.WriteFile(filepath.Join(hooks, "reference-transaction"), []byte("#!/bin/sh\ntouch "+marker+"\n"), 0700))
	git("-C", source, "config", "credential.helper", "!touch "+marker)
	global := filepath.Join(t.TempDir(), "gitconfig")
	require.NoError(t, os.WriteFile(global, []byte("[core]\n hooksPath = "+hooks+"\n[credential]\n helper = !touch "+marker+"\n"), 0600))
	t.Setenv("GIT_CONFIG_GLOBAL", global)
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "credential.helper")
	t.Setenv("GIT_CONFIG_VALUE_0", "!touch "+marker)
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
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, user.ID)
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://localhost:4000"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{}, routerExtras{GitHubSync: main})
	requestSync := func(method string, expected int) string {
		t.Helper()
		r := httptest.NewRequest(method, cfg.Server.PublicURL+"/api/github/sync", nil)
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Origin", cfg.Server.PublicURL)
		r.Header.Set("X-CSRF-Token", "native-csrf")
		r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "native-csrf"})
		r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &user, SessionHash: "native-session"}))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		require.Equal(t, expected, w.Code, w.Body.String())
		return w.Body.String()
	}
	before := requests.Load()
	composeGitHubInstallAuthority(assembled.synced, credentials, false)
	require.Error(t, main.RetrySync(ctx), "an unqualified runtime cannot queue reads")
	require.Error(t, main.PollOnce(ctx))
	require.Equal(t, before, requests.Load())
	var queued int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM github_main_pulls WHERE repository_id=$1`, repo.ID).Scan(&queued))
	require.Zero(t, queued)
	composeGitHubInstallAuthority(assembled.synced, credentials, true)
	requestSync(http.MethodPost, http.StatusAccepted)
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

	require.Contains(t, requestSync(http.MethodGet, http.StatusOK), `"state":"stale"`)
	// The production stale-row sweep leaves refs alone before 30 seconds.
	main.Sweep(ctx)
	require.NoError(t, main.PollOnce(ctx))
	unchanged, err := q.GetGithubMainPull(ctx, repo.ID)
	require.NoError(t, err)
	require.Equal(t, observed.LastCheckedAt, unchanged.LastCheckedAt)
	remaining := time.Until(observed.LastCheckedAt.Time.Add(30 * time.Second))
	if remaining > 0 {
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(remaining + 100*time.Millisecond):
		}
	}
	main.Sweep(ctx)
	require.NoError(t, main.PollOnce(ctx))
	next, err := q.GetGithubMainPull(ctx, repo.ID)
	require.NoError(t, err)
	require.True(t, next.LastCheckedAt.Time.After(observed.LastCheckedAt.Time))
	require.Equal(t, head, next.SmithersHead)
	_, markerErr := os.Stat(marker)
	require.True(t, os.IsNotExist(markerErr), "repository hooks and helpers remain data")

	// A changed sealed installation must revoke admission before queuing or
	// contacting GitHub, while preserving the last successful observation.
	require.NoError(t, credentials.SetInstallation(ctx, 92))
	before = requests.Load()
	require.Error(t, main.RetrySync(ctx))
	require.Error(t, main.PollOnce(ctx))
	require.Equal(t, before, requests.Load())
	after, err := q.GetGithubMainPull(ctx, repo.ID)
	require.NoError(t, err)
	require.Equal(t, next, after)
}

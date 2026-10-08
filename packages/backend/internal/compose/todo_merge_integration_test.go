package compose

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/auth"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	nativeRepository "github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// ownerTokenDecrypter stands in for the sealed OAuth token store only: the
// owner sign-in suite proves sealing; every GitHub answer comes from the fake.
type ownerTokenDecrypter struct{}

func (ownerTokenDecrypter) DecryptOAuthAccessToken([]byte) (string, error) {
	return "ghu_githubfake_owner", nil
}

// noPolicy is a repository with no committed factory policy: the empty
// policy, which names every GitHub maintainer.
type noPolicy struct{}

func (noPolicy) GetBookmark(context.Context, string, string, string) (repohost.Bookmark, error) {
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: http.StatusNotFound, Code: "bookmark_not_found"}
}

func (noPolicy) GetFileAtChange(context.Context, string, string, string, string) (repohost.FileContent, error) {
	return repohost.FileContent{}, &repohost.StatusError{StatusCode: http.StatusNotFound}
}

func (noPolicy) GetFileAtCommit(context.Context, string, string, string, string) (repohost.FileContent, error) {
	return repohost.FileContent{}, &repohost.StatusError{StatusCode: http.StatusNotFound}
}

// The merge route through the composed router (authentication, the
// single-owner boundary, CSRF, the API's content rules) with the merge
// service composed as the install composes it (EnableTodoPublication), real
// PostgreSQL and the GitHub fake: only the owner's browser session with its
// CSRF token and an Idempotency-Key reaches an approval; every other
// credential is refused before any TODO is read, and none records an
// approval, a fence or a GitHub merge.
func TestTodoMergeComposedRouteBoundaryPostgres(t *testing.T) {
	testTodoMergeComposedRouteBoundaryPostgres(t, false, false, false)
}

func TestConfirmationMergeAdmissionComposedPostgres(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		t.Run(fmt.Sprintf("explicit-head-%t", explicit), func(t *testing.T) {
			testTodoMergeComposedRouteBoundaryPostgres(t, true, false, false, false, explicit)
		})
	}
}

func TestConfirmationMergeBrowserComposedPostgres(t *testing.T) {
	if os.Getenv("SMITHERS_CONFIRMATION_BROWSER") != "1" {
		t.Skip("set SMITHERS_CONFIRMATION_BROWSER=1 for the composed browser journey")
	}
	testTodoMergeComposedRouteBoundaryPostgres(t, true, false, false, true)
}

var confirmationMergeInstallations atomic.Int64

func TestCatalogMergeBrowserPostgres(t *testing.T) {
	if os.Getenv("SMITHERS_CATALOG_MERGE_BROWSER") != "1" {
		t.Skip("set SMITHERS_CATALOG_MERGE_BROWSER=1 for the composed browser journey")
	}
	testTodoMergeComposedRouteBoundaryPostgres(t, true, true, false)
}

// TestAccessMergeBrowserPostgres is driven by the real C-ACC-02 browser spec.
func TestAccessMergeBrowserPostgres(t *testing.T) {
	if os.Getenv("SMITHERS_ACCESS_MERGE_PHASE_DIR") == "" {
		t.Skip("run C-ACC-02 for the composed browser journey")
	}
	testTodoMergeComposedRouteBoundaryPostgres(t, true, true, false)
}

func TestTodoPullLabelApprovalComposedPostgres(t *testing.T) {
	testTodoMergeComposedRouteBoundaryPostgres(t, false, false, true)
}

func testTodoMergeComposedRouteBoundaryPostgres(t *testing.T, confirmations, browserJourney, labelApproval bool, options ...bool) {
	// Independent installs must never share the stack worker's scratch checkout.
	t.Setenv("TMPDIR", t.TempDir())
	explicitHead := []bool{len(options) > 1 && options[1]}
	delegatedBrowser := options
	installBrowser := browserJourney || len(delegatedBrowser) > 0 && delegatedBrowser[0]
	learningJourney := len(options) > 2 && options[2]
	installation := int64(98300) + confirmationMergeInstallations.Add(1)
	var pool *pgxpool.Pool
	if installBrowser {
		_, _, pool = splitProcessDatabase(t)
	} else {
		pool, _ = postgresfixture.NewProductDatabase(t)
	}
	ctx := context.Background()
	q := db.New(pool)
	var mirror *pollingGitHost
	gitRoot, base := "", ""
	if confirmations || labelApproval {
		// Real Git transport behind the existing native-host test adapter.
		// GitHub and the install mirror are distinct bare repositories.
		gitRoot = t.TempDir()
		upstream := &pollingGitHost{dir: filepath.Join(gitRoot, "rehearsal-owner", "app.git")}
		require.NoError(t, upstream.git(ctx, nil, io.Discard, "init", "--bare", upstream.dir))
		var tree, commit, blob bytes.Buffer
		require.NoError(t, upstream.git(ctx, strings.NewReader(""), &tree, "mktree"))
		require.NoError(t, upstream.git(ctx, nil, &commit, "commit-tree", strings.TrimSpace(tree.String()), "-m", "Main"))
		base = strings.TrimSpace(commit.String())
		require.NoError(t, upstream.git(ctx, nil, io.Discard, "update-ref", "refs/heads/main", base))
		require.NoError(t, upstream.git(ctx, strings.NewReader("Hello\n"), &blob, "hash-object", "-w", "--stdin"))
		tree.Reset()
		require.NoError(t, upstream.git(ctx, strings.NewReader("100644 blob "+strings.TrimSpace(blob.String())+"\twave.md\n"), &tree, "mktree"))
		commit.Reset()
		require.NoError(t, upstream.git(ctx, nil, &commit, "commit-tree", strings.TrimSpace(tree.String()), "-p", base, "-m", "Wave"))
		require.NoError(t, upstream.git(ctx, nil, io.Discard, "update-ref", "refs/heads/smithers/wave", strings.TrimSpace(commit.String())))
		mirror = &pollingGitHost{dir: filepath.Join(t.TempDir(), "mirror.git")}
		require.NoError(t, mirror.git(ctx, nil, io.Discard, "init", "--bare", mirror.dir))
		require.NoError(t, mirror.git(ctx, nil, io.Discard, "fetch", upstream.dir, "refs/heads/main:refs/heads/main", "refs/heads/smithers/wave:"+repohost.MythicalReservedRefNS+"keep/"+strings.TrimSpace(commit.String())))
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	app := services.GitHubAppCredentials{ID: 42, Slug: "smithers-install", OwnerLogin: "rehearsal-owner", OwnerKind: "user", ClientID: "client",
		ClientSecret: "secret", WebhookSecret: "webhook", PEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))}
	fake, err := githubfake.New(githubfake.Config{OAuthCode: "owner-code", GitRoot: gitRoot, AppID: app.ID, Slug: app.Slug, OwnerLogin: app.OwnerLogin, OwnerKind: app.OwnerKind,
		ClientID: app.ClientID, ClientSecret: app.ClientSecret, WebhookSecret: app.WebhookSecret, PrivateKeyPEM: app.PEM, ConversionCode: "manifest-code",
		Installations: []githubfake.Installation{{ID: installation, Repositories: []githubfake.Repository{{ID: 100, FullName: "rehearsal-owner/app"}}}}})
	require.NoError(t, err)
	t.Cleanup(fake.Close)
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", fake.URL)
	t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", fake.URL)
	for _, call := range []struct{ path, form string }{
		{"/app-manifests/manifest-code/conversions", ""},
		{"/login/oauth/access_token", url.Values{"code": {"owner-code"}, "client_id": {"client"}, "client_secret": {"secret"}, "redirect_uri": {"http://smithers.test/callback"}}.Encode()},
	} {
		response, err := fake.Client().Post(fake.URL+call.path, "application/x-www-form-urlencoded", strings.NewReader(call.form))
		require.NoError(t, err)
		require.Less(t, response.StatusCode, 300, call.path)
		require.NoError(t, response.Body.Close())
	}

	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "merge-owner", LowerUsername: "merge-owner", DisplayName: "Merge owner"})
	require.NoError(t, err)
	if browserJourney && os.Getenv("SMITHERS_CATALOG_MERGE_BROWSER") == "1" {
		// Developer diagnostics are hidden from ordinary owners; this person
		// is both the real install owner and an explicitly enabled developer.
		_, err = pool.Exec(ctx, `UPDATE users SET is_admin=true WHERE id=$1`, owner.ID)
		require.NoError(t, err)
	}
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "merge-member", LowerUsername: "merge-member", DisplayName: "Merge member"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	for _, sql := range []struct {
		text string
		args []any
	}{
		{`UPDATE users SET is_active = true WHERE id IN ($1, $2)`, []any{owner.ID, member.ID}},
		{`INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, []any{repo.ID, member.ID}},
		{`INSERT INTO self_host_owners(singleton,user_id) VALUES (true,$1)`, []any{owner.ID}},
		{`INSERT INTO oauth_accounts(id,user_id,provider,provider_user_id,profile_data) VALUES (1,$1,'github','7','{"login":"rehearsal-owner"}')`, []any{owner.ID}},
		{`UPDATE repositories SET mirror_destination = 'rehearsal-owner/app' WHERE id = $1`, []any{repo.ID}},
	} {
		_, err := pool.Exec(ctx, sql.text, sql.args...)
		require.NoError(t, err, sql.text)
	}
	// Setup bound the repository and verified the owner's access to it.
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"merge-owner","repository_name":"app","repository_id":%d}`, repo.ID))}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access",
		Value: []byte(fmt.Sprintf(`{"last_access_check_at":%q,"owner_login":"merge-owner","repository_name":"app","repository_id":%d}`, time.Now().UTC().Format(time.RFC3339Nano), repo.ID))}))
	session := func(user db.User, raw string) string {
		digest := sha256.Sum256([]byte(raw))
		_, err := pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES ($1,$2,$3,NOW() + interval '1 hour')`,
			hex.EncodeToString(digest[:]), user.ID, user.Username)
		require.NoError(t, err)
		return hex.EncodeToString(digest[:])
	}
	ownerSession := session(owner, "owner-browser-session")
	session(member, "member-browser-session")
	patSeed := sha256.Sum256([]byte("owner-personal-token"))
	pat := "smithers_" + hex.EncodeToString(patSeed[:])[:40]
	patHash := sha256.Sum256([]byte(pat))
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "cli", TokenHash: hex.EncodeToString(patHash[:]),
		TokenLastEight: hex.EncodeToString(patHash[:])[56:], Scopes: "all", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)

	// The install composition (compose/main.go): orchestration, the App's
	// TODO writes with every guard, MergeDecision and the merge transport.
	codec, err := webhook.NewSecretCodec("merge-route-sealing-key")
	require.NoError(t, err)
	credentials := services.NewGitHubAppCredentialStore(pool, codec)
	require.NoError(t, credentials.Save(ctx, app))
	userRepos := services.NewGitHubUserReposService(q, ownerTokenDecrypter{})
	connections := services.NewRepoConnectionService(pool, credentials)
	connections.SetGitHubRepoAccessVerifier(userRepos)
	_, err = connections.ConnectRepo(ctx, owner.ID, "rehearsal-owner", "app", "MIT")
	require.NoError(t, err)
	require.NoError(t, connections.ReconcileGitHubAppInstallations(ctx))
	mythical := services.NewMythicalService(pool, nil)
	if confirmations || labelApproval {
		mythical = services.NewMythicalService(pool, mirror)
	}
	mythical.SetOrchestration(services.NewMythicalGitHub(q, connections, userRepos, connections), nil, nil)
	mythical.SetPolicyReader(noPolicy{})
	if learningJourney {
		store, err := jobs.NewStore(pool)
		require.NoError(t, err)
		mythical.EnableLearningAdmission(store)
	}

	mythical.EnableTodoPublication(credentials, connections, services.NewBudgetTracker())
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 100, false)
	require.NoError(t, err)
	if confirmations || labelApproval {
		require.NoError(t, mythical.PollOnce(ctx))
		stack, err := q.GetMythicalStack(ctx, repo.ID)
		require.NoError(t, err)
		require.Equal(t, "active", stack.State, stack.LastError)
	} else {
		_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state = 'active' WHERE repository_id = $1`, repo.ID)
		require.NoError(t, err)
	}

	if learningJourney {
		// Literal C-J8-01 history: T7 follows six older merged TODOs.
		for n := 1; n <= 6; n++ {
			_, err = pool.Exec(ctx, `INSERT INTO mythical_items(repository_id,source,state,owner_id,pr_state,pr_merge_commit,checks) VALUES($1,'todo','landed',$2,'merged',$3,'{"attempts":[]}')`, repo.ID, owner.ID, base)
			require.NoError(t, err)
		}
		for n := 1; n <= 40; n++ {
			require.EqualValues(t, n, fake.OpenIssue("rehearsal-owner/app", "rehearsal-owner", "Earlier issue", "Recorded history"))
		}
	}

	// A TODO in review: filed by the owner, its pull request open on GitHub.
	// Candidate execution belongs to T-STK-01; this fixture supplies its
	// accepted result, then exercises the real confirmation and merge worker.
	filed, err := mythical.FileTodo(middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, SessionHash: ownerSession}), repo.ID, owner.ID,
		services.MythicalTodoInput{Title: "Wave", Prompt: "Wave hello", Request: "file-wave"})
	require.NoError(t, err)
	if learningJourney {
		require.EqualValues(t, 7, filed.Number)
		// Thirteen more historical outcomes make nineteen before T7's merge.
		for n := 8; n <= 20; n++ {
			_, err = pool.Exec(ctx, `INSERT INTO mythical_items(repository_id,source,state,owner_id,pr_state,pr_merge_commit,checks) VALUES($1,'todo','landed',$2,'merged',$3,'{"attempts":[]}')`, repo.ID, owner.ID, base)
			require.NoError(t, err)
		}
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=checks || '{"attempts":[{"attempt":1,"run_id":"attempt-1","items":[{"kind":"check","name":"lint","state":"failed","tier":"slow","evidence":"Run lint before review to catch unused imports."}]},{"attempt":2,"run_id":"attempt-2","items":[]}],"steers":[{"text":"Use the existing retry helper because it already backs off.","attempt":1}],"githubInputs":[{"text":"Keep retries bounded because the provider can remain unavailable.","review_state":"COMMENTED"}]}' WHERE repository_id=$1 AND number=7`, repo.ID)
		require.NoError(t, err)
	}
	token, err := connections.CreateGitHubInstallationTokenForRepositoryOwner(ctx, owner.ID, 0, "rehearsal-owner", "app", map[string]string{"pull_requests": "write"})
	require.NoError(t, err)
	request, err := http.NewRequest(http.MethodPost, fake.URL+"/repos/rehearsal-owner/app/pulls", strings.NewReader(`{"title":"Wave","head":"smithers/wave","base":"main"}`))
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+token.Token)
	response, err := fake.Client().Do(request)
	require.NoError(t, err)
	var pull githubfake.Pull
	require.NoError(t, json.NewDecoder(response.Body).Decode(&pull))
	require.NoError(t, response.Body.Close())
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state = 'proposed', pr_number = $2, pr_url = $3, pr_state = 'open', pr_head = $4, candidate_verified = true
		WHERE repository_id = $1 AND number = $5`, repo.ID, pull.Number, pull.HTMLURL, pull.Head.SHA, filed.Number)
	require.NoError(t, err)
	if labelApproval {
		fake.RequireCheck("required-ci")
		fake.SetCheck("rehearsal-owner/app", pull.Head.SHA, "required-ci", "in_progress", "")
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{branch}','"smithers/wave"'::jsonb) WHERE repository_id=$1 AND number=$2`, repo.ID, filed.Number)
		require.NoError(t, err)
	}
	item := func() db.MythicalItem {
		row, err := q.GetMythicalItemByNumber(ctx, repo.ID, filed.Number)
		require.NoError(t, err)
		return row
	}
	before := item()

	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	issuer := &outboundProxyIssuer{}
	var authHandler *routes.AuthHandler
	var membersHandler *routes.MembersHandler
	if confirmations && !browserJourney {
		cfg.Auth.SessionSecret = "merge-login-fixture"
		for _, key := range []string{"github.repository", "owner.access"} {
			_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{owner_login}','"rehearsal-owner"') WHERE key=$1`, key)
			require.NoError(t, err)
		}
		members := &services.Members{Pool: pool, Credentials: credentials, Minter: connections}
		authService := services.NewAuthService(q, cfg.Auth, nil, auth.NewGitHubClient(credentials, "", fake.URL, fake.URL))
		authService.InstallSetup = &services.InstallSetupSessions{Pool: pool}
		authService.Members = members
		authHandler = &routes.AuthHandler{Service: authService, AuthConfig: cfg.Auth, InstallSetup: authService.InstallSetup}
		membersHandler = &routes.MembersHandler{Service: members}
	}
	server.Config.Handler = todoMergeComposeRouterWithAuth(cfg, q, pool, &routes.MythicalHandler{Service: mythical}, authHandler, membersHandler, &routes.GitHubProxyHandler{Service: services.NewGitHubProxyService(issuer)})
	if installBrowser {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin') ON CONFLICT DO NOTHING`, repo.ID, owner.ID)
		require.NoError(t, err)
		encrypted, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey("split-process-session-secret"), []byte("ghu_githubfake_owner"))
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE oauth_accounts SET access_token_encrypted=$1 WHERE user_id=$2`, encrypted, owner.ID)
		require.NoError(t, err)
		t.Setenv("SMITHERS_PUBLIC_URL", origin)
		t.Setenv("SMITHERS_SERVER_ALLOWED_ORIGINS", origin)
		t.Setenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY", "merge-route-sealing-key")
		browserOptions := Options{ChatHost: unusedChatHost{}}
		if browserJourney || len(delegatedBrowser) > 0 && delegatedBrowser[0] {
			// This journey observes admission before execution. Run the real
			// HTTP half; the worker is exercised by the recovery journey.
			browserOptions.Duties = DutiesHTTP
		}
		native := repohostffi.New(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
		require.NoError(t, native.Load())
		storagePath := t.TempDir()
		sidecar, err := repohostserver.NewWithFFI(repohostserver.Config{StoragePath: storagePath, AuthToken: "access-merge-test", PushHookCallbackToken: "test-callback"}, native)
		require.NoError(t, err)
		storageServer := httptest.NewServer(sidecar.Handler())
		t.Cleanup(storageServer.Close)
		host := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: storageServer.URL}, "access-merge-test")
		require.NoError(t, host.InitRepo(ctx, owner.Username, repo.Name, "main", true))
		if browserJourney || len(delegatedBrowser) > 0 && delegatedBrowser[0] {
			// The native mirror reads the same accepted main and candidate as
			// the production merge fixture, rather than an unrelated init tree.
			nativeGit := &pollingGitHost{dir: filepath.Join(storagePath, owner.Username, repo.Name, ".jj", "repo", "store", "git")}
			require.NoError(t, nativeGit.git(ctx, nil, io.Discard, "fetch", mirror.dir, "+refs/*:refs/*"))
			require.NoError(t, host.ImportRefs(ctx, owner.Username, repo.Name))
		}
		browserOptions.Repository = host
		t.Setenv("SMITHERS_REPO_HOST_URL", storageServer.URL)
		t.Setenv("SMITHERS_REPO_HOST_AUTH_TOKEN", "access-merge-test")
		api := startSplitProcess(t, browserOptions)
		spa, err := filepath.Abs("../../../../apps/app/dist")
		require.NoError(t, err)
		_, err = os.Stat(filepath.Join(spa, "index.html"))
		require.NoError(t, err, "build apps/app before the browser journey")
		files := http.FileServer(http.Dir(spa))
		server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				api.ServeHTTP(w, r)
			} else if filepath.Ext(r.URL.Path) == "" {
				http.ServeFile(w, r, filepath.Join(spa, "index.html"))
			} else {
				files.ServeHTTP(w, r)
			}
		})
	}
	server.Start()
	t.Cleanup(server.Close)

	if labelApproval {
		require.NoError(t, credentials.SetInstallation(ctx, installation))
		synced := services.NewGitHubSyncedRepoService(q)
		require.NoError(t, synced.ConfigureInstallSync(pool))
		synced.BindInstallAuthority(credentials, true)
		synced.SetConditionalFetcherFactory(userRepos.SyncedRepoConditionalFetcherFactory(connections))
		mythical.UseInstallGitHubPolling(synced)
		syncedRow, err := q.EnrollGitHubSyncedRepo(ctx, db.EnrollGitHubSyncedRepoParams{OwnerLogin: "rehearsal-owner", RepoName: "app", InstallationID: pgtype.Int8{Int64: installation, Valid: true}, GithubRepositoryID: pgtype.Int8{Int64: 100, Valid: true}, SyncMetadata: true, EnrolledVia: services.GitHubSyncedRepoEnrolledViaInstallation})
		require.NoError(t, err)
		require.Positive(t, fake.LabelIssue("rehearsal-owner/app", pull.Number, "rehearsal-owner", "automerge"))
		workerCtx, stop := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() { defer close(done); synced.StartReconciler(workerCtx) }()
		defer func() { stop(); <-done }()
		require.Eventually(t, func() bool {
			request, err := http.NewRequest(http.MethodGet, origin+fmt.Sprintf("/api/todos/%d", filed.Number), nil)
			require.NoError(t, err)
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
			response, err := fake.Client().Do(request)
			require.NoError(t, err)
			defer response.Body.Close()
			var card map[string]any
			require.NoError(t, json.NewDecoder(response.Body).Decode(&card))
			return response.StatusCode == 200 && card["preapproval"] != nil
		}, 20*time.Second, 100*time.Millisecond, "the install TODO card must show the authenticated PR label approval")
		require.Empty(t, item().PendingOp, "ingestion grants approval without dispatching")
		// The production follow pass fetches checks and the same durable
		// delivery worker acknowledges the snapshot and requests evaluation.
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at=NOW()-INTERVAL '1 second' WHERE id=$1`, before.ID)
		require.NoError(t, err)
		require.NoError(t, mythical.PollOnce(ctx))
		require.Eventually(t, func() bool {
			var count int
			err := pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id='checks' AND state='completed'`).Scan(&count)
			return err == nil && count > 0
		}, 10*time.Second, 100*time.Millisecond, "check snapshots must reach the composed merge consumer")
		var woken int
		require.NoError(t, pool.QueryRow(ctx, `SELECT (terminal_receipt->>'woken')::int FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id='checks' AND state='completed' LIMIT 1`).Scan(&woken))
		require.Equal(t, 1, woken)
		for replay := 0; replay < 2; replay++ {
			require.NoError(t, synced.ReadInstallPullFacts(ctx, syncedRow, pull.Number, pull.Head.SHA, "checks"))
		}
		var deliveries int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id='checks'`).Scan(&deliveries))
		require.Equal(t, 1, deliveries, "duplicate fetched facts reuse the committed delivery")
		// C-J4-03's service layer: the later card and person command use
		// the same order decision, before any GitHub merge transport.
		later, err := mythical.FileTodo(middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, SessionHash: ownerSession}), repo.ID, owner.ID,
			services.MythicalTodoInput{Title: "Later", Prompt: "Wait for Wave", Request: "file-later"})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='proposed',pr_head=$2,pr_number=$4,pr_state='open',candidate_verified=true WHERE repository_id=$1 AND number=$3`, repo.ID, pull.Head.SHA, later.Number, pull.Number+1)
		require.NoError(t, err)
		get, err := http.NewRequest(http.MethodGet, origin+fmt.Sprintf("/api/todos/%d", later.Number), nil)
		require.NoError(t, err)
		get.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
		response, err := fake.Client().Do(get)
		require.NoError(t, err)
		var card map[string]any
		require.NoError(t, json.NewDecoder(response.Body).Decode(&card))
		require.NoError(t, response.Body.Close())
		require.Equal(t, 200, response.StatusCode)
		require.Equal(t, "order", card["merge"].(map[string]any)["reason"])
		predecessor := "T1"
		if learningJourney {
			predecessor = "T7"
		}
		require.Equal(t, predecessor, card["merge"].(map[string]any)["detail"])
		press, err := http.NewRequest(http.MethodPost, origin+fmt.Sprintf("/api/todos/%d/merge", later.Number), strings.NewReader(`{"reviewed_head_sha":"`+pull.Head.SHA+`"}`))
		require.NoError(t, err)
		press.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
		press.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		press.Header.Set("X-CSRF-Token", "csrf")
		press.Header.Set("Origin", origin)
		press.Header.Set("Content-Type", "application/json")
		press.Header.Set("Idempotency-Key", "merge-later")
		response, err = fake.Client().Do(press)
		require.NoError(t, err)
		var refusal map[string]any
		require.NoError(t, json.NewDecoder(response.Body).Decode(&refusal))
		require.NoError(t, response.Body.Close())
		require.Equal(t, 409, response.StatusCode)
		require.Equal(t, "order", refusal["code"])
		for _, write := range fake.Writes() {
			require.False(t, strings.HasSuffix(write.Path, "/merge"), "out-of-order requests merge nothing")
		}
		fake.SetCheck("rehearsal-owner/app", pull.Head.SHA, "required-ci", "completed", "success")
		for replay := 0; replay < 2; replay++ {
			require.NoError(t, synced.ReadInstallPullFacts(ctx, syncedRow, pull.Number, pull.Head.SHA, "checks"))
		}
		require.Eventually(t, func() bool {
			var count int
			err := pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id='checks' AND state='completed' AND terminal_receipt->>'woken'='1'`).Scan(&count)
			return err == nil && count == 2
		}, 10*time.Second, 100*time.Millisecond)
		for pass := 0; pass < 6 && item().State != "landed"; pass++ {
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at=NOW()-INTERVAL '1 second' WHERE id=$1`, before.ID)
			require.NoError(t, err)
			_, err = q.RequestMythicalStack(ctx, repo.ID)
			require.NoError(t, err)
			require.NoError(t, mythical.PollOnce(ctx))
		}
		require.Equal(t, "landed", item().State)
		merges := 0
		for _, write := range fake.Writes() {
			if !strings.HasSuffix(write.Path, "/merge") {
				continue
			}
			merges++
			var sent struct {
				SHA    string `json:"sha"`
				Method string `json:"merge_method"`
			}
			require.NoError(t, json.Unmarshal(write.Body, &sent))
			require.Equal(t, pull.Head.SHA, sent.SHA)
			require.Equal(t, "squash", sent.Method)
		}
		require.Equal(t, 1, merges)
		get.URL.Path = fmt.Sprintf("/api/todos/%d", filed.Number)
		response, err = fake.Client().Do(get)
		require.NoError(t, err)
		card = nil
		require.NoError(t, json.NewDecoder(response.Body).Decode(&card))
		require.NoError(t, response.Body.Close())
		require.Equal(t, 200, response.StatusCode)
		require.Equal(t, "merged", card["state"])
		require.Equal(t, "rehearsal-owner", card["preapproval"].(map[string]any)["by"])
		if learningJourney {
			// Confirmed merge/poll admission has settled. Join the GitHub
			// reconciler before the completion-only refusal cases mutate item
			// states, so poll facts cannot race their no-new-events assertions.
			stop()
			<-done
			proveLearningMergedDispatch(t, pool, mythical, item(), server)
		}

		return
	}

	if confirmations {
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET attempt=1,candidate_base=$2,candidate_head=pr_head,checks=jsonb_set(checks,'{branch}','"smithers/wave"'::jsonb) WHERE id=$1`, before.ID, base)
		require.NoError(t, err)
		call := func(method, path, cookie, bearer, key, body string) (int, map[string]any) {
			r, err := http.NewRequest(method, origin+path, strings.NewReader(body))
			require.NoError(t, err)
			r.Header.Set("Origin", origin)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Idempotency-Key", key)
			if cookie != "" {
				r.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
				r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
				r.Header.Set("X-CSRF-Token", "csrf")
			}
			if bearer != "" {
				r.Header.Set("Authorization", "Bearer "+bearer)
			}
			response, err := http.DefaultClient.Do(r)
			require.NoError(t, err)
			defer response.Body.Close()
			var bodyMap map[string]any
			require.NoError(t, json.NewDecoder(response.Body).Decode(&bodyMap))
			return response.StatusCode, bodyMap
		}
		// C-CAT-02: request through the actual source CLI, with a delegated
		// credential. Discovery, schema parsing and HTTP dispatch all run.
		if !installBrowser {
			fake.SetCollaborator(17, "merge-owner", "admin")
			fake.SignInAs("merge-login-code", 17)
			_, err = pool.Exec(ctx, `INSERT INTO oauth_accounts(id,user_id,provider,provider_user_id,profile_data) VALUES(2,$1,'workos','17','{}')`, owner.ID)
			require.NoError(t, err)
			via := "claude-code"
			if len(explicitHead) > 0 && explicitHead[0] {
				via = "cli"
			}
			pat = confirmationCLILogin(t, ctx, origin, "merge-login-code", via)
			digest := sha256.Sum256([]byte(pat))
			var scopes string
			require.NoError(t, pool.QueryRow(ctx, `SELECT scopes FROM access_tokens WHERE token_hash=$1`, hex.EncodeToString(digest[:])).Scan(&scopes))
			require.Contains(t, scopes, "via:"+via)
			require.NotContains(t, scopes, "write:approval")
		}
		invoke := catalogCLIInvoker(t, ctx, origin, pat)
		argv := []string{"merge", fmt.Sprintf("T%d", filed.Number)}
		if len(explicitHead) > 0 && explicitHead[0] {
			argv = append(argv, "--reviewed_head_sha", pull.Head.SHA)
		}
		argv = append(argv, "--idempotencyKey", "confirm-create")
		code, receipt := invoke(argv...)
		require.Equal(t, 3, code, receipt)
		require.Equal(t, "pending", receipt["state"])
		require.Equal(t, "Waiting for Merge owner to confirm", receipt["message"])
		require.Len(t, receipt, 3, "the CLI exposes only the receipt and waiting message")
		id := receipt["confirmation"].(string)
		aliasBody := `{}`
		if len(explicitHead) > 0 && explicitHead[0] {
			aliasBody = fmt.Sprintf(`{"reviewed_head_sha":%q}`, pull.Head.SHA)
		}
		aliasStatus, aliasReceipt := call(http.MethodPost, "/api/repos/merge-owner/app/mythical/items/"+uuid.UUID(before.ID.Bytes).String()+"/merge", "", pat, "confirm-create", aliasBody)
		require.Equal(t, http.StatusAccepted, aliasStatus, aliasReceipt)
		require.Equal(t, id, aliasReceipt["confirmation"], "the legacy door replays the same private confirmation")
		require.Equal(t, "pending", aliasReceipt["state"])
		for _, write := range fake.Writes() {
			require.False(t, write.Method == "PUT" && strings.HasSuffix(write.Path, "/merge"), "requesting confirmation never merges")
		}

		if len(delegatedBrowser) > 0 && delegatedBrowser[0] {
			runMergeConfirmationBrowser(t, cfg, pool, mythical, server, owner, pat, id, filed.Number, pull.Head.SHA, before.ID,
				&services.Members{Pool: pool, Credentials: credentials, Minter: connections, Budget: services.NewBudgetTracker()})
			return
		}
		boundRow, err := q.GetMemberConfirmation(ctx, id, owner.ID)
		require.NoError(t, err)
		require.Equal(t, "review_merge", boundRow.Kind)
		require.Contains(t, boundRow.Revision, pull.Head.SHA)

		replayCode, replay := invoke(argv...)
		require.Equal(t, 3, replayCode)
		require.Equal(t, receipt, replay, "repeated CLI invocation keeps the same private confirmation")
		if phaseDir := os.Getenv("SMITHERS_ACCESS_MERGE_PHASE_DIR"); browserJourney && phaseDir != "" {
			wait := func(name string) {
				t.Helper()
				deadline := time.NewTimer(2 * time.Minute)
				defer deadline.Stop()
				tick := time.NewTicker(20 * time.Millisecond)
				defer tick.Stop()
				for {
					if _, err := os.Stat(filepath.Join(phaseDir, name)); err == nil {
						return
					}
					if _, err := os.Stat(filepath.Join(phaseDir, "done")); err == nil {
						t.Fatalf("browser ended before %s", name)
					}
					select {
					case <-tick.C:
					case <-deadline.C:
						t.Fatalf("browser did not reach %s", name)
					}
				}
			}
			noMerge := func() {
				t.Helper()
				for _, write := range fake.Writes() {
					require.False(t, write.Method == "PUT" && strings.HasSuffix(write.Path, "/merge"))
				}
			}
			fmt.Printf("ACCESS_MERGE_READY %s %s\n", origin, id)
			wait("shown")
			// The head stays the same: generation is an independent approval fence.
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET generation=generation+1 WHERE id=$1`, before.ID)
			require.NoError(t, err)
			fmt.Println("ACCESS_MERGE_CHANGED")
			wait("expired")
			row, err := q.GetMemberConfirmation(ctx, id, owner.ID)
			require.NoError(t, err)
			require.Equal(t, "expired", row.State)
			require.Empty(t, item().PendingOp)
			noMerge()
			argv[len(argv)-1] = "access-current-generation"
			code, receipt = invoke(argv...)
			require.Equal(t, 3, code, receipt)
			id = receipt["confirmation"].(string)
			fmt.Println("ACCESS_MERGE_CURRENT " + id)
			wait("approved")
			row, err = q.GetMemberConfirmation(ctx, id, owner.ID)
			require.NoError(t, err)
			require.Equal(t, "pending", row.State, "admission is not a completed merge")
			var operation services.MythicalOutboundOp
			require.NoError(t, json.Unmarshal(item().PendingOp, &operation))
			require.Equal(t, "merge", operation.Kind)
			noMerge()
			return
		}
		if browserJourney {
			command := exec.CommandContext(t.Context(), "bun", "e2e/real/catalog-merge.browser.ts")
			command.Dir = "../../../../apps/app"
			command.Env = append(os.Environ(), "SMITHERS_CATALOG_ORIGIN="+origin, "SMITHERS_CATALOG_CONFIRMATION="+id)
			output, err := command.CombinedOutput()
			t.Log(string(output))
			require.NoError(t, err)
			row, err := q.GetMemberConfirmation(ctx, id, owner.ID)
			require.NoError(t, err)
			require.Equal(t, "rejected", row.State)
			require.Empty(t, item().PendingOp)
			for _, write := range fake.Writes() {
				require.False(t, write.Method == "PUT" && strings.HasSuffix(write.Path, "/merge"))
			}
			// Cancellation completes only this request. Start a fresh delegated
			// request so the same real browser can also authorize the merge.
			argv[len(argv)-1] = "browser-after-cancellation"
			code, receipt = invoke(argv...)
			require.Equal(t, 3, code, receipt)
			id = receipt["confirmation"].(string)
		}
		status := 0
		require.Empty(t, item().PendingOp)
		status, receipt = call("POST", "/api/confirmations/"+id+"/approve", "", pat, "agent-press", `{}`)
		require.Equal(t, 403, status, receipt)
		status, receipt = call("POST", "/api/confirmations/"+id+"/approve", "member-browser-session", "", "foreign-press", `{}`)
		require.Equal(t, 403, status, receipt)
		// A new generation invalidates the exact revision the agent requested.
		// The person's stale press must expire it without admitting a merge.
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET generation=generation+1 WHERE id=$1`, before.ID)
		require.NoError(t, err)
		status, receipt = call("POST", "/api/confirmations/"+id+"/approve", "owner-browser-session", "", "stale-person-press", `{}`)
		require.Equal(t, 409, status, receipt)
		require.Equal(t, "conflict", receipt["class"])
		require.Equal(t, "confirmation_resolved", receipt["code"])
		staleRow, err := q.GetMemberConfirmation(ctx, id, owner.ID)
		require.NoError(t, err)
		require.Equal(t, "expired", staleRow.State)
		require.Empty(t, item().PendingOp)
		for _, write := range fake.Writes() {
			require.False(t, write.Method == "PUT" && strings.HasSuffix(write.Path, "/merge"))
		}
		// A moved head with the same generation must expire the card too.
		argv[len(argv)-1] = "confirm-before-head-move"
		code, receipt = invoke(argv...)
		require.Equal(t, 3, code, receipt)
		movedID := receipt["confirmation"].(string)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET pr_head=$2 WHERE id=$1`, before.ID, strings.Repeat("e", 40))
		require.NoError(t, err)
		status, receipt = call("POST", "/api/confirmations/"+movedID+"/approve", "owner-browser-session", "", "moved-head-press", `{}`)
		require.Equal(t, 409, status, receipt)
		movedRow, err := q.GetMemberConfirmation(ctx, movedID, owner.ID)
		require.NoError(t, err)
		require.Equal(t, "expired", movedRow.State)
		require.Empty(t, item().PendingOp)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET pr_head=$2 WHERE id=$1`, before.ID, pull.Head.SHA)
		require.NoError(t, err)
		fake.RequireCheck("required/unit")
		fake.SetCheck("rehearsal-owner/app", pull.Head.SHA, "required/unit", "in_progress", "")
		fake.SetCheck("rehearsal-owner/app", pull.Head.SHA, "optional/lint", "completed", "failure")
		argv[len(argv)-1] = "confirm-current-generation"
		code, receipt = invoke(argv...)
		require.Equal(t, 3, code, receipt)
		id = receipt["confirmation"].(string)
		status, receipt = call("POST", "/api/confirmations/"+id+"/approve", "owner-browser-session", "", "pending-check-press", `{}`)
		require.Equal(t, 409, status, receipt)
		require.Equal(t, "checks", receipt["code"])
		pending, err := q.GetMemberConfirmation(ctx, id, owner.ID)
		require.NoError(t, err)
		require.Equal(t, "pending", pending.State)
		require.Empty(t, item().PendingOp)
		for _, write := range fake.Writes() {
			require.False(t, write.Method == "PUT" && strings.HasSuffix(write.Path, "/merge"))
		}
		// Only the required check changes. The failed optional check remains
		// on the reviewed SHA and cannot prevent the person's approval.
		fake.SetCheck("rehearsal-owner/app", pull.Head.SHA, "required/unit", "completed", "success")
		if browserJourney {
			command := exec.CommandContext(t.Context(), "bun", "e2e/real/catalog-merge-approve.browser.ts")
			command.Dir = "../../../../apps/app"
			command.Env = append(os.Environ(), "SMITHERS_CATALOG_ORIGIN="+origin, "SMITHERS_CATALOG_CONFIRMATION="+id)
			output, err := command.CombinedOutput()
			t.Log(string(output))
			require.NoError(t, err)
			var operation services.MythicalOutboundOp
			require.NoError(t, json.Unmarshal(item().PendingOp, &operation))
			require.Equal(t, "merge", operation.Kind, "the keyboard press admits the merge")
		}
		if !browserJourney {
			status, receipt = call("POST", "/api/confirmations/"+id+"/approve", "owner-browser-session", "", "person-press", `{}`)
			require.Equal(t, 202, status, receipt)
			require.Equal(t, "pending", receipt["state"])
			version := item().Version
			status, receipt = call("POST", "/api/confirmations/"+id+"/approve", "owner-browser-session", "", "person-press", `{}`)
			require.Equal(t, 202, status, receipt)
			require.Equal(t, version, item().Version)
		}
		status, receipt = call("POST", "/api/confirmations/"+id+"/deny", "owner-browser-session", "", "cancel-in-flight", `{}`)
		require.Equal(t, 409, status, receipt)
		require.Equal(t, "merging", receipt["code"])
		row, err := q.GetMemberConfirmation(ctx, id, owner.ID)
		require.NoError(t, err)
		require.Equal(t, "pending", row.State)
		for _, write := range fake.Writes() {
			require.False(t, write.Method == "PUT" && strings.HasSuffix(write.Path, "/merge"), "admission never sends a merge")
		}
		// Lose GitHub's answer after it receives the authorized squash. The
		// next worker is reconstructed from durable rows, as after a restart.
		fake.LoseNextResponses(fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d/merge", pull.Number), 1)
		pass := func(worker *services.MythicalService) {
			_, err := pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at=now() WHERE id=$1`, before.ID)
			require.NoError(t, err)
			worker.MainMoved(ctx, repo.ID)
			require.NoError(t, worker.PollOnce(ctx))
		}
		confirmationState := func() string {
			request, err := http.NewRequest("GET", origin+"/api/confirmations", nil)
			require.NoError(t, err)
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
			response, err := fake.Client().Do(request)
			require.NoError(t, err)
			defer response.Body.Close()
			require.Equal(t, 200, response.StatusCode)
			var rows []db.Confirmation
			require.NoError(t, json.NewDecoder(response.Body).Decode(&rows))
			for _, row := range rows {
				if row.ID == id {
					return row.State
				}
			}
			t.Fatal("confirmation disappeared")
			return ""
		}
		pass(mythical)
		var intent struct {
			State string `json:"state"`
		}
		require.NoError(t, json.Unmarshal(item().PendingOp, &intent))
		require.Equal(t, "unknown", intent.State)
		require.Equal(t, "pending", confirmationState())
		recovered := services.NewMythicalService(pool, mirror)
		recovered.SetOrchestration(services.NewMythicalGitHub(q, connections, userRepos, connections), nil, nil)
		recovered.SetPolicyReader(noPolicy{})
		recovered.EnableTodoPublication(credentials, connections, services.NewBudgetTracker())
		for attempt := 0; attempt < 4; attempt++ {
			pass(recovered)
		}
		require.Equal(t, "landed", item().State)
		require.Empty(t, item().PendingOp)
		require.Equal(t, "approved", confirmationState())
		var merges []githubfake.Write
		for _, write := range fake.Writes() {
			if write.Method == "PUT" && strings.HasSuffix(write.Path, "/merge") {
				merges = append(merges, write)
			}
		}
		require.Len(t, merges, 1)
		var sent struct {
			SHA    string `json:"sha"`
			Method string `json:"merge_method"`
		}
		require.NoError(t, json.Unmarshal(merges[0].Body, &sent))
		require.Equal(t, pull.Head.SHA, sent.SHA)
		require.Equal(t, "squash", sent.Method)
		return
	}

	t.Run("shared TODO replay excludes private and other item facts", func(t *testing.T) {
		scope := jobs.Scope{TenantID: strconv.FormatInt(repo.ID, 10), PrincipalID: "todo:" + uuid.UUID(before.ID.Bytes).String()}
		defer func() {
			_, err := pool.Exec(ctx, `UPDATE collaborators SET suspended_at=NULL WHERE repository_id=$1 AND user_id=$2`, repo.ID, member.ID)
			require.NoError(t, err)
		}()
		var shared []jobs.Event
		err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			var err error
			// Literal authors/attempts cross both boundaries. Event identity is
			// returned by the production append and must survive HTTP replay.
			for _, payload := range []string{
				`{"attempt":1,"actor":"Alice"}`, `{"attempt":1,"actor":"Ben"}`,
				`{"attempt":2,"actor":"Alice"}`, `{"attempt":2,"actor":"Ben"}`,
			} {
				event, err := jobs.RecordFactInTx(ctx, tx, scope, uuid.NewString(), "todo.test", "working", json.RawMessage(payload))
				if err != nil {
					return err
				}
				shared = append(shared, event)
			}
			for _, principal := range []string{"user:private", "todo:" + uuid.NewString()} {
				_, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: scope.TenantID, PrincipalID: principal}, uuid.NewString(), "secret", "working", json.RawMessage(`{"secret":"hidden"}`))
				if err != nil {
					return err
				}
			}
			return nil
		})

		require.NoError(t, err)
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		_, err = jobs.RecordFactInTx(ctx, tx, scope, uuid.NewString(), "rolled_back", "working", json.RawMessage(`{"private":"rollback"}`))
		require.NoError(t, err)
		require.NoError(t, tx.Rollback(ctx))
		read := func(cookie, suffix string) (*http.Response, []byte) {
			request, err := http.NewRequest(http.MethodGet, origin+"/api/todos/"+strconv.FormatInt(filed.Number, 10)+"/events"+suffix, nil)
			require.NoError(t, err)
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
			response, err := http.DefaultClient.Do(request)
			require.NoError(t, err)
			raw, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			response.Body.Close()
			return response, raw
		}
		var canonical jobs.ReplayPage
		for _, cookie := range []string{"owner-browser-session", "member-browser-session"} {
			response, raw := read(cookie, "")
			require.Equal(t, 200, response.StatusCode, string(raw))
			var page jobs.ReplayPage
			require.NoError(t, json.Unmarshal(raw, &page))
			require.Len(t, page.Events, 5)
			require.Equal(t, "todo.created", page.Events[0].Type)
			for i, event := range shared {
				require.Equal(t, event.EventID, page.Events[i+1].EventID)
				require.JSONEq(t, string(event.Data), string(page.Events[i+1].Data))
				require.Greater(t, page.Events[i+1].Sequence, page.Events[i].Sequence)
			}
			require.NotContains(t, string(raw), "hidden")
			require.NotContains(t, string(raw), "rollback")
			if cookie == "owner-browser-session" {
				canonical = page
			} else {
				require.Equal(t, canonical, page)
			}
			// A cursor in the middle returns precisely the same suffix,
			// including across the attempt boundary.
			response, raw = read(cookie, "?cursor="+strconv.FormatInt(page.Events[2].Sequence, 10))
			require.Equal(t, 200, response.StatusCode, string(raw))
			var tail jobs.ReplayPage
			require.NoError(t, json.Unmarshal(raw, &tail))
			require.Equal(t, page.Events[3:], tail.Events)
			require.Equal(t, page.Cursor, tail.Cursor)
			response, raw = read(cookie, "?cursor="+strconv.FormatInt(page.Cursor, 10))
			require.Equal(t, 200, response.StatusCode, string(raw))
			require.NoError(t, json.Unmarshal(raw, &tail))
			require.Empty(t, tail.Events)
			response, _ = read(cookie, "?cursor=-1")
			require.Equal(t, 400, response.StatusCode)
		}
		// Membership is checked again on the next request, before disclosure.
		_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, repo.ID, member.ID)
		require.NoError(t, err)
		response, raw := read("member-browser-session", "")
		require.Equal(t, 401, response.StatusCode, string(raw))
		require.Contains(t, string(raw), `"code":"unauthenticated"`)
		require.NotContains(t, string(raw), "Alice")
	})

	for _, previous := range []bool{false, true} {
		name := "attempt logs keep bytes and refuse unrelated digests"
		if previous {
			name = "previous revision logs keep bytes and refuse unrelated digests"
		}
		t.Run(name, func(t *testing.T) {
			disk, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: origin, SigningKey: bytes.Repeat([]byte{0x42}, 32)})
			require.NoError(t, err)
			defer disk.Close()
			logs := &todoCountingLogStore{Store: disk}
			mythical.SetTodoLogStore(logs)
			payload := "literal check stdout\n"
			hash := sha256.Sum256([]byte(payload))
			digest := hex.EncodeToString(hash[:])
			require.NoError(t, blob.Put(ctx, logs, "repos/"+strconv.FormatInt(repo.ID, 10)+"/todo-logs/"+digest, "text/plain", strings.NewReader(payload)))
			oldChecks := before.Checks
			evidence := map[string]any{"attempt": 1, "revision": "old", "items": []any{map[string]any{"kind": "check", "name": "build", "log_digest": digest}}}
			if previous {
				evidence = map[string]any{"attempt": 1, "revision": "new", "items": []any{}, "previous": map[string]any{"revision": "old", "items": evidence["items"]}}
			}
			retained, _ := json.Marshal(map[string]any{"attempts": []any{evidence}})
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET attempt=2,checks=$2 WHERE id=$1`, before.ID, retained)
			require.NoError(t, err)
			defer func() {
				_, err := pool.Exec(ctx, `UPDATE mythical_items SET attempt=$2,checks=$3 WHERE id=$1`, before.ID, before.Attempt, oldChecks)
				require.NoError(t, err)
			}()
			for _, tc := range []struct {
				attempt, digest string
				status          int
			}{{"1", digest, 200}, {"2", digest, 404}, {"1", strings.Repeat("a", 64), 404}} {
				request, err := http.NewRequest(http.MethodGet, origin+"/api/todos/"+strconv.FormatInt(filed.Number, 10)+"/attempts/"+tc.attempt+"/logs/"+tc.digest, nil)
				require.NoError(t, err)
				request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
				response, err := http.DefaultClient.Do(request)
				require.NoError(t, err)
				raw, err := io.ReadAll(response.Body)
				require.NoError(t, err)
				response.Body.Close()
				require.Equal(t, tc.status, response.StatusCode, string(raw))
				require.Equal(t, int64(1), logs.reads.Load(), "unrelated digests and attempts never invoke blob retrieval")
				if tc.status == 200 {
					require.Equal(t, payload, string(raw))
					require.Equal(t, "nosniff", response.Header.Get("X-Content-Type-Options"))
				}
			}

			// The canonical snapshot still references its log when the current card
			// has no measured candidate. Rendering is not an authorization oracle.
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET attempt=1 WHERE id=$1`, before.ID)
			require.NoError(t, err)
			{
				request, err := http.NewRequest(http.MethodGet, origin+"/api/todos/"+strconv.FormatInt(filed.Number, 10)+"/attempts/1/logs/"+digest, nil)
				require.NoError(t, err)
				request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
				response, err := http.DefaultClient.Do(request)
				require.NoError(t, err)
				raw, err := io.ReadAll(response.Body)
				require.NoError(t, err)
				response.Body.Close()
				require.Equal(t, http.StatusOK, response.StatusCode, string(raw))
				require.Equal(t, payload, string(raw))
				require.Equal(t, int64(2), logs.reads.Load())
			}
			response, err := http.Get(origin + "/api/todos/" + strconv.FormatInt(filed.Number, 10) + "/attempts/1/logs/" + digest)
			require.NoError(t, err)
			response.Body.Close()
			require.Equal(t, http.StatusUnauthorized, response.StatusCode)
			require.Equal(t, int64(2), logs.reads.Load(), "unauthenticated requests never retrieve blob bytes")
		})
	}
	itemID := uuid.UUID(before.ID.Bytes).String()
	numbered := func(target string) string { return "/api/todos/" + target + "/merge" }
	repository := func(target string) string { return "/api/repos/merge-owner/app/mythical/items/" + target + "/merge" }
	elsewhere := func(target string) string {
		return "/api/repos/merge-owner/no-such-repo/mythical/items/" + target + "/merge"
	}
	doors := []struct {
		name string
		path func(string) string
		// valid, unknown and malformed name the TODO, none and nothing;
		// encoded holds an encoded slash, routed as one segment.
		valid, unknown, malformed, encoded string
	}{
		{"numbered", numbered, strconv.FormatInt(filed.Number, 10), "999", "abc", "1%2F2"},
		{"repository", repository, itemID, uuid.NewString(), "not-a-uuid", "a%2Fb"},
		{"unknown repository", elsewhere, itemID, uuid.NewString(), "not-a-uuid", "a%2Fb"},
	}
	post := func(path string, set func(*http.Request)) (int, map[string]any) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"reviewed_head_sha": pull.Head.SHA})
		r, err := http.NewRequest(http.MethodPost, origin+path, bytes.NewReader(body))
		require.NoError(t, err)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		set(r)
		response, err := http.DefaultClient.Do(r)
		require.NoError(t, err)
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		var envelope map[string]any
		require.NoError(t, json.Unmarshal(raw, &envelope), string(raw))
		return response.StatusCode, envelope
	}
	browser := func(raw string, csrf bool, key string) func(*http.Request) {
		return func(r *http.Request) {
			r.AddCookie(&http.Cookie{Name: "smithers_session", Value: raw})
			if csrf {
				r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf-token"})
				r.Header.Set("X-CSRF-Token", "csrf-token")
			}
			if key != "" {
				r.Header.Set("Idempotency-Key", key)
			}
		}
	}
	t.Run("order attention composed OK and merge fence", func(t *testing.T) {
		_, err := pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES ($1,$2,'write') ON CONFLICT DO NOTHING`, repo.ID, member.ID)
		require.NoError(t, err)
		defer func() {
			_, err := pool.Exec(ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, repo.ID, member.ID)
			require.NoError(t, err)
		}()
		attention := `[{"id":"order-one","kind":"order","revision":2,"text":"T3 merged before T2; T2's change is in T3's commit","entries":[{"pr":3,"commit":"abc","text":"first"},{"pr":4,"commit":"def","text":"second"}],"actions":[{"tag":"order.ok","label":"OK"}]}]`
		_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET attention=$2 WHERE repository_id=$1`, repo.ID, []byte(attention))
		require.NoError(t, err)
		projection := &liveTopics{queries: q, todos: mythical}
		ownerSource, refusal := projection.resolve(ctx, "home", repo.ID, "rehearsal-owner/app", owner.ID)
		require.Empty(t, refusal)
		memberSource, refusal := projection.resolve(ctx, "home", repo.ID, "rehearsal-owner/app", member.ID)
		require.Empty(t, refusal)
		require.NotEqual(t, ownerSource.Key, memberSource.Key, "role-filtered Home snapshots cannot share a cache")
		ownerHome, err := ownerSource.Build(ctx)
		require.NoError(t, err)
		memberHome, err := memberSource.Build(ctx)
		require.NoError(t, err)
		require.Contains(t, string(ownerHome), "order-one")
		var memberProjection struct {
			Attention []json.RawMessage `json:"attention"`
		}
		require.NoError(t, json.Unmarshal(memberHome, &memberProjection))
		// Home carries shared facts; the app derives each viewer's controls.
		// The member's forbidden OK press is checked through HTTP below.
		require.Len(t, memberProjection.Attention, 1)
		require.JSONEq(t, attention, "["+string(memberProjection.Attention[0])+"]")
		for _, tc := range []struct {
			cookie   string
			via      bool
			revision int
			status   int
			code     string
		}{
			{"member-browser-session", false, 2, 403, "permission"},
			{"owner-browser-session", true, 2, 403, "never"},
			{"owner-browser-session", false, 1, 409, "stale_attention"},
		} {
			request, err := http.NewRequest("POST", origin+"/api/stack/attention/order-one", strings.NewReader(fmt.Sprintf(`{"revision":%d}`, tc.revision)))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", origin)
			browser(tc.cookie, true, "")(request)
			if tc.via {
				request.Header.Set("Authorization", "Bearer "+pat)
			}
			response, err := http.DefaultClient.Do(request)
			require.NoError(t, err)
			raw, err := io.ReadAll(response.Body)
			response.Body.Close()
			require.NoError(t, err)
			require.Equal(t, tc.status, response.StatusCode, string(raw))
			var envelope map[string]any
			require.NoError(t, json.Unmarshal(raw, &envelope))
			require.Equal(t, tc.code, envelope["code"])
			if tc.code == "stale_attention" {
				require.Equal(t, float64(2), envelope["attention"].(map[string]any)["revision"])
			}
		}
		status, envelope := post(numbered(strconv.FormatInt(filed.Number, 10)), browser("owner-browser-session", true, "attention-blocked"))
		require.Equal(t, 409, status)
		require.Equal(t, "attention", envelope["code"])
		request, err := http.NewRequest("POST", origin+"/api/stack/attention/order-one", strings.NewReader(`{"revision":2}`))
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", origin)
		browser("owner-browser-session", true, "")(request)
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		raw, _ := io.ReadAll(response.Body)
		response.Body.Close()
		require.Equal(t, 204, response.StatusCode, string(raw))
		var record []services.OrderAttention
		var stored []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT attention FROM mythical_stacks WHERE repository_id=$1`, repo.ID).Scan(&stored))
		require.NoError(t, json.Unmarshal(stored, &record))
		require.Equal(t, owner.ID, record[0].SettledBy)
		require.NotNil(t, record[0].SettledAt)
		require.Len(t, record[0].Entries, 2)
		_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET attention='[]'::jsonb WHERE repository_id=$1`, repo.ID)
		require.NoError(t, err)
	})

	unchanged := func(t *testing.T) {
		t.Helper()
		refused := item()
		require.Equal(t, before.Version, refused.Version, "a refusal writes nothing")
		require.Empty(t, refused.PendingOp)
	}

	// Non-browser credentials cannot merge through either door. The numbered
	// door retains the install command gate's pending-confirmation refusal.
	for _, tc := range []struct {
		name     string
		set      func(*http.Request)
		status   int
		envelope map[string]any
	}{
		{"no credential", func(r *http.Request) { r.Header.Set("Idempotency-Key", "anonymous") }, 401,
			map[string]any{"code": "unauthenticated", "class": "permission", "message": "Sign in to merge"}},
		{"the owner's personal access token", func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer "+pat)
			r.Header.Set("Idempotency-Key", "token")
		}, 403, map[string]any{"code": "permission", "class": "permission", "message": "Merge requires an owner or maintainer browser session"}},
		{"an agent action riding the owner's session", func(r *http.Request) {
			browser("owner-browser-session", true, "via-agent")(r)
			r.Header.Set("Smithers-Via", "smithers")
		}, 403, map[string]any{"code": "never", "class": "never", "message": "Only a person can do this"}},
		{"the owner's session without its CSRF token", browser("owner-browser-session", false, "no-csrf"), 403, nil},
		{"another member's session", browser("member-browser-session", true, "member"), 403, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var first map[string]any
			for _, door := range doors {
				first = nil
				for _, target := range []string{door.valid, door.unknown, door.malformed, door.encoded} {
					status, envelope := post(door.path(target), tc.set)
					expectedStatus := tc.status

					var expected map[string]any
					if tc.name == "the owner's personal access token" {
						expectedStatus = http.StatusServiceUnavailable
						expected = map[string]any{"code": "confirmation_unavailable", "class": "infra", "message": "Confirmation unavailable"}

						if door.name == "unknown repository" || target == door.unknown {
							expectedStatus = http.StatusNotFound
							expected = map[string]any{"code": "todo_not_found", "class": "user", "message": "TODO not found"}
						} else if target == door.malformed || target == door.encoded {
							expectedStatus = http.StatusBadRequest
							expected = map[string]any{"code": "invalid_confirmation", "class": "user", "message": "Invalid confirmation request"}
							if door.name == "numbered" {
								expected = map[string]any{"code": "invalid_todo", "class": "user", "message": "Invalid TODO number"}
							}
						}
					} else {
						expected = tc.envelope
					}
					require.Equal(t, expectedStatus, status, "%s %s: %v", door.name, target, envelope)
					if expected != nil {
						require.Equal(t, expected, envelope, "%s %s", door.name, target)
					}

					if first == nil {
						first = envelope
					}
					if tc.name != "the owner's personal access token" {
						require.Equal(t, first, envelope, "%s %s: the same refusal through every door", door.name, target)
					}
				}
			}
			unchanged(t)
		})
	}

	// The owner's session: the same refusals of the TODO it names.
	for _, tc := range []struct {
		name    string
		target  func(valid, unknown, malformed string) string
		key     string
		status  int
		code    string
		message map[string]string
	}{
		{"no Idempotency-Key", func(v, _, _ string) string { return v }, "", 400, "idempotency_key_required", nil},
		{"an unknown TODO", func(_, u, _ string) string { return u }, "unknown", 404, "todo_not_found", nil},
		{"a malformed target", func(_, _, m string) string { return m }, "malformed", 400, "invalid_todo",
			map[string]string{"numbered": "Invalid TODO number", "repository": "Invalid TODO id"}},
	} {
		t.Run("owner session, "+tc.name, func(t *testing.T) {
			for _, door := range doors[:2] {
				status, envelope := post(door.path(tc.target(door.valid, door.unknown, door.malformed)), browser("owner-browser-session", true, tc.key))
				require.Equal(t, tc.status, status, "%s: %v", door.name, envelope)
				require.Equal(t, tc.code, envelope["code"], door.name)
				if tc.message != nil {
					require.Equal(t, tc.message[door.name], envelope["message"], door.name)
				}
			}
			status, _ := post(elsewhere(itemID), browser("owner-browser-session", true, "elsewhere"))
			require.Equal(t, http.StatusNotFound, status, "an unknown repository")
			unchanged(t)
		})
	}

	// Pre-approval uses the real composed person route and persists attribution;
	// credentials and members cannot grant or remove it, even with forged via.
	for _, operation := range []string{"preapprove", "unapprove"} {
		path := "/api/todos/" + strconv.FormatInt(filed.Number, 10) + "/preapproval"
		apply := func(set func(*http.Request)) func(*http.Request) {
			return func(r *http.Request) {
				set(r)
				if operation == "unapprove" {
					r.Method = http.MethodDelete
				}
			}
		}
		for _, credential := range []func(*http.Request){
			browser("member-browser-session", true, "member-approval"),
			func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+pat) },
		} {
			status, _ := post(path, apply(credential))
			require.Equal(t, http.StatusForbidden, status)
			unchanged(t)
		}
		status, response := post(path, apply(browser("owner-browser-session", true, operation)))
		require.Equal(t, http.StatusAccepted, status, response)
		var approval struct {
			Automerge   bool `json:"automerge"`
			Preapproval *struct {
				By   string `json:"by"`
				User int64  `json:"standing_user"`
			} `json:"preapproval"`
			Events []struct {
				Approved bool   `json:"approved"`
				User     int64  `json:"user"`
				Via      string `json:"via"`
			} `json:"preapproval_events"`
		}
		require.NoError(t, json.Unmarshal(item().Checks, &approval))
		require.Equal(t, operation == "preapprove", approval.Automerge)
		require.Equal(t, operation == "preapprove", approval.Preapproval != nil)
		if approval.Preapproval != nil {
			require.Equal(t, owner.ID, approval.Preapproval.User)
			require.Equal(t, "rehearsal-owner", approval.Preapproval.By)
		}
		require.Equal(t, owner.ID, approval.Events[len(approval.Events)-1].User)
		require.Equal(t, "session", approval.Events[len(approval.Events)-1].Via)
		require.Empty(t, item().PendingOp, "approval alone does not dispatch")
		before = item()
	}

	// The owner default is exercised through PUT /api/install and TODO creation
	// through POST /api/todos; no existing item is rewritten.
	putSetting := func(body string, credential func(*http.Request)) int {
		request, err := http.NewRequest(http.MethodPut, origin+"/api/install", strings.NewReader(body))
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", origin)
		credential(request)
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		if response.StatusCode == http.StatusOK {
			var model struct {
				Default *bool `json:"todo_preapprove_default"`
			}
			require.NoError(t, json.NewDecoder(response.Body).Decode(&model))
			require.NotNil(t, model.Default, "Settings must receive the persisted creation default")
			var requested struct {
				Default bool `json:"todo_preapprove_default"`
			}
			require.NoError(t, json.Unmarshal([]byte(body), &requested))
			require.Equal(t, requested.Default, *model.Default)
		}
		require.NoError(t, response.Body.Close())
		return response.StatusCode
	}
	putDefault := func(enabled bool, credential func(*http.Request)) int {
		return putSetting(fmt.Sprintf(`{"todo_preapprove_default":%t}`, enabled), credential)
	}
	for _, body := range []string{
		`{}`, `{"unknown":true}`, `{"capacity":null}`, `{"chatgpt":null}`,
		`{"capacity":"1"}`, `{"chatgpt":1}`,
		`{"todo_preapprove_default":true,"capacity":1}`,
		`{"todo_preapprove_default":true,"chatgpt":false}`,
	} {
		t.Run("invalid_install_setting_"+body, func(t *testing.T) {
			require.Equal(t, 400, putSetting(body, browser("owner-browser-session", true, "invalid-default")))
			var granted bool
			require.NoError(t, pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM install_settings WHERE key='todo.preapproval_default' AND value <> 'null'::jsonb)`).Scan(&granted))
			require.False(t, granted, "invalid settings cannot grant future TODO approval")
		})

	}
	for _, credential := range []func(*http.Request){browser("member-browser-session", true, "default-member"), func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+pat) }} {
		require.Equal(t, 403, putDefault(true, credential))
	}
	require.Equal(t, 200, putDefault(true, browser("owner-browser-session", true, "default-on")))
	create := func(title string, expectedApproval bool) db.MythicalItem {
		request, err := http.NewRequest(http.MethodPost, origin+"/api/todos", strings.NewReader(fmt.Sprintf(`{"title":%q,"prompt":"Do it","place":{"mode":"append"}}`, title)))
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", origin)
		browser("owner-browser-session", true, title)(request)
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		var receipt struct {
			N int64 `json:"n"`
		}
		require.NoError(t, json.NewDecoder(response.Body).Decode(&receipt))
		require.Equal(t, 202, response.StatusCode)
		created, err := q.GetMythicalItemByNumber(ctx, repo.ID, receipt.N)
		require.NoError(t, err)
		var checks struct {
			Automerge   bool `json:"automerge"`
			Preapproval *struct {
				User int64 `json:"standing_user"`
			} `json:"preapproval"`
		}
		require.NoError(t, json.Unmarshal(created.Checks, &checks))
		require.Equal(t, expectedApproval, checks.Automerge)
		if expectedApproval {
			require.NotNil(t, checks.Preapproval)
			require.Equal(t, owner.ID, checks.Preapproval.User)
		} else {
			require.Nil(t, checks.Preapproval)
		}
		return created
	}
	inherited := create("Inherits approval", true)
	unchanged(t)
	require.Equal(t, 200, putDefault(false, browser("owner-browser-session", true, "default-off")))
	create("Human gated", false)
	afterDisable, err := q.GetMythicalItem(ctx, inherited.ID)
	require.NoError(t, err)
	require.Equal(t, inherited.Checks, afterDisable.Checks)
	unchanged(t)

	t.Run("install has no legacy PR landing route", func(t *testing.T) {
		request, err := http.NewRequest(http.MethodPut, origin+"/api/repos/merge-owner/app/landings/1/land", strings.NewReader(`{"commit_id":"legacy"}`))
		require.NoError(t, err)
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
		browser("owner-browser-session", true, "legacy-land")(request)
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		require.Equal(t, http.StatusNotFound, response.StatusCode)
		unchanged(t)
	})

	status, envelope := post(numbered(strconv.FormatInt(filed.Number, 10)), browser("owner-browser-session", true, "owner-press"))
	require.Equal(t, http.StatusAccepted, status, envelope)
	require.Equal(t, map[string]any{"state": "accepted"}, envelope)
	approved := item()
	var checks struct {
		Land struct {
			Session, Head string
			Account       int64
		} `json:"land"`
	}
	require.NoError(t, json.Unmarshal(approved.Checks, &checks))
	require.Equal(t, ownerSession, checks.Land.Session, "the approval is the presenting session's own")
	require.Equal(t, pull.Head.SHA, checks.Land.Head)
	require.Equal(t, int64(7), checks.Land.Account)
	require.JSONEq(t, `{"kind":"merge","target":"`+strconv.FormatInt(pull.Number, 10)+`","desired":"`+pull.Head.SHA+`","precondition":"open","state":"intended"}`, string(approved.PendingOp))

	for _, door := range doors[:2] {
		status, envelope = post(door.path(door.valid), browser("owner-browser-session", true, "owner-press"))
		require.Equal(t, http.StatusAccepted, status, "%s: %v", door.name, envelope)
		require.Equal(t, approved.Version, item().Version, "%s: the same request through either door is answered again, never recorded twice", door.name)
	}
	for _, write := range fake.Writes() {
		require.False(t, write.Method == http.MethodPut && strings.HasSuffix(write.Path, "/merge"), "the press never merges")
	}

	t.Run("Drop retains an uncertain body through the install door", func(t *testing.T) {
		// The earlier approval is definitively not sent. This fixture supplies
		// a separate outstanding body write; Drop must preserve its exact slot.
		slot := []byte(`{"kind":"body","target":"1","desired":"new-body","precondition":"old-body","state":"unknown"}`)
		_, err := pool.Exec(ctx, `UPDATE mythical_items SET pending_op=$2, checks=checks-'land' WHERE id=$1`, before.ID, slot)
		require.NoError(t, err)
		control := func() int {
			r, err := http.NewRequest(http.MethodPost, origin+"/api/todos/"+strconv.FormatInt(filed.Number, 10), strings.NewReader(`{"op":"drop"}`))
			require.NoError(t, err)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Origin", origin)
			browser("owner-browser-session", true, "drop-uncertain")(r)
			response, err := http.DefaultClient.Do(r)
			require.NoError(t, err)
			defer response.Body.Close()
			raw, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			require.Equal(t, http.StatusAccepted, response.StatusCode, string(raw))
			return response.StatusCode
		}
		control()
		dropped := item()
		require.Equal(t, "cancelled", dropped.State)
		require.JSONEq(t, string(slot), string(dropped.PendingOp))
		control()
		require.Equal(t, dropped.Version, item().Version, "replayed Drop creates no second effect")
	})
	t.Run("literal Drop sources settle independent waits atomically", func(t *testing.T) {
		// Stored engine states and their product projections are literal inputs;
		// neither the production projection nor a spec file supplies the oracle.
		states := []struct{ engine, product string }{
			{"queued", "queued"}, {"skipped", "queued"}, {"running", "working"},
			{"delivering", "working"}, {"integrating", "working"}, {"verifying", "working"},
			{"proposing", "working"}, {"waiting", "working"}, {"retrying", "working"},
			{"proposed", "in_review"}, {"blocked", "failed"},
			{"landed", "merged"}, {"cancelled", "dropped"}, {"rejected", "dropped"}, {"declined", "dropped"},
		}
		readCard := func(n int64) map[string]any {
			req, err := http.NewRequest(http.MethodGet, origin+fmt.Sprintf("/api/todos/%d", n), nil)
			require.NoError(t, err)
			browser("owner-browser-session", false, "")(req)
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode)
			var card map[string]any
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&card))
			return card
		}
		accepted, refused := 0, 0
		for index, state := range states {
			for _, paused := range []bool{false, true} {
				for _, waiting := range []bool{false, true} {
					name := fmt.Sprintf("%s/pause=%v/waits=%v", state.engine, paused, waiting)
					t.Run(name, func(t *testing.T) {
						checks := `{"waits":[]}`
						if waiting {
							checks = `{"waits":[{"id":"question","kind":"question","prompt":"Which policy?","since":"2026-10-05T12:00:00Z"},{"id":"foreign","kind":"foreign_push","prompt":"Alice pushed","since":"2026-10-05T12:00:01Z"}]}`
						}
						var n int64
						var id pgtype.UUID
						require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,issue_title,revisions,owner_id,paused_at,checks)
 VALUES ($1,'todo',$2,'Drop fixture','Drop fixture','[{"rev":1,"text":"Drop fixture"}]',$3,CASE WHEN $4 THEN NOW() ELSE NULL END,$5::jsonb) RETURNING id,number`, repo.ID, state.engine, owner.ID, paused, checks).Scan(&id, &n))
						terminal := index >= 11
						from := state.product
						if !terminal {
							if waiting {
								from = "needs_you"
							} else if paused {
								from = "paused"
							}
						}
						require.Equal(t, from, readCard(n)["state"])
						before, err := q.GetMythicalItem(ctx, id)
						require.NoError(t, err)
						key := "literal-drop-" + uuid.NewString()
						var envelope map[string]any
						press := func() int {
							req, err := http.NewRequest(http.MethodPost, origin+fmt.Sprintf("/api/todos/%d", n), strings.NewReader(`{"op":"drop"}`))
							require.NoError(t, err)
							req.Header.Set("Content-Type", "application/json")
							req.Header.Set("Origin", origin)
							browser("owner-browser-session", true, key)(req)
							resp, err := http.DefaultClient.Do(req)
							require.NoError(t, err)
							defer resp.Body.Close()
							envelope = nil
							require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
							return resp.StatusCode
						}
						if index == 0 && !paused && !waiting {
							// Fail after SaveMythicalItem but before the fact can commit.
							_, err := pool.Exec(ctx, `CREATE FUNCTION refuse_drop_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='todo.dropped' THEN RAISE EXCEPTION 'injected fact failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER refuse_drop_fact BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION refuse_drop_fact()`)
							require.NoError(t, err)
							t.Cleanup(func() {
								_, _ = pool.Exec(ctx, `DROP TRIGGER IF EXISTS refuse_drop_fact ON product_job_events; DROP FUNCTION IF EXISTS refuse_drop_fact()`)
							})
							require.Equal(t, http.StatusServiceUnavailable, press())
							rolledBack, err := q.GetMythicalItem(ctx, id)
							require.NoError(t, err)
							require.Equal(t, before, rolledBack)
							require.Equal(t, from, readCard(n)["state"])
							_, err = pool.Exec(ctx, `DROP TRIGGER refuse_drop_fact ON product_job_events; DROP FUNCTION refuse_drop_fact()`)
							require.NoError(t, err)
						}
						want := http.StatusAccepted
						if terminal {
							want = http.StatusConflict
						}
						require.Equal(t, want, press())
						after, err := q.GetMythicalItem(ctx, id)
						require.NoError(t, err)
						var facts [][]byte
						rows, err := pool.Query(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.dropped' AND data->>'item'=$1 ORDER BY sequence`, uuid.UUID(id.Bytes).String())
						require.NoError(t, err)
						for rows.Next() {
							var fact []byte
							require.NoError(t, rows.Scan(&fact))
							facts = append(facts, fact)
						}
						rows.Close()
						require.NoError(t, rows.Err())
						if terminal {
							refused++
							require.Equal(t, "todo_transition_refused", envelope["code"])
							require.Equal(t, "conflict", envelope["class"])
							require.Equal(t, from, envelope["from"])
							require.Equal(t, "drop", envelope["trigger"])
							require.Equal(t, before, after)
							require.Empty(t, facts)
							return
						}
						accepted++
						require.Equal(t, "cancelled", after.State)
						require.False(t, after.PausedAt.Valid)
						var stored struct {
							Waits []services.TodoWait `json:"waits"`
						}
						require.NoError(t, json.Unmarshal(after.Checks, &stored))
						for _, wait := range stored.Waits {
							require.NotNil(t, wait.SettledAt, wait.ID)
							require.Empty(t, wait.Answer)
						}
						card := readCard(n)
						require.Equal(t, "dropped", card["state"])
						require.Nil(t, card["needs_you"])
						require.Len(t, facts, 1)
						var fact map[string]any
						require.NoError(t, json.Unmarshal(facts[0], &fact))
						require.Equal(t, from, fact["from"])
						require.Equal(t, "dropped", fact["to"])
						require.Equal(t, map[string]any{"kind": "person", "id": float64(owner.ID), "login": owner.Username}, fact["actor"])
						require.Equal(t, http.StatusAccepted, press())
						replayed, err := q.GetMythicalItem(ctx, id)
						require.NoError(t, err)
						require.Equal(t, after, replayed)
						var eventCount int
						require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.dropped' AND data->>'item'=$1`, uuid.UUID(id.Bytes).String()).Scan(&eventCount))
						require.Equal(t, 1, eventCount, "replayed Drop writes no second event")
					})
				}
			}
		}
		require.Equal(t, 44, accepted)
		require.Equal(t, 16, refused)
		t.Logf("literal Drop boundary cases: %d accepted, %d refused", accepted, refused)
	})
	t.Run("bound attachment commits with its fact and survives independent waits", func(t *testing.T) {
		const run = "literal-resumed-run"
		digest, source := strings.Repeat("d", 64), strings.Repeat("c", 40)
		checks := fmt.Sprintf(`{"run_launched":true,"run_attached":false,"flowSource":%q,"attempts":[{"attempt":2,"run_id":%q,"items":[]}],"waits":[{"id":"foreign","kind":"foreign_push","prompt":"Alice pushed","since":"2026-10-05T12:00:00Z"}]}`, source, run)
		var id pgtype.UUID
		var n int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,issue_title,revisions,owner_id,attempt,generation,request_run_id,flow_digest,checks,paused_at)
 VALUES($1,'todo','running','Resume fixture','Resume fixture','[{"rev":1,"text":"Resume fixture"}]',$2,2,3,$3,$4,$5::jsonb,NOW()) RETURNING id,number`, repo.ID, owner.ID, run, digest, checks).Scan(&id, &n))
		itemID := uuid.UUID(id.Bytes).String()
		read := func() (db.MythicalItem, map[string]any, int) {
			stored, err := q.GetMythicalItem(ctx, id)
			require.NoError(t, err)
			req, err := http.NewRequest(http.MethodGet, origin+fmt.Sprintf("/api/todos/%d", n), nil)
			require.NoError(t, err)
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode)
			var card map[string]any
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&card))
			var facts int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.run_updated' AND data->>'item'=$1`, itemID).Scan(&facts))
			return stored, card, facts
		}
		// The launch belongs to generation 1; candidate capture advanced it to
		// 3 without replacing attempt 2. No first-step event is supplied.
		projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": itemID, "generation": 1, "attempt": 2, "phase": "todo", "flowDigest": digest, "flowSource": source})
		require.NoError(t, err)
		update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{
			Projection: projection, FlowID: "todo", RunID: run, ExecutionDigest: digest,
			Run: &flowruntime.Run{RunID: run, FlowID: "todo", Status: "running"},
		}}
		before, cardBefore, factsBefore := read()
		require.Equal(t, "needs_you", cardBefore["state"])
		// Literal identities are independent of the production projection. A
		// checkpoint from the wrong attempt, run or pin cannot change the
		// stored TODO, its HTTP card or its event stream.
		for _, generation := range []int64{1, 3} {
			for _, invalid := range []string{"prior attempt", "missing attempt", "wrong run", "empty run", "wrong nested run", "wrong digest", "wrong source", "missing digest"} {
				t.Run(fmt.Sprintf("attachment refuses %s generation %d", invalid, generation), func(t *testing.T) {
					attempt := int32(2)
					flowDigest, flowSource := digest, source
					bad := update
					nested := *update.Checkpoint.Run
					bad.Checkpoint.Run = &nested
					switch invalid {
					case "prior attempt":
						attempt = 1
					case "missing attempt":
						attempt = 0
					case "wrong run":
						bad.Checkpoint.RunID, nested.RunID = "retired-run", "retired-run"
					case "empty run":
						bad.Checkpoint.RunID, nested.RunID = "", ""
					case "wrong nested run":
						nested.RunID = "retired-run"
					case "wrong digest":
						flowDigest = strings.Repeat("e", 64)
					case "wrong source":
						flowSource = strings.Repeat("f", 40)
					case "missing digest":
						flowDigest = ""
					}
					bad.Checkpoint.Projection, err = json.Marshal(map[string]any{"kind": "mythical-item", "itemId": itemID, "generation": generation, "attempt": attempt, "phase": "todo", "flowDigest": flowDigest, "flowSource": flowSource})
					require.NoError(t, err)
					require.NoError(t, mythical.ProjectFlowRuntime(ctx, bad))
					stored, card, facts := read()
					require.Equal(t, before, stored)
					require.Equal(t, cardBefore, card)
					require.Equal(t, factsBefore, facts)
				})
			}
		}
		// Failure between the versioned item save and its fact rolls back
		// both; the HTTP card must still expose the original stored facts.
		_, err = pool.Exec(ctx, `CREATE FUNCTION refuse_attach_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='todo.run_updated' THEN RAISE EXCEPTION 'injected attachment failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER refuse_attach_fact BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION refuse_attach_fact()`)
		require.NoError(t, err)
		t.Cleanup(func() {
			_, _ = pool.Exec(ctx, `DROP TRIGGER IF EXISTS refuse_attach_fact ON product_job_events; DROP FUNCTION IF EXISTS refuse_attach_fact()`)
		})
		require.Error(t, mythical.ProjectFlowRuntime(ctx, update))
		rolledBack, cardRolledBack, factsRolledBack := read()
		require.Equal(t, before, rolledBack)
		require.Equal(t, cardBefore, cardRolledBack)
		require.Equal(t, factsBefore, factsRolledBack)
		_, err = pool.Exec(ctx, `DROP TRIGGER refuse_attach_fact ON product_job_events; DROP FUNCTION refuse_attach_fact()`)
		require.NoError(t, err)
		// Reconnects may replay attachment concurrently. The versioned writer
		// must publish one fact, preserving the person's pause and branch wait.
		var replay sync.WaitGroup
		errors := make(chan error, 20)
		for range 20 {
			replay.Add(1)
			go func() {
				defer replay.Done()
				errors <- mythical.ProjectFlowRuntime(ctx, update)
			}()
		}
		replay.Wait()
		close(errors)
		for err := range errors {
			require.NoError(t, err)
		}
		after, cardAfter, factsAfter := read()
		require.Equal(t, before.Version+1, after.Version)
		require.Equal(t, before.PausedAt, after.PausedAt)
		require.Equal(t, before.Generation, after.Generation)
		require.Equal(t, run, after.RequestRunID)
		require.Equal(t, "needs_you", cardAfter["state"])
		require.Equal(t, cardBefore["waits"], cardAfter["waits"])
		require.Len(t, cardAfter["waits"], 1)
		var attached struct {
			Attached bool                `json:"run_attached"`
			Waits    []services.TodoWait `json:"waits"`
		}
		require.NoError(t, json.Unmarshal(after.Checks, &attached))
		require.True(t, attached.Attached)
		require.Len(t, attached.Waits, 1)
		require.Nil(t, attached.Waits[0].SettledAt)
		require.Equal(t, factsBefore+1, factsAfter)
		require.NoError(t, mythical.ProjectFlowRuntime(ctx, update))
		replayed, cardReplayed, factsReplayed := read()
		require.Equal(t, after, replayed)
		require.Equal(t, cardAfter, cardReplayed)
		require.Equal(t, factsAfter, factsReplayed)
		// A resumed run's delayed question cannot create a run wait while
		// the person still has it paused, or after it proposed its result.
		update.Checkpoint.Run.PendingWaits = []flowruntime.PendingWait{{RunID: "planning-child", Token: "late-question", Name: "choice", Request: json.RawMessage(`{"kind":"ask","prompt":"Too late?"}`)}}
		for _, state := range []string{"paused", "in_review"} {
			if state == "in_review" {
				_, err := pool.Exec(ctx, `UPDATE mythical_items SET state='proposed',paused_at=NULL WHERE id=$1`, id)
				require.NoError(t, err)
			}
			before, cardBefore, factsBefore := read()
			require.NoError(t, mythical.ProjectFlowRuntime(ctx, update))
			after, cardAfter, factsAfter := read()
			require.Equal(t, before, after, state)
			require.Equal(t, cardBefore, cardAfter, state)
			require.Equal(t, factsBefore, factsAfter, state)
		}
		// With the same run working again, a question may join its branch
		// wait. The branch wait remains primary and neither settles the other.
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='running',paused_at=NULL WHERE id=$1`, id)
		require.NoError(t, err)
		_, _, beforeQuestion := read()
		require.NoError(t, mythical.ProjectFlowRuntime(ctx, update))
		withQuestion, questionCard, questionFacts := read()
		require.Equal(t, "needs_you", questionCard["state"])
		require.Len(t, questionCard["waits"], 2)
		require.Equal(t, "foreign_push", questionCard["waits"].([]any)[0].(map[string]any)["kind"])
		require.NoError(t, json.Unmarshal(withQuestion.Checks, &attached))
		require.Len(t, attached.Waits, 2)
		require.Equal(t, "foreign_push", attached.Waits[0].Kind)
		require.Equal(t, "question", attached.Waits[1].Kind)
		for _, wait := range attached.Waits {
			require.Nil(t, wait.SettledAt)
		}
		require.Equal(t, beforeQuestion+1, questionFacts)
		update.State = jobs.StateCompleted
		require.NoError(t, mythical.ProjectFlowRuntime(ctx, update))
		ended, endedCard, endedFacts := read()
		require.Equal(t, "needs_you", endedCard["state"])
		require.NoError(t, json.Unmarshal(ended.Checks, &attached))
		require.Nil(t, attached.Waits[0].SettledAt)
		require.NotNil(t, attached.Waits[1].SettledAt)
		require.Equal(t, questionFacts+1, endedFacts)

	})

	t.Run("machine proxy mutations mint no token", func(t *testing.T) {
		seed := sha256.Sum256([]byte("outbound-machine-token"))
		machine := "smithers_" + hex.EncodeToString(seed[:])[:40]
		digest := sha256.Sum256([]byte(machine))
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "outbound-machine", TokenHash: hex.EncodeToString(digest[:]), TokenLastEight: hex.EncodeToString(digest[:])[56:], Scopes: "all,repo:" + strconv.FormatInt(repo.ID, 10), SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		// An unrelated uncertain publication is a durable obligation. A
		// forbidden machine request cannot clear or replace that slot.
		uncertain, err := q.InsertMythicalTodo(ctx, repo.ID, owner.ID, "Uncertain publication", "Publish once", json.RawMessage(`[]`), json.RawMessage(`{"todo":true}`))
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='proposing',pending_op='{"kind":"open","target":"smithers/uncertain","desired":"fixed-head","precondition":"","state":"unknown"}'::jsonb WHERE id=$1`, uncertain.ID)
		require.NoError(t, err)
		uncertainBefore, err := q.GetMythicalItem(ctx, uncertain.ID)
		require.NoError(t, err)
		writes := len(fake.Writes())
		var pendingBefore int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE pending_op IS NOT NULL`).Scan(&pendingBefore))
		for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", " post ", " put ", " patch ", " delete "} {
			for _, target := range []string{"pulls", "git/refs/heads/main", "check-runs"} {
				payload, _ := json.Marshal(map[string]any{"method": method, "path": "/repos/merge-owner/app/" + target, "body": map[string]string{"head": "hostile", "state": "closed"}})
				r, err := http.NewRequest(http.MethodPost, origin+"/api/repos/merge-owner/app/github-proxy", bytes.NewReader(payload))
				require.NoError(t, err)
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("Origin", origin)
				r.Header.Set("Authorization", "Bearer "+machine)
				response, err := http.DefaultClient.Do(r)
				require.NoError(t, err)
				raw, err := io.ReadAll(response.Body)
				require.NoError(t, err)
				require.NoError(t, response.Body.Close())
				require.Equal(t, http.StatusForbidden, response.StatusCode, string(raw))
			}
		}
		require.Zero(t, issuer.calls)
		require.Len(t, fake.Writes(), writes)
		var pendingAfter int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE pending_op IS NOT NULL`).Scan(&pendingAfter))
		require.Equal(t, pendingBefore, pendingAfter)
		uncertainAfter, err := q.GetMythicalItem(ctx, uncertain.ID)
		require.NoError(t, err)
		require.Equal(t, uncertainBefore, uncertainAfter, "machine mutations preserve the exact uncertain operation and item version")
	})

	t.Run("native item-only diff through composed install", func(t *testing.T) {
		library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
		if library == "" {
			t.Skip("SMITHERS_FFI_LIBRARY_PATH required for native composed diff")
		}
		storage := t.TempDir()
		local, err := nativeRepository.OpenLocal(nativeRepository.Config{StoragePath: storage, AuthToken: "composed-item-diff", FFILibraryPath: library})
		require.NoError(t, err)
		defer local.Shutdown(ctx)
		native := local.Client()
		require.NoError(t, native.InitRepo(ctx, owner.Username, repo.Name, "main", true))
		work := t.TempDir()
		git := func(args ...string) string {
			cmd := exec.CommandContext(ctx, "git", args...)
			cmd.Dir = work
			out, err := cmd.CombinedOutput()
			require.NoError(t, err, string(out))
			return strings.TrimSpace(string(out))
		}
		git("init", "-q", "--initial-branch=main")
		git("config", "user.name", "Fixture")
		git("config", "user.email", "fixture@example.test")
		require.NoError(t, func() error {
			path := filepath.Join(storage, owner.Username, repo.Name, ".jj", "repo", "store", "git")

			git("fetch", "-q", path, "refs/heads/main")
			git("checkout", "-q", "-B", "main", "FETCH_HEAD")
			return nil
		}())
		require.NoError(t, os.WriteFile(filepath.Join(work, "FIRST.txt"), []byte("first\n"), 0600))
		git("add", "FIRST.txt")
		git("commit", "-qm", "first")
		firstHead := git("rev-parse", "HEAD")
		require.NoError(t, os.WriteFile(filepath.Join(work, "SECOND.txt"), []byte("second\n"), 0600))
		git("add", "SECOND.txt")
		git("commit", "-qm", "second")
		head := git("rev-parse", "HEAD")
		var store string
		require.NoError(t, func() error {
			path := filepath.Join(storage, owner.Username, repo.Name, ".jj", "repo", "store", "git")
			store = path
			git("push", "-q", path, "HEAD:refs/heads/main")
			return nil
		}())
		require.NoError(t, native.ImportRefs(ctx, owner.Username, repo.Name))
		service := services.NewMythicalService(pool, native)
		item, err := service.FileTodo(middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, SessionHash: ownerSession}), repo.ID, owner.ID, services.MythicalTodoInput{Title: "Native diff", Prompt: "second", Request: "native-diff"})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='proposed',candidate_verified=true,candidate_base=$3,candidate_head=$4,checks=jsonb_build_object('branch','smithers/native-diff') WHERE repository_id=$1 AND number=$2`, repo.ID, item.Number, firstHead, head)
		require.NoError(t, err)
		marker := filepath.Join(t.TempDir(), "executed")
		program := filepath.Join(t.TempDir(), "program")
		require.NoError(t, os.WriteFile(program, []byte("#!/bin/sh\ntouch '"+marker+"'\nexit 1\n"), 0700))
		for key, value := range map[string]string{"core.hooksPath": filepath.Dir(program), "diff.external": program, "diff.hostile.textconv": program, "merge.hostile.driver": program, "credential.helper": "!" + program, "core.fsmonitor": program} {
			git("--git-dir", store, "config", key, value)
		}
		require.NoError(t, os.WriteFile(filepath.Join(store, "info", "attributes"), []byte("*.txt diff=hostile merge=hostile\n"), 0600))
		router := todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
		request := httptest.NewRequest("GET", origin+"/api/branches/smithers%2Fnative-diff/diff", nil)
		request.RemoteAddr = "127.0.0.1:12345"
		request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		require.Equal(t, 200, response.Code, response.Body.String())
		var diff services.BranchDiff
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &diff))
		require.Len(t, diff.Files, 1)
		require.Equal(t, "SECOND.txt", diff.Files[0].Path)
		require.Equal(t, firstHead, diff.Files[0].Against.Rev)
		require.Equal(t, "item_base", diff.Files[0].Against.Kind)
		require.Equal(t, "second", diff.Files[0].Hunks[0].Lines[0].Text)
		require.NoFileExists(t, marker)
	})

}

type outboundProxyIssuer struct{ calls int }

func (i *outboundProxyIssuer) CreateGitHubInstallationTokenForUserRepo(context.Context, int64, string, string, map[string]string) (services.GitHubInstallationToken, error) {
	i.calls++
	return services.GitHubInstallationToken{}, fmt.Errorf("unexpected token issuance")
}

// todoMergeComposeRouter is the production router with the mythical
// handler mounted, which mounts /api/todos in single-owner mode. The other
// handlers are unused by these requests.
func todoMergeComposeRouter(cfg *config.Config, q *db.Queries, pool *pgxpool.Pool, mythical *routes.MythicalHandler, proxy ...*routes.GitHubProxyHandler) http.Handler {
	return todoMergeComposeRouterWithAuth(cfg, q, pool, mythical, nil, nil, proxy...)
}

func todoMergeComposeRouterWithAuth(cfg *config.Config, q *db.Queries, pool *pgxpool.Pool, mythical *routes.MythicalHandler, authHandler *routes.AuthHandler, members *routes.MembersHandler, proxy ...*routes.GitHubProxyHandler) http.Handler {
	if authHandler == nil {
		authHandler = &routes.AuthHandler{}
	}
	var proxyHandler *routes.GitHubProxyHandler
	if len(proxy) > 0 {
		proxyHandler = proxy[0]
	}
	setup := &routes.GitHubAppSetupHandler{Setup: &services.InstallSetupService{Pool: pool}, Owners: q, Roster: q, Origins: func() []string { return cfg.Server.AllowedOrigins }}
	if service, ok := mythical.Service.(interface {
		SetTodoPreapprovalDefault(context.Context, int64, bool) error
	}); ok {
		setup.SetTodoPreapprovalDefault = service.SetTodoPreapprovalDefault
	}
	return buildRouterCompat(
		cfg, q, pool,
		&routes.RepoHandler{}, authHandler, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, nil,
		&routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil,
		routerExtras{Mythical: mythical, GitHubAppSetup: setup, Members: members}, proxyHandler,
	)
}

// Instrument only retrieval; storage and reads use the production filesystem adapter.
type todoCountingLogStore struct {
	blob.Store
	reads atomic.Int64
}

func (s *todoCountingLogStore) NewReader(ctx context.Context, key string) (io.ReadCloser, error) {
	s.reads.Add(1)
	return s.Store.NewReader(ctx, key)
}
func (s *todoCountingLogStore) Put(ctx context.Context, key, kind string, reader io.Reader) error {
	return blob.Put(ctx, s.Store, key, kind, reader)
}

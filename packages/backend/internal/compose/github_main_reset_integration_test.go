package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/jackc/pgx/v5"
	"io"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// This is refusal evidence through the real install router and persisted
// credentials. Successful reset activation still requires STK-04/STK-08.
func TestMainResetInstallOwnerOnlyAndMissingSerialization(t *testing.T) {
	ctx := t.Context()
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	users := make([]db.User, 3)
	sessions := make([]string, 3)
	tokens := make([]string, 3)
	for i, name := range []string{"reset-owner", "reset-maintainer", "reset-member"} {
		user, err := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name})
		require.NoError(t, err)
		users[i] = user
		sessions[i] = name + "-session"
		sum := sha256.Sum256([]byte(sessions[i]))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: name, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		tokens[i] = fmt.Sprintf("smithers_%040x", user.ID+9200)
		sum = sha256.Sum256([]byte(tokens[i]))
		hash := hex.EncodeToString(sum[:])
		_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: user.ID, Name: "reset-codex", TokenHash: hash, TokenLastEight: hash[56:], Scopes: "write:repository,read:user,via:codex", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
	}
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, users[0].ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: users[0].ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	for i, user := range users {
		role := "admin"
		if i == 2 {
			role = "write"
		}
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, user.ID, role)
		require.NoError(t, err)
	}
	binding := fmt.Sprintf(`{"owner_login":"reset-owner","repository_name":"app","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339) + `"}`)}))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	main := services.NewGitHubMainPullService(q, nil, nil, nil)
	main.UseInstallPolicy()
	router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{GitHubSync: main})
	for i := range users {
		for _, person := range []bool{true, false} {
			t.Run(fmt.Sprintf("%d/person=%t", i, person), func(t *testing.T) {
				request := httptest.NewRequest("POST", "http://example.com/api/stack/attention/force-19", strings.NewReader(`{"old":"1111111111111111111111111111111111111111","new":"2222222222222222222222222222222222222222"}`))
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Origin", "http://example.com")
				if person {
					request.AddCookie(&http.Cookie{Name: "session", Value: sessions[i]})
					request.Header.Set("X-CSRF-Token", "reset-csrf")
					request.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "reset-csrf"})
				} else {
					request.Header.Set("Authorization", "Bearer "+tokens[i])
				}
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				if i == 0 && person {
					require.Equal(t, 503, response.Code, response.Body.String())
					require.Contains(t, response.Body.String(), `"code":"github_sync_unavailable"`)
				} else {
					require.Equal(t, 403, response.Code, response.Body.String())
					if i == 0 {
						require.Contains(t, response.Body.String(), `"code":"never"`)
					} else {
						require.Contains(t, response.Body.String(), `"code":"permission"`)
					}
				}
			})
		}
	}
	for _, input := range []string{`{"old":"same","new":"same"}`, `{"old":"","new":"new"}`, `{"old":"old","new":""}`} {
		t.Run("invalid binding/"+input, func(t *testing.T) {
			request := httptest.NewRequest("POST", "http://example.com/api/stack/attention/force-19", strings.NewReader(input))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", "http://example.com")
			request.AddCookie(&http.Cookie{Name: "session", Value: sessions[0]})
			request.Header.Set("X-CSRF-Token", "reset-csrf")
			request.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "reset-csrf"})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			require.Equal(t, http.StatusConflict, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), `"class":"conflict"`)
			require.Contains(t, response.Body.String(), `"code":"stale_attention"`)
		})
	}
	var requests int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM github_main_pulls`).Scan(&requests))
	require.Zero(t, requests, "refused resets do not queue a pull")
}

// Only the unlanded attention/rebase fold and the native jj boundary are
// substituted. This crosses the composed HTTP door, the production journal,
// PostgreSQL and real Git smart transport; it does not activate C-J10-07.
type resetStackContractFixture struct {
	old, new string
	fail     bool
}

func (*resetStackContractFixture) Ready(context.Context) error { return nil }
func (*resetStackContractFixture) OpenForcePush(context.Context, pgx.Tx, int64, services.GitHubMainForcePush) error {
	return nil
}
func (f *resetStackContractFixture) ValidateReset(_ context.Context, _ pgx.Tx, _ int64, id, old, new string) (string, error) {
	if id != "force-bound" || old != f.old || new != f.new {
		return "", &services.TodoControlError{Status: 409, Class: "conflict", Code: "stale_attention", Message: "Main changed"}
	}
	return id, nil
}
func (*resetStackContractFixture) VerifyPull(context.Context, pgx.Tx, int64, string, string) error {
	return nil
}
func (f *resetStackContractFixture) SettleReset(ctx context.Context, tx pgx.Tx, intent services.GitHubMainResetIntent) error {
	_, err := tx.Exec(ctx, `UPDATE mythical_stacks SET reason=reason || '|reset' WHERE repository_id=$1`, intent.RepositoryID)
	if err != nil {
		return err
	}
	if f.fail {
		return fmt.Errorf("fault before atomic settlement")
	}
	return nil
}
func (*resetStackContractFixture) LeaveOpen(ctx context.Context, tx pgx.Tx, intent services.GitHubMainResetIntent) error {
	_, err := tx.Exec(ctx, `UPDATE mythical_stacks SET reason=reason || '|open' WHERE repository_id=$1`, intent.RepositoryID)
	return err
}

func TestMainResetJournalRecoveryThroughComposedInstall(t *testing.T) {
	for _, crash := range []string{"after_write", "before_write", "third_tip"} {
		t.Run(crash, func(t *testing.T) {
			f := newInstallPollingComposition(t, true)
			ctx := t.Context()
			conversion, err := http.Post(f.upstream.URL+"/app-manifests/manifest/conversions", "application/json", nil)
			require.NoError(t, err)
			require.Equal(t, http.StatusCreated, conversion.StatusCode)
			require.NoError(t, conversion.Body.Close())
			credentials, err := f.credentials.Load(ctx)
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `INSERT INTO github_app_installations(installation_id) VALUES($1)`, credentials.InstallationID)
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `INSERT INTO github_app_installation_repositories(installation_id,github_repository_id) VALUES($1,100)`, credentials.InstallationID)
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `INSERT INTO repo_connections(user_id,repo_owner,repo_name,repo_owner_lower,repo_name_lower,license_spdx_id,github_repository_id) VALUES($1,'acme','app','acme','app','MIT',100)`, f.user.ID)
			require.NoError(t, err)
			root := t.TempDir()
			source := &pollingGitHost{dir: filepath.Join(root, "github.git")}
			mirror := &pollingGitHost{dir: filepath.Join(root, "mirror.git")}
			for _, host := range []*pollingGitHost{source, mirror} {
				require.NoError(t, host.git(ctx, nil, io.Discard, "init", "--bare", host.dir))
			}
			var tree, old, newTip, third bytes.Buffer
			require.NoError(t, source.git(ctx, strings.NewReader(""), &tree, "mktree"))
			require.NoError(t, source.git(ctx, nil, &old, "commit-tree", strings.TrimSpace(tree.String()), "-m", "Mirror old"))
			require.NoError(t, source.git(ctx, nil, &newTip, "commit-tree", strings.TrimSpace(tree.String()), "-m", "GitHub rewritten"))
			require.NoError(t, source.git(ctx, nil, &third, "commit-tree", strings.TrimSpace(tree.String()), "-m", "Concurrent third tip"))
			thirdSHA := strings.TrimSpace(third.String())
			oldSHA, newSHA := strings.TrimSpace(old.String()), strings.TrimSpace(newTip.String())
			require.NoError(t, source.git(ctx, nil, io.Discard, "update-ref", "refs/heads/main", newSHA))
			require.NoError(t, source.git(ctx, nil, io.Discard, "push", mirror.dir, oldSHA+":refs/heads/main"))
			backend := &cgi.Handler{Path: mustResetGit(t), Args: []string{"http-backend"}, Dir: root, Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=" + os.DevNull}}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "receive-pack") {
					t.Error("reset attempted upstream write")
					w.WriteHeader(403)
					return
				}
				r.URL.Path = "/github.git/" + strings.TrimPrefix(r.URL.Path, "/acme/app.git/")
				backend.ServeHTTP(w, r)
			}))
			defer upstream.Close()
			t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", upstream.URL)
			contracts := &resetStackContractFixture{old: oldSHA, new: newSHA, fail: true}
			journal := &services.GitHubMainResetJournal{Pool: f.pool, Stack: contracts}
			main := services.NewGitHubMainPullService(f.q, mirror, f.sync.connections, f.sync.connections)
			main.UseInstallPolicy()
			main.SetMainSerialization(journal)
			_, err = f.q.RequestGithubMainPull(ctx, f.repository)
			require.NoError(t, err)
			binding := fmt.Sprintf(`{"owner_login":"acme","repository_name":"app","repository_id":%d,"last_access_check_at":"%s"}`, f.repository, time.Now().UTC().Format(time.RFC3339))
			require.NoError(t, f.q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding)}))
			cfg := testConfigAllFlagsOn()
			cfg.Auth.Mode = "selfhost"
			cfg.Server.PublicURL = "http://example.com"
			cfg.Server.AllowedOrigins = []string{"http://example.com"}
			router := githubAppSetupComposeRouter(cfg, f.pool, nil, routerExtras{GitHubSync: main})
			request := httptest.NewRequest("POST", "http://example.com/api/stack/attention/force-bound", strings.NewReader(fmt.Sprintf(`{"old":"%s","new":"%s"}`, oldSHA, newSHA)))
			request.Header.Set("Origin", "http://example.com")
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-CSRF-Token", "reset-csrf")
			request.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "reset-csrf"})
			request = request.WithContext(middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &f.user, SessionHash: "reset-owner-session"}))
			if crash != "after_write" {
				// The persisted bound target becomes stale before the locked write.
				require.NoError(t, source.git(ctx, nil, io.Discard, "update-ref", "refs/heads/main", thirdSHA))
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			observed, err := mirror.GetBookmark(ctx, "acme", "app", "main")
			require.NoError(t, err)
			if crash == "after_write" {
				require.Equal(t, 500, response.Code, response.Body.String())
				require.Equal(t, newSHA, observed.TargetCommitID, "write succeeded before settlement fault")
			} else {
				require.Equal(t, http.StatusConflict, response.Code, response.Body.String())
				require.Contains(t, response.Body.String(), `"code":"stale_attention"`)
				require.Equal(t, oldSHA, observed.TargetCommitID, "stale bound target cannot write")
				if crash == "third_tip" {
					require.NoError(t, source.git(ctx, nil, io.Discard, "push", "--force", mirror.dir, thirdSHA+":refs/heads/main"))
				}
			}
			pending, err := journal.Pending(ctx)
			require.NoError(t, err)
			require.Len(t, pending, 1)
			var reason string
			require.NoError(t, f.pool.QueryRow(ctx, `SELECT reason FROM mythical_stacks WHERE repository_id=$1`, f.repository).Scan(&reason))
			require.Empty(t, reason, "no projection before atomic settlement")
			contracts.fail = false
			restarted := services.NewGitHubMainPullService(f.q, mirror, f.sync.connections, f.sync.connections)
			restarted.UseInstallPolicy()
			restarted.SetMainSerialization(&services.GitHubMainResetJournal{Pool: f.pool, Stack: contracts})
			require.NoError(t, restarted.RecoverMainResets(ctx))
			require.NoError(t, restarted.RecoverMainResets(ctx))
			pending, err = journal.Pending(ctx)
			require.NoError(t, err)
			require.Empty(t, pending)
			require.NoError(t, f.pool.QueryRow(ctx, `SELECT reason FROM mythical_stacks WHERE repository_id=$1`, f.repository).Scan(&reason))
			if crash != "after_write" {
				require.Equal(t, "|open", reason, "recovery preserves attention without settlement")
				observed, err := mirror.GetBookmark(ctx, "acme", "app", "main")
				require.NoError(t, err)
				want := oldSHA
				if crash == "third_tip" {
					want = thirdSHA
				}
				require.Equal(t, want, observed.TargetCommitID, "recovery never repeats a write or replaces a third tip")
				observed, err = source.GetBookmark(ctx, "acme", "app", "main")
				require.NoError(t, err)
				require.Equal(t, thirdSHA, observed.TargetCommitID, "GitHub remains unchanged")
				return
			}
			require.Equal(t, "|reset", reason)
			replay := request.Clone(request.Context())
			replay.Body = io.NopCloser(strings.NewReader(fmt.Sprintf(`{"old":"%s","new":"%s"}`, oldSHA, newSHA)))
			replayed := httptest.NewRecorder()
			router.ServeHTTP(replayed, replay)
			require.Equal(t, http.StatusOK, replayed.Code, replayed.Body.String())
			require.NoError(t, f.pool.QueryRow(ctx, `SELECT reason FROM mythical_stacks WHERE repository_id=$1`, f.repository).Scan(&reason))
			require.Equal(t, "|reset", reason, "a lost reply replay does not settle twice")
			observed, err = source.GetBookmark(ctx, "acme", "app", "main")
			require.NoError(t, err)
			require.Equal(t, newSHA, observed.TargetCommitID)
		})
	}
}

func mustResetGit(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("git")
	require.NoError(t, err)
	return path
}

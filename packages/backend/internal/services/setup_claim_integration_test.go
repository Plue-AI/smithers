package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5/pgtype"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestSetupClaimAtomicAndRestart(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	s := &InstallSetupSessions{Pool: pool}
	var output bytes.Buffer
	require.NoError(t, s.Mint(ctx, []string{"http://lan-a:4000"}, &output))
	var line struct {
		URLs []string `json:"setup_urls"`
	}
	require.NoError(t, json.Unmarshal(output.Bytes(), &line))
	require.Len(t, line.URLs, 2)
	var replay bytes.Buffer
	require.NoError(t, s.Emit(ctx, &replay))
	require.Equal(t, output.String(), replay.String())
	root := setupHandoffTestDirectory(t)
	require.NoError(t, os.Chmod(root, 0700))
	closeSocket, err := StartInstallSetupHandoff(t.Context(), root, s.Emit)
	require.NoError(t, err)
	defer closeSocket()
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(root, "run/host.sock"))
	}}}
	defer client.CloseIdleConnections()
	readSocket := func(status int) string {
		response, err := client.Get("http://localhost/setup-urls")
		require.NoError(t, err)
		defer response.Body.Close()
		require.Equal(t, status, response.StatusCode)
		body, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		return string(body)
	}
	require.Equal(t, output.String(), readSocket(200))
	require.Equal(t, output.String(), readSocket(200))

	require.Equal(t, byte('\n'), output.Bytes()[output.Len()-1])
	parsed, err := url.Parse(line.URLs[0])
	require.NoError(t, err)
	token := parsed.Query().Get("token")
	setting, err := db.New(pool).GetInstallSetting(ctx, "setup.token")
	require.NoError(t, err)
	digest := sha256.Sum256([]byte(token))
	require.JSONEq(t, `"`+hex.EncodeToString(digest[:])+`"`, string(setting.Value))
	_, err = s.Exchange(ctx, "wrong")
	require.Error(t, err)
	a, err := s.Exchange(ctx, token)
	require.NoError(t, err)
	b, err := s.Exchange(ctx, token)
	require.NoError(t, err)
	output.Reset()
	require.NoError(t, s.Mint(ctx, nil, &output))
	_, err = s.Exchange(ctx, token)
	require.Error(t, err)
	require.NoError(t, s.Validate(ctx, a))
	require.NoError(t, s.Validate(ctx, b))
	user, err := db.New(pool).CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner"})
	require.NoError(t, err)
	_, err = s.ClaimOwner(ctx, user, "unauthorized", time.Now().Add(time.Hour))
	require.Error(t, err)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i, setup := range []string{a, b} {
		wg.Add(1)
		go func(i int, setup string) {
			defer wg.Done()
			_, err := s.ClaimOwner(WithInstallSetupSession(ctx, setup), user, []string{"first-session", "second-session"}[i], time.Now().Add(time.Hour))
			results <- err
		}(i, setup)
	}
	wg.Wait()
	close(results)
	success, closed := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else {
			require.EqualError(t, err, "setup_closed")
			closed++
		}
	}
	require.Equal(t, 1, success)
	require.Equal(t, 1, closed)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='setup.token' OR key LIKE 'setup.session.%'`).Scan(&count))
	require.Zero(t, count)
	require.ErrorContains(t, s.Validate(ctx, a), "setup_closed")
	output.Reset()
	require.NoError(t, s.Mint(ctx, nil, &output))
	require.Empty(t, output.String())
	require.ErrorContains(t, s.Emit(ctx, &output), "setup_closed")
	require.Empty(t, output.String())
	require.JSONEq(t, `{"error":"setup_closed"}`, readSocket(401))
	var sessions int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE user_id=$1`, user.ID).Scan(&sessions))
	require.Equal(t, 1, sessions)
}

type memberCredentials struct{}

func (memberCredentials) Load(context.Context) (GitHubAppCredentials, error) {
	return GitHubAppCredentials{}, nil
}
func (memberCredentials) InstallURL(context.Context) (string, error) { return "", nil }
func (memberCredentials) AppJWT(context.Context) (string, error)     { return "app-jwt", nil }

func TestVerifyOwnerLivePermissionPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, user.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding, _ := json.Marshal(map[string]any{"owner_login": "acme", "repository_name": "app", "repository_id": repo.ID})
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	permission := "read"
	role := "read"
	calls := []string{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/acme/app/installation":
			require.Equal(t, "Bearer app-jwt", r.Header.Get("Authorization"))
			w.Write([]byte(`{"id":91}`))
		case "/app/installations/91/access_tokens":
			require.Equal(t, "Bearer app-jwt", r.Header.Get("Authorization"))
			body, _ := io.ReadAll(r.Body)
			require.JSONEq(t, `{"permissions":{"metadata":"read"}}`, string(body), "the owner check asks for metadata:read and nothing else")
			w.WriteHeader(201)
			w.Write([]byte(`{"token":"installation-token","expires_at":"2099-01-01T00:00:00Z"}`))
		case "/repos/acme/app/collaborators/owner/permission":
			require.Equal(t, "Bearer installation-token", r.Header.Get("Authorization"))
			json.NewEncoder(w).Encode(map[string]string{"permission": permission, "role_name": role})
		default:
			t.Errorf("unexpected call %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	t.Setenv(envGitHubAppAPIBaseURL, provider.URL)
	invalidateCachedInstallationToken(91)
	t.Cleanup(func() { invalidateCachedInstallationToken(91) })
	m := &Members{Pool: pool, Credentials: memberCredentials{}, Minter: NewRepoConnectionService(nil, memberCredentials{})}
	// A read-only owner stays provisional; permission is checked live.
	require.ErrorContains(t, m.BindRepository(ctx, user, "acme", "app", repo.ID), "needs access on GitHub")
	_, err = q.GetInstallSetting(ctx, "owner.access")
	require.Error(t, err)
	role = "maintain"
	require.NoError(t, m.BindRepository(ctx, user, "acme", "app", repo.ID))
	setting, err := q.GetInstallSetting(ctx, "owner.access")
	require.NoError(t, err)
	require.Contains(t, string(setting.Value), `"installation_id": 91`)
	permission = "write"
	require.NoError(t, m.BindRepository(ctx, user, "acme", "app", repo.ID))
	// The one minter caches the token, so only the first check mints.
	require.Len(t, calls, 7)
	require.Equal(t, []string{"GET /repos/acme/app/installation", "POST /app/installations/91/access_tokens", "GET /repos/acme/app/collaborators/owner/permission"}, calls[:3])
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM collaborators WHERE repository_id=$1 AND user_id=$2 AND permission='admin'`, repo.ID, user.ID).Scan(&count))
	require.Equal(t, 1, count)
}

func TestGitHubOwnerMigrationPreservesOwner(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "upgrade-owner", LowerUsername: "upgrade-owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "upgrade", LowerName: "upgrade", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, user.ID)
	require.NoError(t, err)
	// Restore the old password table to exercise an existing install upgrade.
	_, err = pool.Exec(ctx, `CREATE TABLE local_credentials(user_id bigint PRIMARY KEY REFERENCES users(id),password_hash text NOT NULL); INSERT INTO local_credentials(user_id,password_hash) SELECT user_id,'retired-password' FROM self_host_owners`)
	require.NoError(t, err)
	paths, err := filepath.Glob("../../db/product/migrations/*.sql")
	require.NoError(t, err)
	var migration []byte
	for _, path := range paths {
		content, err := os.ReadFile(path)
		require.NoError(t, err)
		if strings.Contains(string(content), "DROP TABLE local_credentials;") {
			require.Nil(t, migration, "only one migration retires password credentials")
			migration = content
		}
	}
	require.NotNil(t, migration, "password retirement migration is present")
	_, err = pool.Exec(ctx, string(migration))
	require.NoError(t, err)
	owner, err := q.GetSelfHostOwner(ctx)
	require.NoError(t, err)
	require.Equal(t, user.ID, owner.ID)
	var permission string
	require.NoError(t, pool.QueryRow(ctx, `SELECT permission FROM collaborators WHERE repository_id=$1 AND user_id=$2`, repo.ID, user.ID).Scan(&permission))
	require.Equal(t, "admin", permission)
	var removed bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT to_regclass('local_credentials') IS NULL`).Scan(&removed))
	require.True(t, removed)
}

// Database commit and output failures must never leave usable uncommitted
// authority. Faults live in this test database and writer, not production hooks.
func TestSetupMintFailureRecoveryPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	setup := &InstallSetupSessions{Pool: pool}
	_, err := pool.Exec(ctx, `CREATE FUNCTION refuse_setup_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key='setup.token' THEN RAISE EXCEPTION 'fixture refuses commit'; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER refuse_setup_commit AFTER INSERT OR UPDATE ON install_settings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_setup_commit()`)
	require.NoError(t, err)
	var output bytes.Buffer
	require.ErrorContains(t, setup.Mint(ctx, nil, &output), "fixture refuses commit")
	require.Empty(t, output.String())
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='setup.token'`).Scan(&count))
	require.Zero(t, count)
	_, err = pool.Exec(ctx, `DROP TRIGGER refuse_setup_commit ON install_settings; DROP FUNCTION refuse_setup_commit()`)
	require.NoError(t, err)
	require.ErrorContains(t, setup.Mint(ctx, nil, setupRefusingWriter{}), "fixture output failure")
	var committed string
	require.NoError(t, pool.QueryRow(ctx, `SELECT value #>> '{}' FROM install_settings WHERE key='setup.token'`).Scan(&committed))
	require.Len(t, committed, 64)
	restarted := &InstallSetupSessions{Pool: pool}
	require.NoError(t, restarted.Mint(ctx, nil, &output))
	var replacement string
	require.NoError(t, pool.QueryRow(ctx, `SELECT value #>> '{}' FROM install_settings WHERE key='setup.token'`).Scan(&replacement))
	require.NotEqual(t, committed, replacement)
	var line struct {
		URLs []string `json:"setup_urls"`
	}
	require.NoError(t, json.Unmarshal(output.Bytes(), &line))
	parsed, err := url.Parse(line.URLs[0])
	require.NoError(t, err)
	digest := sha256.Sum256([]byte(parsed.Query().Get("token")))
	require.Equal(t, hex.EncodeToString(digest[:]), replacement)
	_, err = restarted.Exchange(ctx, parsed.Query().Get("token"))
	require.NoError(t, err)
}

type setupRefusingWriter struct{}

func (setupRefusingWriter) Write([]byte) (int, error) { return 0, errors.New("fixture output failure") }

func TestSetupMintClaimLockOrdersPostgres(t *testing.T) {
	for _, claimFirst := range []bool{true, false} {
		name := "mint first"
		if claimFirst {
			name = "claim first"
		}
		t.Run(name, func(t *testing.T) {
			pool, _ := postgresfixture.NewProductDatabase(t)
			ctx := t.Context()
			setup := &InstallSetupSessions{Pool: pool}
			var initial bytes.Buffer
			require.NoError(t, setup.Mint(ctx, nil, &initial))
			var line struct {
				URLs []string `json:"setup_urls"`
			}
			require.NoError(t, json.Unmarshal(initial.Bytes(), &line))
			parsed, err := url.Parse(line.URLs[0])
			require.NoError(t, err)
			session, err := setup.Exchange(ctx, parsed.Query().Get("token"))
			require.NoError(t, err)
			user, err := db.New(pool).CreateUser(ctx, db.CreateUserParams{Username: "ordered-owner", LowerUsername: "ordered-owner"})
			require.NoError(t, err)
			barrier, err := pool.Acquire(ctx)
			require.NoError(t, err)
			defer barrier.Release()
			_, err = barrier.Exec(ctx, `SELECT pg_advisory_lock(3443)`)
			require.NoError(t, err)
			defer barrier.Exec(ctx, `SELECT pg_advisory_unlock(3443)`)
			waiters := func(n int) {
				t.Helper()
				require.Eventually(t, func() bool {
					var count int
					err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=3443 AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted`).Scan(&count)
					return err == nil && count == n
				}, 5*time.Second, 10*time.Millisecond)
			}
			claimResult, mintResult := make(chan error, 1), make(chan error, 1)
			claim := func() {
				_, err := setup.ClaimOwner(WithInstallSetupSession(ctx, session), user, "ordered-person-session", time.Now().Add(time.Hour))
				claimResult <- err
			}
			var output bytes.Buffer
			mint := func() { mintResult <- setup.Mint(ctx, nil, &output) }
			if claimFirst {
				go claim()
			} else {
				go mint()
			}
			waiters(1)
			if claimFirst {
				go mint()
			} else {
				go claim()
			}
			waiters(2)
			_, err = barrier.Exec(ctx, `SELECT pg_advisory_unlock(3443)`)
			require.NoError(t, err)
			require.NoError(t, <-claimResult)
			mintErr := <-mintResult
			if claimFirst {
				require.NoError(t, mintErr)
			} else {
				require.ErrorContains(t, mintErr, "setup_closed")
			}
			require.Empty(t, output.String(), "no stale setup link may escape after claim")
			var remaining int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='setup.token' OR key LIKE 'setup.session.%'`).Scan(&remaining))
			require.Zero(t, remaining)
			owner, err := db.New(pool).GetSelfHostOwner(ctx)
			require.NoError(t, err)
			require.Equal(t, user.ID, owner.ID)
		})
	}
}

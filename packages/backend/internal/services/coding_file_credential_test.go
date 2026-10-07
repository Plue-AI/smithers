package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

const codingGrantBody = `{"changes":[{"path":"a.txt","base_digest":"absent","content":"new"}]}`

type codingGrantFixture struct {
	pool                        *pgxpool.Pool
	issuer                      *CodingFileCredentials
	workspaces                  *WorkspaceService
	host, credential, workspace string
	user, repo                  int64
}

func newCodingGrantFixture(t *testing.T) codingGrantFixture {
	return newCodingGrantFixtureWithWorkspace(t, nil)
}

func newCodingGrantFixtureWithWorkspace(t *testing.T, setup func(codingGrantFixture)) codingGrantFixture {
	t.Helper()
	pool := newProductTestPool(t)
	ctx := t.Context()
	f := codingGrantFixture{pool: pool}
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES('owner','owner','owner@example.invalid','owner@example.invalid') RETURNING id`).Scan(&f.user))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, f.user)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'repo','repo') RETURNING id`, f.user).Scan(&f.repo))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,status,vm_id) VALUES($1,$2,'running','vm-1') RETURNING id::text`, f.repo, f.user).Scan(&f.workspace))
	if setup != nil {
		setup(f)
	}
	store, err := flowhost.NewStore(pool, callbackTestCodec{})
	require.NoError(t, err)
	lease, err := store.Acquire(ctx, flowhost.Authority{Target: flowruntime.Target{TenantID: "repository:1", PrincipalID: "user:1", BindingKind: "browser-flow", BindingID: "owner/repo"},
		RepositoryID: f.repo, UserID: f.user, WorkspaceID: f.workspace, CatalogKey: flowhost.CatalogCoding, SourceRevision: strings.Repeat("a", 40)},
		flowhost.Catalog{Key: flowhost.CatalogCoding, Family: flowhost.CatalogCoding, Executable: "/opt/smithers/coding", ArtifactDigest: strings.Repeat("b", 64), ServiceName: "coding", SystemFlows: []string{"coding/plan"}})
	require.NoError(t, err)
	_, err = lease.PrepareStart(ctx, false)
	require.NoError(t, err)
	require.NoError(t, lease.MarkRunning(ctx, "flow-host:test"))
	f.host, f.credential = lease.Binding().ID, lease.Credential()
	require.NoError(t, lease.Close())
	q := db.New(pool)
	auth := NewAuthService(q, config.AuthConfig{Mode: "selfhost"}, nil, nil)
	auth.Members = &Members{Pool: pool}
	f.workspaces = NewWorkspaceService(q)
	f.workspaces.transactions = pool
	f.issuer = NewCodingFileCredentials(auth, NewFlowHostCallbacks(pool, q), f.workspaces)
	return f
}

func (f codingGrantFixture) mint(t *testing.T) CodingFileGrant {
	t.Helper()
	digest := sha256.Sum256([]byte(codingGrantBody))
	grant, err := f.issuer.Mint(t.Context(), f.host, f.credential, CodingFileGrantInput{RunID: "Run-A", BatchDigest: hex.EncodeToString(digest[:])})
	require.NoError(t, err)
	return grant
}

func (f codingGrantFixture) dispatch(token, body string, fn func(context.Context) error) *httptest.ResponseRecorder {
	request := httptest.NewRequest("PUT", "/api/repos/owner/repo/workspaces/"+f.workspace+"/files/content", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	middleware.AuthLoader(db.New(f.pool), config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := f.workspaces.withCodingFileMutationAuthority(r.Context(), f.workspace, f.repo, f.user, fn); err != nil {
			w.WriteHeader(403)
			return
		}
		w.WriteHeader(204)
	})).ServeHTTP(recorder, request)
	return recorder
}

func TestCodingFileGrantPostgresLifecycle(t *testing.T) {
	f := newCodingGrantFixture(t)
	var turns int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM chat_turns`).Scan(&turns))
	require.Zero(t, turns, "coding grants belong to a flow host, not a chat producer")
	g := f.mint(t)
	require.Equal(t, "Run-A", g.RunID)
	require.Equal(t, f.workspace, g.WorkspaceID)
	require.Equal(t, "owner/repo", g.RepositorySlug)
	require.WithinDuration(t, time.Now().Add(2*time.Minute), time.UnixMilli(g.ExpiresAt), 3*time.Second)
	var scopes string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT scopes FROM access_tokens WHERE id=$1`, g.TokenID).Scan(&scopes))
	binding, valid := middleware.CodingFileCredential(&middleware.AuthInfo{User: &db.User{ID: f.user}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: scopes})
	require.True(t, valid)
	require.Equal(t, g.BatchDigest, binding.BatchDigest)
	require.Equal(t, f.host, binding.HostID)
	calls := 0
	apply := func(context.Context) error { calls++; return nil }
	require.Equal(t, 204, f.dispatch(g.Token, codingGrantBody, apply).Code)
	require.Equal(t, 403, f.dispatch(g.Token, codingGrantBody+" ", apply).Code)
	require.Equal(t, 1, calls)
	// Cleanup has no authority over a different grant, even for this host.
	other := f.mint(t)
	require.NoError(t, f.issuer.Revoke(t.Context(), f.host, other.TokenID, g.Token))
	require.Equal(t, 204, f.dispatch(other.Token, codingGrantBody, apply).Code)
	require.NoError(t, f.issuer.Revoke(t.Context(), f.host, g.TokenID, g.Token))
	require.NoError(t, f.issuer.Revoke(t.Context(), f.host, g.TokenID, g.Token))
	require.Equal(t, 401, f.dispatch(g.Token, codingGrantBody, apply).Code)
	_, err := f.pool.Exec(t.Context(), `UPDATE flow_runtime_host_bindings SET credential_hash=decode($2,'hex') WHERE id=$1`, f.host, strings.Repeat("f", 64))
	require.NoError(t, err)
	require.Equal(t, 403, f.dispatch(other.Token, codingGrantBody, apply).Code)
	require.NoError(t, f.issuer.Revoke(t.Context(), f.host, other.TokenID, other.Token), "self cleanup survives host rotation")
}

func TestCodingFileGrantRevocationWaitsForWholeMutation(t *testing.T) {
	for _, rotate := range []bool{false, true} {
		t.Run(map[bool]string{false: "revoke", true: "rotate"}[rotate], func(t *testing.T) {
			f := newCodingGrantFixture(t)
			g := f.mint(t)
			entered, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			unblock := func() { once.Do(func() { close(release) }) }
			defer unblock()
			finished := make(chan int, 1)
			go func() {
				finished <- f.dispatch(g.Token, codingGrantBody, func(context.Context) error { close(entered); <-release; return nil }).Code
			}()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("mutation did not enter")
			}
			revoked := make(chan error, 1)
			go func() {
				if rotate {
					_, err := f.pool.Exec(context.Background(), `UPDATE flow_runtime_host_bindings SET credential_hash=decode($2,'hex') WHERE id=$1`, f.host, strings.Repeat("e", 64))
					revoked <- err
				} else {
					revoked <- f.issuer.Revoke(context.Background(), f.host, g.TokenID, g.Token)
				}
			}()
			require.Eventually(t, func() bool {
				var waiting bool
				err := f.pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE 'DELETE FROM access_tokens%' OR query LIKE 'UPDATE flow_runtime_host_bindings%'))`).Scan(&waiting)
				return err == nil && waiting
			}, 5*time.Second, 10*time.Millisecond)
			select {
			case err := <-revoked:
				t.Fatalf("authority changed before batch settled: %v", err)
			default:
			}
			unblock()
			require.Equal(t, 204, <-finished)
			require.NoError(t, <-revoked)
			calls := 0
			status := f.dispatch(g.Token, codingGrantBody, func(context.Context) error { calls++; return nil }).Code
			require.Contains(t, []int{401, 403}, status)
			require.Zero(t, calls)
		})
	}
}

func TestCodingFileGrantRefusesInvalidAndInactiveSubjects(t *testing.T) {
	f := newCodingGrantFixture(t)
	for _, input := range []CodingFileGrantInput{{}, {RunID: "bad,run", BatchDigest: strings.Repeat("a", 64)}, {RunID: "run", BatchDigest: "bad"}} {
		_, err := f.issuer.Mint(t.Context(), f.host, f.credential, input)
		require.Error(t, err)
	}
	g := f.mint(t)
	_, err := f.pool.Exec(t.Context(), `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, g.TokenID)
	require.NoError(t, err)
	require.Equal(t, 401, f.dispatch(g.Token, codingGrantBody, func(context.Context) error { t.Fatal("expired grant executed"); return nil }).Code)
	_, err = f.pool.Exec(t.Context(), `UPDATE users SET prohibit_login=true WHERE id=$1`, f.user)
	require.NoError(t, err)
	_, err = f.issuer.Mint(t.Context(), f.host, f.credential, CodingFileGrantInput{RunID: "run", BatchDigest: strings.Repeat("a", 64)})
	require.Error(t, err)
}

func TestCodingFileGrantSingleDecisionPostgres(t *testing.T) {
	f := newCodingGrantFixture(t)
	q := db.New(f.pool)
	f.workspaces.installQueries = q
	grant := f.mint(t)
	for _, bound := range []bool{false, true} {
		t.Run(fmt.Sprintf("bound=%v", bound), func(t *testing.T) {
			var decisions []string
			effects := 0
			request := httptest.NewRequest("PUT", "/api/repos/owner/repo/workspaces/"+f.workspace+"/files/content", strings.NewReader(codingGrantBody))
			request.Header.Set("Authorization", "Bearer "+grant.Token)
			request = request.WithContext(WithAuthorizationObserver(request.Context(), func(command string) { decisions = append(decisions, command) }))
			out := httptest.NewRecorder()
			middleware.AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ctx := r.Context()
				binding, valid := middleware.CodingFileCredential(middleware.AuthInfoFromContext(ctx))
				require.True(t, valid)
				subject := InstallSubject{RepositoryID: binding.RepositoryID, WorkspaceID: binding.WorkspaceID, RunID: binding.RunID, PayloadDigest: binding.BatchDigest}
				if bound {
					decision, err := Authorize(ctx, q, "branch.join", subject)
					require.NoError(t, err)
					ctx = WithInstallAuthorization(ctx, "branch.join", decision, subject)
				}
				require.NoError(t, f.workspaces.withCodingFileMutationAuthority(ctx, f.workspace, f.repo, f.user, func(context.Context) error { effects++; return nil }))
				require.Equal(t, []string{"branch.join"}, decisions)
				require.Equal(t, 1, effects)
				// Reusing an admission for any changed subject is a fresh refusal.
				for _, changed := range []InstallSubject{
					{RepositoryID: f.repo, WorkspaceID: f.workspace, RunID: "other", PayloadDigest: binding.BatchDigest},
					{RepositoryID: f.repo, WorkspaceID: f.workspace, RunID: binding.RunID, PayloadDigest: strings.Repeat("0", 64)},
					{RepositoryID: f.repo, WorkspaceID: "other", RunID: binding.RunID, PayloadDigest: binding.BatchDigest},
					{RepositoryID: f.repo + 1, WorkspaceID: f.workspace, RunID: binding.RunID, PayloadDigest: binding.BatchDigest},
				} {
					_, err := Authorize(ctx, q, "branch.join", changed)
					require.Error(t, err)
					var refused *AccessError
					require.ErrorAs(t, err, &refused)
					require.Equal(t, 403, refused.Status)
					require.Equal(t, "permission", refused.Code)
				}
				w.WriteHeader(204)
			})).ServeHTTP(out, request)
			require.Equal(t, 204, out.Code)
		})
	}
}

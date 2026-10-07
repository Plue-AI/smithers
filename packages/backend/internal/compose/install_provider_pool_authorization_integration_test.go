package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// These wrappers schedule real SQL changes after the real catalog decision,
// and observe real account-store reads. They supply no replacement authority.
type poolAfterAuthorization struct {
	*services.ProviderPoolScopes
	after func()
}

func (s *poolAfterAuthorization) ScopeAuthorization(ctx context.Context, bearer string) (*services.ProviderPoolAuthority, error) {
	grant, err := s.ProviderPoolScopes.ScopeAuthorization(ctx, bearer)
	if err == nil && s.after != nil {
		s.after()
	}
	return grant, err
}

type poolReadObservation struct {
	routes.ProviderPool
	before func(context.Context)
}

func (p *poolReadObservation) HasPool(ctx context.Context, user, repository int64, provider string) (bool, error) {
	if p.before != nil {
		p.before(ctx)
	}
	return p.ProviderPool.HasPool(ctx, user, repository, provider)
}

type poolPickObservation struct {
	routes.ProviderPool
	after func()
}

func (p *poolPickObservation) PickForModelCall(ctx context.Context, user, repository int64, provider string, excluded []string) (services.ProviderPoolPick, error) {
	pick, err := p.ProviderPool.PickForModelCall(ctx, user, repository, provider, excluded)
	if err == nil && p.after != nil {
		p.after()
	}
	return pick, err
}

type poolRoundTrip func(*http.Request) (*http.Response, error)

func (f poolRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestInstallProviderPoolAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	require.NoError(t, f.q.UpsertInstallSetting(f.ctx, db.UpsertInstallSettingParams{Key: "models.chatgpt", Value: []byte("true")}))
	workspace, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "provider", TargetBookmark: "main", Kind: "container", Status: "running"})
	require.NoError(t, err)
	codec, err := webhook.NewSecretCodec("pool-host-test-key")
	require.NoError(t, err)
	pool := services.NewProviderConnectionService(f.q, codec, nil, services.WithSubscriptionConnectionsEnabled(true))
	scopes := services.NewProviderPoolScopes(f.q, f.pool, codec, true)
	handler := &routes.ProviderConnectionHandler{Service: pool, Pool: &routes.ProviderPoolHandler{Pool: pool, Scopes: scopes}}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, handler)
	raw := services.ProviderPoolTokenScopes(f.repoID, workspace.ID)
	machine := f.token(f.owner, "provider-pool-workspace-"+workspace.ID, raw, true)
	wrong := f.token(f.owner, "wrong-pool-name", raw, true)
	run := f.token(f.owner, "provider-run", "write:repository,"+middleware.RepositoryRestrictionScope(f.repoID), true)
	delegated := f.token(f.owner, "provider-delegated", "write:repository,via:codex", true)
	for _, cell := range []struct {
		name, token string
		status      int
	}{
		{"own pool", machine, 200}, {"another machine grant", wrong, 403}, {"run", run, 403}, {"delegated", delegated, 403},
	} {
		t.Run(cell.name, func(t *testing.T) {
			request := httptest.NewRequest("GET", "http://example.com/provider-pool/routes", nil)
			request.Header.Set("Authorization", "Bearer "+cell.token)
			decisions := []string{}
			request = request.WithContext(services.WithAuthorizationObserver(request.Context(), func(command string) { decisions = append(decisions, command) }))
			out := httptest.NewRecorder()
			router.ServeHTTP(out, request)
			require.Equal(t, cell.status, out.Code, out.Body.String())
			require.Equal(t, []string{"workspace.provider-pool"}, decisions)
			if cell.status == 200 {
				require.JSONEq(t, `{"routes":[]}`, out.Body.String())
			}
		})
	}
	t.Run("model request binds its admitted payload", func(t *testing.T) {
		originalLimit := handler.Pool.MaxBodyBytes
		handler.Pool.MaxBodyBytes = 32
		defer func() { handler.Pool.MaxBodyBytes = originalLimit }()
		for _, tc := range []struct {
			name   string
			status int
		}{
			{"unchanged", 404}, {"headers", 403}, {"query", 403}, {"oversized", 413},
		} {
			t.Run(tc.name, func(t *testing.T) {
				body := `{"model":"original"}`
				if tc.name == "oversized" {
					body = strings.Repeat("x", 33)
				}
				request := httptest.NewRequest("POST", "http://example.com/provider-pool/chatgpt/codex/responses", strings.NewReader(body))
				request.Header.Set("Authorization", "Bearer "+machine)
				decisions := 0
				request = request.WithContext(services.WithAuthorizationObserver(request.Context(), func(command string) {
					require.Equal(t, "workspace.provider-pool", command)
					decisions++
					switch tc.name {
					case "headers":
						request.Header.Set("Originator", "substituted")
					case "query":
						request.URL.RawQuery = "substituted=true"
					}
				}))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, request)
				require.Equal(t, tc.status, out.Code, out.Body.String())
				require.Equal(t, 1, decisions)
				if tc.status == 404 {
					require.Contains(t, out.Body.String(), "No connected account")
				}
				if tc.status == 403 {
					require.Contains(t, out.Body.String(), `"code":"permission"`)
				}
			})
		}
	})
	t.Run("credential and workspace changes after admission prevent pool reads", func(t *testing.T) {
		digest := sha256.Sum256([]byte(machine))
		hash := hex.EncodeToString(digest[:])
		for _, tc := range []struct {
			name, change, restore string
			status                int
		}{
			{"expired", `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, `UPDATE access_tokens SET expires_at=NULL WHERE token_hash=$1`, 401},
			{"suspended", `UPDATE users SET prohibit_login=true WHERE id=$1::bigint`, `UPDATE users SET prohibit_login=false WHERE id=$1::bigint`, 401},
			{"workspace owner", `UPDATE workspaces SET user_id=` + fmt.Sprint(f.other.ID) + ` WHERE id=$1::uuid`, `UPDATE workspaces SET user_id=` + fmt.Sprint(f.owner.ID) + ` WHERE id=$1::uuid`, 403},
			{"deleted workspace", `UPDATE workspaces SET deleted_at=now() WHERE id=$1::uuid`, `UPDATE workspaces SET deleted_at=NULL WHERE id=$1::uuid`, 403},
		} {
			t.Run(tc.name, func(t *testing.T) {
				var key any = workspace.ID
				if tc.name == "expired" {
					key = hash
				}
				if tc.name == "suspended" {
					key = f.owner.ID
				}
				beforeScopes, beforePool := handler.Pool.Scopes, handler.Pool.Pool
				defer func() {
					handler.Pool.Scopes, handler.Pool.Pool = beforeScopes, beforePool
					_, err := f.pool.Exec(f.ctx, tc.restore, key)
					require.NoError(t, err)
				}()
				reads := 0
				handler.Pool.Pool = &poolReadObservation{ProviderPool: pool, before: func(context.Context) { reads++ }}
				handler.Pool.Scopes = &poolAfterAuthorization{ProviderPoolScopes: scopes, after: func() { _, err := f.pool.Exec(f.ctx, tc.change, key); require.NoError(t, err) }}
				request := httptest.NewRequest("GET", "http://example.com/provider-pool/routes", nil)
				request.Header.Set("Authorization", "Bearer "+machine)
				decisions := 0
				request = request.WithContext(services.WithAuthorizationObserver(request.Context(), func(string) { decisions++ }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, request)
				require.Equal(t, tc.status, out.Code, out.Body.String())
				require.Equal(t, 1, decisions)
				require.Zero(t, reads)
			})
		}
	})
	t.Run("revocation waits until account reads finish", func(t *testing.T) {
		beforePool := handler.Pool.Pool
		defer func() { handler.Pool.Pool = beforePool }()
		digest := sha256.Sum256([]byte(machine))
		hash := hex.EncodeToString(digest[:])
		checked := false
		handler.Pool.Pool = &poolReadObservation{ProviderPool: pool, before: func(ctx context.Context) {
			if checked {
				return
			}
			checked = true
			for _, query := range []struct {
				sql string
				key any
			}{
				{`UPDATE access_tokens SET expires_at=now() WHERE token_hash=$1`, hash},
				{`UPDATE users SET prohibit_login=true WHERE id=$1`, f.owner.ID},
				{`UPDATE workspaces SET deleted_at=now() WHERE id=$1::uuid`, workspace.ID},
			} {
				tx, err := f.pool.Begin(ctx)
				require.NoError(t, err)
				_, err = tx.Exec(ctx, `SET LOCAL lock_timeout='75ms'`)
				require.NoError(t, err)
				_, err = tx.Exec(ctx, query.sql, query.key)
				var pgerr *pgconn.PgError
				require.ErrorAs(t, err, &pgerr)
				require.Equal(t, "55P03", pgerr.Code)
				require.NoError(t, tx.Rollback(ctx))
			}
		}}
		request := httptest.NewRequest("GET", "http://example.com/provider-pool/routes", nil)
		request.Header.Set("Authorization", "Bearer "+machine)
		out := httptest.NewRecorder()
		router.ServeHTTP(out, request)
		require.Equal(t, 200, out.Code, out.Body.String())
		require.True(t, checked)
		// No streaming or response lifetime retains the credential lock.
		_, err := f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, hash)
		require.NoError(t, err)
		out = httptest.NewRecorder()
		router.ServeHTTP(out, request.Clone(request.Context()))
		require.Equal(t, 401, out.Code, out.Body.String())
		_, err = f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=NULL WHERE token_hash=$1`, hash)
		require.NoError(t, err)
	})
	t.Run("direct entry refuses another subject", func(t *testing.T) {
		sum := sha256.Sum256([]byte(machine))
		hash := hex.EncodeToString(sum[:])
		row, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
		require.NoError(t, err)
		info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: row.TokenID, TokenHash: hash, RawScopes: raw, Scopes: middleware.ParseTokenScopes(raw)}
		ctx := middleware.ContextWithAuthInfo(f.ctx, info)
		user, repo, ok := scopes.Scope(ctx, machine)
		require.True(t, ok)
		require.Equal(t, f.owner.ID, user)
		require.Equal(t, f.repoID, repo)
		for _, expire := range []bool{false, true} {
			t.Run(map[bool]string{false: "direct live handler", true: "direct expired handler"}[expire], func(t *testing.T) {
				original := handler.Pool.Scopes
				defer func() {
					handler.Pool.Scopes = original
					_, err := f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=NULL WHERE token_hash=$1`, hash)
					require.NoError(t, err)
				}()
				if expire {
					handler.Pool.Scopes = &poolAfterAuthorization{ProviderPoolScopes: scopes, after: func() {
						_, err := f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, hash)
						require.NoError(t, err)
					}}
				}
				decisions := 0
				request := httptest.NewRequest("GET", "http://example.com/provider-pool/routes", nil).WithContext(services.WithAuthorizationObserver(ctx, func(string) { decisions++ }))
				request.Header.Set("Authorization", "Bearer "+machine)
				out := httptest.NewRecorder()
				handler.Pool.ServeHTTP(out, request)
				status := 200
				if expire {
					status = 401
				}
				require.Equal(t, status, out.Code, out.Body.String())
				require.Equal(t, 1, decisions)
			})
		}
		_, err = services.Authorize(ctx, f.q, "workspace.provider-pool", services.InstallSubject{RepositoryID: f.repoID + 1, WorkspaceID: workspace.ID})
		require.Error(t, err)
		_, err = services.Authorize(ctx, f.q, "workspace.provider-pool", services.InstallSubject{RepositoryID: f.repoID, WorkspaceID: "another"})
		require.Error(t, err)
	})
	t.Run("expiry during account selection prevents outbound send", func(t *testing.T) {
		cipher, err := codec.EncryptString("sk-ant-api03-fr4b-access-test-abcdefghijklmnopqrstuvwxyz0123456789")
		require.NoError(t, err)
		connection, err := f.q.CreateProviderConnection(f.ctx, db.CreateProviderConnectionParams{OwnerType: "user", UserID: pgtype.Int8{Int64: f.owner.ID, Valid: true}, Provider: "claude", Kind: "api_key", Label: "local-test", AccessTokenEncrypted: []byte(cipher), CreatedBy: pgtype.Int8{Int64: f.owner.ID, Valid: true}})
		require.NoError(t, err)
		_, err = f.q.AddProviderConnectionGrant(f.ctx, db.AddProviderConnectionGrantParams{ConnectionID: connection.ID, RepositoryID: pgtype.Int8{Int64: f.repoID, Valid: true}})
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `DELETE FROM provider_connections WHERE id=$1`, connection.ID)
			require.NoError(t, err)
		}()
		var sends atomic.Int64
		var streaming atomic.Bool
		headers := make(chan struct{})
		releaseBody := make(chan struct{})
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sends.Add(1)
			raw, err := io.ReadAll(r.Body)
			if err != nil || string(raw) != `{"model":"local-test","messages":[]}` {
				w.WriteHeader(400)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			if streaming.Load() {
				w.WriteHeader(200)
				w.(http.Flusher).Flush()
				close(headers)
				select {
				case <-releaseBody:
				case <-r.Context().Done():
					return
				}
			}
			_, _ = io.WriteString(w, `{"id":"local-response"}`)
		}))
		defer upstream.Close()
		oldUpstreams := handler.Pool.Upstreams
		handler.Pool.Upstreams = map[string]string{"anthropic": upstream.URL}
		defer func() { handler.Pool.Upstreams = oldUpstreams }()
		digest := sha256.Sum256([]byte(machine))
		hash := hex.EncodeToString(digest[:])
		oldClient := handler.Pool.Client
		defer func() { handler.Pool.Client = oldClient }()
		sendsUnderLock := 0
		handler.Pool.Client = &http.Client{Transport: poolRoundTrip(func(r *http.Request) (*http.Response, error) {
			tx, err := f.pool.Begin(r.Context())
			require.NoError(t, err)
			_, err = tx.Exec(r.Context(), `SET LOCAL lock_timeout='75ms'`)
			require.NoError(t, err)
			_, err = tx.Exec(r.Context(), `UPDATE access_tokens SET expires_at=now() WHERE token_hash=$1`, hash)
			var pgerr *pgconn.PgError
			require.ErrorAs(t, err, &pgerr)
			require.Equal(t, "55P03", pgerr.Code)
			require.NoError(t, tx.Rollback(r.Context()))
			sendsUnderLock++
			return http.DefaultTransport.RoundTrip(r)
		})}
		for _, expire := range []bool{false, true} {
			t.Run(map[bool]string{false: "live", true: "expired after selection"}[expire], func(t *testing.T) {
				beforeScopes, beforePool := handler.Pool.Scopes, handler.Pool.Pool
				defer func() {
					handler.Pool.Scopes, handler.Pool.Pool = beforeScopes, beforePool
					_, err := f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=NULL WHERE token_hash=$1`, hash)
					require.NoError(t, err)
				}()
				sends.Store(0)
				if expire {
					handler.Pool.Scopes = &poolAfterAuthorization{ProviderPoolScopes: scopes, after: func() {
						_, err := f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=now()+interval '0.2 seconds' WHERE token_hash=$1`, hash)
						require.NoError(t, err)
					}}
					handler.Pool.Pool = &poolPickObservation{ProviderPool: pool, after: func() { time.Sleep(250 * time.Millisecond) }}
				}
				request := httptest.NewRequest("POST", "http://example.com/provider-pool/anthropic/v1/messages", strings.NewReader(`{"model":"local-test","messages":[]}`))
				request.Header.Set("Authorization", "Bearer "+machine)
				calls := 0
				request = request.WithContext(services.WithAuthorizationObserver(request.Context(), func(string) { calls++ }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, request)
				require.Equal(t, 1, calls)
				if expire {
					require.Equal(t, 401, out.Code, out.Body.String())
					require.Zero(t, sends.Load())
				} else {
					require.Equal(t, 200, out.Code, out.Body.String())
					require.EqualValues(t, 1, sends.Load())
					require.JSONEq(t, `{"id":"local-response"}`, out.Body.String())
				}
			})
		}
		require.Equal(t, 1, sendsUnderLock)
		stored, err := f.q.GetProviderConnection(f.ctx, connection.ID)
		require.NoError(t, err)
		require.True(t, stored.LastUsedAt.Valid, "account rotation records must commit with the fenced selection")
		t.Run("streaming does not retain credential locks", func(t *testing.T) {
			handler.Pool.Client = oldClient
			streaming.Store(true)
			defer close(releaseBody)
			ctx, cancel := context.WithTimeout(f.ctx, 3*time.Second)
			defer cancel()
			request := httptest.NewRequest("POST", "http://example.com/provider-pool/anthropic/v1/messages", strings.NewReader(`{"model":"local-test","messages":[]}`)).WithContext(ctx)
			request.Header.Set("Authorization", "Bearer "+machine)
			out := httptest.NewRecorder()
			done := make(chan struct{})
			go func() { defer close(done); router.ServeHTTP(out, request) }()
			select {
			case <-headers:
			case <-ctx.Done():
				t.Fatal("provider did not send headers")
			}
			tx, err := f.pool.Begin(ctx)
			require.NoError(t, err)
			defer func() { _ = tx.Rollback(f.ctx) }()
			_, err = tx.Exec(ctx, `SET LOCAL lock_timeout='1s'`)
			require.NoError(t, err)
			_, err = tx.Exec(ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, hash)
			require.NoError(t, err, "streaming must not hold the credential transaction")
			require.NoError(t, tx.Rollback(ctx))
			// End the response after the lock probe, without closing twice.
			select {
			case releaseBody <- struct{}{}:
			case <-ctx.Done():
				t.Fatal("provider stream closed early")
			}
			select {
			case <-done:
			case <-ctx.Done():
				t.Fatal("provider response did not finish")
			}
			require.Equal(t, 200, out.Code, out.Body.String())
			require.JSONEq(t, `{"id":"local-response"}`, out.Body.String())
		})
	})
	t.Run("authority and account reads share one database connection", func(t *testing.T) {
		config := f.pool.Config()
		config.MaxConns, config.MinConns = 1, 0
		single, err := pgxpool.NewWithConfig(f.ctx, config)
		require.NoError(t, err)
		defer single.Close()
		q := db.New(single)
		connections := services.NewProviderConnectionService(q, codec, nil,
			services.WithProviderPoolOwner(func(ctx context.Context) (int64, error) {
				owner, err := services.ProviderPoolQueries(ctx, q).GetSelfHostOwner(ctx)
				return owner.ID, err
			}),
			services.WithSubscriptionConnectionsSetting(func(ctx context.Context) bool {
				enabled, err := services.InstallChatGPTEnabled(ctx, services.ProviderPoolQueries(ctx, q))
				return err == nil && enabled
			}))
		beforePool, beforeScopes := handler.Pool.Pool, handler.Pool.Scopes
		handler.Pool.Pool = connections
		handler.Pool.Scopes = services.NewProviderPoolScopes(q, single, codec, true)
		defer func() { handler.Pool.Pool, handler.Pool.Scopes = beforePool, beforeScopes }()
		for _, tc := range []struct {
			method, path string
			status       int
		}{
			{"GET", "/provider-pool/routes", 200}, {"POST", "/provider-pool/anthropic/v1/messages", 404},
		} {
			ctx, cancel := context.WithTimeout(f.ctx, 2*time.Second)
			request := httptest.NewRequest(tc.method, "http://example.com"+tc.path, strings.NewReader(`{"model":"local-test"}`)).WithContext(ctx)
			request.Header.Set("Authorization", "Bearer "+machine)
			out := httptest.NewRecorder()
			router.ServeHTTP(out, request)
			cancel()
			require.Equal(t, tc.status, out.Code, out.Body.String())
		}
	})
	t.Run("disabled feature keeps credential death priority", func(t *testing.T) {
		require.NoError(t, f.q.UpsertInstallSetting(f.ctx, db.UpsertInstallSettingParams{Key: "models.chatgpt", Value: []byte("false")}))
		defer func() {
			require.NoError(t, f.q.UpsertInstallSetting(f.ctx, db.UpsertInstallSettingParams{Key: "models.chatgpt", Value: []byte("true")}))
		}()

		disabled := *cfg
		disabled.FeatureFlags.SubscriptionConnections = false
		boundary := githubAppSetupComposeRouter(&disabled, f.pool, nil, handler)
		dead := f.token(f.owner, "expired-pool-probe", "write:repository,via:codex", true)
		digest := sha256.Sum256([]byte(dead))
		_, err := f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, hex.EncodeToString(digest[:]))
		require.NoError(t, err)
		for _, tc := range []struct {
			token             string
			status, decisions int
		}{{dead, 401, 0}, {machine, 403, 1}} {
			req := httptest.NewRequest("GET", "http://example.com/provider-pool/routes", nil)
			req.Header.Set("Authorization", "Bearer "+tc.token)
			calls := 0
			req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(string) { calls++ }))
			out := httptest.NewRecorder()
			boundary.ServeHTTP(out, req)
			require.Equal(t, tc.status, out.Code, out.Body.String())
			require.Equal(t, tc.decisions, calls)
			if tc.status == 401 {
				require.Contains(t, out.Body.String(), `"code":"unauthenticated"`)
			}
		}
	})
	t.Run("managed host uses its verified stored binding", func(t *testing.T) {
		id := uuid.NewString()
		control := "pool-host-control"
		digest := sha256.Sum256([]byte(control))
		encrypted, err := codec.EncryptString(control)
		require.NoError(t, err)
		_, err = f.pool.Exec(f.ctx, `INSERT INTO flow_runtime_host_bindings(id,tenant_id,principal_id,binding_kind,binding_id,repository_id,user_id,workspace_id,catalog_key,service_name,runtime_artifact_digest,source_revision,owner_generation,credential_ciphertext,credential_hash,state)
   VALUES($1,'install','owner','workspace',$2::text,$3,$4,$2::text::uuid,'coding','coding',$5,$6,1,$7,$8,'running')`, id, workspace.ID, f.repoID, f.owner.ID, strings.Repeat("a", 64), strings.Repeat("b", 40), encrypted, digest[:])
		require.NoError(t, err)
		token := flowhost.ModelCredential(id, control)
		call := func(status, decisions int) {
			t.Helper()
			request := httptest.NewRequest("GET", "http://example.com/provider-pool/routes", nil)
			request.Header.Set("Authorization", "Bearer "+token)
			count := 0
			request = request.WithContext(services.WithAuthorizationObserver(request.Context(), func(command string) { require.Equal(t, "workspace.provider-pool", command); count++ }))
			out := httptest.NewRecorder()
			router.ServeHTTP(out, request)
			require.Equal(t, status, out.Code, out.Body.String())
			require.Equal(t, decisions, count)
		}
		call(200, 1)
		t.Run("host retirement serializes with account reads", func(t *testing.T) {
			before := handler.Pool.Pool
			defer func() { handler.Pool.Pool = before }()
			checked := false
			handler.Pool.Pool = &poolReadObservation{ProviderPool: pool, before: func(ctx context.Context) {
				if checked {
					return
				}
				checked = true
				tx, err := f.pool.Begin(ctx)
				require.NoError(t, err)
				_, err = tx.Exec(ctx, `SET LOCAL lock_timeout='75ms'`)
				require.NoError(t, err)
				_, err = tx.Exec(ctx, `UPDATE flow_runtime_host_bindings SET state='retired' WHERE id=$1`, id)
				var pgerr *pgconn.PgError
				require.ErrorAs(t, err, &pgerr)
				require.Equal(t, "55P03", pgerr.Code)
				require.NoError(t, tx.Rollback(ctx))
			}}
			call(200, 1)
			require.True(t, checked)
		})
		t.Run("retirement after admission", func(t *testing.T) {
			before := handler.Pool.Scopes
			defer func() {
				handler.Pool.Scopes = before
				_, err := f.pool.Exec(f.ctx, `UPDATE flow_runtime_host_bindings SET state='running' WHERE id=$1`, id)
				require.NoError(t, err)
			}()
			handler.Pool.Scopes = &poolAfterAuthorization{ProviderPoolScopes: scopes, after: func() {
				_, err := f.pool.Exec(f.ctx, `UPDATE flow_runtime_host_bindings SET state='retired' WHERE id=$1`, id)
				require.NoError(t, err)
			}}
			call(401, 1)
		})
		_, err = f.pool.Exec(f.ctx, `UPDATE flow_runtime_host_bindings SET repository_id=$2 WHERE id=$1`, id, f.repoID+1)
		require.NoError(t, err)
		call(403, 1)
		_, err = f.pool.Exec(f.ctx, `UPDATE flow_runtime_host_bindings SET repository_id=$2 WHERE id=$1`, id, f.repoID)
		require.NoError(t, err)
		_, err = f.pool.Exec(f.ctx, `UPDATE users SET prohibit_login=true WHERE id=$1`, f.owner.ID)
		require.NoError(t, err)
		call(401, 1)
		_, err = f.pool.Exec(f.ctx, `UPDATE users SET prohibit_login=false WHERE id=$1`, f.owner.ID)
		require.NoError(t, err)
		call(200, 1)
		_, err = f.pool.Exec(f.ctx, `UPDATE flow_runtime_host_bindings SET state='retired' WHERE id=$1`, id)
		require.NoError(t, err)
		call(401, 0)
		disabled := *cfg
		disabled.FeatureFlags.SubscriptionConnections = false
		require.NoError(t, f.q.UpsertInstallSetting(f.ctx, db.UpsertInstallSettingParams{Key: "models.chatgpt", Value: []byte("false")}))
		disabledBoundary := githubAppSetupComposeRouter(&disabled, f.pool, nil, handler)
		original := router
		router = disabledBoundary
		call(401, 0)
		router = original
	})

}

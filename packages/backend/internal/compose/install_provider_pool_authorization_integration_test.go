package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallProviderPoolAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	require.NoError(t, f.q.UpsertInstallSetting(f.ctx, db.UpsertInstallSettingParams{Key: "models.chatgpt", Value: []byte("true")}))
	workspace, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "provider", TargetBookmark: "main", Kind: "container", Status: "running"})
	require.NoError(t, err)
	pool := services.NewProviderConnectionService(f.q, nil, nil, services.WithSubscriptionConnectionsEnabled(true))
	codec, err := webhook.NewSecretCodec("pool-host-test-key")
	require.NoError(t, err)
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
		_, err = services.Authorize(ctx, f.q, "workspace.provider-pool", services.InstallSubject{RepositoryID: f.repoID + 1, WorkspaceID: workspace.ID})
		require.Error(t, err)
		_, err = services.Authorize(ctx, f.q, "workspace.provider-pool", services.InstallSubject{RepositoryID: f.repoID, WorkspaceID: "another"})
		require.Error(t, err)
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

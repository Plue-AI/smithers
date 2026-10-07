package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Authenticated role credentials and actual proxy receipts share product SQL.
// This proves the host boundary, not a live microVM TODO journey.
func TestFactoryRoleModelCredentialAtComposedProxyPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "factory-owner", LowerUsername: "factory-owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "factory", LowerName: "factory", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1);`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"factory-owner","repository_name":"factory","repository_id":%d}`, repo.ID)
	for key, value := range map[string]string{"github.repository": binding, "owner.access": binding[:len(binding)-1] + `,"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339) + `"}`, "agent:reviewer": `{"protocol":"anthropic-messages","modelId":"model-a","credential":"ANTHROPIC_API_KEY"}`} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	session := "factory-session"
	hash := sha256.Sum256([]byte(session))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	var workspace string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id) VALUES($1,$2) RETURNING id::text`, repo.ID, owner.ID).Scan(&workspace))
	id, control, item := uuid.NewString(), "trusted-control", uuid.NewString()
	controlHash := sha256.Sum256([]byte(control))
	digest := strings.Repeat("a", 64)
	_, err = pool.Exec(ctx, `INSERT INTO flow_runtime_host_bindings(id,tenant_id,principal_id,binding_kind,binding_id,repository_id,user_id,workspace_id,catalog_key,service_name,runtime_artifact_digest,source_revision,owner_generation,credential_ciphertext,credential_hash,state)
 VALUES($1,'repository:1','user:1','mythical-item',$2,$3,$4,$5,'coding','coding',$6,$7,1,$8,$9,'running')`, id, item, repo.ID, owner.ID, workspace, digest, strings.Repeat("b", 40), control, controlHash[:])
	require.NoError(t, err)
	started, release := make(chan string, 4), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad", 400)
			return
		}
		started <- body.Model
		if body.Model == "model-a" {
			<-release
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"usage":{"input_tokens":3,"output_tokens":4}}`)
	}))
	defer upstream.Close()
	var released sync.Once
	defer released.Do(func() { close(release) })
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{Setup: &services.InstallSetupService{Pool: pool}, Owners: q, Roster: q, Origins: middleware.FixedOrigins("http://example.com")})
	mountModelPublic(router.(chi.Router), modelhost.OwnerModels{Pool: pool}, q, cfg)
	handler := &modelproxy.Handler{OwnerPaid: true, Owner: modelproxy.OwnerMeter{DB: pool, DailyTokens: func(context.Context, int64) (int64, error) { return 1000000, nil }}, Keys: modelproxy.StaticKeys{modelproxy.ProviderAnthropic: "fixture"}, Callers: services.NewModelProxyCallers(q, pool, webhook.NoopSecretCodec{}), Upstreams: map[string]string{modelproxy.ProviderAnthropic: upstream.URL}, ResolveFactorySeat: resolveFactorySeat(q, nil)}
	mountModelProxy(router.(chi.Router), q, cfg, handler)
	credential := flowhost.RoleModelCredential(id, control, "reviewer")
	proxy := func(token, model string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", modelproxy.Path+"/anthropic/v1/messages", strings.NewReader(fmt.Sprintf(`{"model":%q,"max_tokens":10,"messages":[]}`, model)))
		req.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res
	}
	selection := func(token string) (int, modelproxy.FactorySeat) {
		req := httptest.NewRequest("GET", modelproxy.Path+"/factory-seat", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		var seat modelproxy.FactorySeat
		if res.Code == 200 {
			require.NoError(t, json.Unmarshal(res.Body.Bytes(), &seat))
		}
		return res.Code, seat
	}
	code, first := selection(credential)
	require.Equal(t, 200, code)
	require.Equal(t, "anthropic:model-a", first.Seat)
	refused, _ := selection(flowhost.ModelCredential(id, control))
	require.Equal(t, 403, refused)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- proxy(credential, "model-a") }()
	select {
	case model := <-started:
		require.Equal(t, "model-a", model)
	case <-time.After(10 * time.Second):
		t.Fatal("provider not started")
	}
	req := httptest.NewRequest("PUT", "http://example.com/api/agents/reviewer/model", strings.NewReader(`{"model":{"protocol":"anthropic-messages","modelId":"model-b","credential":"ANTHROPIC_API_KEY"}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://example.com")
	req.AddCookie(&http.Cookie{Name: "session", Value: session})
	req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "factory-csrf"})
	req.Header.Set("X-CSRF-Token", "factory-csrf")
	assigned := httptest.NewRecorder()
	router.ServeHTTP(assigned, req)
	require.Equal(t, 200, assigned.Code, assigned.Body.String())
	code, second := selection(credential)
	require.Equal(t, 200, code)
	require.Equal(t, "anthropic:model-b", second.Seat)
	require.Equal(t, "anthropic:model-a", first.Seat, "in-flight binding remains immutable")
	released.Do(func() { close(release) })
	require.Equal(t, 200, (<-done).Code)
	next := proxy(credential, "model-b")
	require.Equal(t, 200, next.Code, next.Body.String())
	require.Equal(t, "model-b", <-started)
	require.Equal(t, 401, proxy(strings.Replace(credential, ".reviewer.", ".planner.", 1), "model-b").Code, "the model credential cannot be relabelled")
	var models []string
	rows, err := pool.Query(ctx, `SELECT model FROM model_usage ORDER BY id`)
	require.NoError(t, err)
	for rows.Next() {
		var model string
		require.NoError(t, rows.Scan(&model))
		models = append(models, model)
	}
	rows.Close()
	require.Equal(t, []string{"model-a", "model-b"}, models)
	runs, err := q.RecentFactoryAgentRuns(ctx, "reviewer")
	require.NoError(t, err)
	require.Equal(t, []db.AgentModelRun{{ID: item, Model: "model-b"}, {ID: item, Model: "model-a"}}, runs)
	var after string
	require.NoError(t, pool.QueryRow(ctx, `SELECT runtime_artifact_digest FROM flow_runtime_host_bindings WHERE id=$1`, id).Scan(&after))
	require.Equal(t, digest, after)
	// Other valid roles cannot project a reviewer receipt under their own role.
	for _, role := range []string{"planner", "implementer"} {
		reply := proxy(flowhost.RoleModelCredential(id, control, role), "model-b")
		require.Equal(t, 200, reply.Code, reply.Body.String())
		require.Equal(t, "model-b", <-started)
		receipts, err := q.RecentFactoryAgentRuns(ctx, role)
		require.NoError(t, err)
		require.Equal(t, []db.AgentModelRun{{ID: item, Model: "model-b"}}, receipts)
	}
}

package compose

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/stretchr/testify/require"
)

// Real setup/model doors, sealed connections and the compiled provider host.
func TestInstallSubscriptionModelAccessPostgres(t *testing.T) {
	const session = "subscription-owner-session"
	access := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`)) + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"https://api.openai.com/auth":{"chatgpt_account_id":"private-subscription-account","chatgpt_plan_type":"pro"}}`)) + "." + base64.RawURLEncoding.EncodeToString([]byte("signature"))
	const account = "private-subscription-account"
	const coding = `{"protocol":"openai-responses-chatgpt","modelId":"gpt-6-sol","credential":"CHATGPT_SUBSCRIPTION"}`
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v4/ai/evaluation-model" {
			require.Equal(t, "Bearer gateway-fixture", r.Header.Get("Authorization"))
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"answers":{"ok":{"type":"boolean","probability":1}}}`)
			return
		}
		require.Equal(t, "/codex/responses", r.URL.Path)
		require.Equal(t, "Bearer "+access, r.Header.Get("Authorization"))
		require.Equal(t, account, r.Header.Get("chatgpt-account-id"))
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"subscription answer\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n")
	}))
	defer provider.Close()
	local := startConfiguredLocalChat(t, func(local *localChat, _ *chat.RuntimeOptions) {
		var err error
		local.host, err = modelhost.New(local.resolver, local.launcher, modelhost.WithProviderStandIn(provider.URL))
		require.NoError(t, err)
	})
	defer local.stop(t)
	ctx := local.ctx
	q := db.New(local.pool)
	_, err := local.pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, local.ownerID)
	require.NoError(t, err)
	_, err = local.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, local.repoID, local.ownerID)
	require.NoError(t, err)
	repository := fmt.Sprintf(`{"owner_login":"chatowner","repository_name":"chatrepo","repository_id":%d}`, local.repoID)
	for key, value := range map[string]string{"github.repository": repository, "owner.access": repository[:len(repository)-1] + `,"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339) + `"}`} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	hash := sha256.Sum256([]byte(session))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: local.ownerID, Username: "chatowner", SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	sealed, err := local.codec.EncryptString(access)
	require.NoError(t, err)
	_, err = local.pool.Exec(ctx, `INSERT INTO provider_connections(owner_type,user_id,provider,kind,label,account_id,access_token_encrypted,created_by) VALUES('user',$1,'codex','oauth','ChatGPT',$2,$3,$1)`, local.ownerID, account, []byte(sealed))
	require.NoError(t, err)
	store, err := jobs.NewStore(local.pool)
	require.NoError(t, err)
	setup := &services.InstallSetupService{Pool: local.pool, Jobs: store, Models: local.host}
	require.NoError(t, setup.Initialize(ctx))
	for _, id := range []string{"address", "app_manifest", "sign_in", "repository"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.step." + id, Value: []byte(`{"status":"done"}`)}))
	}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, local.pool, &routes.GitHubAppSetupHandler{Setup: setup, Owners: q, Roster: q, Origins: middleware.FixedOrigins(cfg.Server.PublicURL)})
	mountModelPublic(router.(chi.Router), modelhost.OwnerModels{Pool: local.pool, Codec: local.codec, Tester: local.host}, q, cfg)
	call := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, cfg.Server.PublicURL+path, strings.NewReader(body))
		r.Header.Set("Origin", cfg.Server.PublicURL)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", "subscription-setup")
		r.AddCookie(&http.Cookie{Name: "session", Value: session})
		r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "subscription-csrf"})
		r.Header.Set("X-CSRF-Token", "subscription-csrf")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	res := call("GET", "/api/model/catalog", "")
	require.Equal(t, 200, res.Code, res.Body.String())
	require.NotContains(t, res.Body.String(), "CHATGPT_SUBSCRIPTION")
	res = call("PUT", "/api/install", `{"chatgpt":true}`)
	require.Equal(t, 200, res.Code, res.Body.String())
	res = call("GET", "/api/model/catalog", "")
	require.Equal(t, 200, res.Code, res.Body.String())
	require.Contains(t, res.Body.String(), `"protocol":"openai-responses-chatgpt"`)
	require.NotContains(t, res.Body.String(), access)
	require.NotContains(t, res.Body.String(), account)
	res = call("PUT", "/api/model/default", `{"model":`+coding+`}`)
	require.Equal(t, 200, res.Code, res.Body.String())
	res = call("POST", "/api/model/credential", `{"action":"enroll","requestId":"gateway-enroll","name":"AI_GATEWAY_API_KEY","origin":"https://ai-gateway.vercel.sh","value":"gateway-fixture"}`)
	require.Equal(t, 200, res.Code, res.Body.String())
	require.Contains(t, res.Body.String(), `"ok":true`)
	res = call("POST", "/api/model/credential", `{"action":"enroll","requestId":"subscription-enroll","name":"CHATGPT_SUBSCRIPTION","origin":"https://chatgpt.com","value":"must-not-be-saved"}`)
	require.Equal(t, 200, res.Code, res.Body.String())
	require.Contains(t, res.Body.String(), `"ok":false`)
	var subscriptionKeys int
	require.NoError(t, local.pool.QueryRow(ctx, `SELECT count(*) FROM owner_model_credentials WHERE name='CHATGPT_SUBSCRIPTION'`).Scan(&subscriptionKeys))
	require.Zero(t, subscriptionKeys)
	res = call("POST", "/api/install/setup/models", `{}`)
	require.Equal(t, 202, res.Code, res.Body.String())
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- store.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "subscription-setup", Capacity: 1, Lease: time.Minute, PollInterval: 10 * time.Millisecond, Operations: []string{"install.setup.models"}}, setup.Handle)
	}()
	defer func() { cancel(); require.NoError(t, <-done) }()
	require.Eventually(t, func() bool {
		var state string
		err := local.pool.QueryRow(ctx, `SELECT value->>'status' FROM install_settings WHERE key='setup.step.models'`).Scan(&state)
		return err == nil && (state == "done" || state == "failed")
	}, 20*time.Second, 20*time.Millisecond)
	res = call("GET", "/api/install", "")
	require.Equal(t, 200, res.Code, res.Body.String())
	require.Contains(t, res.Body.String(), `"id":"models","state":"done"`)
	require.Contains(t, res.Body.String(), `"key":"saved","model":"gpt-6-sol","provider":"ChatGPT","role":"fast"`)
	require.NotContains(t, res.Body.String(), access)
	var fast json.RawMessage
	require.NoError(t, local.pool.QueryRow(ctx, `SELECT value FROM install_settings WHERE key='agent:fast'`).Scan(&fast))
	require.JSONEq(t, coding, string(fast))
	transport := &recordingHostTransport{}
	launcher := newBoxHostLauncher(transport, &recordingBoxes{env: map[string]string{}}, nil)
	launcher.codingModel = ownerCodingSeat(q, nil)
	_, err = launcher.StartFlowHost(ctx, flowhost.HostLaunch{Binding: flowhost.Binding{ID: "subscription-coding-host", UserID: local.ownerID}, Authority: flowhost.Authority{WorkspaceID: "subscription-workspace", UserID: local.ownerID}})
	require.NoError(t, err)
	require.Equal(t, "openai:gpt-6-sol", transport.started[0].Catalog.ImplementationModel)
	local.resolver.Close()
	resolved, err := local.resolver.ResolveChatModel(ctx, local.ownerID, local.repoID, json.RawMessage(`{}`))
	require.NoError(t, err)
	require.Contains(t, resolved.CredentialValue, access)
	res = call("PUT", "/api/install", `{"chatgpt":false}`)
	require.Equal(t, 200, res.Code, res.Body.String())
	_, err = local.resolver.ResolveChatModel(ctx, local.ownerID, local.repoID, json.RawMessage(`{}`))
	require.Error(t, err)
	require.NotContains(t, err.Error(), access)
	_, err = ownerCodingSeat(q, nil)(ctx)
	require.Error(t, err, "disabled subscription must refuse coding dispatch")
}

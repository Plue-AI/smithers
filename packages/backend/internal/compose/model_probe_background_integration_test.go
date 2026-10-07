package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/stretchr/testify/require"
)

// Real PostgreSQL and packaged host; only the external HTTP provider is a
// deterministic fixture. Admission/reconnection use the composed install door.
func TestComposedModelProbeReconnectsWithoutAnotherProviderCall(t *testing.T) {
	var session string
	local := startConfiguredLocalChat(t, func(local *localChat, _ *chat.RuntimeOptions) {
		q := db.New(local.pool)
		_, err := local.pool.Exec(local.ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, local.ownerID)
		require.NoError(t, err)
		_, err = local.pool.Exec(local.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, local.repoID, local.ownerID)
		require.NoError(t, err)
		binding := fmt.Sprintf(`{"owner_login":"chatowner","repository_name":"chatrepo","repository_id":%d}`, local.repoID)
		require.NoError(t, q.UpsertInstallSetting(local.ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
		require.NoError(t, q.UpsertInstallSetting(local.ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339) + `"}`)}))
		session = "probe-owner-session"
		hash := sha256.Sum256([]byte(session))
		_, err = q.CreateAuthSession(local.ctx, db.CreateAuthSessionParams{UserID: local.ownerID, Username: "chatowner", SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	})
	defer local.stop(t)
	var calls atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		raw, _ := io.ReadAll(r.Body)
		require.Contains(t, string(raw), `"model":"probe-model"`)
		close(started)
		<-release
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"id\":\"probe\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"probe-ok\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"probe\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer func() {
		if !released {
			close(release)
			released = true
		}
		provider.Close()
	}()
	local.enroll(t, "PROBE_KEY", provider.URL, "private-probe-secret")
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	q := db.New(local.pool)
	router := githubAppSetupComposeRouter(cfg, local.pool, &routes.GitHubAppSetupHandler{Setup: &services.InstallSetupService{Pool: local.pool}, Owners: q, Roster: q, Origins: middleware.FixedOrigins("http://example.com")})
	models := modelhost.OwnerModels{Pool: local.pool, Tester: local.host}
	mountModelPublic(router.(chi.Router), models, q, cfg)
	call := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://example.com"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://example.com")
		req.AddCookie(&http.Cookie{Name: "session", Value: session})
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "probe-csrf"})
		req.Header.Set("X-CSRF-Token", "probe-csrf")
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res
	}
	body := fmt.Sprintf(`{"requestId":"probe-request-1","model":{"id":"probe","protocol":"openai-chat","modelId":"probe-model","credential":"PROBE_KEY","baseUrl":%q}}`, provider.URL)
	res := call("POST", "/api/model/test", body)
	require.Equal(t, 202, res.Code, res.Body.String())
	require.Zero(t, calls.Load())
	var admitted struct {
		OperationID string `json:"operationId"`
	}
	require.NoError(t, json.Unmarshal(res.Body.Bytes(), &admitted))
	workerCtx, stop := context.WithCancel(local.ctx)
	done := make(chan error, 1)
	go func() { done <- models.RunModelTests(workerCtx) }()
	workerStopped := false
	defer func() {
		if !workerStopped {
			stop()
			require.NoError(t, <-done)
		}
	}()
	select {
	case <-started:
	case <-time.After(20 * time.Second):
		t.Fatal("probe did not start", local.logs.String())
	}
	// Reload repeats admission with the persisted request identity. Both launch
	// and polling finish while the actual provider is deliberately held open.
	res = call("POST", "/api/model/test", body)
	require.Equal(t, 202, res.Code, res.Body.String())
	require.Contains(t, res.Body.String(), admitted.OperationID)
	res = call("GET", "/api/model/test/receipt?requestId=probe-request-1", "")
	require.Equal(t, 200, res.Code)
	require.Contains(t, res.Body.String(), `"state":"running"`)
	conflict := call("POST", "/api/model/test", strings.ReplaceAll(body, "probe-model", "changed-model"))
	require.Equal(t, 409, conflict.Code)
	require.EqualValues(t, 1, calls.Load())
	close(release)
	released = true
	require.Eventually(t, func() bool {
		res = call("GET", "/api/model/test/receipt?requestId=probe-request-1", "")
		return strings.Contains(res.Body.String(), `"state":"completed"`)
	}, 20*time.Second, 20*time.Millisecond)
	require.Contains(t, res.Body.String(), `"ok":true`)
	require.Contains(t, res.Body.String(), "probe-ok")
	res = call("POST", "/api/model/test", body)
	require.Equal(t, 202, res.Code)
	require.EqualValues(t, 1, calls.Load())
	// A different receipt identity never reveals the first result.
	res = call("GET", "/api/model/test/receipt?requestId=unknown-request", "")
	require.Equal(t, 404, res.Code)
	store, err := jobs.NewStore(local.pool)
	require.NoError(t, err)
	op, err := store.GetByRequest(local.ctx, jobs.Scope{TenantID: "install", PrincipalID: fmt.Sprint(local.ownerID)}, "model.test", "probe-request-1")
	require.NoError(t, err)
	require.Equal(t, jobs.EffectUnsafe, op.EffectPolicy)
	require.NotContains(t, string(op.Payload), "private-probe-secret")
	stop()
	require.NoError(t, <-done)
	workerStopped = true
	// A restart after StartExternal cannot replay an unconfirmed provider
	// effect. Recovery durably exposes uncertainty through the same receipt.
	uncertainBody := strings.ReplaceAll(body, "probe-request-1", "probe-request-2")
	res = call("POST", "/api/model/test", uncertainBody)
	require.Equal(t, 202, res.Code)
	claim, err := store.ClaimForOperations(local.ctx, "crashed-model-worker", time.Minute, []string{"model.test"})
	require.NoError(t, err)
	_, err = store.BeginExternal(local.ctx, claim, json.RawMessage(`{"kind":"model.test"}`))
	require.NoError(t, err)
	_, err = local.pool.Exec(local.ctx, `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, claim.OperationID)
	require.NoError(t, err)
	recovered, err := store.RecoverExpiredForOperations(local.ctx, []string{"model.test"}, 1)
	require.NoError(t, err)
	require.Equal(t, 1, recovered)
	res = call("GET", "/api/model/test/receipt?requestId=probe-request-2", "")
	require.Equal(t, 200, res.Code)
	require.Contains(t, res.Body.String(), `"state":"uncertain"`)
	res = call("POST", "/api/model/test", uncertainBody)
	require.Equal(t, 202, res.Code)
	require.Contains(t, res.Body.String(), `"state":"accepted"`)
	require.EqualValues(t, 1, calls.Load())
}

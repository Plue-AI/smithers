package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/stretchr/testify/require"
)

// Actual provider requests from the packaged host, admitted through the install
// router. A setting write must not replace an already dispatched call's binding.
func TestComposedAppModelSwitchPreservesInflightCall(t *testing.T) {
	const session = "app-model-owner-session"
	local := startConfiguredLocalChat(t, func(local *localChat, _ *chat.RuntimeOptions) {
		q := db.New(local.pool)
		_, err := local.pool.Exec(local.ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, local.ownerID)
		require.NoError(t, err)
		_, err = local.pool.Exec(local.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, local.repoID, local.ownerID)
		require.NoError(t, err)
		binding := fmt.Sprintf(`{"owner_login":"chatowner","repository_name":"chatrepo","repository_id":%d}`, local.repoID)
		for key, value := range map[string]string{"github.repository": binding, "owner.access": binding[:len(binding)-1] + `,"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339) + `"}`} {
			require.NoError(t, q.UpsertInstallSetting(local.ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
		}
		hash := sha256.Sum256([]byte(session))
		_, err = q.CreateAuthSession(local.ctx, db.CreateAuthSessionParams{UserID: local.ownerID, Username: "chatowner", SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	})
	defer local.stop(t)
	started, release := make(chan string, 4), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request", 400)
			return
		}
		started <- body.Model
		if body.Model == "model-a" {
			<-release
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: {\"id\":\"answer\",\"choices\":[{\"index\":0,\"delta\":{\"content\":%q},\"finish_reason\":null}]}\n\ndata: {\"id\":\"answer\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", "answered on "+body.Model)
	}))
	defer func() { unblock(); provider.Close() }()
	local.enroll(t, "TURN_KEY", provider.URL, "private-turn-secret")
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	q := db.New(local.pool)
	router := githubAppSetupComposeRouter(cfg, local.pool, &routes.GitHubAppSetupHandler{Setup: &services.InstallSetupService{Pool: local.pool}, Owners: q, Roster: q, Origins: middleware.FixedOrigins("http://example.com")})
	mountModelPublic(router.(chi.Router), modelhost.OwnerModels{Pool: local.pool, Codec: local.codec}, q, cfg)
	mountChatPublic(router.(chi.Router), local.composition.runtime, q, cfg)
	public := httptest.NewServer(router)
	defer public.Close()
	request := func(method, path, body string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(method, public.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Host = "example.com"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://example.com")
		req.AddCookie(&http.Cookie{Name: "session", Value: session})
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "turn-csrf"})
		req.Header.Set("X-CSRF-Token", "turn-csrf")
		res, err := local.client.Do(req)
		require.NoError(t, err)
		return res
	}
	assign := func(role, model string) {
		t.Helper()
		res := request("PUT", "/api/agents/"+role+"/model", fmt.Sprintf(`{"model":{"protocol":"openai-chat","modelId":%q,"credential":"TURN_KEY","baseUrl":%q}}`, model, provider.URL))
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.Equal(t, 200, res.StatusCode, string(raw))
		require.Contains(t, string(raw), `"id":"`+model+`"`)
	}
	turn := func(run string) *http.Response {
		return request("POST", chat.TurnPath, fmt.Sprintf(`{"runId":%q,"journal":{"version":1,"legId":%q,"token":%q},"instructions":"Answer briefly.","messages":[{"role":"user","content":"Hello"}]}`, run, run+"-leg", strings.Repeat("a", 48)))
	}
	assign("coding", "model-a")
	first := turn("app-switch-before")
	defer first.Body.Close()
	require.Equal(t, 200, first.StatusCode)
	select {
	case model := <-started:
		require.Equal(t, "model-a", model)
	case <-time.After(20 * time.Second):
		t.Fatal("old model did not dispatch", local.logs.String())
	}
	assign("app", "model-b")
	var todos int
	require.NoError(t, local.pool.QueryRow(local.ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, local.repoID).Scan(&todos))
	require.Zero(t, todos, "a model assignment creates no TODO")
	unblock()
	raw, err := io.ReadAll(first.Body)
	require.NoError(t, err)
	require.Contains(t, string(raw), "answered on model-a", local.logs.String())
	next := turn("app-switch-after")
	defer next.Body.Close()
	raw, err = io.ReadAll(next.Body)
	require.NoError(t, err)
	require.Equal(t, 200, next.StatusCode, string(raw))
	require.Contains(t, string(raw), "answered on model-b", local.logs.String())
	select {
	case model := <-started:
		require.Equal(t, "model-b", model)
	case <-time.After(20 * time.Second):
		t.Fatal("new model did not dispatch", local.logs.String())
	}
	require.Empty(t, started, "exactly one provider call per turn")
	require.NotContains(t, local.logs.String(), "private-turn-secret")
}

package compose

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestFastGatewayComposedAuthQuotaCountsAndKeyConfinementPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "gateway-owner", LowerUsername: "gateway-owner"})
	require.NoError(t, err)
	stranger, err := q.CreateUser(ctx, db.CreateUserParams{Username: "stranger", LowerUsername: "stranger"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_admin=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	sessions := map[int64]string{}
	hostTokens := map[int64]string{}
	for _, user := range []db.User{owner, stranger} {
		raw := user.Username + "-session"
		hash := sha256.Sum256([]byte(raw))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		sessions[user.ID] = raw
		seed := sha256.Sum256([]byte(user.Username))
		hostToken := "smithers_" + hex.EncodeToString(seed[:])[:40]
		hostHash := sha256.Sum256([]byte(hostToken))
		digest := hex.EncodeToString(hostHash[:])
		_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: user.ID, Name: "host-sign-in", TokenHash: digest, TokenLastEight: digest[56:], Scopes: "write:user"})
		require.NoError(t, err)
		hostTokens[user.ID] = hostToken
	}
	const platformKey = "private-cerebras-platform-key-DO-NOT-LEAK"
	const prompt = "secret-prompt-fixture-8932"
	const completion = "completion-fixture-7264"
	var calls atomic.Int64
	var mode atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		require.Equal(t, "Bearer "+platformKey, r.Header.Get("Authorization"))
		require.Empty(t, r.Header.Get(modelproxy.InstallHeader))
		require.Equal(t, "/v1/chat/completions", r.URL.Path)
		raw, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.Contains(t, string(raw), prompt)
		if mode.Load() == 1 {
			w.WriteHeader(500)
			_, _ = w.Write([]byte(platformKey))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"` + completion + ` ` + platformKey + `"}}],"usage":{"prompt_tokens":8,"completion_tokens":2}}`))
	}))
	defer upstream.Close()
	now := time.Date(2026, 10, 7, 23, 59, 59, 0, time.UTC)
	gateway := &modelproxy.FastGateway{Quota: credits.FastQuota{DB: pool, DailyTokens: 100_000, Now: func() time.Time { return now }}, Keys: modelproxy.StaticKeys{modelproxy.ProviderCerebras: platformKey}, Upstream: upstream.URL}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{FastGateway: gateway})
	server := httptest.NewServer(router)
	defer server.Close()
	var logs bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(old)
	request := func(user int64, method, path, body, install, token string) (int, string) {
		t.Helper()
		r, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		r.Header.Set("Content-Type", "application/json")
		if user > 0 && method == "POST" && path == "/api/fast-model/installs" {
			r.Header.Set("Authorization", "Bearer "+hostTokens[user])
		} else if user > 0 {
			r.AddCookie(&http.Cookie{Name: "session", Value: sessions[user]})
			r.Header.Set("Origin", "http://example.com")
			r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "fixture-csrf"})
			r.Header.Set("X-CSRF-Token", "fixture-csrf")
		}
		if install != "" {
			r.Header.Set(modelproxy.InstallHeader, install)
		}
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := server.Client().Do(r)
		require.NoError(t, err)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.NotContains(t, string(raw), platformKey)
		return res.StatusCode, string(raw)
	}
	install := uuid.NewString()
	other := uuid.NewString()
	issue := func(user int64, id string) string {
		status, raw := request(user, "POST", "/api/fast-model/installs", `{"install_id":"`+id+`"}`, "", "")
		require.Equal(t, 200, status, raw)
		var result struct {
			Credential string `json:"credential"`
		}
		require.NoError(t, json.Unmarshal([]byte(raw), &result))
		require.NotEmpty(t, result.Credential)
		return result.Credential
	}
	status, raw := request(0, "POST", "/api/fast-model/installs", `{"install_id":"`+install+`"}`, "", "")
	require.Equal(t, 401, status, raw)
	// A signed-in browser never receives the install credential.
	browser := httptest.NewRequest("POST", "http://example.com/api/fast-model/installs", strings.NewReader(`{"install_id":"`+install+`"}`))
	browser.AddCookie(&http.Cookie{Name: "session", Value: sessions[owner.ID]})
	browser.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "fixture-csrf"})
	browser.Header.Set("Origin", "http://example.com")
	browser.Header.Set("X-CSRF-Token", "fixture-csrf")
	refusedBrowser := httptest.NewRecorder()
	router.ServeHTTP(refusedBrowser, browser)
	require.Equal(t, 403, refusedBrowser.Code, refusedBrowser.Body.String())
	require.NotContains(t, refusedBrowser.Body.String(), "smf_")
	delegated := "smithers_0123456789abcdef0123456789abcdef01234567"
	delegatedHash := sha256.Sum256([]byte(delegated))
	digest := hex.EncodeToString(delegatedHash[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "delegated", TokenHash: digest, TokenLastEight: digest[56:], Scopes: "write:user,via:codex", SystemIssued: true})
	require.NoError(t, err)
	status, raw = request(0, "POST", "/api/fast-model/installs", `{"install_id":"`+install+`"}`, "", delegated)
	require.Equal(t, 403, status, raw)
	token := issue(owner.ID, install)
	otherToken := issue(owner.ID, other)
	status, raw = request(stranger.ID, "POST", "/api/fast-model/installs", `{"install_id":"`+install+`"}`, "", "")
	require.Equal(t, 403, status, raw)
	body := `{"model":"gpt-oss-120b","max_completion_tokens":10,"messages":[{"role":"user","content":"` + prompt + `"}]}`
	for _, bad := range []struct{ id, token string }{{install, "unknown"}, {uuid.NewString(), token}, {install, otherToken}, {"invalid", token}, {install, ""}} {
		status, raw = request(0, "POST", modelproxy.FastGatewayPath+"/v1/chat/completions", body, bad.id, bad.token)
		require.Equal(t, 401, status, raw)
	}
	require.Zero(t, calls.Load())
	for i := 0; i < 100; i++ {
		status, raw = request(0, "POST", modelproxy.FastGatewayPath+"/v1/chat/completions", body, install, token)
		require.Equal(t, 200, status, raw)
		require.Contains(t, raw, completion)
	}
	require.EqualValues(t, 100, calls.Load())
	var stored string
	require.NoError(t, pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(c))::text FROM fast_model_counts c`).Scan(&stored))
	for _, secret := range []string{prompt, completion, platformKey, token} {
		require.NotContains(t, stored, secret)
		require.NotContains(t, logs.String(), secret)
	}
	var total, count int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT sum(tokens)::bigint,count(*) FROM fast_model_counts`).Scan(&total, &count))
	require.EqualValues(t, 1000, total)
	require.EqualValues(t, 100, count)
	status, raw = request(owner.ID, "GET", "/api/admin/fast-model/daily-totals?from=2026-10-07&until=2026-10-08", "", "", "")
	require.Equal(t, 200, status, raw)
	require.JSONEq(t, `[{"install":"`+install+`","day":"2026-10-07","tokens":1000}]`, raw)
	status, raw = request(stranger.ID, "GET", "/api/admin/fast-model/daily-totals?from=2026-10-07&until=2026-10-08", "", "", "")
	require.Equal(t, 403, status, raw)
	status, raw = request(0, "GET", modelproxy.FastGatewayPath+"/quota", "", install, token)
	require.Equal(t, 200, status, raw)
	require.Contains(t, raw, `"remaining_tokens":99000`)
	gateway.Quota.DailyTokens = 5000
	status, raw = request(0, "POST", modelproxy.FastGatewayPath+"/v1/chat/completions", body, install, token)
	require.Equal(t, 429, status, raw)
	require.Contains(t, raw, `"type":"capacity"`)
	require.Contains(t, raw, `"reset_at":"2026-10-08T00:00:00Z"`)
	require.EqualValues(t, 100, calls.Load())
	now = now.Add(time.Second)
	status, raw = request(0, "POST", modelproxy.FastGatewayPath+"/v1/chat/completions", body, install, token)
	require.Equal(t, 200, status, raw)
	// A provider failure that might have run retains its bound and leaks no key.
	mode.Store(1)
	status, raw = request(0, "POST", modelproxy.FastGatewayPath+"/v1/chat/completions", body, install, token)
	require.Equal(t, 500, status, raw)
	require.Contains(t, raw, "[redacted]")
	status, raw = request(0, "POST", modelproxy.FastGatewayPath+"/v1/chat/completions", body, install, token)
	require.Equal(t, 429, status, raw)
	status, raw = request(stranger.ID, "DELETE", "/api/fast-model/installs/"+install, "", "", "")
	require.Equal(t, 403, status, raw)
	status, raw = request(owner.ID, "DELETE", "/api/fast-model/installs/"+install, "", "", "")
	require.Equal(t, 204, status, raw)
	before := calls.Load()
	status, raw = request(0, "POST", modelproxy.FastGatewayPath+"/v1/chat/completions", body, install, token)
	require.Equal(t, 401, status, raw)
	require.Equal(t, before, calls.Load())
	rotated := issue(owner.ID, install)
	require.NotEqual(t, token, rotated)
	status, raw = request(0, "GET", modelproxy.FastGatewayPath+"/quota", "", install, token)
	require.Equal(t, 401, status, raw)
}

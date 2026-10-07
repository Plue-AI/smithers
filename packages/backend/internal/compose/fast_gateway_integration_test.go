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
	for _, invalid := range []string{`{`, `{"model":"coding-model","messages":[]}`, `{"model":"gpt-oss-120b","max_completion_tokens":-1,"messages":[]}`} {
		status, raw = request(0, "POST", modelproxy.FastGatewayPath+"/v1/chat/completions", invalid, install, token)
		require.Equal(t, 400, status, raw)
	}
	status, raw = request(0, "POST", modelproxy.FastGatewayPath+"/v1/responses", body, install, token)
	// Install credentials cannot authenticate an unoffered product API route.
	require.Equal(t, 401, status, raw)
	status, raw = request(owner.ID, "GET", "/api/admin/fast-model/daily-totals?from=invalid&until=2026-10-08", "", "", "")
	require.Equal(t, 400, status, raw)
	require.Contains(t, raw, `"code":"bad_request"`)
	status, raw = request(owner.ID, "POST", "/api/fast-model/installs", `{"install_id":"`+install+`"} {}`, "", "")
	require.Equal(t, 400, status, raw)
	require.Zero(t, calls.Load())
	for i := 0; i < 100; i++ {
		status, raw = request(0, "POST", modelproxy.FastGatewayPath+"/v1/chat/completions", body, install, token)
		require.Equal(t, 200, status, raw)
		require.Contains(t, raw, completion)
	}
	require.EqualValues(t, 100, calls.Load())
	var columns []string
	require.NoError(t, pool.QueryRow(ctx, `SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='fast_model_counts'`).Scan(&columns))
	require.Equal(t, []string{"id", "install_id", "tokens", "created_at", "settled"}, columns)
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

func TestFastGatewayComposedConcurrentStreamingAdmissionPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	var owner int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('stream-owner','stream-owner') RETURNING id`).Scan(&owner))
	quota := credits.FastQuota{DB: pool, DailyTokens: 5000}
	install := uuid.NewString()
	token, err := quota.Issue(ctx, owner, install)
	require.NoError(t, err)
	entered := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int64
	const key = "stream-provider-key-confinement-fixture"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		close(entered)
		<-release
		w.Header().Set("Content-Type", "text/event-stream")
		// The provider echoes the key split across network writes.
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"" + key[:12]))
		w.(http.Flusher).Flush()
		_, _ = w.Write([]byte(key[12:] + "\"}}]}\n\ndata: {\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n"))
	}))
	defer upstream.Close()
	gateway := &modelproxy.FastGateway{Quota: quota, Keys: modelproxy.StaticKeys{modelproxy.ProviderCerebras: key}, Upstream: upstream.URL}
	cfg := testConfigAllFlagsOn()
	router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{FastGateway: gateway})
	body := `{"model":"gpt-oss-120b","stream":true,"max_completion_tokens":10,"messages":[{"role":"user","content":"hello"}]}`
	call := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", modelproxy.FastGatewayPath+"/v1/chat/completions", strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set(modelproxy.InstallHeader, install)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- call() }()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("upstream did not start")
	}
	refused := call()
	require.Equal(t, 429, refused.Code, refused.Body.String())
	require.Contains(t, refused.Body.String(), `"type":"capacity"`)
	require.EqualValues(t, 1, calls.Load())
	left, err := quota.Remaining(ctx, install, token)
	require.NoError(t, err)
	require.Less(t, left, int64(1000))
	close(release)
	var response *httptest.ResponseRecorder
	select {
	case response = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("stream did not finish")
	}
	require.Equal(t, 200, response.Code)
	require.Contains(t, response.Body.String(), "data: [DONE]")
	require.Contains(t, response.Body.String(), "[redacted]")
	require.NotContains(t, response.Body.String(), key)
	left, err = quota.Remaining(ctx, install, token)
	require.NoError(t, err)
	require.EqualValues(t, 4990, left)
}

func TestFastGatewayComposedRedirectMissingUsageAndUnavailableKeyPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	var owner int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('failure-owner','failure-owner') RETURNING id`).Scan(&owner))
	now := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	quota := credits.FastQuota{DB: pool, DailyTokens: 5000, Now: func() time.Time { return now }}
	install := uuid.NewString()
	token, err := quota.Issue(ctx, owner, install)
	require.NoError(t, err)
	var redirected, upstreamCalls atomic.Int64
	var mode atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1); w.WriteHeader(200) }))
	defer target.Close()
	const key = "private-redirect-and-failure-provider-key"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		switch mode.Load() {
		case 0:
			w.Header().Set("Location", target.URL)
			w.WriteHeader(307)
			_, _ = w.Write([]byte(key))
		case 1:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"` + key + `"}}]}`))
		case 2:
			w.WriteHeader(401)
			_, _ = w.Write([]byte(key))
		}
	}))
	defer upstream.Close()
	gateway := &modelproxy.FastGateway{Quota: quota, Keys: modelproxy.StaticKeys{modelproxy.ProviderCerebras: key}, Upstream: upstream.URL, Client: &http.Client{}}
	router := githubAppSetupComposeRouter(testConfigAllFlagsOn(), pool, nil, routerExtras{FastGateway: gateway})
	call := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", modelproxy.FastGatewayPath+"/v1/chat/completions", strings.NewReader(`{"model":"gpt-oss-120b","max_completion_tokens":10,"messages":[{"role":"user","content":"hello"}]}`))
		r.Header.Set(modelproxy.InstallHeader, install)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		require.NotContains(t, w.Body.String(), key)
		return w
	}
	response := call()
	require.Equal(t, 307, response.Code)
	require.Zero(t, redirected.Load(), "custom clients cannot follow redirects with the platform key")
	left, err := quota.Remaining(ctx, install, token)
	require.NoError(t, err)
	require.EqualValues(t, 5000, left)
	mode.Store(1)
	response = call()
	require.Equal(t, 200, response.Code)
	left, err = quota.Remaining(ctx, install, token)
	require.NoError(t, err)
	require.Less(t, left, int64(1000))
	response = call()
	require.Equal(t, 429, response.Code)
	require.EqualValues(t, 2, upstreamCalls.Load())
	now = now.Add(24 * time.Hour)
	mode.Store(2)
	response = call()
	require.Equal(t, 502, response.Code)
	left, err = quota.Remaining(ctx, install, token)
	require.NoError(t, err)
	require.EqualValues(t, 5000, left)
	gateway.Keys = nil
	response = call()
	require.Equal(t, 503, response.Code)
	require.EqualValues(t, 3, upstreamCalls.Load())
	left, err = quota.Remaining(ctx, install, token)
	require.NoError(t, err)
	require.EqualValues(t, 5000, left)
}

package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// fakePool hands out its accounts in order, skipping excluded and limited
// ones, and records what the proxy reports back.
type fakePool struct {
	mu        sync.Mutex
	accounts  []services.ResolvedProviderConnection
	limited   map[string]time.Time
	rejected  []string
	refreshed []string
	refreshOK bool
	nextReset time.Time
	reconnect bool
	pooled    bool
	next      int
	onRefresh func()
}

func (p *fakePool) PickForModelCall(_ context.Context, _, _ int64, _ string, excluded []string) (services.ProviderPoolPick, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pick := services.ProviderPoolPick{Pooled: p.pooled, NextReset: p.nextReset, Reconnect: p.reconnect}
	for range p.accounts {
		account := p.accounts[p.next%len(p.accounts)]
		p.next++
		if _, limited := p.limited[account.ConnectionID]; limited || contains(excluded, account.ConnectionID) || contains(p.rejected, account.ConnectionID) {
			continue
		}
		pick.Connection = &account
		return pick, nil
	}
	return pick, nil
}
func (p *fakePool) MarkLimited(_ context.Context, id string, until time.Time) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.limited[id] = until
	return nil
}
func (p *fakePool) MarkRejected(_ context.Context, id string, _ int64, _ string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.rejected = append(p.rejected, id)
	return nil
}
func (p *fakePool) ForceRefresh(_ context.Context, id string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.refreshed = append(p.refreshed, id)
	if p.onRefresh != nil {
		p.onRefresh()
	}
	if p.refreshOK {
		return nil
	}
	return assert.AnError
}

func (p *fakePool) HasPool(_ context.Context, _, _ int64, provider string) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, account := range p.accounts {
		if account.Provider == provider {
			return p.pooled, nil
		}
	}
	return false, nil
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

type fakeScopes struct{ ok bool }

func (s fakeScopes) Scope(ctx context.Context, bearer string) (int64, int64, bool) {
	return 7, 42, s.ok && bearer != "" && middleware.AuthInfoFromContext(ctx) != nil
}

type providerCall struct {
	auth, account, path, apiKey, version string
	betas                                []string
	body                                 map[string]any
}

// accountUpstream answers per bearer token: the status and body configured
// for that account, 200 SSE otherwise.
func accountUpstream(t *testing.T, calls *[]providerCall, answers map[string]func(w http.ResponseWriter)) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		call := providerCall{auth: r.Header.Get("Authorization"), account: r.Header.Get("Chatgpt-Account-Id"), path: r.URL.Path,
			apiKey: r.Header.Get("X-Api-Key"), version: r.Header.Get("Anthropic-Version"), betas: r.Header.Values("Anthropic-Beta")}
		_ = json.Unmarshal(raw, &call.body)
		mu.Lock()
		*calls = append(*calls, call)
		mu.Unlock()
		key := strings.TrimPrefix(call.auth, "Bearer ")
		if key == "" {
			key = call.apiKey
		}
		if answer, ok := answers[key]; ok {
			answer(w)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, responsesStream)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func poolHandler(pool *fakePool, upstream string) *ProviderPoolHandler {
	return &ProviderPoolHandler{Pool: pool, Scopes: fakeScopes{ok: true}, Upstreams: map[string]string{"chatgpt": upstream}}
}

const responsesStream = "event: response.created\n" +
	`data: {"type":"response.created"}` + "\n\n" +
	"event: response.completed\n" +
	`data: {"type":"response.completed"}` + "\n\n"

func workspaceContext() context.Context {
	return middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: true, RawScopes: "read:workspace,repo:42,workspace:ws1"})
}

func proxyRequest(t *testing.T, h http.Handler, path, body string, ctx context.Context) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer smithers_pooltoken")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func codexAccounts(ids ...string) []services.ResolvedProviderConnection {
	var out []services.ResolvedProviderConnection
	for _, id := range ids {
		out = append(out, services.ResolvedProviderConnection{ConnectionID: id, Provider: "codex", Kind: "oauth", AccessToken: "codex-" + id, AccountID: "acct-" + id})
	}
	return out
}

const (
	responsesPath = "/provider-pool/chatgpt/codex/responses"
	responsesBody = `{"model":"gpt-6-luna","stream":true,"instructions":"Be terse.","input":[{"role":"user","content":"hi"}]}`
)

func usageLimited(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "3600")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)
	_, _ = io.WriteString(w, `{"error":{"type":"usage_limit_reached","message":"usage limit"}}`)
}

func TestProviderPool_RotatesPastALimitedAccountBeforeAnyByteReachesTheCaller(t *testing.T) {
	var calls []providerCall
	upstream := accountUpstream(t, &calls, map[string]func(http.ResponseWriter){"codex-a": usageLimited})
	pool := &fakePool{pooled: true, accounts: codexAccounts("a", "b"), limited: map[string]time.Time{}}
	h := poolHandler(pool, upstream.URL)

	rec := proxyRequest(t, h, responsesPath, responsesBody, workspaceContext())

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, responsesStream, rec.Body.String())
	require.Len(t, calls, 2)
	assert.WithinDuration(t, time.Now().Add(time.Hour), pool.limited["a"], time.Minute, "the limited account is parked until its reset")
	second := calls[1]
	assert.Equal(t, "/codex/responses", second.path)
	assert.Equal(t, "Bearer codex-b", second.auth)
	assert.Equal(t, "acct-b", second.account)
	assert.Equal(t, "Be terse.", second.body["instructions"], "the body is forwarded unchanged")
	assert.NotContains(t, rec.Body.String()+strings.Join(rec.Header().Values("Authorization"), ""), "codex-b")
	assert.NotContains(t, second.auth, "smithers_pooltoken", "the pool credential never reaches the provider")
}

func TestProviderPool_AllLimitedAnswersRateLimitUntilTheEarliestReset(t *testing.T) {
	var calls []providerCall
	upstream := accountUpstream(t, &calls, nil)
	pool := &fakePool{pooled: true, accounts: codexAccounts("a"), limited: map[string]time.Time{"a": time.Now().Add(time.Hour)}, nextReset: time.Now().Add(20 * time.Minute)}

	rec := proxyRequest(t, poolHandler(pool, upstream.URL), responsesPath, responsesBody, workspaceContext())

	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.InDelta(t, 1200, atoi(rec.Header().Get("Retry-After")), 5)
	assert.JSONEq(t, `{"error":{"type":"usage_limit_reached","message":"Every connected account is at its usage limit."}}`, rec.Body.String())
	assert.Empty(t, calls, "no provider call and no platform fallback")
}

func TestProviderPool_ReconnectAndRefusedCredentials(t *testing.T) {
	var calls []providerCall
	unauthorized := func(w http.ResponseWriter) { w.WriteHeader(http.StatusUnauthorized) }
	upstream := accountUpstream(t, &calls, map[string]func(http.ResponseWriter){"codex-a": unauthorized, "oauth-token": unauthorized})
	pool := &fakePool{pooled: true, accounts: codexAccounts("a"), limited: map[string]time.Time{}, refreshOK: true}

	rec := proxyRequest(t, poolHandler(pool, upstream.URL), responsesPath, responsesBody, workspaceContext())

	assert.Equal(t, []string{"a"}, pool.rejected, "a refused token without a refresh token needs a reconnect")
	assert.Empty(t, pool.refreshed, "nothing to refresh")
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code, "every account was tried for this call")

	codex := services.ResolvedProviderConnection{ConnectionID: "o", Provider: "codex", Kind: "oauth", AccessToken: "oauth-token", AccountID: "acct-o", HasRefreshToken: true}
	pool = &fakePool{pooled: true, accounts: []services.ResolvedProviderConnection{codex}, limited: map[string]time.Time{}, refreshOK: true}
	rec = proxyRequest(t, poolHandler(pool, upstream.URL), responsesPath, responsesBody, workspaceContext())
	assert.Equal(t, []string{"o"}, pool.refreshed, "a refused OAuth token is refreshed once and retried")
	assert.Equal(t, []string{"o"}, pool.rejected, "an OAuth token refused again after its refresh needs a reconnect")
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)

	// A refresh that fixes the token serves the same request.
	calls = nil
	fixed := accountUpstream(t, &calls, map[string]func(http.ResponseWriter){"oauth-token": unauthorized})
	single := &fakePool{pooled: true, limited: map[string]time.Time{}, refreshOK: true, accounts: []services.ResolvedProviderConnection{codex}}
	h := poolHandler(single, fixed.URL)
	single.onRefresh = func() { single.accounts[0].AccessToken = "fresh-token" }
	rec = proxyRequest(t, h, responsesPath, responsesBody, workspaceContext())
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, single.rejected)

	pool = &fakePool{pooled: true, reconnect: true, limited: map[string]time.Time{}}
	rec = proxyRequest(t, poolHandler(pool, upstream.URL), responsesPath, responsesBody, workspaceContext())
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Body.String(), "authentication_error")
}

func TestProviderPool_ChatGPTAccountsAndPaths(t *testing.T) {
	var calls []providerCall
	upstream := accountUpstream(t, &calls, map[string]func(http.ResponseWriter){
		"codex-a": func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":{"type":"usage_limit_reached","resets_in_seconds":7200}}`)
		},
	})
	pool := &fakePool{pooled: true, limited: map[string]time.Time{}, accounts: codexAccounts("a", "b")}
	h := poolHandler(pool, upstream.URL)

	rec := proxyRequest(t, h, responsesPath, `{"model":"gpt-6-luna","stream":true,"input":[]}`, workspaceContext())

	require.Equal(t, http.StatusOK, rec.Code)
	require.Len(t, calls, 2)
	assert.Equal(t, "/codex/responses", calls[1].path)
	assert.Equal(t, "Bearer codex-b", calls[1].auth)
	assert.Equal(t, "acct-b", calls[1].account)
	assert.WithinDuration(t, time.Now().Add(2*time.Hour), pool.limited["a"], time.Minute)

	calls = nil
	rec = proxyRequest(t, h, "/provider-pool/chatgpt/backend-api/accounts", `{"model":"x"}`, workspaceContext())
	assert.Equal(t, http.StatusNotFound, rec.Code, "only the inference path is served with an account")
	rec = proxyRequest(t, h, "/provider-pool/claude/v1/messages", `{"model":"x"}`, workspaceContext())
	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.JSONEq(t, `{"error":{"type":"not_found_error","message":"Unknown provider."}}`, rec.Body.String())
	assert.Empty(t, calls)
}

func claudeKeys(ids ...string) []services.ResolvedProviderConnection {
	var out []services.ResolvedProviderConnection
	for _, id := range ids {
		out = append(out, services.ResolvedProviderConnection{ConnectionID: id, Provider: "claude", Kind: "api_key", AccessToken: "sk-ant-api03-" + id})
	}
	return out
}

// #2792: a connected Anthropic API key serves the anthropic route, signed as
// x-api-key; the pool credential never reaches Anthropic.
func TestProviderPool_AnthropicAPIKeys(t *testing.T) {
	var calls []providerCall
	upstream := accountUpstream(t, &calls, map[string]func(http.ResponseWriter){
		"sk-ant-api03-a": func(w http.ResponseWriter) {
			w.Header().Set("Retry-After", "120")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}`)
		},
		"sk-ant-api03-b": func(w http.ResponseWriter) { w.WriteHeader(http.StatusUnauthorized) },
		"sk-ant-api03-c": func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"type":"message","content":[]}`)
		},
	})
	pool := &fakePool{pooled: true, limited: map[string]time.Time{}, accounts: claudeKeys("a", "b", "c")}
	h := &ProviderPoolHandler{Pool: pool, Scopes: fakeScopes{ok: true}, Upstreams: map[string]string{"anthropic": upstream.URL}}

	req := httptest.NewRequest(http.MethodPost, "/provider-pool/anthropic/v1/messages", strings.NewReader(`{"model":"claude-sonnet-4-6","messages":[]}`)).WithContext(workspaceContext())
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", "smithers_pooltoken")
	req.Header.Set("Anthropic-Version", "2023-06-01")
	req.Header.Add("Anthropic-Beta", "context-1m-2025-08-07")
	req.Header.Add("Anthropic-Beta", "fine-grained-tool-streaming-2025-05-14")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.JSONEq(t, `{"type":"message","content":[]}`, rec.Body.String())
	require.Len(t, calls, 3, "a limited key and a refused key each hand the call to the next")
	for i, id := range []string{"a", "b", "c"} {
		assert.Equal(t, "/v1/messages", calls[i].path)
		assert.Equal(t, "sk-ant-api03-"+id, calls[i].apiKey)
		assert.Empty(t, calls[i].auth, "no bearer reaches Anthropic")
		assert.Empty(t, calls[i].account)
		assert.Equal(t, "2023-06-01", calls[i].version)
		assert.Equal(t, []string{"context-1m-2025-08-07", "fine-grained-tool-streaming-2025-05-14"}, calls[i].betas, "every repeated beta header reaches Anthropic")
		assert.Equal(t, "claude-sonnet-4-6", calls[i].body["model"])
	}
	assert.WithinDuration(t, time.Now().Add(2*time.Minute), pool.limited["a"], 10*time.Second)
	assert.Equal(t, []string{"b"}, pool.rejected, "an API key refused once needs a new key")
	assert.Empty(t, pool.refreshed, "an API key has nothing to refresh")

	calls = nil
	rec = proxyRequest(t, h, "/provider-pool/anthropic/v1/complete", `{"model":"x"}`, workspaceContext())
	assert.Equal(t, http.StatusNotFound, rec.Code, "only the Messages path is served with a key")
	assert.Empty(t, calls)
}

func TestProviderPool_RefusesWithoutAWorkspaceCredentialOrAPool(t *testing.T) {
	var calls []providerCall
	upstream := accountUpstream(t, &calls, nil)
	pool := &fakePool{pooled: true, accounts: codexAccounts("a"), limited: map[string]time.Time{}}
	h := poolHandler(pool, upstream.URL)
	h.Scopes = fakeScopes{ok: false}
	rec := proxyRequest(t, h, responsesPath, responsesBody, workspaceContext())
	assert.Equal(t, http.StatusForbidden, rec.Code, "a credential not bound to a workspace never spends an account")

	h = poolHandler(&fakePool{limited: map[string]time.Time{}}, upstream.URL)
	rec = proxyRequest(t, h, responsesPath, responsesBody, workspaceContext())
	assert.Equal(t, http.StatusNotFound, rec.Code, "no connected accounts: nothing to serve, no platform fallback")
	assert.Empty(t, calls)

	var via string
	userAuth := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { via = "user"; next.ServeHTTP(w, r) })
	}
	auth := func(next http.Handler) http.Handler { return ProviderPoolAuth(userAuth)(next) }
	rec = httptest.NewRecorder()
	auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Empty(t, r.Header.Get("Cookie"))
	})).ServeHTTP(rec, func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, responsesPath, nil)
		req.Header.Set("Authorization", "Bearer smithers_pooltoken")
		req.Header.Set("Cookie", "session=abc")
		return req
	}())
	assert.Equal(t, "user", via)
	via = ""
	rec = httptest.NewRecorder()
	auth(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).ServeHTTP(rec, func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, responsesPath, nil)
		req.Header.Set("Authorization", "Bearer smithers_flowhost_binding.mac")
		return req
	}())
	assert.Empty(t, via, "a managed host's model credential is verified by the scope, not the user auth")
	rec = httptest.NewRecorder()
	auth(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("a cookie alone never authenticates") })).
		ServeHTTP(rec, func() *http.Request {
			req := httptest.NewRequest(http.MethodPost, responsesPath, nil)
			req.Header.Set("Cookie", "session=abc")
			return req
		}())
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	// An Anthropic Messages client sends the pool key as x-api-key; the user
	// auth reads it as the bearer it is, and it goes no further.
	via = ""
	rec = httptest.NewRecorder()
	auth(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer smithers_pooltoken", r.Header.Get("Authorization"))
		assert.Empty(t, r.Header.Get("X-Api-Key"))
	})).ServeHTTP(rec, func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/provider-pool/anthropic/v1/messages", nil)
		req.Header.Set("X-Api-Key", "smithers_pooltoken")
		return req
	}())
	assert.Equal(t, "user", via)
}

func TestProviderPool_RoutesListsProvidersWithAccountsNow(t *testing.T) {
	claude := services.ResolvedProviderConnection{ConnectionID: "k", Provider: "claude", Kind: "api_key", AccessToken: "sk-ant-api03-k"}
	pool := &fakePool{pooled: true, limited: map[string]time.Time{}, accounts: []services.ResolvedProviderConnection{claude}}
	h := poolHandler(pool, "")
	get := func(ctx context.Context) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/provider-pool/routes", nil).WithContext(ctx)
		req.Header.Set("Authorization", "Bearer smithers_pooltoken")
		h.ServeHTTP(rec, req)
		return rec
	}
	rec := get(workspaceContext())
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"routes":["anthropic"]}`, rec.Body.String(), "a connected Anthropic API key serves the anthropic route (#2792)")

	// The first Codex account, connected while the guest runs, is listed on
	// the next ask: no restart.
	pool.mu.Lock()
	pool.accounts = append(pool.accounts, codexAccounts("c")...)
	pool.mu.Unlock()
	assert.Equal(t, `{"routes":["anthropic","chatgpt"]}`+"\n", get(workspaceContext()).Body.String(), "routes are listed in order")

	h.Scopes = fakeScopes{ok: false}
	assert.Equal(t, http.StatusForbidden, get(workspaceContext()).Code)
}

func TestProviderPool_StreamedLimitParksTheAccount(t *testing.T) {
	var calls []providerCall
	stream := "event: error\n" + `data: {"type":"error","error":{"type":"usage_limit_reached","message":"limit"}}` + "\n\n"
	upstream := accountUpstream(t, &calls, map[string]func(http.ResponseWriter){
		"codex-a": func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, stream)
		},
	})
	pool := &fakePool{pooled: true, accounts: codexAccounts("a"), limited: map[string]time.Time{}}

	rec := proxyRequest(t, poolHandler(pool, upstream.URL), responsesPath, responsesBody, workspaceContext())

	assert.Equal(t, stream, rec.Body.String(), "output already sent is never retried")
	assert.Contains(t, pool.limited, "a")
}

func TestProviderPool_NeverFollowsARedirectWithAnAccountCredential(t *testing.T) {
	var leaked string
	elsewhere := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { leaked = r.Header.Get("Authorization") }))
	t.Cleanup(elsewhere.Close)
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirect.Close)
	pool := &fakePool{pooled: true, accounts: codexAccounts("a"), limited: map[string]time.Time{}}

	proxyRequest(t, poolHandler(pool, redirect.URL), responsesPath, responsesBody, workspaceContext())
	assert.Empty(t, leaked)
}

func TestModelPoolLimitReset(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	h := http.Header{}
	assert.Equal(t, now.Add(5*time.Minute), modelPoolLimitReset(h, nil, now), "unknown: a short default")
	h.Set("Retry-After", "90")
	assert.Equal(t, now.Add(90*time.Second), modelPoolLimitReset(h, nil, now))
	assert.Equal(t, time.Unix(1_800_003_600, 0), modelPoolLimitReset(h, []byte(`{"error":{"resets_at":1800003600}}`), now), "the body's reset wins")
	assert.Equal(t, now.Add(30*time.Second), modelPoolLimitReset(http.Header{"Retry-After": {"1"}}, nil, now), "clamped up")
	assert.Equal(t, now.Add(7*24*time.Hour), modelPoolLimitReset(nil, []byte(`{"error":{"resets_in_seconds":99999999}}`), now), "clamped down")
}

func atoi(value string) int {
	n := 0
	for _, c := range value {
		n = n*10 + int(c-'0')
	}
	return n
}

type fakePoolUses struct {
	mu   sync.Mutex
	uses []string
}

func (u *fakePoolUses) RecordWorkspaceProviderUse(_ context.Context, workspaceID, connectionID, model string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.uses = append(u.uses, workspaceID+"|"+connectionID+"|"+model)
	return nil
}

func TestProviderPool_RecordsTheAccountThatTookTheCall(t *testing.T) {
	var calls []providerCall
	upstream := accountUpstream(t, &calls, map[string]func(http.ResponseWriter){
		"codex-a": usageLimited,
	})
	pool := &fakePool{pooled: true, accounts: codexAccounts("a", "b"), limited: map[string]time.Time{}}
	uses := &fakePoolUses{}
	h := poolHandler(pool, upstream.URL)
	h.Uses = uses

	rec := proxyRequest(t, h, responsesPath, responsesBody, workspaceContext())
	require.Equal(t, http.StatusOK, rec.Code)
	h.recorded.Wait()
	assert.Equal(t, []string{"ws1|b|gpt-6-luna"}, uses.uses, "only the account that answered is recorded, with the model the call named")

	// A model field that is not a model id is not recorded as one.
	rec = proxyRequest(t, h, responsesPath, `{"model":"sk-proj secret\n","input":[]}`, workspaceContext())
	require.Equal(t, http.StatusOK, rec.Code)
	h.recorded.Wait()
	require.Len(t, uses.uses, 2)
	assert.Equal(t, "ws1|b|", uses.uses[1])

	// Nothing is recorded when no account takes the call.
	pool.limited["b"] = time.Now().Add(time.Hour)
	pool.nextReset = time.Now().Add(time.Hour)
	rec = proxyRequest(t, h, responsesPath, responsesBody, workspaceContext())
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	h.recorded.Wait()
	assert.Len(t, uses.uses, 2)
}

func TestProviderPool_ARefusedCallIsNotCountedAndARecordNeverHoldsTheCall(t *testing.T) {
	var calls []providerCall
	upstream := accountUpstream(t, &calls, map[string]func(http.ResponseWriter){
		"codex-a": func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":{"type":"invalid_request_error","message":"unknown model"}}`)
		},
	})
	release := make(chan struct{})
	uses := &blockingPoolUses{release: release}
	h := poolHandler(&fakePool{pooled: true, accounts: codexAccounts("a"), limited: map[string]time.Time{}}, upstream.URL)
	h.Uses = uses
	rec := proxyRequest(t, h, responsesPath, `{"model":"made-up-model","input":[]}`, workspaceContext())
	require.Equal(t, http.StatusBadRequest, rec.Code, "the provider's refusal reaches the caller")
	h.recorded.Wait()
	assert.Zero(t, uses.count(), "a refused call is not a call the account ran")

	h = poolHandler(&fakePool{pooled: true, accounts: codexAccounts("b"), limited: map[string]time.Time{}}, upstream.URL)
	h.Uses = uses
	rec = proxyRequest(t, h, responsesPath, responsesBody, workspaceContext())
	require.Equal(t, http.StatusOK, rec.Code, "the answer is relayed while its record is still waiting")
	assert.Equal(t, responsesStream, rec.Body.String())
	close(release)
	h.recorded.Wait()
	assert.Equal(t, 1, uses.count())
}

type blockingPoolUses struct {
	release chan struct{}
	mu      sync.Mutex
	n       int
}

func (u *blockingPoolUses) RecordWorkspaceProviderUse(context.Context, string, string, string) error {
	<-u.release
	u.mu.Lock()
	defer u.mu.Unlock()
	u.n++
	return nil
}

func (u *blockingPoolUses) count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.n
}

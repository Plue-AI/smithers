package services

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
	"github.com/stretchr/testify/require"
)

func TestGitHubUserRefusalClassification(t *testing.T) {
	for _, tc := range []struct {
		name, kind string
		status     int
		headers    http.Header
		want       int32
	}{
		{"user-401", "user", 401, nil, 1},
		{"user-403", "user", 403, nil, 1},
		{"secondary-limit", "user", 403, http.Header{"Retry-After": {"60"}}, 0},
		{"primary-limit", "user", 403, http.Header{"X-Ratelimit-Remaining": {"0"}}, 0},
		{"429", "user", 429, nil, 0},
		{"404", "user", 404, nil, 0},
		{"500", "user", 500, nil, 0},
		{"success", "user", 200, nil, 0},
		{"installation", "installation", 401, nil, 0},
		{"app", "app", 403, nil, 0},
		{"unknown", "unknown", 401, nil, 0},
		{"anonymous", "anonymous", 401, nil, 0},
		{"expired-classification", "expired", 403, nil, 0},
		{"no-reclassify-installation", "collision", 401, nil, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := NewGitHubResponseBudgetTracker()
			now := time.Now().UTC()
			b.now = func() time.Time { return now }
			var hints atomic.Int32
			b.userRefused = func() {
				if !b.mu.TryLock() {
					t.Error("callback ran under the budget lock")
					return
				}
				b.mu.Unlock()
				hints.Add(1)
			}
			switch tc.kind {
			case "user", "expired":
				b.registerUserCredential("credential")
			case "installation", "collision":
				b.registerToken("credential", 12, now.Add(time.Hour))
			case "app":
				b.registerAppToken("credential", 21, now.Add(time.Hour))
			}
			if tc.kind == "collision" {
				b.registerUserCredential("credential")
			}
			if tc.kind == "expired" {
				now = now.Add(2 * time.Hour)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				for k, v := range tc.headers {
					w.Header()[k] = v
				}
				w.WriteHeader(tc.status)
			}))
			defer server.Close()
			req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL+"/user/repos", nil)
			require.NoError(t, err)
			if tc.kind != "anonymous" {
				req.Header.Set("Authorization", "Bearer credential")
			}
			resp, err := b.WrapClient(server.Client()).Do(req)
			require.NoError(t, err)
			resp.Body.Close()
			require.Equal(t, tc.status, resp.StatusCode, "classification preserves caller response")
			require.Equal(t, tc.want, hints.Load())
		})
	}
}

func TestUserGitHubRefusalQueuesPermissionRecheckPostgres(t *testing.T) {
	for _, tc := range []struct {
		name, caller, permission string
		status                   int
		permissionFails          bool
	}{
		{"list-401-confirms-loss", "list", "read", 401, false},
		{"list-403-retains-write", "list", "write", 403, false},
		{"proxy-401-confirms-loss", "proxy", "read", 401, false},
		{"proxy-403-retains-write", "proxy", "write", 403, false},
		{"installation-refusal-is-not-member-loss", "list", "read", 401, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var reads atomic.Int32
			f := newPermissionPollFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if reads.Add(1) == 1 {
					fmt.Fprint(w, `{"permission":"write"}`)
					return
				}
				if tc.permissionFails {
					w.WriteHeader(403)
					return
				}
				fmt.Fprintf(w, `{"permission":%q}`, tc.permission)
			}, func(w http.ResponseWriter, r *http.Request) {
				require.Contains(t, []string{"/user/repos", "/repos/factory/app/pulls"}, r.URL.Path)
				require.Equal(t, "Bearer user-access", r.Header.Get("Authorization"))
				w.WriteHeader(tc.status)
			})
			ctx := t.Context()
			require.NoError(t, f.m.PollPermissions(ctx))
			f.clock.Add(1)
			q := db.New(f.m.Pool)
			cfg := config.AuthConfig{SessionSecret: "recheck-session"}
			sealed, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey(cfg.SessionSecret), []byte("user-access"))
			require.NoError(t, err)
			_, err = f.m.Pool.Exec(ctx, `INSERT INTO oauth_accounts(user_id,provider,provider_user_id,access_token_encrypted) VALUES($1,'github','77',$2)`, f.userID, sealed)
			require.NoError(t, err)
			auth := NewAuthService(q, cfg, nil, nil)
			auth.Members = f.m
			users := NewGitHubUserReposService(q, auth, WithGitHubUserReposTokenRefresher(auth), WithGitHubUserReposHTTPClient(f.m.Budget.WrapClient(http.DefaultClient)))
			if tc.caller == "list" {
				_, err = users.ListAuthenticatedUserGitHubRepos(ctx, f.userID, nil)
				require.Error(t, err)
			} else {
				proxy := NewGitHubProxyService(importedSourceNotCovered(), WithGitHubProxyUserTokens(users), WithGitHubProxyBudgetTracker(f.m.Budget), WithGitHubProxyHTTPClient(f.m.Budget.WrapClient(http.DefaultClient)))
				response, err := proxy.ProxyRepoRequest(mirrorContext(), &db.User{ID: f.userID}, "factory", "app", GitHubProxyRequest{Method: "GET", Path: "/repos/factory/app/pulls"})
				require.True(t, response != nil || err != nil, "proxy preserves a refusal result")
				if response != nil {
					response.Body.Close()
					require.Equal(t, tc.status, response.StatusCode)
				}
				if tc.status == 403 {
					require.NoError(t, err)
				} // A raw refusal remains visible to proxy clients.
			}
			require.EqualValues(t, 1, f.wakes.Load())
			require.EqualValues(t, 1, reads.Load(), "caller does not await or perform the permission recheck")
			f.assertRoster(t, false, 1)
			err = f.m.PollPermissions(ctx)
			if tc.permissionFails {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			if tc.permission == "read" && !tc.permissionFails {
				f.assertRoster(t, true, 0)
			} else {
				f.assertRoster(t, false, 1)
			}
			require.EqualValues(t, 2, reads.Load(), "refusal makes the existing worker due before the hourly cadence")
			require.EqualValues(t, 1, f.wakes.Load(), "installation failure must not recursively request another recheck")
		})
	}
}

func TestRefreshedGitHubUserCredentialRetainsRecheckClassification(t *testing.T) {
	q := &mockAuthQuerier{}
	cfg := defaultAuthConfig()
	sealed, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey(cfg.SessionSecret), []byte("refresh"))
	require.NoError(t, err)
	account := db.OauthAccount{UserID: 42, Provider: "github", ProviderUserID: "77", RefreshTokenEncrypted: sealed}
	q.getOAuthAccountByProviderUserIDFn = func(context.Context, db.GetOAuthAccountByProviderUserIDParams) (db.OauthAccount, error) {
		return account, nil
	}
	q.upsertOAuthAccountFn = func(context.Context, db.UpsertOAuthAccountParams) (db.OauthAccount, error) {
		return db.OauthAccount{}, nil
	}
	auth := NewAuthService(q, cfg, nil, mockGitHubClient{refreshTokenFn: func(context.Context, string) (GitHubTokenResult, error) {
		return GitHubTokenResult{AccessToken: "rotated", RefreshToken: "rotated-refresh"}, nil
	}})
	b := NewGitHubResponseBudgetTracker()
	auth.Members = &Members{Budget: b}
	var hints atomic.Int32
	b.userRefused = func() { hints.Add(1) }
	token, err := auth.RefreshUserGitHubToken(t.Context(), account)
	require.NoError(t, err)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer rotated", r.Header.Get("Authorization"))
		w.WriteHeader(403)
	}))
	defer server.Close()
	req, err := http.NewRequestWithContext(t.Context(), "GET", server.URL+"/user/repos", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := b.WrapClient(server.Client()).Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.EqualValues(t, 1, hints.Load())
}

func TestGitHubUserClassificationPreservesExistingBudget(t *testing.T) {
	b := NewGitHubResponseBudgetTracker()
	var requests, hints atomic.Int32
	b.userRefused = func() { hints.Add(1) }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("X-RateLimit-Limit", "100")
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", fmt.Sprint(time.Now().Add(time.Hour).Unix()))
		w.WriteHeader(403)
	}))
	defer server.Close()
	client := b.WrapClient(server.Client())
	request := func() int {
		req, err := http.NewRequestWithContext(t.Context(), "GET", server.URL+"/user/repos", nil)
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer stored-user")
		response, err := client.Do(req)
		require.NoError(t, err)
		response.Body.Close()
		return response.StatusCode
	}
	require.Equal(t, 403, request())
	b.registerUserCredential("stored-user")
	require.Equal(t, 429, request(), "classification does not reset the existing credential budget")
	require.EqualValues(t, 1, requests.Load())
	require.Zero(t, hints.Load(), "rate-limit responses are not member permission refusals")
}

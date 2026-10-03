package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestNewGitHubClient_UsesConfiguredBaseURLsWhenProvided(t *testing.T) {
	t.Parallel()

	client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "http://mock-github:8081", "http://mock-github:8082")
	assert.Equal(t, "http://mock-github:8081", client.oauthBaseURL)
	assert.Equal(t, "http://mock-github:8082", client.apiBaseURL)
}

func TestNewGitHubClient_UsesDefaultBaseURLsWhenConfigMissing(t *testing.T) {
	t.Parallel()

	client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "   ", "")
	assert.Equal(t, "https://github.com", client.oauthBaseURL)
	assert.Equal(t, "https://api.github.com", client.apiBaseURL)
}

func TestGitHubClient_AuthorizationURL(t *testing.T) {
	t.Parallel()

	client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "https://github.example", "")
	authURL, err := client.AuthorizationURL(context.Background(), "state-123")
	require.NoError(t, err)
	parsed, err := url.Parse(authURL)
	require.NoError(t, err)
	assert.Equal(t, "https", parsed.Scheme)
	assert.Equal(t, "github.example", parsed.Host)
	assert.Equal(t, "/login/oauth/authorize", parsed.Path)
	assert.Equal(t, "client-id", parsed.Query().Get("client_id"))
	assert.Equal(t, "http://localhost:4000/api/auth/github/callback", parsed.Query().Get("redirect_uri"))
	assert.Equal(t, "read:user user:email repo", parsed.Query().Get("scope"))
	assert.Equal(t, "state-123", parsed.Query().Get("state"))
}

func TestGitHubClient_ExchangeCode(t *testing.T) {
	t.Parallel()

	t.Run("success", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, http.MethodPost, r.Method)
			require.Equal(t, "/login/oauth/access_token", r.URL.Path)
			require.Equal(t, "application/json", r.Header.Get("Accept"))
			require.NoError(t, r.ParseForm())
			assert.Equal(t, "client-id", r.Form.Get("client_id"))
			assert.Equal(t, "client-secret", r.Form.Get("client_secret"))
			assert.Equal(t, "code-123", r.Form.Get("code"))
			assert.Equal(t, "authorization_code", r.Form.Get("grant_type"))

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "token-123",
				"token_type":   "bearer",
			})
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.oauthBaseURL = srv.URL

		result, err := client.ExchangeCode(context.Background(), "code-123")
		require.NoError(t, err)
		assert.Equal(t, "token-123", result.AccessToken)
	})

	t.Run("non-2xx returns error", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "upstream failure", http.StatusBadGateway)
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.oauthBaseURL = srv.URL

		_, err := client.ExchangeCode(context.Background(), "code-123")
		require.Error(t, err)
	})

	t.Run("malformed non-json response returns error", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte("not-json"))
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.oauthBaseURL = srv.URL

		_, err := client.ExchangeCode(context.Background(), "code-123")
		require.Error(t, err)
	})

	t.Run("empty token payload returns error", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "   ",
			})
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.oauthBaseURL = srv.URL

		_, err := client.ExchangeCode(context.Background(), "code-123")
		require.Error(t, err)
	})

	t.Run("non-2xx with error_description in JSON body", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error":             "bad_verification_code",
				"error_description": "The code passed is incorrect or expired.",
			})
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.oauthBaseURL = srv.URL

		_, err := client.ExchangeCode(context.Background(), "code-123")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "The code passed is incorrect or expired.")
	})

	t.Run("non-2xx with error field only in JSON body", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": "bad_verification_code",
			})
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.oauthBaseURL = srv.URL

		_, err := client.ExchangeCode(context.Background(), "code-123")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "bad_verification_code")
	})

	t.Run("non-2xx with empty JSON body returns status code error", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]any{})
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.oauthBaseURL = srv.URL

		_, err := client.ExchangeCode(context.Background(), "code-123")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "403")
	})

	t.Run("canceled context returns request creation error", func(t *testing.T) {
		t.Parallel()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.oauthBaseURL = "http://localhost:1" // unreachable

		ctx, cancel := context.WithCancel(context.Background())
		cancel() // cancel immediately

		_, err := client.ExchangeCode(ctx, "code-123")
		require.Error(t, err)
	})

	t.Run("invalid base URL returns request creation error", func(t *testing.T) {
		t.Parallel()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.oauthBaseURL = "://invalid\x7f" // invalid URL

		_, err := client.ExchangeCode(context.Background(), "code-123")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "create github oauth exchange request")
	})
}

func TestGitHubClient_FetchUser(t *testing.T) {
	t.Parallel()

	t.Run("success", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, http.MethodGet, r.Method)
			require.Equal(t, "/user", r.URL.Path)
			require.Equal(t, "Bearer access-token", r.Header.Get("Authorization"))
			require.Equal(t, "application/vnd.github+json", r.Header.Get("Accept"))
			require.Equal(t, "smithers-plue", r.Header.Get("User-Agent"))
			require.Equal(t, "2022-11-28", r.Header.Get("X-GitHub-Api-Version"))

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":    101,
				"login": "octocat",
				"name":  "The Octocat",
			})
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.apiBaseURL = srv.URL

		profile, err := client.FetchUser(context.Background(), "access-token")
		require.NoError(t, err)
		assert.Equal(t, int64(101), profile.ID)
		assert.Equal(t, "octocat", profile.Login)
		assert.Equal(t, "The Octocat", profile.Name)
	})

	t.Run("non-2xx returns error", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "failure", http.StatusUnauthorized)
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.apiBaseURL = srv.URL

		_, err := client.FetchUser(context.Background(), "access-token")
		require.Error(t, err)
		require.ErrorIs(t, err, services.ErrGitHubTokenRejected, "a 401 must be typed so the caller answers 401, not 500")
	})

	t.Run("malformed non-json response returns error", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte("not-json"))
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.apiBaseURL = srv.URL

		_, err := client.FetchUser(context.Background(), "access-token")
		require.Error(t, err)
	})

	t.Run("missing required fields returns error", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 0,
			})
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.apiBaseURL = srv.URL

		_, err := client.FetchUser(context.Background(), "access-token")
		require.Error(t, err)
	})

	t.Run("canceled context returns error", func(t *testing.T) {
		t.Parallel()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.apiBaseURL = "http://localhost:1"

		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		_, err := client.FetchUser(ctx, "access-token")
		require.Error(t, err)
	})

	t.Run("invalid base URL returns request creation error", func(t *testing.T) {
		t.Parallel()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.apiBaseURL = "://invalid\x7f"

		_, err := client.FetchUser(context.Background(), "access-token")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "create github user request")
	})
}

func TestGitHubClient_FetchEmails(t *testing.T) {
	t.Parallel()

	t.Run("success", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, http.MethodGet, r.Method)
			require.Equal(t, "/user/emails", r.URL.Path)
			require.Equal(t, "Bearer access-token", r.Header.Get("Authorization"))
			require.Equal(t, "application/vnd.github+json", r.Header.Get("Accept"))
			require.Equal(t, "smithers-plue", r.Header.Get("User-Agent"))
			require.Equal(t, "2022-11-28", r.Header.Get("X-GitHub-Api-Version"))

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"email": "octo@example.com", "primary": true, "verified": true},
				{"email": "alt@example.com", "primary": false, "verified": true},
			})
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.apiBaseURL = srv.URL

		emails, err := client.FetchEmails(context.Background(), "access-token")
		require.NoError(t, err)
		require.Len(t, emails, 2)
		assert.Equal(t, "octo@example.com", emails[0].Email)
		assert.True(t, emails[0].Primary)
		assert.True(t, emails[0].Verified)
	})

	t.Run("non-2xx returns error", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "failure", http.StatusInternalServerError)
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.apiBaseURL = srv.URL

		_, err := client.FetchEmails(context.Background(), "access-token")
		require.Error(t, err)
		require.NotErrorIs(t, err, services.ErrGitHubTokenRejected, "a 5xx is not a rejected credential")
	})

	t.Run("403 is a typed rejected-token error", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "forbidden", http.StatusForbidden)
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.apiBaseURL = srv.URL

		_, err := client.FetchEmails(context.Background(), "access-token")
		require.ErrorIs(t, err, services.ErrGitHubTokenRejected)
	})

	t.Run("malformed non-json response returns error", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte("not-json"))
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.apiBaseURL = srv.URL

		_, err := client.FetchEmails(context.Background(), "access-token")
		require.Error(t, err)
	})

	t.Run("canceled context returns error", func(t *testing.T) {
		t.Parallel()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.apiBaseURL = "http://localhost:1"

		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		_, err := client.FetchEmails(ctx, "access-token")
		require.Error(t, err)
	})

	t.Run("invalid base URL returns request creation error", func(t *testing.T) {
		t.Parallel()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.apiBaseURL = "://invalid\x7f"

		_, err := client.FetchEmails(context.Background(), "access-token")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "create github emails request")
	})
}

func TestGitHubClient_RefreshToken(t *testing.T) {
	t.Parallel()

	t.Run("success rotates access and refresh tokens", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, http.MethodPost, r.Method)
			require.Equal(t, "/login/oauth/access_token", r.URL.Path)
			require.Equal(t, "application/json", r.Header.Get("Accept"))
			require.NoError(t, r.ParseForm())
			assert.Equal(t, "client-id", r.Form.Get("client_id"))
			assert.Equal(t, "client-secret", r.Form.Get("client_secret"))
			assert.Equal(t, "refresh_token", r.Form.Get("grant_type"))
			assert.Equal(t, "ghr_old", r.Form.Get("refresh_token"))

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":             "gho_new",
				"refresh_token":            "ghr_new",
				"expires_in":               28800,
				"refresh_token_expires_in": 15897600,
				"token_type":               "bearer",
			})
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.oauthBaseURL = srv.URL

		result, err := client.RefreshToken(context.Background(), "ghr_old")
		require.NoError(t, err)
		assert.Equal(t, "gho_new", result.AccessToken)
		assert.Equal(t, "ghr_new", result.RefreshToken)
		assert.Equal(t, int64(28800), result.ExpiresIn)
		assert.Equal(t, int64(15897600), result.RefreshTokenExpiresIn)
	})

	t.Run("200 with error body (bad refresh token) returns error", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error":             "bad_refresh_token",
				"error_description": "The refresh token passed is incorrect or expired.",
			})
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.oauthBaseURL = srv.URL

		_, err := client.RefreshToken(context.Background(), "ghr_bad")
		require.Error(t, err)
		assert.ErrorIs(t, err, services.ErrGitHubRefreshTokenInvalid)
		assert.Contains(t, err.Error(), "The refresh token passed is incorrect or expired.")
	})

	t.Run("non-2xx returns error", func(t *testing.T) {
		t.Parallel()

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "upstream failure", http.StatusBadGateway)
		}))
		defer srv.Close()

		client := NewGitHubClient(&testOAuthCredentials{id: "client-id", secret: "client-secret"}, "http://localhost:4000/api/auth/github/callback", "", "")
		client.oauthBaseURL = srv.URL

		_, err := client.RefreshToken(context.Background(), "ghr_old")
		require.Error(t, err)
	})
}

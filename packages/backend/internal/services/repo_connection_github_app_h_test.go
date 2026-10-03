package services

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type repoConnectionGitHubAppHFailReader struct{}

func (repoConnectionGitHubAppHFailReader) Read([]byte) (int, error) {
	return 0, errors.New("random failed")
}

func repoConnectionGitHubAppHPrivateKeyPEM(t *testing.T) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	return string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
}

func repoConnectionGitHubAppHTokenService(t *testing.T, installationID int64, serverURL string) *RepoConnectionService {
	t.Helper()
	invalidateCachedInstallationToken(installationID)
	t.Cleanup(func() { invalidateCachedInstallationToken(installationID) })
	setTestCallerCredentials(t, "ID", "12345")
	setTestCallerCredentials(t, "PEM", repoConnectionGitHubAppHPrivateKeyPEM(t))
	t.Setenv(envGitHubAppAPIBaseURL, serverURL)
	return newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				*(dest[0].(*int64)) = installationID
				return nil
			}}
		},
	})
}

func TestRepoConnectionGitHubApp_H_StatusAndLookupErrors(t *testing.T) {
	ctx := context.Background()

	_, err := newTestRepoConnectionService(t, &mockRepoConnectionDB{}).GetGitHubAppStatus(ctx, 0, "owner", "repo")
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))

	_, err = newTestRepoConnectionService(t, &mockRepoConnectionDB{}).GetGitHubAppStatus(ctx, 1, "", "repo")
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	svc := newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(...any) error { return errors.New("query failed") }}
		},
	})
	_, err = svc.GetGitHubAppStatus(ctx, 1, "owner", "repo")
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	queries := 0
	svc = newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			queries++
			if queries == 1 {
				return mockRepoConnectionRow{scanFn: func(...any) error { return pgx.ErrNoRows }}
			}
			return mockRepoConnectionRow{scanFn: func(...any) error { return errors.New("fallback failed") }}
		},
	})
	_, err = svc.GetGitHubAppStatus(ctx, 1, "owner", "repo")
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				if installationID, ok := dest[0].(*int64); ok {
					*installationID = 0
				}
				return nil
			}}
		},
	})
	status, err := svc.GetGitHubAppStatus(ctx, 1, "owner", "repo")
	require.NoError(t, err)
	assert.False(t, status.GitHubAppInstalled)

	svc = newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				*(dest[0].(*int64)) = 77
				return nil
			}}
		},
	})
	status, err = svc.GetGitHubAppStatus(ctx, 1, "owner", "repo")
	require.NoError(t, err)
	assert.True(t, status.GitHubAppInstalled)
	assert.Equal(t, int64(77), status.InstallationID)
	assert.Equal(t, GitHubInstallationHourlyBudget, status.GitHubRateLimitLimit)
	assert.Equal(t, GitHubInstallationHourlyBudget, status.GitHubRateLimitRemaining)
	_, parseResetErr := time.Parse(time.RFC3339, status.GitHubRateLimitReset)
	require.NoError(t, parseResetErr)

	tracker := NewBudgetTrackerWithLimits(2, time.Hour)
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	tracker.now = func() time.Time { return now }
	allowed, _ := tracker.Allow(78)
	require.True(t, allowed)
	svc = newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				*(dest[0].(*int64)) = 78
				return nil
			}}
		},
	})
	svc.SetGitHubBudgetTracker(tracker)
	status, err = svc.GetGitHubAppStatus(ctx, 1, "owner", "repo")
	require.NoError(t, err)
	assert.Equal(t, 2, status.GitHubRateLimitLimit)
	assert.Equal(t, 1, status.GitHubRateLimitRemaining)
	assert.Equal(t, now.Add(30*time.Minute).Format(time.RFC3339), status.GitHubRateLimitReset)

	queries = 0
	svc = newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			queries++
			if queries == 1 {
				return mockRepoConnectionRow{scanFn: func(...any) error { return pgx.ErrNoRows }}
			}
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				*(dest[0].(*bool)) = true
				return nil
			}}
		},
	})
	status, err = svc.GetGitHubAppStatus(ctx, 1, "owner", "repo")
	require.NoError(t, err)
	assert.True(t, status.GitHubAppInstalled)
	assert.Zero(t, status.InstallationID)

	queries = 0
	svc = newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			queries++
			return mockRepoConnectionRow{scanFn: func(...any) error { return pgx.ErrNoRows }}
		},
	})
	status, err = svc.GetGitHubAppStatus(ctx, 1, "owner", "repo")
	require.NoError(t, err)
	assert.False(t, status.GitHubAppInstalled)

	id, _, err := svc.lookupGitHubRepository(ctx, 1, 0, "owner", "repo")
	require.NoError(t, err)
	assert.Zero(t, id)

	queries = 0
	svc = newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			queries++
			if queries == 1 {
				return mockRepoConnectionRow{scanFn: func(...any) error { return pgx.ErrNoRows }}
			}
			t.Fatalf("user-scoped installation lookup must not fall back to an unscoped repo query")
			return mockRepoConnectionRow{}
		},
	})
	id, _, err = svc.lookupGitHubRepository(ctx, 1, 0, "owner", "repo")
	require.NoError(t, err)
	assert.Equal(t, 1, queries)
	assert.Zero(t, id)

	svc = newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				*(dest[0].(*int64)) = 88
				return nil
			}}
		},
	})
	id, _, err = svc.GetGitHubRepositoryForRepositoryOwner(ctx, 1, 0, "owner", "repo")
	require.NoError(t, err)
	assert.Equal(t, int64(88), id)

	svc = newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(...any) error { return errors.New("fallback failed") }}
		},
	})
	_, _, err = svc.GetGitHubRepositoryForRepositoryOwner(ctx, 1, 0, "owner", "repo")
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(...any) error { return errors.New("lookup failed") }}
		},
	})
	_, err = svc.CreateGitHubInstallationTokenForUserRepo(ctx, 1, "owner", "repo", testTokenPermissions)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

func TestRepoConnectionGitHubApp_H_CreateTokenHTTPBranches(t *testing.T) {
	ctx := context.Background()

	_, err := newTestRepoConnectionService(t, &mockRepoConnectionDB{}).CreateGitHubInstallationTokenForUserRepo(ctx, 0, "owner", "repo", testTokenPermissions)
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))

	_, err = newTestRepoConnectionService(t, &mockRepoConnectionDB{}).CreateGitHubInstallationTokenForUserRepo(ctx, 1, "", "repo", testTokenPermissions)
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	svc := newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(...any) error { return pgx.ErrNoRows }}
		},
	})
	_, err = svc.CreateGitHubInstallationTokenForUserRepo(ctx, 1, "owner", "repo", testTokenPermissions)
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	setTestCallerCredentials(t, "ID", "42")
	setTestCallerCredentials(t, "PEM", testGitHubAppPrivateKeyPEM(t))
	storeCachedInstallationToken(testTokenKey(8700), 8700, "cached-token", time.Now().Add(time.Hour))
	t.Cleanup(func() { invalidateCachedInstallationToken(8700) })
	svc = newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				*(dest[0].(*int64)) = 8700
				return nil
			}}
		},
	})
	token, err := svc.CreateGitHubInstallationTokenForUserRepo(ctx, 1, "owner", "repo", testTokenPermissions)
	require.NoError(t, err)
	assert.Equal(t, "cached-token", token.Token)

	svc = newTestRepoConnectionService(t, &mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				*(dest[0].(*int64)) = 8701
				return nil
			}}
		},
	})
	setTestCallerCredentials(t, "ID", "")
	setTestCallerCredentials(t, "PEM", "")
	_, err = svc.CreateGitHubInstallationTokenForUserRepo(ctx, 1, "owner", "repo", testTokenPermissions)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	setTestCallerCredentials(t, "ID", "12345")
	setTestCallerCredentials(t, "PEM", repoConnectionGitHubAppHPrivateKeyPEM(t))
	oldReader := rand.Reader
	rand.Reader = repoConnectionGitHubAppHFailReader{}
	_, err = svc.CreateGitHubInstallationTokenForUserRepo(ctx, 1, "owner", "repo", testTokenPermissions)
	rand.Reader = oldReader
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	serverOK := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"token":"ghs_ok","expires_at":"2030-01-01T00:00:00Z"}`))
	}))
	defer serverOK.Close()
	svc = repoConnectionGitHubAppHTokenService(t, 8702, serverOK.URL)
	token, err = svc.CreateGitHubInstallationTokenForUserRepo(ctx, 1, "owner", "repo", testTokenPermissions)
	require.NoError(t, err)
	assert.Equal(t, "ghs_ok", token.Token)

	cases := []struct {
		name         string
		status       int
		body         string
		wantStatus   int
		wantContains string
	}{
		{"forbidden message", http.StatusForbidden, `{"message":"denied"}`, http.StatusForbidden, "github refused the installation token request"},
		{"server fallback", http.StatusInternalServerError, `{}`, http.StatusInternalServerError, "github installation token request was rejected"},
		{"missing token", http.StatusCreated, `{"expires_at":"2026-07-07T15:00:00Z"}`, http.StatusInternalServerError, "github installation token response was invalid"},
		{"invalid expiry", http.StatusCreated, `{"token":"ghs_bad","expires_at":"not-time"}`, http.StatusInternalServerError, "github installation token response was invalid"},
	}
	for i, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()

			svc := repoConnectionGitHubAppHTokenService(t, int64(8800+i), server.URL)
			_, err := svc.CreateGitHubInstallationTokenForUserRepo(ctx, 1, "owner", "repo", testTokenPermissions)
			require.Error(t, err)
			assert.Equal(t, tc.wantStatus, apiStatus(t, err))
			assert.Contains(t, err.Error(), tc.wantContains)
		})
	}

	closed := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	closedURL := closed.URL
	closed.Close()
	svc = repoConnectionGitHubAppHTokenService(t, 8899, closedURL)
	_, err = svc.CreateGitHubInstallationTokenForUserRepo(ctx, 1, "owner", "repo", testTokenPermissions)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = repoConnectionGitHubAppHTokenService(t, 8900, "%")
	_, err = svc.CreateGitHubInstallationTokenForUserRepo(ctx, 1, "owner", "repo", testTokenPermissions)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

func TestRepoConnectionGitHubApp_H_CredentialAndEncodingBranches(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	edKey := ed25519.NewKeyFromSeed(seed)
	der, err := x509.MarshalPKCS8PrivateKey(edKey)
	require.NoError(t, err)
	_, err = parseGitHubAppPrivateKey(string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "must be RSA")

	_, err = parseGitHubAppPrivateKey(string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte("bad-der")})))
	require.Error(t, err)

	_, err = base64URLEncodeJSON(func() {})
	require.Error(t, err)

	t.Setenv(envGitHubAppAPIBaseURL, " ")
	assert.Equal(t, defaultGitHubAPIBaseURL, githubAPIBaseURL())

	t.Setenv(envGitHubAppAPIBaseURL, "https://api.example///")
	assert.Equal(t, "https://api.example", githubAPIBaseURL())

	storeCachedInstallationToken(testTokenKey(9991), 9991, "too-old", time.Now().Add(time.Minute))
	_, ok := getCachedInstallationToken(testTokenKey(9991))
	assert.False(t, ok)
	invalidateCachedInstallationToken(9991)
}

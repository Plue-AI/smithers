package services

import (
	"context"
	"fmt"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestAuthService_StartGitHubOAuth_PersistsState(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 2, 19, 10, 0, 0, 0, time.UTC)
	createCalled := false
	var createdArg db.CreateOAuthStateParams
	stateVerifier := "browser-verifier"

	svc := NewAuthService(&mockAuthQuerier{
		createOAuthStateFn: func(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
			createCalled = true
			createdArg = arg
			return db.OauthState{
				StateKey:  arg.State,
				ExpiresAt: arg.ExpiresAt,
			}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})
	svc.now = func() time.Time { return now }
	svc.generateState = func() string { return "persisted-state" }

	redirectURL, err := svc.StartGitHubOAuth(context.Background(), stateVerifier)
	require.NoError(t, err)
	require.True(t, createCalled, "expected oauth state to be persisted")
	assert.Equal(t, "persisted-state", createdArg.State)
	assert.Equal(t, hashOAuthStateVerifier(stateVerifier), createdArg.ContextHash)
	assert.Equal(t, now.Add(10*time.Minute), createdArg.ExpiresAt)

	parsed, err := url.Parse(redirectURL)
	require.NoError(t, err)
	assert.Equal(t, "persisted-state", parsed.Query().Get("state"))
}

func TestAuthService_StartGitHubOAuth_PersistStateError(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		createOAuthStateFn: func(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
			return db.OauthState{}, fmt.Errorf("insert failed")
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})
	svc.generateState = func() string { return "persisted-state" }

	_, err := svc.StartGitHubOAuth(context.Background(), "browser-verifier")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
}

func TestAuthService_StartGitHubOAuth_EmptyVerifierRejected(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		createOAuthStateFn: func(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
			t.Fatal("oauth state should not be created without verifier")
			return db.OauthState{}, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{})

	_, err := svc.StartGitHubOAuth(context.Background(), "")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 400, apiErr.Status)
}

func TestAuthService_StartGitHubOAuth_UnconfiguredGitHubRejected(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		createOAuthStateFn: func(ctx context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
			t.Fatal("oauth state should not be created when github oauth is unconfigured")
			return db.OauthState{}, nil
		},
	}, config.AuthConfig{
		GitHubRedirectURL: "http://localhost:4000/api/auth/github/callback",
	}, mockKeyAuthVerifier{}, nil)

	_, err := svc.StartGitHubOAuth(context.Background(), "browser-verifier")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
	assert.Contains(t, apiErr.Message, "github oauth is not configured")
}

func TestAuthService_CompleteGitHubOAuth_InvalidStateRejected(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		state         string
		verifier      string
		expectConsume bool
	}{
		{name: "empty", state: "", verifier: "browser-verifier", expectConsume: false},
		{name: "missing verifier", state: "issued-state", verifier: "", expectConsume: false},
		{name: "unknown", state: "unknown-state", verifier: "browser-verifier", expectConsume: true},
		{name: "expired", state: "expired-state", verifier: "browser-verifier", expectConsume: true},
		{name: "reused", state: "reused-state", verifier: "browser-verifier", expectConsume: true},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			consumeCalled := false
			exchangeCalled := false

			svc := NewAuthService(&mockAuthQuerier{
				consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
					consumeCalled = true
					if !tc.expectConsume {
						t.Fatalf("unexpected consume for state %q", arg.State)
					}
					assert.Equal(t, tc.state, arg.State)
					assert.Equal(t, hashOAuthStateVerifier(tc.verifier), arg.ContextHash)
					return 0, nil
				},
			}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
				exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
					exchangeCalled = true
					t.Fatalf("exchange should not be called for invalid state %q", tc.state)
					return GitHubTokenResult{}, nil
				},
				fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
					t.Fatalf("fetch user should not be called for invalid state %q", tc.state)
					return GitHubUserProfile{}, nil
				},
				fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
					t.Fatalf("fetch emails should not be called for invalid state %q", tc.state)
					return nil, nil
				},
			})

			_, err := svc.CompleteGitHubOAuth(context.Background(), "code", tc.state, tc.verifier)
			require.Error(t, err)
			apiErr, ok := err.(*errors.APIError)
			require.True(t, ok)
			assert.Contains(t, []int{400, 401}, apiErr.Status)
			assert.False(t, exchangeCalled)
			assert.Equal(t, tc.expectConsume, consumeCalled)
		})
	}
}

func TestAuthService_CompleteGitHubOAuth_EmptyCodeRejected(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			t.Fatal("consume state should not run when oauth code is empty")
			return 0, nil
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			t.Fatal("exchange should not run when oauth code is empty")
			return GitHubTokenResult{}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return nil, nil
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "", "issued-state", "browser-verifier")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 400, apiErr.Status)
	assert.Contains(t, apiErr.Message, "invalid oauth code")
}

func TestAuthService_CompleteGitHubOAuth_ConsumeStateDBError(t *testing.T) {
	t.Parallel()

	svc := NewAuthService(&mockAuthQuerier{
		consumeOAuthStateFn: func(ctx context.Context, arg db.ConsumeOAuthStateParams) (int64, error) {
			assert.Equal(t, "issued-state", arg.State)
			assert.Equal(t, hashOAuthStateVerifier("browser-verifier"), arg.ContextHash)
			return 0, fmt.Errorf("db unavailable")
		},
	}, defaultAuthConfig(), mockKeyAuthVerifier{}, mockGitHubClient{
		exchangeCodeFn: func(ctx context.Context, code string) (GitHubTokenResult, error) {
			t.Fatal("exchange should not be called when consume fails")
			return GitHubTokenResult{}, nil
		},
		fetchUserFn: func(ctx context.Context, accessToken string) (GitHubUserProfile, error) {
			return GitHubUserProfile{}, nil
		},
		fetchEmailsFn: func(ctx context.Context, accessToken string) ([]GitHubEmail, error) {
			return nil, nil
		},
	})

	_, err := svc.CompleteGitHubOAuth(context.Background(), "code", "issued-state", "browser-verifier")
	require.Error(t, err)
	apiErr, ok := err.(*errors.APIError)
	require.True(t, ok)
	assert.Equal(t, 500, apiErr.Status)
}

func TestAuthService_StartGitHubOAuth_CredentialFailureDoesNotPersistState(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"missing", ErrGitHubAppNotConfigured},
		{"corrupt", fmt.Errorf("sealed oauth credentials unavailable")},
		{"canceled", context.Canceled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			persisted := false
			service := NewAuthService(&mockAuthQuerier{createOAuthStateFn: func(context.Context, db.CreateOAuthStateParams) (db.OauthState, error) {
				persisted = true
				return db.OauthState{}, nil
			}}, defaultAuthConfig(), nil, mockGitHubClient{authorizationErr: tc.err})
			value, err := service.StartGitHubOAuth(context.Background(), "bound-verifier")
			require.Error(t, err)
			require.Empty(t, value)
			require.False(t, persisted)
		})
	}
}

func TestAuthService_StartGitHubOAuth_LoadsCredentialsBeforePersistingState(t *testing.T) {
	stateSeen := ""
	service := NewAuthService(&mockAuthQuerier{createOAuthStateFn: func(_ context.Context, arg db.CreateOAuthStateParams) (db.OauthState, error) {
		require.Equal(t, arg.State, stateSeen, "credential resolution must precede persisting OAuth state")
		return db.OauthState{}, nil
	}}, defaultAuthConfig(), nil, mockGitHubClient{authorizationSeen: &stateSeen})
	value, err := service.StartGitHubOAuth(context.Background(), "bound-verifier")
	require.NoError(t, err)
	require.Contains(t, value, stateSeen)
}

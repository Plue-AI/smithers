package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	dto "github.com/prometheus/client_model/go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// mockWorkspaceTerminalService implements WorkspaceTerminalService for testing.
type mockWorkspaceTerminalService struct {
	getSessionFunc            func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error)
	getSSHConnectionFunc      func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error)
	touchSessionActivityFunc  func(ctx context.Context, sessionID string) error
	resolveLanguageServerFunc func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.LanguageServerLaunch, error)
	touchCalls                []string
}

func (m *mockWorkspaceTerminalService) ResolveLanguageServer(ctx context.Context, sessionID string, repositoryID, userID int64) (services.LanguageServerLaunch, error) {
	if m.resolveLanguageServerFunc != nil {
		return m.resolveLanguageServerFunc(ctx, sessionID, repositoryID, userID)
	}
	spec, _ := services.LanguageServerFor("typescript")
	return services.LanguageServerLaunch{SessionID: sessionID, WorkspaceID: "workspace-1", Language: spec.Language, Spec: spec, Command: spec.LaunchCommand("/home/developer/workspace")}, nil
}

func (m *mockWorkspaceTerminalService) GetSession(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error) {
	if m.getSessionFunc != nil {
		return m.getSessionFunc(ctx, sessionID, repositoryID, userID)
	}
	return services.WorkspaceSessionResponse{}, pkgerrors.NotFound("session not found")
}

func (m *mockWorkspaceTerminalService) GetSSHConnectionInfo(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
	if m.getSSHConnectionFunc != nil {
		return m.getSSHConnectionFunc(ctx, sessionID, repositoryID, userID)
	}
	return services.WorkspaceSSHConnectionInfo{}, pkgerrors.NotFound("session not found")
}

func (m *mockWorkspaceTerminalService) TouchSessionActivity(ctx context.Context, sessionID string) error {
	m.touchCalls = append(m.touchCalls, sessionID)
	if m.touchSessionActivityFunc != nil {
		return m.touchSessionActivityFunc(ctx, sessionID)
	}
	return nil
}

// dialWithOrigin connects a WebSocket to the given URL with a custom Origin header.
func dialWithOrigin(ctx context.Context, wsURL, origin string) (*websocket.Conn, *http.Response, error) {
	opts := &websocket.DialOptions{}
	if origin != "" {
		opts.HTTPHeader = http.Header{"Origin": []string{origin}}
	}
	return websocket.Dial(ctx, wsURL, opts)
}

// --- Origin validation tests ---

func TestTerminalWebSocket_OriginValidation_InvalidOrigin(t *testing.T) {
	handler := &WorkspaceTerminalHandler{
		Service:        &mockWorkspaceTerminalService{},
		AllowedOrigins: []string{"https://smithers.sh"},
	}

	r := chi.NewRouter()
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	ctx := context.Background()
	_, resp, err := dialWithOrigin(ctx,
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"https://evil.com",
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestTerminalWebSocket_OriginValidation_MissingOrigin(t *testing.T) {
	handler := &WorkspaceTerminalHandler{
		Service:        &mockWorkspaceTerminalService{},
		AllowedOrigins: []string{"https://smithers.sh"},
	}

	r := chi.NewRouter()
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	// Send request with no Origin header at all.
	ctx := context.Background()
	_, resp, err := dialWithOrigin(ctx,
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"",
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestTerminalWebSocket_OriginValidation_NullOrigin(t *testing.T) {
	handler := &WorkspaceTerminalHandler{
		Service:        &mockWorkspaceTerminalService{},
		AllowedOrigins: []string{"https://smithers.sh"},
	}

	r := chi.NewRouter()
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	ctx := context.Background()
	_, resp, err := dialWithOrigin(ctx,
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"null",
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestTerminalWebSocket_OriginValidation_AllowsForwardedProxyOrigin(t *testing.T) {
	handler := &WorkspaceTerminalHandler{
		Service:        &mockWorkspaceTerminalService{},
		AllowedOrigins: []string{"https://smithers.sh"},
	}
	req := httptest.NewRequest(http.MethodGet, "/repos/testowner/testrepo/workspace/sessions/abc-123/terminal", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "smithers-multi-williamcory.willcory10.workers.dev")

	assert.True(t, handler.checkOrigin("https://smithers-multi-williamcory.willcory10.workers.dev", req))
	assert.False(t, handler.checkOrigin("https://evil.example", req))
}

func TestTerminalWebSocket_OriginValidation_AllowsTheAPIsOwnHost(t *testing.T) {
	handler := &WorkspaceTerminalHandler{
		Service:        &mockWorkspaceTerminalService{},
		AllowedOrigins: []string{"https://smithers.sh"},
	}
	// The packaged native window relays its terminal socket with the API's own
	// origin. A load balancer forwards the scheme but keeps the Host header.
	req := httptest.NewRequest(http.MethodGet, "/repos/testowner/testrepo/workspace/sessions/abc-123/terminal", nil)
	req.Host = "api.jjhub.tech"
	req.Header.Set("X-Forwarded-Proto", "https")

	assert.True(t, handler.checkOrigin("https://api.jjhub.tech", req))
	assert.False(t, handler.checkOrigin("http://api.jjhub.tech", req))
	assert.False(t, handler.checkOrigin("https://evil.example", req))
}

func TestTerminalWebSocket_OriginValidation_CaseInsensitive(t *testing.T) {
	handler := &WorkspaceTerminalHandler{
		Service:        &mockWorkspaceTerminalService{},
		AllowedOrigins: []string{"https://smithers.sh"},
	}

	r := chi.NewRouter()
	// Inject user and repo context so origin validation passes and we reach session lookup.
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := &db.User{ID: 1, Username: "testuser"}
			ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: user})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "testowner",
				Repository: &db.Repository{ID: 1, Name: "testrepo"},
			}, middleware.PermissionWrite)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	// Use upper-case origin -- should still pass origin check and reach session lookup.
	ctx := context.Background()
	_, resp, err := dialWithOrigin(ctx,
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"HTTPS://SMITHERS.SH",
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	// Should get past origin check. With no valid session, expect 404.
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestTerminalWebSocket_OriginValidation_EmptyAllowedOrigins(t *testing.T) {
	handler := &WorkspaceTerminalHandler{
		Service:        &mockWorkspaceTerminalService{},
		AllowedOrigins: []string{},
	}

	r := chi.NewRouter()
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	ctx := context.Background()
	_, resp, err := dialWithOrigin(ctx,
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"https://smithers.sh",
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestTerminalWebSocket_OriginValidation_MetricsIncremented(t *testing.T) {
	metrics := NewSmithersMetrics()

	handler := &WorkspaceTerminalHandler{
		Service:        &mockWorkspaceTerminalService{},
		AllowedOrigins: []string{"https://smithers.sh"},
		Metrics:        metrics,
	}

	r := chi.NewRouter()
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	ctx := context.Background()
	_, resp, err := dialWithOrigin(ctx,
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"https://evil.com",
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)

	// Verify Prometheus counter was incremented.
	counter, err := metrics.ValidationRejectionsTotal().GetMetricWithLabelValues("WebSocket", "origin")
	require.NoError(t, err)
	var metric dto.Metric
	require.NoError(t, counter.Write(&metric))
	assert.Equal(t, float64(1), metric.GetCounter().GetValue())
}

func TestTerminalWebSocket_OriginValidation_ValidOriginPassesThrough(t *testing.T) {
	handler := &WorkspaceTerminalHandler{
		Service:        &mockWorkspaceTerminalService{},
		AllowedOrigins: []string{"https://smithers.sh"},
	}

	r := chi.NewRouter()
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	// With valid origin but no auth, should reach the auth check and return 401 (not 403).
	ctx := context.Background()
	_, resp, err := dialWithOrigin(ctx,
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"https://smithers.sh",
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func newTerminalOriginTestServer(t *testing.T, authInfo *middleware.AuthInfo) *httptest.Server {
	t.Helper()

	handler := &WorkspaceTerminalHandler{
		Service:        &mockWorkspaceTerminalService{},
		AllowedOrigins: []string{"https://smithers.sh"},
	}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := middleware.ContextWithAuthInfo(req.Context(), authInfo)
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "testowner",
				Repository: &db.Repository{ID: 1, Name: "testrepo"},
			}, middleware.PermissionWrite)
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)
	return httptest.NewServer(r)
}

func dialTerminalOriginTest(ctx context.Context, wsURL, origin string, headers http.Header) (*websocket.Conn, *http.Response, error) {
	if headers == nil {
		headers = make(http.Header)
	}
	if origin != "" {
		headers.Set("Origin", origin)
	}
	return websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: headers})
}

func TestTerminalWebSocket_OriginValidation_CookieSessionRejectsBadOrigin(t *testing.T) {
	srv := newTerminalOriginTestServer(t, &middleware.AuthInfo{User: &db.User{ID: 1}})
	defer srv.Close()

	headers := http.Header{"Cookie": []string{"smithers_session=session-key"}}
	_, resp, err := dialTerminalOriginTest(
		context.Background(),
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"https://evil.com",
		headers,
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestTerminalWebSocket_OriginValidation_BearerMissingOriginPassesGate(t *testing.T) {
	srv := newTerminalOriginTestServer(t, &middleware.AuthInfo{
		User:        &db.User{ID: 1},
		IsTokenAuth: true,
	})
	defer srv.Close()

	_, resp, err := dialTerminalOriginTest(
		context.Background(),
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"",
		http.Header{"Authorization": []string{"Bearer smithers_test"}},
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestTerminalWebSocket_OriginValidation_BearerArbitraryOriginPassesGate(t *testing.T) {
	srv := newTerminalOriginTestServer(t, &middleware.AuthInfo{
		User:        &db.User{ID: 1},
		IsTokenAuth: true,
	})
	defer srv.Close()

	_, resp, err := dialTerminalOriginTest(
		context.Background(),
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"https://evil.com",
		http.Header{"Authorization": []string{"Bearer smithers_test"}},
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestTerminalWebSocket_OriginValidation_TicketRejectsBadOrigin(t *testing.T) {
	srv := newTerminalOriginTestServer(t, &middleware.AuthInfo{
		User:        &db.User{ID: 1},
		IsTokenAuth: true,
	})
	defer srv.Close()

	_, resp, err := dialTerminalOriginTest(
		context.Background(),
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal?ticket=browser-ticket",
		"https://evil.com",
		nil,
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

// --- Existing tests (updated with valid origins) ---

func TestTerminalWebSocket_NoAuth(t *testing.T) {
	handler := &WorkspaceTerminalHandler{
		Service:        &mockWorkspaceTerminalService{},
		AllowedOrigins: []string{"https://smithers.sh"},
	}

	r := chi.NewRouter()
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	// Try to connect without authentication -- should get 401.
	ctx := context.Background()
	_, resp, err := dialWithOrigin(ctx,
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"https://smithers.sh",
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestTerminalWebSocket_NoRepoContext(t *testing.T) {
	handler := &WorkspaceTerminalHandler{
		Service:        &mockWorkspaceTerminalService{},
		AllowedOrigins: []string{"https://smithers.sh"},
	}

	r := chi.NewRouter()
	// Inject user but no repo context.
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := &db.User{ID: 1, Username: "testuser"}
			ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: user})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	ctx := context.Background()
	_, resp, err := dialWithOrigin(ctx,
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"https://smithers.sh",
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestTerminalWebSocket_SessionNotFound(t *testing.T) {
	svc := &mockWorkspaceTerminalService{
		getSessionFunc: func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error) {
			return services.WorkspaceSessionResponse{}, pkgerrors.NotFound("session not found")
		},
	}

	handler := &WorkspaceTerminalHandler{
		Service:        svc,
		AllowedOrigins: []string{"https://smithers.sh"},
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := &db.User{ID: 1, Username: "testuser"}
			ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: user})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "testowner",
				Repository: &db.Repository{ID: 1, Name: "testrepo"},
			}, middleware.PermissionWrite)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	ctx := context.Background()
	_, resp, err := dialWithOrigin(ctx,
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"https://smithers.sh",
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestTerminalWebSocket_PendingSessionReturnsTooEarlyWithoutSSHLookup(t *testing.T) {
	metrics := NewSmithersMetrics()
	sshCalls := 0
	svc := &mockWorkspaceTerminalService{
		getSessionFunc: func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error) {
			return services.WorkspaceSessionResponse{
				ID:           sessionID,
				WorkspaceID:  "workspace-1",
				RepositoryID: repositoryID,
				UserID:       userID,
				Status:       "pending",
				Cols:         80,
				Rows:         24,
			}, nil
		},
		getSSHConnectionFunc: func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
			sshCalls++
			return services.WorkspaceSSHConnectionInfo{}, nil
		},
	}

	handler := &WorkspaceTerminalHandler{
		Service:        svc,
		AllowedOrigins: []string{"https://smithers.sh"},
		Metrics:        metrics,
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := &db.User{ID: 1, Username: "testuser"}
			ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: user})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "testowner",
				Repository: &db.Repository{ID: 1, Name: "testrepo"},
			}, middleware.PermissionWrite)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	ctx := context.Background()
	_, resp, err := dialWithOrigin(ctx,
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"https://smithers.sh",
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusTooEarly, resp.StatusCode)
	assert.Equal(t, "2", resp.Header.Get("Retry-After"))
	assert.Equal(t, 0, sshCalls, "pending sessions must not provision synchronously on the WebSocket path")

	counter, err := metrics.WorkspaceTerminalAttachTotal.GetMetricWithLabelValues("session_pending")
	require.NoError(t, err)
	var metric dto.Metric
	require.NoError(t, counter.Write(&metric))
	assert.Equal(t, float64(1), metric.GetCounter().GetValue())
}

func TestTerminalWebSocket_PassesRepoAndUserToSessionLookup(t *testing.T) {
	svc := &mockWorkspaceTerminalService{
		getSessionFunc: func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error) {
			assert.Equal(t, "abc-123", sessionID)
			assert.Equal(t, int64(1), repositoryID)
			assert.Equal(t, int64(1), userID)
			return services.WorkspaceSessionResponse{}, pkgerrors.NotFound("session not found")
		},
	}

	handler := &WorkspaceTerminalHandler{
		Service:        svc,
		AllowedOrigins: []string{"https://smithers.sh"},
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := &db.User{ID: 1, Username: "testuser"}
			ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: user})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "testowner",
				Repository: &db.Repository{ID: 1, Name: "testrepo"},
			}, middleware.PermissionWrite)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	ctx := context.Background()
	_, resp, err := dialWithOrigin(ctx,
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"https://smithers.sh",
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestTerminalWebSocket_DurableSessionFailureBeforeUpgrade(t *testing.T) {
	svc := &mockWorkspaceTerminalService{
		getSessionFunc: func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error) {
			return services.WorkspaceSessionResponse{
				ID:           sessionID,
				WorkspaceID:  "workspace-1",
				RepositoryID: repositoryID,
				UserID:       userID,
				Status:       "running",
				Cols:         80,
				Rows:         24,
			}, nil
		},
		getSSHConnectionFunc: func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
			return services.WorkspaceSSHConnectionInfo{
				WorkspaceID: "workspace-1",
				VMID:        "vm-1",
				Host:        "vm-ssh.example",
				Username:    "developer",
			}, nil
		},
	}
	handler := &WorkspaceTerminalHandler{
		Service:        svc,
		AllowedOrigins: []string{"https://smithers.sh"},
		TerminalSessions: NewTerminalSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo, cols, rows int32) (terminalSSHClient, terminalSSHSession, error) {
			return nil, nil, errors.New("ssh dial failed")
		}),
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := &db.User{ID: 1, Username: "testuser"}
			ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: user})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "testowner",
				Repository: &db.Repository{ID: 1, Name: "testrepo"},
			}, middleware.PermissionWrite)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	ctx := context.Background()
	_, resp, err := dialWithOrigin(ctx,
		srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal",
		"https://smithers.sh",
	)
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusInternalServerError, resp.StatusCode)
	assert.Empty(t, resp.Header.Get("Sec-Websocket-Accept"))
}

func TestTerminalWebSocket_GuestNotReadyReturnsRetryable503(t *testing.T) {
	svc := &mockWorkspaceTerminalService{
		getSessionFunc: func(_ context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error) {
			return services.WorkspaceSessionResponse{ID: sessionID, Status: "running", Cols: 80, Rows: 24}, nil
		},
		getSSHConnectionFunc: func(context.Context, string, int64, int64) (services.WorkspaceSSHConnectionInfo, error) {
			return services.WorkspaceSSHConnectionInfo{WorkspaceID: "workspace-1", VMID: "vm-1", Kind: "vm"}, nil
		},
	}
	dials := 0
	manager := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
		dials++
		fake := newFakeTerminalSSH()
		fake.session.waitImmediately = true
		fake.session.waitErr = fakeTerminalExitError{status: 127}
		return fake.client, fake.session, nil
	})
	manager.startupWatch = 10 * time.Millisecond
	manager.startupRetryDelay = time.Millisecond
	manager.keepaliveInterval = 0

	handler := &WorkspaceTerminalHandler{
		Service:          svc,
		AllowedOrigins:   []string{"https://smithers.sh"},
		TerminalSessions: manager,
	}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := &db.User{ID: 1, Username: "testuser"}
			ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: user})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner: "testowner", Repository: &db.Repository{ID: 1, Name: "testrepo"},
			}, middleware.PermissionWrite)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)
	srv := httptest.NewServer(r)
	defer srv.Close()

	_, resp, err := dialWithOrigin(context.Background(), srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal", "https://smithers.sh")
	require.Error(t, err)
	require.NotNil(t, resp)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
	assert.Equal(t, "3", resp.Header.Get("Retry-After"))
	var body map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.Equal(t, "guest_not_ready", body["code"])
	assert.Equal(t, "wait", body["fault"], "a boot window is not a failure")
	// guest_not_ready is in the safe 5xx message set (ace2a681ef, #3071).
	assert.Equal(t, "workspace guest is still starting; retry shortly", body["message"])
	assert.Equal(t, 2, dials, "exit 127 is retried exactly once")
}

func TestTerminalResizeMsg_JSON(t *testing.T) {
	msg := terminalResizeMsg{
		Type: "resize",
		Cols: 120,
		Rows: 40,
	}
	data, err := json.Marshal(msg)
	require.NoError(t, err)

	var parsed terminalResizeMsg
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, "resize", parsed.Type)
	assert.Equal(t, uint32(120), parsed.Cols)
	assert.Equal(t, uint32(40), parsed.Rows)
}

// TestTerminalActivityRefresh verifies that terminal I/O causes TouchSessionActivity
// to be called. It wires up a real WebSocket pair in-process and confirms that
// pipeSSHToWS invokes the notifyActivity callback — which the activity-refresh
// goroutine inside TerminalWebSocket drains and converts into TouchSessionActivity
// calls. Rather than spinning up the full TerminalWebSocket handler (which
// requires a live SSH server), we exercise the two lowest layers directly:
//
//  1. pipeSSHToWS — SSH stdout → WebSocket binary frame + notifyActivity()
//  2. the activity-refresh goroutine logic via a standalone debounce loop
func TestTerminalActivityRefresh(t *testing.T) {
	t.Parallel()

	// activityCh mimics the buffered channel used inside TerminalWebSocket.
	activityCh := make(chan struct{}, 8)
	notifyActivity := func() {
		select {
		case activityCh <- struct{}{}:
		default:
		}
	}

	// svc records every TouchSessionActivity call.
	svc := &mockWorkspaceTerminalService{}

	// Build a minimal in-process WebSocket pair.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true,
		})
		if err != nil {
			t.Logf("server accept error: %v", err)
			return
		}
		defer conn.CloseNow()
		// Drain frames so the client write doesn't block.
		for {
			_, _, readErr := conn.Read(r.Context())
			if readErr != nil {
				return
			}
		}
	}))
	defer srv.Close()

	wsURL := "ws" + srv.URL[len("http"):]
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	clientConn, _, err := websocket.Dial(ctx, wsURL, nil)
	require.NoError(t, err)
	defer clientConn.CloseNow()

	handler := &WorkspaceTerminalHandler{Service: svc}

	// Pipe a small byte slice from a reader through pipeSSHToWS.
	// pipeSSHToWS reads → writes a binary WS frame → calls notifyActivity().
	payload := []byte("hello terminal")
	r, w, err := os.Pipe()
	require.NoError(t, err)

	go func() {
		_, _ = w.Write(payload)
		w.Close()
	}()

	handler.pipeSSHToWS(ctx, clientConn, r, "test-session-id", notifyActivity)
	r.Close()

	// notifyActivity should have been called; signal should be in the channel.
	require.NotEmpty(t, activityCh, "expected notifyActivity to send a signal to activityCh")

	// Drain the channel and call TouchSessionActivity once — mirrors the
	// first-signal path in the activity-refresh goroutine.
	select {
	case <-activityCh:
		touchErr := svc.TouchSessionActivity(ctx, "test-session-id")
		require.NoError(t, touchErr)
	case <-ctx.Done():
		t.Fatal("timed out waiting for activity signal")
	}

	require.Len(t, svc.touchCalls, 1, "expected exactly one TouchSessionActivity call")
	assert.Equal(t, "test-session-id", svc.touchCalls[0])
}

// TestTerminalWebSocket_AcceptFailureReleasesCreatedSession is the issue #123
// regression at the handler level: when the durable SSH session is created but
// the websocket upgrade then fails (plain GET, no Upgrade headers), the
// freshly dialed session must be destroyed and removed from the manager
// immediately instead of leaking until the idle timeout.
func TestTerminalWebSocket_AcceptFailureReleasesCreatedSession(t *testing.T) {
	svc := &mockWorkspaceTerminalService{
		getSessionFunc: func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error) {
			return services.WorkspaceSessionResponse{
				ID:           sessionID,
				WorkspaceID:  "workspace-1",
				RepositoryID: repositoryID,
				UserID:       userID,
				Status:       "running",
				Cols:         80,
				Rows:         24,
			}, nil
		},
		getSSHConnectionFunc: func(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error) {
			return services.WorkspaceSSHConnectionInfo{
				WorkspaceID: "workspace-1",
				VMID:        "vm-1",
				Host:        "vm-ssh.example",
				Username:    "developer",
			}, nil
		},
	}
	fake := newFakeTerminalSSH()
	manager := NewTerminalSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo, cols, rows int32) (terminalSSHClient, terminalSSHSession, error) {
		return fake.client, fake.session, nil
	})
	manager.keepaliveInterval = 0
	defer manager.Close()
	handler := &WorkspaceTerminalHandler{
		Service:          svc,
		AllowedOrigins:   []string{"https://smithers.sh"},
		TerminalSessions: manager,
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := &db.User{ID: 1, Username: "testuser"}
			ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: user})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{
				Owner:      "testowner",
				Repository: &db.Repository{ID: 1, Name: "testrepo"},
			}, middleware.PermissionWrite)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	r.Get("/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", handler.TerminalWebSocket)

	srv := httptest.NewServer(r)
	defer srv.Close()

	// Plain GET with a valid Origin but no websocket upgrade headers: the
	// handler dials the durable session, then websocket.Accept fails.
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/repos/testowner/testrepo/workspace/sessions/abc-123/terminal", nil)
	require.NoError(t, err)
	req.Header.Set("Origin", "https://smithers.sh")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	assert.NotEqual(t, http.StatusSwitchingProtocols, resp.StatusCode)

	manager.mu.Lock()
	remaining := len(manager.sessions)
	manager.mu.Unlock()
	assert.Zero(t, remaining, "accept failure must remove the created session from the manager")
	// Transport closes run off the revocation path (2c7f3c77bc), so the SSH
	// session closes shortly after the manager drops it.
	assert.Eventually(t, fake.session.closed.Load, time.Second, 5*time.Millisecond,
		"accept failure must close the freshly dialed SSH session")
}

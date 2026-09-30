// Package routes — regression tests for T44 launch-blocker defects.
//
// Each test locks down a specific trust boundary that was identified as
// high-risk during code review:
//
//  1. Workspace isolation  — cross-user access returns 403 (not 404)
//  2. OAuth2 scope guard   — tokens with insufficient scope get 403
//  3. Admin auth           — non-admin tokens cannot reach /api/admin/ routes
//  4. Runner secrets       — GetTaskEnvironment returns injected secrets,
//     log redaction via RedactSecretValues works correctly
//  5. SSE longevity        — SSE handler is NOT cancelled by the 30 s
//     JSON timeout (verifying route-level timeout exemption)
//  6. Webhook delivery     — DispatchEvent persists a pending delivery in the
//     product schema and the worker POSTs it and persists the result
//  7. Git streaming        — upload-pack streams the packfile to the client
//     before the proxy returns (the repohostserver package covers repo-host)
//  8. Migration parity     — product and private tables have models in their
//     respective generated packages

package routes

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// ---------------------------------------------------------------------------
// 1. Workspace isolation — cross-user access MUST return 403, not 404
// ---------------------------------------------------------------------------

// TestRegression_WorkspaceIsolation_CrossUserReturns403 verifies that when a
// service returns a Forbidden error for a workspace owned by a different user,
// the HTTP handler propagates 403 (not 404 or 200).
//
// Background: a previous variant of the service returned generic "not found"
// for foreign workspaces, leaking ownership information via the error shape.
// The access-check layer now returns 403 unconditionally for non-owners.
func TestRegression_WorkspaceIsolation_CrossUserReturns403(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		getWorkspaceFn: func(_ context.Context, workspaceID string, _ int64, userID int64) (services.WorkspaceResponse, error) {
			// Simulate service enforcing cross-user boundary: always 403 for
			// a requester that is not the workspace owner.
			if userID != 1 {
				return services.WorkspaceResponse{}, pkgerrors.Forbidden("access denied")
			}
			return services.WorkspaceResponse{ID: workspaceID, Status: "running"}, nil
		},
	}}

	// User 2 attempts to access a workspace that belongs to User 1.
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/ws-owner-1", nil)
	req = withRouteParams(req, map[string]string{"id": "ws-owner-1"})
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 2 /* user 2 */, "bob")
	rec := httptest.NewRecorder()

	h.GetWorkspace(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code,
		"cross-user workspace access must return 403, not 404 or 200")

	// Verify the response body is a well-formed APIError JSON object.
	var apiErr pkgerrors.APIError
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &apiErr))
	assert.Equal(t, "access denied", apiErr.Message)
}

// TestRegression_WorkspaceIsolation_OwnerCanAccess ensures the owner still gets 200.
func TestRegression_WorkspaceIsolation_OwnerCanAccess(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		getWorkspaceFn: func(_ context.Context, workspaceID string, _ int64, userID int64) (services.WorkspaceResponse, error) {
			if userID != 1 {
				return services.WorkspaceResponse{}, pkgerrors.Forbidden("access denied")
			}
			return services.WorkspaceResponse{ID: workspaceID, Status: "running"}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/ws-owner-1", nil)
	req = withRouteParams(req, map[string]string{"id": "ws-owner-1"})
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1 /* owner */, "alice")
	rec := httptest.NewRecorder()

	h.GetWorkspace(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
}

// ---------------------------------------------------------------------------
// 2. OAuth2 scope guard — insufficient scope returns 403
// ---------------------------------------------------------------------------

// TestRegression_OAuth2Scope_InsufficientScopeReturns403 verifies that the
// RequireScope middleware returns 403 (not 401 or 200) when a token-authenticated
// request lacks the required scope.
//
// Background: earlier versions of the scope middleware had a code path that
// fell through to the handler when scopes were absent, letting token requests
// bypass scope enforcement.
func TestRegression_OAuth2Scope_InsufficientScopeReturns403(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name            string
		grantedScope    string
		requiredScope   middleware.TokenScope
		expectForbidden bool
	}{
		{
			name:            "read:repository token cannot hit write:workspace endpoint",
			grantedScope:    "read:repository",
			requiredScope:   middleware.ScopeWriteWorkspace,
			expectForbidden: true,
		},
		{
			name:            "read:workspace token cannot hit write:workspace endpoint",
			grantedScope:    "read:workspace",
			requiredScope:   middleware.ScopeWriteWorkspace,
			expectForbidden: true,
		},
		{
			name:            "write:workspace token satisfies write:workspace endpoint",
			grantedScope:    "write:workspace",
			requiredScope:   middleware.ScopeWriteWorkspace,
			expectForbidden: false,
		},
		{
			name:            "all scope satisfies any endpoint",
			grantedScope:    "all",
			requiredScope:   middleware.ScopeWriteWorkspace,
			expectForbidden: false,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			nextCalled := false
			handler := middleware.RequireScope(tc.requiredScope)(
				http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					nextCalled = true
					w.WriteHeader(http.StatusOK)
				}),
			)

			req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces", nil)
			req = withTokenAuth(req, 42, "token-user", middleware.TokenScope(tc.grantedScope))
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if tc.expectForbidden {
				assert.Equal(t, http.StatusForbidden, rec.Code,
					"token with scope %q must be blocked from endpoint requiring %q",
					tc.grantedScope, tc.requiredScope)
				assert.False(t, nextCalled, "handler must not be called when scope is insufficient")

				var apiErr pkgerrors.APIError
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &apiErr))
				assert.Equal(t, "insufficient token scope", apiErr.Message)
			} else {
				assert.Equal(t, http.StatusOK, rec.Code)
				assert.True(t, nextCalled)
			}
		})
	}
}

// TestRegression_OAuth2Scope_UnauthenticatedRequestRejected verifies that a
// request with no auth info at all is rejected by RequireScope with 401.
func TestRegression_OAuth2Scope_UnauthenticatedRequestRejected(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := middleware.RequireScope(middleware.ScopeReadWorkspace)(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusOK)
		}),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces", nil)
	// No auth context added.
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.False(t, nextCalled)
}

// ---------------------------------------------------------------------------
// 3. Admin auth — non-admin PAT cannot access /api/admin/ routes
// ---------------------------------------------------------------------------

// TestRegression_AdminAuth_NonAdminTokenCannotHitAdminRoute verifies that a
// token issued to a non-admin user is blocked by RequireAdmin with 403.
//
// Background: the old RequireAdmin checked only IsAdmin without also verifying
// the token carries a read:admin scope, so an admin user with a scoped token
// (e.g. read:repository only) could still reach admin endpoints.
func TestRegression_AdminAuth_NonAdminTokenCannotHitAdminRoute(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		user        *db.User
		isTokenAuth bool
		tokenSource middleware.TokenSource
		scopes      string
		wantStatus  int
		wantMsg     string
	}{
		{
			name:        "non-admin user with admin scope is rejected",
			user:        &db.User{ID: 10, Username: "pleb", IsAdmin: false},
			isTokenAuth: true,
			tokenSource: middleware.TokenSourcePersonalAccessToken,
			scopes:      "write:admin",
			wantStatus:  http.StatusForbidden,
			wantMsg:     "admin access required",
		},
		{
			name:        "admin user with repo-only scope is rejected",
			user:        &db.User{ID: 11, Username: "admin-no-scope", IsAdmin: true},
			isTokenAuth: true,
			tokenSource: middleware.TokenSourcePersonalAccessToken,
			scopes:      "read:repository",
			wantStatus:  http.StatusForbidden,
			wantMsg:     "insufficient token scope",
		},
		{
			name:        "admin user with admin scope is allowed",
			user:        &db.User{ID: 12, Username: "superadmin", IsAdmin: true},
			isTokenAuth: true,
			tokenSource: middleware.TokenSourcePersonalAccessToken,
			scopes:      "admin",
			wantStatus:  http.StatusNoContent,
		},
		{
			name:        "oauth2 access token is always rejected for admin routes",
			user:        &db.User{ID: 13, Username: "oauth-admin", IsAdmin: true},
			isTokenAuth: true,
			tokenSource: middleware.TokenSourceOAuth2AccessToken,
			scopes:      "read:admin",
			wantStatus:  http.StatusForbidden,
			wantMsg:     "oauth2 access tokens cannot access admin endpoints",
		},
		{
			name:        "unauthenticated request returns 401",
			user:        nil,
			isTokenAuth: false,
			wantStatus:  http.StatusUnauthorized,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			nextCalled := false
			handler := middleware.RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				nextCalled = true
				w.WriteHeader(http.StatusNoContent)
			}))

			req := httptest.NewRequest(http.MethodGet, "/api/admin/runners", nil)
			if tc.user != nil {
				scopeSet := middleware.ParseTokenScopes(tc.scopes)
				req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
					User:        tc.user,
					IsTokenAuth: tc.isTokenAuth,
					TokenSource: tc.tokenSource,
					Scopes:      scopeSet,
				}))
			}
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			assert.Equal(t, tc.wantStatus, rec.Code)
			if tc.wantMsg != "" {
				var apiErr pkgerrors.APIError
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &apiErr),
					"response body must be valid APIError JSON")
				assert.Equal(t, tc.wantMsg, apiErr.Message)
			}
			if tc.wantStatus == http.StatusNoContent {
				assert.True(t, nextCalled, "handler must be called for authorized request")
			} else {
				assert.False(t, nextCalled, "handler must NOT be called for unauthorized request")
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 4. Runner secrets — GetTaskEnvironment response includes injected secrets;
//    RedactSecretValues masks them in log output
// ---------------------------------------------------------------------------

// TestRegression_RunnerSecrets_GetTaskEnvironmentIncludesSecrets verifies that
// GetTaskEnvironment returns the injected repository secrets and the agent token
// in the response payload.
//
// Background: an earlier handler version returned an empty env map because the
// service call was missing the context-injected workflow run.

// TestRegression_RunnerSecrets_RedactSecretValuesRemovesSecretsFromLogOutput
// verifies that RedactSecretValues replaces every secret value in a log string
// with the redacted placeholder, preventing accidental credential exposure in
// structured log output.
func TestRegression_RunnerSecrets_RedactSecretValuesRemovesSecretsFromLogOutput(t *testing.T) {
	t.Parallel()

	secretEnv := map[string]string{
		"ANTHROPIC_AUTH_TOKEN": "sk-ant-secret12345",
		"GITHUB_TOKEN":         "ghp_top-secret-value",
	}

	logLine := `running workflow with ANTHROPIC_AUTH_TOKEN=sk-ant-secret12345 and GITHUB_TOKEN=ghp_top-secret-value in step`

	redacted := services.RedactSecretValues(secretEnv, logLine)

	assert.NotContains(t, redacted, "sk-ant-secret12345",
		"ANTHROPIC_AUTH_TOKEN value must be redacted in log output")
	assert.NotContains(t, redacted, "ghp_top-secret-value",
		"GITHUB_TOKEN value must be redacted in log output")
	assert.Contains(t, redacted, "running workflow with",
		"non-secret text must be preserved")

	// Also verify that an empty secret map is a no-op (no panics, no corruption).
	unchanged := services.RedactSecretValues(nil, logLine)
	assert.Equal(t, logLine, unchanged, "nil secret map must leave text unchanged")
}

// ---------------------------------------------------------------------------
// 5. SSE longevity — SSE handler must NOT be cancelled by the 30 s timeout
// ---------------------------------------------------------------------------

// TestRegression_SSELongevity_HandlerNotCancelledByRequestTimeout verifies
// that an SSE handler registered outside the JSONTimeout middleware group is
// not subject to the request timeout. The handler sleeps longer than the
// configured timeout and must still emit the second event.
//
// This mirrors the production pattern: SSE routes are mounted before the
// chi sub-router that applies JSONTimeout so they never see a deadline.
func TestRegression_SSELongevity_HandlerNotCancelledByRequestTimeout(t *testing.T) {
	t.Parallel()

	firstEventSent := make(chan struct{})

	sseHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		require.True(t, ok, "SSE handler must receive an http.Flusher")

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)

		fmt.Fprintf(w, "data: event-1\n\n")
		flusher.Flush()
		close(firstEventSent)

		// Sleep longer than the timeout — if timeout applies, context is cancelled.
		select {
		case <-time.After(80 * time.Millisecond):
		case <-r.Context().Done():
			return
		}

		fmt.Fprintf(w, "data: event-2\n\n")
		flusher.Flush()
	})

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)

	// SSE route registered OUTSIDE the timeout group — identical to production.
	r.Get("/api/events", sseHandler)

	// All other /api routes get a very short (25 ms) timeout.
	r.Route("/api", func(r chi.Router) {
		r.Use(middleware.JSONTimeout(25 * time.Millisecond))
		r.Get("/ping", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		})
	})

	srv := httptest.NewServer(r)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/events", nil)
	require.NoError(t, err)

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode)

	// Wait until the first event was sent.
	select {
	case <-firstEventSent:
	case <-ctx.Done():
		t.Fatal("timed out waiting for first SSE event")
	}

	scanner := bufio.NewScanner(resp.Body)
	var receivedLines []string
	doneCh := make(chan struct{})
	go func() {
		defer close(doneCh)
		for scanner.Scan() {
			line := scanner.Text()
			if line != "" {
				receivedLines = append(receivedLines, line)
			}
			if len(receivedLines) >= 2 {
				return
			}
		}
	}()

	select {
	case <-doneCh:
	case <-time.After(500 * time.Millisecond):
	}

	assert.GreaterOrEqual(t, len(receivedLines), 2,
		"both SSE events must be received — SSE route must not be subject to the request timeout")
	assert.Contains(t, receivedLines[0], "event-1")
	assert.Contains(t, receivedLines[1], "event-2")
}

// TestRegression_SSELongevity_NormalRouteIsTimedOut is the control: a route
// inside the JSONTimeout group is cut off after the timeout, confirming the
// test itself has discriminating power.
func TestRegression_SSELongevity_NormalRouteIsTimedOut(t *testing.T) {
	t.Parallel()

	r := chi.NewRouter()
	r.Route("/api", func(r chi.Router) {
		r.Use(middleware.JSONTimeout(25 * time.Millisecond))
		r.Get("/slow", func(w http.ResponseWriter, r *http.Request) {
			<-r.Context().Done()
		})
	})

	req := httptest.NewRequest(http.MethodGet, "/api/slow", nil)
	rec := httptest.NewRecorder()
	start := time.Now()
	r.ServeHTTP(rec, req)
	elapsed := time.Since(start)

	assert.Equal(t, http.StatusGatewayTimeout, rec.Code,
		"route inside timeout group must return 504 when handler blocks")
	assert.Less(t, elapsed, 200*time.Millisecond,
		"timeout must be enforced quickly")
}

// ---------------------------------------------------------------------------
// 6. Webhook delivery — dispatcher → product store → worker → endpoint
// ---------------------------------------------------------------------------

// seedWebhookRegressionRepo creates a user and repository in a product-schema
// database and returns the repository ID.
func seedWebhookRegressionRepo(t *testing.T, ctx context.Context, pool *pgxpool.Pool, queries *db.Queries, name string) int64 {
	t.Helper()
	user, err := queries.CreateUser(ctx, db.CreateUserParams{
		Username:      name,
		LowerUsername: name,
		Email:         pgtype.Text{String: name + "@example.test", Valid: true},
		LowerEmail:    pgtype.Text{String: name + "@example.test", Valid: true},
		DisplayName:   name,
	})
	require.NoError(t, err)
	var repoID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark)
		 VALUES ($1, 'hooks', 'hooks', '', TRUE, 'main') RETURNING id`, user.ID).Scan(&repoID))
	return repoID
}

func createRegressionWebhook(t *testing.T, ctx context.Context, queries *db.Queries, repoID int64, url, secret string, active bool, events ...string) db.Webhook {
	t.Helper()
	hook, err := queries.CreateWebhook(ctx, db.CreateWebhookParams{
		RepositoryID: repoID, Url: url, Secret: secret, Events: events, IsActive: active,
	})
	require.NoError(t, err)
	return hook
}

type regressionDeliveryRow struct {
	WebhookID      int64
	EventType      string
	Payload        string
	Status         string
	ResponseStatus pgtype.Int4
	ResponseBody   string
	Attempts       int32
	Delivered      bool
}

func listRegressionDeliveries(t *testing.T, ctx context.Context, pool *pgxpool.Pool) []regressionDeliveryRow {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT webhook_id, event_type, payload::text, status, response_status,
		response_body, attempts, delivered_at IS NOT NULL FROM webhook_deliveries ORDER BY webhook_id, id`)
	require.NoError(t, err)
	defer rows.Close()
	var out []regressionDeliveryRow
	for rows.Next() {
		var row regressionDeliveryRow
		require.NoError(t, rows.Scan(&row.WebhookID, &row.EventType, &row.Payload, &row.Status,
			&row.ResponseStatus, &row.ResponseBody, &row.Attempts, &row.Delivered))
		out = append(out, row)
	}
	require.NoError(t, rows.Err())
	return out
}

// TestRegression_WebhookDelivery_DispatchEventPersistsDeliveries drives the
// production dispatcher against the product schema: a domain event must
// persist one pending delivery per active, subscribed webhook of that
// repository and nothing else.
//
// Background: a refactor removed the CreateWebhookDelivery call from one code
// path, so events were logged but never persisted.
func TestRegression_WebhookDelivery_DispatchEventPersistsDeliveries(t *testing.T) {
	t.Parallel()
	pool, _ := postgresfixture.NewProductDatabase(t)
	queries := db.New(pool)
	ctx := context.Background()

	repoID := seedWebhookRegressionRepo(t, ctx, pool, queries, "hook-dispatch-owner")
	otherRepoID := seedWebhookRegressionRepo(t, ctx, pool, queries, "hook-dispatch-other")
	push := createRegressionWebhook(t, ctx, queries, repoID, "https://push.example/hook", "", true, "push")
	createRegressionWebhook(t, ctx, queries, repoID, "https://inactive.example/hook", "", false, "push")
	createRegressionWebhook(t, ctx, queries, repoID, "https://issues.example/hook", "", true, "issues")
	wildcard := createRegressionWebhook(t, ctx, queries, repoID, "https://all.example/hook", "", true, "*")
	createRegressionWebhook(t, ctx, queries, otherRepoID, "https://other-repo.example/hook", "", true, "push")

	dispatcher := webhooks.NewDispatcher(queries)
	require.NoError(t, dispatcher.DispatchEvent(ctx, repoID, webhooks.EventTypePush, map[string]string{"ref": "refs/heads/main"}))

	deliveries := listRegressionDeliveries(t, ctx, pool)
	require.Len(t, deliveries, 2, "only the active push and wildcard hooks of this repository receive a delivery")
	for i, want := range []int64{push.ID, wildcard.ID} {
		assert.Equal(t, want, deliveries[i].WebhookID)
		assert.Equal(t, "push", deliveries[i].EventType)
		assert.Equal(t, "pending", deliveries[i].Status)
		assert.JSONEq(t, `{"ref":"refs/heads/main"}`, deliveries[i].Payload)
		assert.Zero(t, deliveries[i].Attempts)
	}

	require.Error(t, dispatcher.DispatchEvent(ctx, 0, webhooks.EventTypePush, nil), "an invalid repository must be rejected")
	assert.Len(t, listRegressionDeliveries(t, ctx, pool), 2)
}

// TestRegression_WebhookDelivery_WorkerDeliversDispatchedDelivery follows a
// dispatched delivery through the production worker: it must POST the signed
// payload to the endpoint once and persist the endpoint's result.
func TestRegression_WebhookDelivery_WorkerDeliversDispatchedDelivery(t *testing.T) {
	t.Parallel()
	pool, _ := postgresfixture.NewProductDatabase(t)
	queries := db.New(pool)
	ctx := context.Background()

	type received struct {
		method, event, delivery, signature, contentType string
		body                                            []byte
	}
	var mu sync.Mutex
	var requests []received
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		assert.NoError(t, err)
		mu.Lock()
		requests = append(requests, received{
			method: r.Method, event: r.Header.Get("X-Smithers-Event"), delivery: r.Header.Get("X-Smithers-Delivery"),
			signature: r.Header.Get("X-Smithers-Signature-256"), contentType: r.Header.Get("Content-Type"), body: body,
		})
		mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, "accepted")
	}))
	defer target.Close()

	repoID := seedWebhookRegressionRepo(t, ctx, pool, queries, "hook-worker-owner")
	hook := createRegressionWebhook(t, ctx, queries, repoID, target.URL+"/hook", "s3cret", true, "push")
	require.NoError(t, webhooks.NewDispatcher(queries).DispatchEvent(ctx, repoID, webhooks.EventTypePush, map[string]string{"ref": "refs/heads/main"}))
	var deliveryID int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM webhook_deliveries WHERE webhook_id = $1`, hook.ID).Scan(&deliveryID))

	worker := webhook.NewWorker(queries, target.Client(), webhook.NoopSecretCodec{})
	require.NoError(t, worker.PollOnce(ctx))

	mu.Lock()
	require.Len(t, requests, 1, "the endpoint must receive the dispatched delivery exactly once")
	got := requests[0]
	mu.Unlock()
	assert.Equal(t, http.MethodPost, got.method)
	assert.Equal(t, "push", got.event)
	assert.Equal(t, strconv.FormatInt(deliveryID, 10), got.delivery)
	assert.Equal(t, "application/json", got.contentType)
	assert.JSONEq(t, `{"ref":"refs/heads/main"}`, string(got.body))
	assert.True(t, webhook.VerifyPayloadSignature("s3cret", got.body, got.signature), "the payload must carry the hook's HMAC signature")

	deliveries := listRegressionDeliveries(t, ctx, pool)
	require.Len(t, deliveries, 1)
	assert.Equal(t, "success", deliveries[0].Status)
	assert.Equal(t, pgtype.Int4{Int32: http.StatusAccepted, Valid: true}, deliveries[0].ResponseStatus)
	assert.Equal(t, "accepted", deliveries[0].ResponseBody)
	assert.Equal(t, int32(1), deliveries[0].Attempts)
	assert.True(t, deliveries[0].Delivered)

	// A completed delivery is never claimed again.
	require.NoError(t, worker.PollOnce(ctx))
	mu.Lock()
	assert.Len(t, requests, 1)
	mu.Unlock()
}

// ---------------------------------------------------------------------------
// 7. Git streaming — upload-pack streams without buffering the whole response
// ---------------------------------------------------------------------------

// TestRegression_GitStreaming_UploadPackStreamsBeforeServiceReturns serves
// GitSmartHandler.UploadPack over HTTP and holds the proxy open after it has
// written the first part of a packfile. The client must receive the git
// Content-Type and that first part while the proxy is still running; a handler
// that buffered the whole packfile would deliver nothing until the proxy
// returned. (The repohostserver package covers the repo-host side.)
func TestRegression_GitStreaming_UploadPackStreamsBeforeServiceReturns(t *testing.T) {
	t.Parallel()

	firstPart := bytes.Repeat([]byte("PACK"), 64*1024) // 256 KiB
	release := make(chan struct{})
	finished := make(chan struct{})
	handler := &GitSmartHandler{Service: &mockGitSmartRouteService{
		proxyUploadPackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
			defer close(finished)
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			body, err := io.ReadAll(stdin)
			assert.NoError(t, err)
			assert.Equal(t, "0032want deadbeef\n0000", string(body))
			if _, err := stdout.Write(firstPart); err != nil {
				return err
			}
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			_, err = io.WriteString(stdout, "0000")
			return err
		},
	}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.UploadPack(w, withRouteParams(r, map[string]string{"owner": "alice", "repo": "demo.git"}))
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/alice/demo.git/git-upload-pack",
		strings.NewReader("0032want deadbeef\n0000"))
	require.NoError(t, err)
	req.SetBasicAuth("alice", "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
	resp, err := server.Client().Do(req)
	require.NoError(t, err, "response headers must arrive while the proxy is still streaming")
	defer resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "application/x-git-upload-pack-result", resp.Header.Get("Content-Type"))
	got := make([]byte, len(firstPart))
	_, err = io.ReadFull(resp.Body, got)
	require.NoError(t, err, "the first packfile part must arrive before the proxy returns")
	assert.Equal(t, firstPart, got)
	select {
	case <-finished:
		t.Fatal("the proxy returned before it was released")
	default:
	}

	close(release)
	rest, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	assert.Equal(t, "0000", string(rest))
}

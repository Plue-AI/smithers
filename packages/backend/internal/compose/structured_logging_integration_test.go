package compose

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/database"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func captureStructuredLogs(t *testing.T, req *http.Request) (int, string) {
	t.Helper()

	buf := installLogCapture(t)
	rec := httptest.NewRecorder()
	defaultRouter(nil).ServeHTTP(rec, req)
	return rec.Code, buf.String()
}

// installLogCapture redirects slog.Default() into a buffer for the rest of
// the test. It must run BEFORE buildRouter: the router binds slog.Default()
// to StructuredLogger at construction time.
func installLogCapture(t *testing.T) *syncBuffer {
	t.Helper()
	buf := &syncBuffer{}
	originalLogger := slog.Default()
	slog.SetDefault(slog.New(middleware.NewGCPJSONHandler(buf, slog.LevelInfo)))
	t.Cleanup(func() { slog.SetDefault(originalLogger) })
	return buf
}

// serveCapturingLogs serves req through router and returns the status code
// plus only the log output produced while serving it.
func serveCapturingLogs(router http.Handler, buf *syncBuffer, req *http.Request) (int, string) {
	before := len(buf.String())
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec.Code, buf.String()[before:]
}

// accessLogEntry finds the "http request" access-log line in logs.
func accessLogEntry(t *testing.T, logs string) map[string]any {
	t.Helper()
	for _, line := range strings.Split(strings.TrimSpace(logs), "\n") {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry["message"] == "http request" {
			return entry
		}
	}
	require.FailNow(t, "no access log line found", "logs:\n%s", logs)
	return nil
}

func TestStructuredLogging_RequestIDCorrelatesInLogs(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("X-Request-Id", "structured-log-correlation-123")

	status, logs := captureStructuredLogs(t, req)

	require.Equal(t, http.StatusOK, status)
	require.NotEmpty(t, logs)

	// Parse JSON log entry
	var logEntry map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(logs), &logEntry))

	// Verify request_id is present and matches
	labels, ok := logEntry["labels"].(map[string]interface{})
	require.True(t, ok, "log entry should have labels")
	assert.Equal(t, "structured-log-correlation-123", labels["request_id"])
}

func TestStructuredLogging_LogsAreValidJSON(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("X-Request-Id", "structured-log-json-check")

	status, logs := captureStructuredLogs(t, req)

	require.Equal(t, http.StatusOK, status)
	require.NotEmpty(t, logs)
	assert.True(t, json.Valid([]byte(logs)), "logs should be valid JSON")

	var logEntry map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(logs), &logEntry))

	// Verify GCP severity field
	assert.NotEmpty(t, logEntry["severity"], "should have severity field")
	assert.NotEmpty(t, logEntry["httpRequest"], "should have httpRequest field")
}

func TestStructuredLogging_IncludesRequestID(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("X-Request-Id", "structured-log-request-id-check")
	req.Header.Set("Traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")

	status, logs := captureStructuredLogs(t, req)

	require.Equal(t, http.StatusOK, status)
	require.NotEmpty(t, logs)

	var logEntry map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(logs), &logEntry))

	// Verify request_id is in labels
	labels, ok := logEntry["labels"].(map[string]interface{})
	require.True(t, ok, "log entry should have labels")
	assert.Equal(t, "structured-log-request-id-check", labels["request_id"])
}

func TestStructuredLogging_NotFoundPath(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/does-not-exist", nil)
	req.Header.Set("X-Request-Id", "structured-log-404-check")

	status, logs := captureStructuredLogs(t, req)

	require.Equal(t, http.StatusNotFound, status)
	require.NotEmpty(t, logs)

	var logEntry map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(logs), &logEntry))

	// Verify request ID in labels
	labels, ok := logEntry["labels"].(map[string]interface{})
	require.True(t, ok, "log entry should have labels")
	assert.Equal(t, "structured-log-404-check", labels["request_id"])

	// Verify httpRequest fields
	httpReq, ok := logEntry["httpRequest"].(map[string]interface{})
	require.True(t, ok, "log entry should have httpRequest")
	assert.Equal(t, float64(404), httpReq["status"])
}

// ---------------------------------------------------------------------------
// R005: the access log names the authenticated user (live database)
// ---------------------------------------------------------------------------

// TestStructuredLogging_AuthenticatedRequestCarriesUserID drives the real
// router (global StructuredLogger, then /api's AuthLoader backed by a live
// *db.Queries) with a personal access token and asserts the access log carries
// the token's user. Before the fix the logger only saw the pre-auth context.
func TestStructuredLogging_AuthenticatedRequestCarriesUserID(t *testing.T) {
	ctx := context.Background()
	// The production pool constructor: it registers the sqlc type overrides
	// (tsvector as text) that the generated user queries depend on.
	pool, err := database.NewPool(ctx, config.DatabaseConfig{
		URL: testDatabaseURL(t), MaxConns: 4, MaxConnLifetime: 60, MaxConnIdleTime: 30,
	})
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	queries := db.New(pool)
	buf := installLogCapture(t)

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	user, err := queries.CreateUser(ctx, db.CreateUserParams{
		Username:      "accesslog-" + suffix,
		LowerUsername: "accesslog-" + suffix,
		DisplayName:   "Access Log",
	})
	require.NoError(t, err)

	var raw [20]byte
	_, err = rand.Read(raw[:])
	require.NoError(t, err)
	token := "smithers_" + hex.EncodeToString(raw[:])
	sum := sha256.Sum256([]byte(token))
	_, err = queries.CreateAccessToken(ctx, db.CreateAccessTokenParams{
		UserID:         user.ID,
		Name:           "access-log-" + suffix,
		TokenHash:      hex.EncodeToString(sum[:]),
		TokenLastEight: token[len(token)-8:],
		Scopes:         "read:user",
		ExpiresAt:      pgtype.Timestamptz{},
	})
	require.NoError(t, err)

	router := buildRouterCompat(
		testConfigAllFlagsOn(),
		queries,
		nil, // pool
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{ProfileService: services.NewUserService(queries)},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, // admin handlers
		nil, nil, nil, nil, // webhook, secret, variable, commitStatus
		nil, nil, nil, nil, nil, nil, // lfs, jjVCS, agentInternal, agentSession, agentSessionStream, pushHook
		nil, nil, nil, nil, // workflow, workspace, workspaceInternal, workspaceTerminal
		nil, nil, nil, // telemetry, featureFlag, oauth2
		nil, // smithersMetrics
	)

	req := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Request-Id", "access-log-user-"+suffix)

	status, logs := serveCapturingLogs(router, buf, req)
	require.Equal(t, http.StatusOK, status, "logs:\n%s", logs)

	entry := accessLogEntry(t, logs)
	labels, ok := entry["labels"].(map[string]any)
	require.True(t, ok, "log entry should have labels: %v", entry)
	assert.Equal(t, "access-log-user-"+suffix, labels["request_id"])
	assert.Equal(t, fmt.Sprintf("%d", user.ID), labels["user_id"], "access log must name the PAT's user")
	assert.NotContains(t, logs, token, "the raw token must never be logged")
}

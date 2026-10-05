package security_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/controlstore"
	"github.com/smithersai/smithers/packages/backend/security"
	"github.com/stretchr/testify/require"
)

func TestPublicSharedBearerGateRefusesWithoutDisclosure(t *testing.T) {
	for _, row := range []struct {
		expected, header string
		allowed          bool
	}{
		{"", "Bearer fixture", false}, {"fixture", "", false}, {"fixture", "Basic fixture", false},
		{"fixture", "Bearer", false}, {"fixture", "Bearer wrong", false}, {"fixture", "Bearer fixture extra", false},
		{"fixture", "Bearer  fixture", false}, {"fixture", " Bearer fixture", false},
		{"fixture", "Bearer fixture", true}, {"fixture", "bEaReR fixture", true},
	} {
		calls := 0
		handler := security.RequireSharedBearerToken(row.expected)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			w.WriteHeader(204)
		}))
		request := httptest.NewRequest("POST", "/internal", nil)
		request.Header.Set("Authorization", row.header)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if row.allowed {
			require.Equal(t, 204, recorder.Code)
			require.Equal(t, 1, calls)
		} else {
			require.Zero(t, calls)
			require.Equal(t, 401, recorder.Code)
			require.Equal(t, "application/json", recorder.Header().Get("Content-Type"))
			require.JSONEq(t, `{"code":"unauthorized","class":"permission","fault":"user","message":"this endpoint requires its shared bearer token"}`, recorder.Body.String())
		}
	}
}

// Explicit no-SQL query unit fake, implementing the exported authentication
// port. It returns typed outcomes, never a pool or a SQL expectation.
type agentQueryUnit struct {
	run   controlstore.WorkflowRun
	err   error
	calls int
	hash  pgtype.Text
	ctx   context.Context
}

func (q *agentQueryUnit) GetWorkflowRunByAgentToken(ctx context.Context, hash pgtype.Text) (controlstore.WorkflowRun, error) {
	q.calls++
	q.hash = hash
	q.ctx = ctx
	return q.run, q.err
}

const publicAgentFixtureToken = "smithers_agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const publicAgentFixtureHash = "8c32349e96edb7d507e991596548a3a33ff16f731fa5a790ae9e65a61700333c"

func TestPublicAgentTokenMalformedCredentialsNeverQueryOrDispatch(t *testing.T) {
	for _, header := range []string{"", "Basic " + publicAgentFixtureToken, "Bearer", "Bearer short", "Bearer " + publicAgentFixtureToken + " extra",
		"Bearer smithers_agent_" + strings.Repeat("a", 39), "Bearer smithers_agent_" + strings.Repeat("a", 41),
		"Bearer smithers_agent_" + strings.Repeat("A", 40), "Bearer smithers_agent_" + strings.Repeat("g", 40)} {
		query := &agentQueryUnit{}
		dispatches := 0
		handler := security.RequireAgentToken(query)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { dispatches++ }))
		request := httptest.NewRequest("POST", "/agent", nil)
		request.Header.Set("Authorization", header)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		require.Zero(t, query.calls)
		require.Zero(t, dispatches)
		require.Equal(t, 401, recorder.Code)
		require.JSONEq(t, `{"code":"unauthorized","class":"permission","fault":"user","message":"invalid or missing agent token"}`, recorder.Body.String())
	}
}

func TestPublicAgentTokenLookupExpiryAndTerminalRefusalsStayClosed(t *testing.T) {
	for _, row := range []struct {
		name, status, message string
		err                   error
		expired               bool
		statusCode            int
	}{
		{"missing record", "running", "invalid or expired agent token", pgx.ErrNoRows, false, 401},
		{"query failure", "running", "internal server error", errors.New("unit-only private query failure"), false, 500},
		{"expired", "running", "agent token expired", nil, true, 401},
		{"success", "success", "agent token no longer valid: workflow run is terminal", nil, false, 401},
		{"failure", "failure", "agent token no longer valid: workflow run is terminal", nil, false, 401},
		{"cancelled", "cancelled", "agent token no longer valid: workflow run is terminal", nil, false, 401},
		{"error", "error", "agent token no longer valid: workflow run is terminal", nil, false, 401},
	} {
		t.Run(row.name, func(t *testing.T) {
			query := &agentQueryUnit{run: controlstore.WorkflowRun{ID: 7, Status: row.status,
				AgentTokenHash: pgtype.Text{String: publicAgentFixtureHash, Valid: true}}, err: row.err}
			if row.expired {
				query.run.AgentTokenExpiresAt = pgtype.Timestamptz{Time: time.Unix(0, 0), Valid: true}
			}
			dispatches := 0
			handler := security.RequireAgentToken(query)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { dispatches++ }))
			request := httptest.NewRequest("POST", "/agent", nil)
			request.Header.Set("Authorization", "Bearer "+publicAgentFixtureToken)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			require.Equal(t, 1, query.calls)
			require.Equal(t, pgtype.Text{String: publicAgentFixtureHash, Valid: true}, query.hash)
			require.Zero(t, dispatches)
			require.Equal(t, row.statusCode, recorder.Code)
			class, fault, code := `"class":"permission",`, "user", "unauthorized"
			if row.statusCode == 500 {
				class, fault, code = "", "bug", "internal"
			}
			require.JSONEq(t, `{"code":"`+code+`",`+class+`"fault":"`+fault+`","message":"`+row.message+`"}`, recorder.Body.String())
			require.NotContains(t, recorder.Body.String(), publicAgentFixtureToken)
		})
	}
	request := httptest.NewRequest("POST", "/agent", nil)
	request.Header.Set("Authorization", "Bearer "+publicAgentFixtureToken)
	recorder := httptest.NewRecorder()
	security.RequireAgentToken(nil)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("missing query port dispatched") })).ServeHTTP(recorder, request)
	require.Equal(t, 500, recorder.Code)
	require.JSONEq(t, `{"code":"internal","fault":"bug","message":"internal server error"}`, recorder.Body.String())
}

func TestPublicAgentTokenAdmitsActiveRunAndPreservesContext(t *testing.T) {
	type marker struct{}
	for _, expiresValid := range []bool{false, true} {
		query := &agentQueryUnit{run: controlstore.WorkflowRun{ID: 7, Status: "running", AgentTokenHash: pgtype.Text{String: publicAgentFixtureHash, Valid: true},
			AgentTokenExpiresAt: pgtype.Timestamptz{Time: time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC), Valid: expiresValid}}}
		ctx := context.WithValue(t.Context(), marker{}, "request marker")
		dispatches := 0
		handler := security.RequireAgentToken(query)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			dispatches++
			require.Equal(t, "request marker", r.Context().Value(marker{}))
			require.Equal(t, publicAgentFixtureToken, security.AgentTokenFromContext(r.Context()))
			require.Equal(t, query.run, *security.WorkflowRunFromContext(r.Context()))
			w.WriteHeader(204)
		}))
		request := httptest.NewRequest("POST", "/agent", nil).WithContext(ctx)
		request.Header.Set("Authorization", " bEaReR\t "+publicAgentFixtureToken+" ")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		require.Equal(t, 204, recorder.Code)
		require.Equal(t, 1, dispatches)
		require.Equal(t, 1, query.calls)
		require.Equal(t, publicAgentFixtureHash, query.hash.String)
		require.Equal(t, publicAgentFixtureToken, security.AgentTokenFromContext(query.ctx))
		require.Empty(t, security.AgentTokenFromContext(ctx))
		require.Nil(t, security.WorkflowRunFromContext(ctx))
	}
}

func TestPublicAgentTokenCanceledQueryNeverDispatches(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	query := &agentQueryUnit{err: context.Canceled}
	handler := security.RequireAgentToken(query)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("cancelled query dispatched agent work") }))
	request := httptest.NewRequest("POST", "/agent", nil).WithContext(ctx)
	request.Header.Set("Authorization", "Bearer "+publicAgentFixtureToken)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	require.Equal(t, 1, query.calls)
	require.ErrorIs(t, query.ctx.Err(), context.Canceled)
	require.Equal(t, 500, recorder.Code)
	require.JSONEq(t, `{"code":"internal","fault":"bug","message":"internal server error"}`, recorder.Body.String())
}

func TestPublicSecurityContextLoggingAndCredentialFinding(t *testing.T) {
	base := t.Context()
	run := &controlstore.WorkflowRun{ID: 9, Status: "running"}
	ctx := security.ContextWithWorkflowRun(security.ContextWithAgentToken(base, "unit-only secret"), run)
	require.Same(t, run, security.WorkflowRunFromContext(ctx))
	require.Equal(t, "unit-only secret", security.AgentTokenFromContext(ctx))
	require.Nil(t, security.WorkflowRunFromContext(base))
	require.Empty(t, security.AgentTokenFromContext(base))
	previous := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previous) })
	var output bytes.Buffer
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	security.LoggerWithWorkflowRun(ctx, 9).Info("one")
	security.LoggerWithAgentSessionAndWorkflowRun(ctx, "session", 9).Info("two")
	decoder := json.NewDecoder(&output)
	for _, expectedSession := range []string{"", "session"} {
		var record map[string]any
		require.NoError(t, decoder.Decode(&record))
		require.Equal(t, float64(9), record["workflow_run_id"])
		if expectedSession == "" {
			require.NotContains(t, record, "agent_session_id")
		} else {
			require.Equal(t, expectedSession, record["agent_session_id"])
		}
		encoded, err := json.Marshal(record)
		require.NoError(t, err)
		require.NotContains(t, string(encoded), "unit-only secret")
	}
	require.Nil(t, security.ScanForCredentialMaterial("token=process.env.MY_SECRET\nsafe text"))
	finding := security.ScanForCredentialMaterial("safe line\nBearer NNNNNNNNNNNNNNNNNNNN")
	require.Equal(t, &security.CredentialFinding{Rule: "bearer_literal", Hint: "a literal bearer token", Line: 2}, finding)
	encoded, err := json.Marshal(finding)
	require.NoError(t, err)
	require.Equal(t, `{"rule":"bearer_literal","hint":"a literal bearer token","line":2}`, string(encoded))
	require.NotContains(t, string(encoded), "NNNNNNNNNNNNNNNNNNNN")
}

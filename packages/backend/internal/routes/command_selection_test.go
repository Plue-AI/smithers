package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// selectionFake answers SelectCommands from its fields; with block it waits
// for the call's context to end and returns its error.
type selectionFake struct {
	calls  atomic.Int32
	got    ports.CommandSelectionRequest
	result ports.CommandSelectionResult
	err    error
	block  bool
}

func (f *selectionFake) Recommend(context.Context, ports.RecommendationRequest) (ports.RecommendationResult, error) {
	return ports.RecommendationResult{}, errors.New("selectionFake does not recommend")
}

func (f *selectionFake) SelectCommands(ctx context.Context, request ports.CommandSelectionRequest) (ports.CommandSelectionResult, error) {
	f.calls.Add(1)
	f.got = request
	if f.block {
		<-ctx.Done()
		return ports.CommandSelectionResult{}, fmt.Errorf("Jev call: %w", ctx.Err())
	}
	return f.result, f.err
}

const selectBody = `{"message":"review my change","tail":[{"role":"user","text":"hi"}],"repo":"owner/created","commands":[{"name":"review","summary":"Review"},{"name":"land","summary":"Land"}]}`

func postSelect(handler *RecommendationHandler, body string, signed bool) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/api/commands/select", strings.NewReader(body))
	if signed {
		request = signedIn(request)
	}
	rec := httptest.NewRecorder()
	handler.Select(rec, request)
	return rec
}

func selectionCommands(n int) string {
	commands := make([]string, n)
	for i := range commands {
		commands[i] = fmt.Sprintf(`{"name":"c%d","summary":"s"}`, i)
	}
	return "[" + strings.Join(commands, ",") + "]"
}

func TestSelectHandler_RejectsInvalidRequestsBeforeCallingJev(t *testing.T) {
	long := strings.Repeat("x", 4001)
	tail13 := strings.TrimSuffix(strings.Repeat(`{"role":"user","text":"t"},`, 13), ",")
	for name, body := range map[string]string{
		"empty message":        `{"message":"","tail":[],"repo":null,"commands":[{"name":"review","summary":"Review"}]}`,
		"blank message":        `{"message":" \n\t","tail":[],"repo":null,"commands":[{"name":"review","summary":"Review"}]}`,
		"long message":         `{"message":"` + long + `","tail":[],"repo":null,"commands":[{"name":"review","summary":"Review"}]}`,
		"too many tail":        `{"message":"hi","tail":[` + tail13 + `],"repo":null,"commands":[{"name":"review","summary":"Review"}]}`,
		"long tail text":       `{"message":"hi","tail":[{"role":"user","text":"` + long + `"}],"repo":null,"commands":[{"name":"review","summary":"Review"}]}`,
		"bad role":             `{"message":"hi","tail":[{"role":"tool","text":"t"}],"repo":null,"commands":[{"name":"review","summary":"Review"}]}`,
		"no commands":          `{"message":"hi","tail":[],"repo":null,"commands":[]}`,
		"too many commands":    `{"message":"hi","tail":[],"repo":null,"commands":` + selectionCommands(301) + `}`,
		"duplicate names":      `{"message":"hi","tail":[],"repo":null,"commands":[{"name":"review","summary":"a"},{"name":"review","summary":"b"}]}`,
		"blank name":           `{"message":"hi","tail":[],"repo":null,"commands":[{"name":" ","summary":"a"}]}`,
		"long name":            `{"message":"hi","tail":[],"repo":null,"commands":[{"name":"` + strings.Repeat("n", 161) + `","summary":"a"}]}`,
		"long summary":         `{"message":"hi","tail":[],"repo":null,"commands":[{"name":"n","summary":"` + strings.Repeat("s", 513) + `"}]}`,
		"unknown field":        `{"message":"hi","tail":[],"repo":null,"commands":[{"name":"review","summary":"Review"}],"model":{"modelId":"typesafe-ai/jev"}}`,
		"repo without owner":   `{"message":"hi","tail":[],"repo":"created","commands":[{"name":"review","summary":"Review"}]}`,
		"repo with three":      `{"message":"hi","tail":[],"repo":"a/b/c","commands":[{"name":"review","summary":"Review"}]}`,
		"repo dot segment":     `{"message":"hi","tail":[],"repo":"../b","commands":[{"name":"review","summary":"Review"}]}`,
		"trailing document":    `{"message":"hi","tail":[],"repo":null,"commands":[{"name":"review","summary":"Review"}]} {}`,
		"not json":             `message=hi`,
		"oversized body (cap)": `{"message":"hi","tail":[],"repo":null,"commands":[{"name":"review","summary":"` + strings.Repeat("s", 256<<10) + `"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			provider := &selectionFake{}
			rec := postSelect(NewRecommendationHandler(provider, nil, nil), body, true)
			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			require.JSONEq(t, `{"status":"error","code":"request_invalid"}`, rec.Body.String())
			require.Zero(t, provider.calls.Load())
		})
	}
}

func TestSelectHandler_AcceptsTheContractBoundaries(t *testing.T) {
	for name, body := range map[string]string{
		"300 commands, null repo, no tail": `{"message":"hi","tail":[],"repo":null,"commands":` + selectionCommands(300) + `}`,
		"4000-char message, 12 tail":       `{"message":"` + strings.Repeat("é", 4000) + `","tail":[` + strings.TrimSuffix(strings.Repeat(`{"role":"assistant","text":"t"},`, 12), ",") + `],"repo":"o.w-n_er/re.po","commands":[{"name":"review","summary":"Review"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			provider := &selectionFake{result: ports.CommandSelectionResult{Model: ports.RecommendationModelID}}
			rec := postSelect(NewRecommendationHandler(provider, nil, nil), body, true)
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			require.JSONEq(t, `{"commands":[],"model":"typesafe-ai/jev"}`, rec.Body.String())
			require.EqualValues(t, 1, provider.calls.Load())
		})
	}
}

func TestSelectHandler_ReturnsOnlyOfferedCommandsByProbability(t *testing.T) {
	selected := []ports.SelectedCommand{
		{Name: "land", Probability: 0.3}, {Name: "fabricated", Probability: 0.99}, {Name: "none", Probability: 0.9},
		{Name: "review", Probability: 0.7}, {Name: "land", Probability: 0.1}, {Name: "help", Probability: 0.019},
	}
	for i := range 14 {
		selected = append(selected, ports.SelectedCommand{Name: fmt.Sprintf("c%d", i), Probability: 0.05 + float64(i)/1000})
	}
	commands := `[{"name":"review","summary":"Review"},{"name":"land","summary":"Land"},{"name":"help","summary":"Help"},{"name":"none","summary":"A command named none"}`
	for i := range 14 {
		commands += fmt.Sprintf(`,{"name":"c%d","summary":"s"}`, i)
	}
	commands += "]"
	provider := &selectionFake{result: ports.CommandSelectionResult{Commands: selected, Model: ports.RecommendationModelID}}
	rec := postSelect(NewRecommendationHandler(provider, nil, nil), `{"message":" review it ","tail":[],"repo":"owner/created","commands":`+commands+`}`, true)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		Commands []ports.SelectedCommand `json:"commands"`
		Model    string                  `json:"model"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, ports.RecommendationModelID, body.Model)
	require.Len(t, body.Commands, ports.CommandSelectionMax)
	require.Equal(t, ports.SelectedCommand{Name: "review", Probability: 0.7}, body.Commands[0])
	require.Equal(t, ports.SelectedCommand{Name: "land", Probability: 0.3}, body.Commands[1], "a repeated name keeps its highest probability")
	for i, command := range body.Commands[2:] {
		require.Equal(t, fmt.Sprintf("c%d", 13-i), command.Name, "descending, capped at 12")
	}
	require.NotContains(t, rec.Body.String(), "fabricated")
	require.NotContains(t, rec.Body.String(), `"none"`)
	require.NotContains(t, rec.Body.String(), `"help"`, "below 0.02")
	require.Equal(t, "review it", provider.got.Message)
	require.Equal(t, "owner/created", *provider.got.Repo)
}

func TestSelectHandler_MapsErrorsToCodes(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"insufficient credit", credits.ErrInsufficient, http.StatusPaymentRequired, "out_of_credit"},
		{"sealed account", fmt.Errorf("wrapped: %w", credits.ErrSealed), http.StatusPaymentRequired, "out_of_credit"},
		{"spend cap", modelproxy.ErrSpendCapReached, http.StatusTooManyRequests, "spend_cap_reached"},
		{"credential missing", errors.Join(modelproxy.ErrNotCharged, ports.ErrModelCredentialMissing), http.StatusServiceUnavailable, "credential_missing"},
		{"deadline", fmt.Errorf("Jev call: %w", context.DeadlineExceeded), http.StatusGatewayTimeout, "select_timeout"},
		{"http error", errors.Join(modelproxy.ErrNotCharged, errors.New("Jev answered HTTP 500")), http.StatusBadGateway, "select_failed"},
		{"no answers", errors.New("Jev returned no decision"), http.StatusBadGateway, "select_failed"},
		{"canceled", context.Canceled, http.StatusBadGateway, "select_failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := postSelect(NewRecommendationHandler(&selectionFake{err: tc.err}, nil, nil), selectBody, true)
			require.Equal(t, tc.status, rec.Code)
			require.JSONEq(t, `{"status":"error","code":"`+tc.code+`"}`, rec.Body.String())
			if tc.code == "spend_cap_reached" {
				require.Equal(t, modelproxy.SpendCapRetryAfter, rec.Header().Get("Retry-After"))
			}
		})
	}
	t.Run("answer without model", func(t *testing.T) {
		rec := postSelect(NewRecommendationHandler(&selectionFake{}, nil, nil), selectBody, true)
		require.Equal(t, http.StatusBadGateway, rec.Code)
		require.JSONEq(t, `{"status":"error","code":"select_failed"}`, rec.Body.String())
	})
}

func TestSelectHandler_TimesOutAtTheDeadline(t *testing.T) {
	provider := &selectionFake{block: true}
	handler := NewRecommendationHandler(provider, nil, nil)
	handler.SelectDeadline = 50 * time.Millisecond
	started := time.Now()
	rec := postSelect(handler, selectBody, true)
	elapsed := time.Since(started)
	require.Equal(t, http.StatusGatewayTimeout, rec.Code)
	require.JSONEq(t, `{"status":"error","code":"select_timeout"}`, rec.Body.String())
	require.GreaterOrEqual(t, elapsed, 50*time.Millisecond)
	require.Less(t, elapsed, time.Second)
}

func TestSelectHandler_DefaultsToTheContractDeadline(t *testing.T) {
	require.Equal(t, 1500*time.Millisecond, CommandSelectDeadline)
	var remaining time.Duration
	handler := NewRecommendationHandler(&deadlineProbe{remaining: &remaining}, nil, nil)
	rec := postSelect(handler, selectBody, true)
	require.Equal(t, http.StatusOK, rec.Code)
	require.LessOrEqual(t, remaining, CommandSelectDeadline)
	require.Greater(t, remaining, CommandSelectDeadline-time.Second)
}

type deadlineProbe struct{ remaining *time.Duration }

func (deadlineProbe) Recommend(context.Context, ports.RecommendationRequest) (ports.RecommendationResult, error) {
	return ports.RecommendationResult{}, errors.New("unused")
}

func (p *deadlineProbe) SelectCommands(ctx context.Context, _ ports.CommandSelectionRequest) (ports.CommandSelectionResult, error) {
	deadline, ok := ctx.Deadline()
	if !ok {
		return ports.CommandSelectionResult{}, errors.New("no deadline")
	}
	*p.remaining = time.Until(deadline)
	return ports.CommandSelectionResult{Model: ports.RecommendationModelID}, nil
}

// The route is mounted behind the chat turn's admission boundary.
func TestSelectHandler_AdmissionUsesTheChatTurnBoundary(t *testing.T) {
	provider := &selectionFake{result: ports.CommandSelectionResult{Model: ports.RecommendationModelID}}
	router := chi.NewRouter()
	router.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post("/api/commands/select", NewRecommendationHandler(provider, nil, nil).Select)
	send := func(info *middleware.AuthInfo) int {
		request := httptest.NewRequest(http.MethodPost, "/api/commands/select", bytes.NewBufferString(selectBody))
		if info != nil {
			ctx := context.WithValue(request.Context(), middleware.UserContextKey, info.User)
			request = request.WithContext(middleware.ContextWithAuthInfo(ctx, info))
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, request)
		return rec.Code
	}
	user := &db.User{ID: 42}
	require.Equal(t, http.StatusUnauthorized, send(nil))
	require.Zero(t, provider.calls.Load())
	require.Equal(t, http.StatusForbidden, send(&middleware.AuthInfo{User: user, IsTokenAuth: true, Scopes: middleware.ParseTokenScopes("read:user")}))
	require.Zero(t, provider.calls.Load())
	require.Equal(t, http.StatusOK, send(&middleware.AuthInfo{User: user, IsTokenAuth: true, Scopes: middleware.ParseTokenScopes("write:user")}))
	require.Equal(t, http.StatusOK, send(&middleware.AuthInfo{User: user}))
	require.EqualValues(t, 2, provider.calls.Load())
}

func TestSelectHandler_MetersTheUserAndKeepsNoLog(t *testing.T) {
	meter, account := recommendationMeter(t)
	ctx := context.Background()
	require.NoError(t, meter.Ledger.Grant(ctx, account, "test", 10_000_000, nil))
	provider := &selectionFake{result: ports.CommandSelectionResult{
		Commands: []ports.SelectedCommand{{Name: "review", Probability: 0.9}},
		Model:    ports.RecommendationModelID,
		Usage:    &ports.RecommendationUsage{InputTokens: 1_000, OutputTokens: 3},
	}}
	// No RecommendationLog: selection is never logged.
	handler := NewRecommendationHandler(provider, nil, meter)
	rec := postSelect(handler, selectBody, true)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"commands":[{"name":"review","probability":0.9}],"model":"typesafe-ai/jev"}`, rec.Body.String())
	require.EqualValues(t, 1, provider.calls.Load())
	balance, err := meter.Ledger.Balance(ctx, account)
	require.NoError(t, err)
	require.Equal(t, int64(10_000_000-42_000), balance, "1,000 input tokens at 0.042 USD per million")
	var rows int
	var outcome, source string
	var userID, ownerID int64
	require.NoError(t, meter.Ledger.DB.QueryRow(ctx, `SELECT count(*) OVER (), outcome, source, user_id, owner_id FROM model_usage`).Scan(&rows, &outcome, &source, &userID, &ownerID))
	require.Equal(t, 1, rows)
	require.Equal(t, []any{"succeeded", "recommendation", int64(42), int64(42)}, []any{outcome, source, userID, ownerID})

	rec = postSelect(handler, selectBody, false)
	require.Equal(t, http.StatusUnauthorized, rec.Code, "a platform-key call needs a payer")
	require.EqualValues(t, 1, provider.calls.Load())
}

// A timed-out call is still settled on the request context.
func TestSelectHandler_SettlesATimedOutMeteredCall(t *testing.T) {
	meter, account := recommendationMeter(t)
	ctx := context.Background()
	require.NoError(t, meter.Ledger.Grant(ctx, account, "test", 10_000_000, nil))
	handler := NewRecommendationHandler(&selectionFake{block: true}, nil, meter)
	handler.SelectDeadline = 30 * time.Millisecond
	rec := postSelect(handler, selectBody, true)
	require.Equal(t, http.StatusGatewayTimeout, rec.Code)
	var outcome string
	require.NoError(t, meter.Ledger.DB.QueryRow(ctx, `SELECT outcome FROM model_usage`).Scan(&outcome))
	require.NotEqual(t, "pending", outcome)
}

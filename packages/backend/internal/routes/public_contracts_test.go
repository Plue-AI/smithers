package routes

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

type catalogSource struct{ rows []db.PublicRepository }

func (s catalogSource) ListPublicRepositoryCatalog(context.Context) ([]db.PublicRepository, error) {
	return s.rows, nil
}

type recommendationFake struct {
	got   ports.RecommendationRequest
	usage *ports.RecommendationUsage
}

func (f *recommendationFake) Recommend(_ context.Context, request ports.RecommendationRequest) (ports.RecommendationResult, error) {
	f.got = request
	return ports.RecommendationResult{Commands: []string{"review", "fabricated"}, Model: "fixture-jev", Usage: f.usage}, nil
}

// SelectCommands is not part of the recommendation contract; the selection
// tests use selectionFake.
func (f *recommendationFake) SelectCommands(context.Context, ports.CommandSelectionRequest) (ports.CommandSelectionResult, error) {
	return ports.CommandSelectionResult{}, errors.New("recommendationFake does not select")
}

type recommendationLogFake struct {
	id      string
	outcome string
}

func (f *recommendationLogFake) AppendRecommendation(_ context.Context, _ ports.RecommendationRequest, _ ports.RecommendationResult, digest string) (string, error) {
	f.id = "recommendation-1:" + digest
	return f.id, nil
}
func (f *recommendationLogFake) RecordRecommendationOutcome(_ context.Context, id, command string, _ time.Time) (int, error) {
	if id != f.id {
		return http.StatusNotFound, nil
	}
	f.outcome = command
	return http.StatusNoContent, nil
}

type modelStreamFake struct{ body []byte }

func (f modelStreamFake) RunModelStream(context.Context, ports.ModelStreamGrant) (io.ReadCloser, error) {
	return io.NopCloser(bytes.NewReader(f.body)), nil
}

type missingModelStream struct{}

func (missingModelStream) RunModelStream(context.Context, ports.ModelStreamGrant) (io.ReadCloser, error) {
	return nil, ports.ErrModelCredentialMissing
}

func TestPublicRepositoryCatalog_ReadsTheProductSource(t *testing.T) {
	handler := NewPublicRepositoryCatalog(catalogSource{rows: []db.PublicRepository{{Name: "owner/created", Title: "created", URL: "/owner/created", Summary: "from db"}}})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/public/repos", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"name":"owner/created"`)
	require.NotContains(t, rec.Body.String(), "smithersai/smithers")
}

func recommendationMeter(t *testing.T) (*modelproxy.Meter, int64) {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	ledger := credits.Ledger{DB: pool}
	account, err := ledger.EnsureAccount(context.Background(), "user", 42)
	require.NoError(t, err)
	return &modelproxy.Meter{Ledger: ledger}, account
}

func signedIn(r *http.Request) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), middleware.UserContextKey, &db.User{ID: 42}))
}

func TestRecommendationHandler_CallsProviderMetersAndPersistsReceipt(t *testing.T) {
	meter, account := recommendationMeter(t)
	ctx := context.Background()
	require.NoError(t, meter.Ledger.Grant(ctx, account, "test", 10_000_000, nil))
	provider := &recommendationFake{usage: &ports.RecommendationUsage{InputTokens: 1_000, OutputTokens: 3}}
	log := &recommendationLogFake{}
	handler := NewRecommendationHandler(provider, log, meter)
	rec := httptest.NewRecorder()
	body := `{"repo":"owner/created","tail":[{"role":"user","text":"review this"}],"commands":[{"name":"review","summary":"Review"}]}`
	handler.Recommend(rec, signedIn(httptest.NewRequest(http.MethodPost, "/api/recommend", bytes.NewBufferString(body))))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"commands":["review"]`)
	require.NotContains(t, rec.Body.String(), "fabricated")
	require.Equal(t, "owner/created", *provider.got.Repo)
	// Jev is priced per input token: 1,000 tokens at 0.042 USD per million.
	balance, err := meter.Ledger.Balance(ctx, account)
	require.NoError(t, err)
	require.Equal(t, int64(10_000_000-42_000), balance)
	require.NotContains(t, rec.Body.String(), "inputTokens")
	var outcome, source string
	require.NoError(t, meter.Ledger.DB.QueryRow(ctx, `SELECT outcome, source FROM model_usage`).Scan(&outcome, &source))
	require.Equal(t, []string{"succeeded", "recommendation"}, []string{outcome, source})

	rec = httptest.NewRecorder()
	handler.Outcome(rec, httptest.NewRequest(http.MethodPost, "/api/recommend/outcome", bytes.NewBufferString(`{"id":"`+log.id+`","command":"review"}`)))
	require.Equal(t, http.StatusNoContent, rec.Code)
	require.Equal(t, "review", log.outcome)
}

// An answer that reported no token count is charged at the request ceiling.
func TestRecommendationHandler_ChargesTheCeilingWhenJevReportsNoUsage(t *testing.T) {
	meter, account := recommendationMeter(t)
	ctx := context.Background()
	require.NoError(t, meter.Ledger.Grant(ctx, account, "test", 10_000_000, nil))
	handler := NewRecommendationHandler(&recommendationFake{}, &recommendationLogFake{}, meter)
	rec := httptest.NewRecorder()
	handler.Recommend(rec, signedIn(httptest.NewRequest(http.MethodPost, "/api/recommend", bytes.NewBufferString(`{"tail":[],"commands":[{"name":"review","summary":"Review"}]}`))))
	require.Equal(t, http.StatusOK, rec.Code)
	balance, err := meter.Ledger.Balance(ctx, account)
	require.NoError(t, err)
	require.Equal(t, int64(10_000_000-2_688_000), balance, "64,000 input tokens at 0.042 USD per million")
	var outcome string
	require.NoError(t, meter.Ledger.DB.QueryRow(ctx, `SELECT outcome FROM model_usage`).Scan(&outcome))
	require.Equal(t, "succeeded", outcome)
}

func TestRecommendationHandler_RefusesWithoutCreditOrSignIn(t *testing.T) {
	meter, _ := recommendationMeter(t)
	provider := &recommendationFake{}
	handler := NewRecommendationHandler(provider, &recommendationLogFake{}, meter)
	body := `{"tail":[],"commands":[{"name":"review","summary":"Review"}]}`
	rec := httptest.NewRecorder()
	handler.Recommend(rec, httptest.NewRequest(http.MethodPost, "/api/recommend", bytes.NewBufferString(body)))
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	rec = httptest.NewRecorder()
	handler.Recommend(rec, signedIn(httptest.NewRequest(http.MethodPost, "/api/recommend", bytes.NewBufferString(body))))
	require.Equal(t, http.StatusPaymentRequired, rec.Code)
	require.Contains(t, rec.Body.String(), `"code":"out_of_credit"`)
	require.Nil(t, provider.got.Repo)
	require.Empty(t, provider.got.Commands)
}

// The daily spend cap refuses a recommendation as a rate limit with the
// hourly retry, so the app defers instead of asking again (plue#414).
func TestRecommendationHandler_DefersAtTheDailySpendCap(t *testing.T) {
	meter, account := recommendationMeter(t)
	require.NoError(t, meter.Ledger.Grant(context.Background(), account, "test", 10_000_000, nil))
	meter.DailyCapNanos = 1
	provider := &recommendationFake{}
	handler := NewRecommendationHandler(provider, &recommendationLogFake{}, meter)
	rec := httptest.NewRecorder()
	handler.Recommend(rec, signedIn(httptest.NewRequest(http.MethodPost, "/api/recommend", bytes.NewBufferString(`{"tail":[],"commands":[{"name":"review","summary":"Review"}]}`))))
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	require.Equal(t, modelproxy.SpendCapRetryAfter, rec.Header().Get("Retry-After"))
	require.Contains(t, rec.Body.String(), `"code":"spend_cap_reached"`)
	require.Empty(t, provider.got.Commands)
}

func TestRecommendationHandler_RejectsUnknownModelBinding(t *testing.T) {
	provider := &recommendationFake{}
	handler := NewRecommendationHandler(provider, &recommendationLogFake{}, &modelproxy.Meter{})
	rec := httptest.NewRecorder()
	handler.Recommend(rec, signedIn(httptest.NewRequest(http.MethodPost, "/api/recommend", bytes.NewBufferString(`{"model":{"modelId":"other"},"tail":[],"commands":[]}`))))
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), `"code":"request_invalid"`)
}

func TestModelStreamHandler_ForwardsProviderFrames(t *testing.T) {
	user := &db.User{ID: 42}
	request := httptest.NewRequest(http.MethodPost, "/api/model/stream", bytes.NewBufferString(`{"messages":[{"role":"user","content":"hi"}]}`))
	request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, user))
	rec := httptest.NewRecorder()
	NewModelStreamHandler(modelStreamFake{body: []byte(`{"type":"delta","text":"ok"}`)}).ServeHTTP(rec, request)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"text":"ok"`)
}

func TestModelStreamHandler_ReportsMissingCredential(t *testing.T) {
	user := &db.User{ID: 42}
	request := httptest.NewRequest(http.MethodPost, "/api/model/stream", bytes.NewBufferString(`{"messages":[]}`))
	request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, user))
	rec := httptest.NewRecorder()
	NewModelStreamHandler(missingModelStream{}).ServeHTTP(rec, request)
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	require.Contains(t, rec.Body.String(), `"code":"credential_missing"`)
}

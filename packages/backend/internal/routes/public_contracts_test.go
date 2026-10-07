package routes

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

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

package routes

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockGitSmartRouteService struct {
	proxyInfoRefsFn    func(ctx context.Context, owner, repo, service, token string, stdout io.Writer) (string, error)
	proxyUploadPackFn  func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error
	proxyReceivePackFn func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error
}

func (m *mockGitSmartRouteService) ProxyInfoRefs(ctx context.Context, owner, repo, service, token string, stdout io.Writer) (string, error) {
	if m.proxyInfoRefsFn != nil {
		return m.proxyInfoRefsFn(ctx, owner, repo, service, token, stdout)
	}
	return "", nil
}

func (m *mockGitSmartRouteService) ProxyUploadPack(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
	if m.proxyUploadPackFn != nil {
		return m.proxyUploadPackFn(ctx, owner, repo, token, stdin, stdout)
	}
	return nil
}

func (m *mockGitSmartRouteService) ProxyReceivePack(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
	if m.proxyReceivePackFn != nil {
		return m.proxyReceivePackFn(ctx, owner, repo, token, stdin, stdout)
	}
	return nil
}

func TestGitSmartHandler_InfoRefs_Success(t *testing.T) {
	t.Parallel()

	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyInfoRefsFn: func(ctx context.Context, owner, repo, service, token string, stdout io.Writer) (string, error) {
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, "git-upload-pack", service)
				assert.Equal(t, "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", token)
				_, _ = io.WriteString(stdout, "001e# service=git-upload-pack\n0000")
				return "application/x-git-upload-pack-advertisement", nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/alice/demo.git/info/refs?service=git-upload-pack", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	req.SetBasicAuth("alice", "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
	rec := httptest.NewRecorder()

	handler.InfoRefs(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "application/x-git-upload-pack-advertisement", rec.Header().Get("Content-Type"))
	assert.Equal(t, "001e# service=git-upload-pack\n0000", rec.Body.String())
}

func TestGitSmartHandler_InfoRefs_PassesThroughBearerTokenWithoutPATFormat(t *testing.T) {
	t.Parallel()

	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyInfoRefsFn: func(ctx context.Context, owner, repo, service, token string, stdout io.Writer) (string, error) {
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, "git-upload-pack", service)
				assert.Equal(t, "smithers-repo-host-dev-token", token)
				_, _ = io.WriteString(stdout, "001e# service=git-upload-pack\n0000")
				return "application/x-git-upload-pack-advertisement", nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/alice/demo.git/info/refs?service=git-upload-pack", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	req.Header.Set("Authorization", "Bearer smithers-repo-host-dev-token")
	rec := httptest.NewRecorder()

	handler.InfoRefs(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "application/x-git-upload-pack-advertisement", rec.Header().Get("Content-Type"))
	assert.Equal(t, "001e# service=git-upload-pack\n0000", rec.Body.String())
}

func TestGitSmartHandler_UploadPack_Success(t *testing.T) {
	t.Parallel()

	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyUploadPackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", token)
				body, err := io.ReadAll(stdin)
				require.NoError(t, err)
				assert.Equal(t, "upload-request", string(body))
				_, _ = io.WriteString(stdout, "upload-response")
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewBufferString("upload-request"))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	req.SetBasicAuth("alice", "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
	rec := httptest.NewRecorder()

	handler.UploadPack(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "application/x-git-upload-pack-result", rec.Header().Get("Content-Type"))
	assert.Equal(t, "upload-response", rec.Body.String())
}

// git's remote-curl gzips smart-HTTP request bodies past a size threshold, so
// cloning a many-ref mirror (a large negotiation) arrives with
// Content-Encoding: gzip while small clones arrive as identity. The handler
// must decompress — passing gzip bytes to `git upload-pack` made it exit
// silently and every large clone died with "remote end hung up" (prod,
// 2026-07-05).
func TestGitSmartHandler_UploadPack_GzipRequestBody(t *testing.T) {
	t.Parallel()

	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyUploadPackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
				body, err := io.ReadAll(stdin)
				require.NoError(t, err)
				assert.Equal(t, "upload-request-large-negotiation", string(body), "the proxy must see the DECOMPRESSED negotiation")
				_, _ = io.WriteString(stdout, "upload-response")
				return nil
			},
		},
	}

	var compressed bytes.Buffer
	zw := gzip.NewWriter(&compressed)
	_, err := zw.Write([]byte("upload-request-large-negotiation"))
	require.NoError(t, err)
	require.NoError(t, zw.Close())

	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", &compressed)
	req.Header.Set("Content-Encoding", "gzip")
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	req.SetBasicAuth("alice", "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
	rec := httptest.NewRecorder()

	handler.UploadPack(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "upload-response", rec.Body.String())
}

func TestGitSmartHandler_UploadPack_MalformedGzipBody_BadRequest(t *testing.T) {
	t.Parallel()

	handler := &GitSmartHandler{Service: &mockGitSmartRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewBufferString("not gzip at all"))
	req.Header.Set("Content-Encoding", "gzip")
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	rec := httptest.NewRecorder()

	handler.UploadPack(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestGitSmartHandler_ReceivePack_Success(t *testing.T) {
	t.Parallel()

	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyReceivePackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", token)
				body, err := io.ReadAll(stdin)
				require.NoError(t, err)
				assert.Equal(t, "receive-request", string(body))
				_, _ = io.WriteString(stdout, "receive-response")
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-receive-pack", bytes.NewBufferString("receive-request"))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	req.SetBasicAuth("alice", "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
	rec := httptest.NewRecorder()

	handler.ReceivePack(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "application/x-git-receive-pack-result", rec.Header().Get("Content-Type"))
	assert.Equal(t, "receive-response", rec.Body.String())
}

// Not parallel: overrides the package-level body-size cap. Sequential tests
// finish (and restore the cap via Cleanup) before any parallel test resumes.
func TestGitSmartHandler_ReceivePack_BodyOverLimit_Returns413(t *testing.T) {
	oldMax := maxGitRequestBodySize
	maxGitRequestBodySize = 64
	t.Cleanup(func() { maxGitRequestBodySize = oldMax })

	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyReceivePackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
				// Mirror the real service/client: consume the push body and
				// surface a generic proxy failure when the stream errors.
				if _, err := io.Copy(io.Discard, stdin); err != nil {
					return pkgerrors.Internal("failed to proxy git receive-pack")
				}
				_, _ = io.WriteString(stdout, "receive-response")
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-receive-pack", bytes.NewReader(bytes.Repeat([]byte("x"), 256)))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	rec := httptest.NewRecorder()

	handler.ReceivePack(rec, req)

	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
}

// Not parallel: overrides the package-level body-size cap.
func TestGitSmartHandler_UploadPack_BodyOverLimit_Returns413(t *testing.T) {
	oldMax := maxGitRequestBodySize
	maxGitRequestBodySize = 64
	t.Cleanup(func() { maxGitRequestBodySize = oldMax })

	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyUploadPackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
				if _, err := io.Copy(io.Discard, stdin); err != nil {
					return pkgerrors.Internal("failed to proxy git upload-pack")
				}
				return nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewReader(bytes.Repeat([]byte("x"), 256)))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	rec := httptest.NewRecorder()

	handler.UploadPack(rec, req)

	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
}

// Not parallel: overrides the package-level advertisement cap.
func TestGitSmartHandler_InfoRefs_AdvertisementOverLimit_FailsClosed(t *testing.T) {
	oldMax := maxRefAdvertisementSize
	maxRefAdvertisementSize = 1024
	t.Cleanup(func() { maxRefAdvertisementSize = oldMax })

	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyInfoRefsFn: func(ctx context.Context, owner, repo, service, token string, stdout io.Writer) (string, error) {
				// Mirror the real service/client: surface a generic proxy
				// failure when streaming the advertisement fails.
				if _, err := stdout.Write(bytes.Repeat([]byte("r"), 2048)); err != nil {
					return "", pkgerrors.Internal("failed to proxy git info refs")
				}
				return "application/x-git-upload-pack-advertisement", nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/alice/demo.git/info/refs?service=git-upload-pack", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	rec := httptest.NewRecorder()

	handler.InfoRefs(rec, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestGitSmartHandler_InfoRefs_InvalidService_BadRequest(t *testing.T) {
	t.Parallel()

	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyInfoRefsFn: func(ctx context.Context, owner, repo, service, token string, stdout io.Writer) (string, error) {
				t.Fatal("service should not be called for invalid service query")
				return "", nil
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/alice/demo.git/info/refs?service=git-upload-archive", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	rec := httptest.NewRecorder()

	handler.InfoRefs(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestGitSmartHandler_AuthFailure_SetsWWWAuthenticate(t *testing.T) {
	t.Parallel()

	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyUploadPackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
				return pkgerrors.Unauthorized("authentication required")
			},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewBufferString("upload-request"))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	rec := httptest.NewRecorder()

	handler.UploadPack(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Header().Get("WWW-Authenticate"), "Basic")
}

func TestGitSmartHandler_RepoNotFound_Propagates404(t *testing.T) {
	t.Parallel()

	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyInfoRefsFn: func(ctx context.Context, owner, repo, service, token string, stdout io.Writer) (string, error) {
				return "", pkgerrors.NotFound("repository not found")
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/alice/missing.git/info/refs?service=git-upload-pack", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "missing.git"})
	rec := httptest.NewRecorder()

	handler.InfoRefs(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)
}

// counterValue reads the current value of a prometheus.Counter via the dto model.
func counterValue(t *testing.T, m *SmithersMetrics, command, result string) float64 {
	t.Helper()
	counter, err := m.HTTPGitOperationsTotal.GetMetricWithLabelValues(command, result)
	require.NoError(t, err)
	var metric dto.Metric
	require.NoError(t, counter.Write(&metric))
	return metric.GetCounter().GetValue()
}

// histogramCount reads the sample count from an HTTPGitOperationDurationSeconds histogram.
func histogramCount(t *testing.T, m *SmithersMetrics, command string) uint64 {
	t.Helper()
	observer, err := m.HTTPGitOperationDurationSeconds.GetMetricWithLabelValues(command)
	require.NoError(t, err)
	h := observer.(prometheus.Metric)
	var metric dto.Metric
	require.NoError(t, h.Write(&metric))
	return metric.GetHistogram().GetSampleCount()
}

func TestGitSmartHandler_InfoRefs_Metrics_Success(t *testing.T) {
	t.Parallel()

	m := NewSmithersMetrics()
	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyInfoRefsFn: func(ctx context.Context, owner, repo, service, token string, stdout io.Writer) (string, error) {
				_, _ = io.WriteString(stdout, "refs")
				return "application/x-git-upload-pack-advertisement", nil
			},
		},
		Metrics: m,
	}

	req := httptest.NewRequest(http.MethodGet, "/alice/demo.git/info/refs?service=git-upload-pack", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	rec := httptest.NewRecorder()

	handler.InfoRefs(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, float64(1), counterValue(t, m, "info-refs", "success"))
	assert.Equal(t, float64(0), counterValue(t, m, "info-refs", "error"))
	assert.Equal(t, uint64(1), histogramCount(t, m, "info-refs"))
}

func TestGitSmartHandler_InfoRefs_Metrics_Error(t *testing.T) {
	t.Parallel()

	m := NewSmithersMetrics()
	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyInfoRefsFn: func(ctx context.Context, owner, repo, service, token string, stdout io.Writer) (string, error) {
				return "", pkgerrors.NotFound("not found")
			},
		},
		Metrics: m,
	}

	req := httptest.NewRequest(http.MethodGet, "/alice/demo.git/info/refs?service=git-upload-pack", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	rec := httptest.NewRecorder()

	handler.InfoRefs(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)
	assert.Equal(t, float64(1), counterValue(t, m, "info-refs", "error"))
	assert.Equal(t, float64(0), counterValue(t, m, "info-refs", "success"))
	assert.Equal(t, uint64(1), histogramCount(t, m, "info-refs"))
}

func TestGitSmartHandler_UploadPack_Metrics_Success(t *testing.T) {
	t.Parallel()

	m := NewSmithersMetrics()
	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyUploadPackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
				_, _ = io.WriteString(stdout, "pack-data")
				return nil
			},
		},
		Metrics: m,
	}

	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewBufferString("want"))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	rec := httptest.NewRecorder()

	handler.UploadPack(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, float64(1), counterValue(t, m, "upload-pack", "success"))
	assert.Equal(t, float64(0), counterValue(t, m, "upload-pack", "error"))
	assert.Equal(t, uint64(1), histogramCount(t, m, "upload-pack"))
}

func TestGitSmartHandler_UploadPack_Metrics_Error(t *testing.T) {
	t.Parallel()

	m := NewSmithersMetrics()
	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyUploadPackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
				return pkgerrors.Unauthorized("auth required")
			},
		},
		Metrics: m,
	}

	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewBufferString("want"))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	rec := httptest.NewRecorder()

	handler.UploadPack(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Equal(t, float64(1), counterValue(t, m, "upload-pack", "error"))
	assert.Equal(t, float64(0), counterValue(t, m, "upload-pack", "success"))
	assert.Equal(t, uint64(1), histogramCount(t, m, "upload-pack"))
}

func TestGitSmartHandler_ReceivePack_Metrics_Success(t *testing.T) {
	t.Parallel()

	m := NewSmithersMetrics()
	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyReceivePackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
				_, _ = io.WriteString(stdout, "ok")
				return nil
			},
		},
		Metrics: m,
	}

	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-receive-pack", bytes.NewBufferString("push-data"))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	rec := httptest.NewRecorder()

	handler.ReceivePack(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, float64(1), counterValue(t, m, "receive-pack", "success"))
	assert.Equal(t, float64(0), counterValue(t, m, "receive-pack", "error"))
	assert.Equal(t, uint64(1), histogramCount(t, m, "receive-pack"))
}

func TestGitSmartHandler_ReceivePack_Metrics_Error(t *testing.T) {
	t.Parallel()

	m := NewSmithersMetrics()
	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyReceivePackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
				return pkgerrors.Internal("internal error")
			},
		},
		Metrics: m,
	}

	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-receive-pack", bytes.NewBufferString("push-data"))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	rec := httptest.NewRecorder()

	handler.ReceivePack(rec, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, float64(1), counterValue(t, m, "receive-pack", "error"))
	assert.Equal(t, float64(0), counterValue(t, m, "receive-pack", "success"))
	assert.Equal(t, uint64(1), histogramCount(t, m, "receive-pack"))
}

func TestGitSmartHandler_NilMetrics_DoesNotPanic(t *testing.T) {
	t.Parallel()

	// Existing tests already implicitly cover nil Metrics since they don't set
	// the Metrics field. This test explicitly verifies that behavior.
	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyInfoRefsFn: func(ctx context.Context, owner, repo, service, token string, stdout io.Writer) (string, error) {
				_, _ = io.WriteString(stdout, "refs")
				return "", nil
			},
		},
		// Metrics intentionally nil
	}

	req := httptest.NewRequest(http.MethodGet, "/alice/demo.git/info/refs?service=git-upload-pack", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	rec := httptest.NewRecorder()

	// Must not panic
	handler.InfoRefs(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
}

// A push to a held repository is a 503 git shows, with a Retry-After.
func TestGitSmartHandler_ReceivePack_HeldRepository(t *testing.T) {
	t.Parallel()
	held := errors.New(errors.CodeRepositoryHeld, "repository maintenance is finishing; retry in 5s")
	handler := &GitSmartHandler{
		Service: &mockGitSmartRouteService{
			proxyReceivePackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
				return held
			},
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-receive-pack", bytes.NewBufferString("receive-request"))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo.git"})
	rec := httptest.NewRecorder()

	handler.ReceivePack(rec, req)

	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.Equal(t, "5", rec.Header().Get("Retry-After"))
	assert.Equal(t, "text/plain; charset=utf-8", rec.Header().Get("Content-Type"))
	assert.Equal(t, "repository maintenance is finishing; retry in 5s\n", rec.Body.String())
}

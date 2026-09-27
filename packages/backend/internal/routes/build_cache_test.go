package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/buildcache"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// mockBuildCacheService is a map-backed BuildCacheRouteService: enough of the
// protocol semantics to drive every status code the handler emits.
type mockBuildCacheService struct {
	mu        sync.Mutex
	entries   map[string]buildcache.Publication
	artifacts map[string][]byte
	fail      error
	max       int64
	block     chan struct{}
}

func newMockBuildCacheService() *mockBuildCacheService {
	return &mockBuildCacheService{entries: map[string]buildcache.Publication{}, artifacts: map[string][]byte{}, max: buildcache.DefaultArtifactBodyBytes}
}

func (m *mockBuildCacheService) key(repo int64, k string) string { return string(rune(repo)) + "|" + k }

func (m *mockBuildCacheService) MaxArtifactBytes() int64 { return m.max }

func (m *mockBuildCacheService) GetEntry(_ context.Context, repo int64, k string) (string, bool, error) {
	if m.fail != nil {
		return "", false, m.fail
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.entries[m.key(repo, k)]
	return entry.Body, ok, nil
}

func (m *mockBuildCacheService) PutEntry(_ context.Context, repo int64, k string, p buildcache.Publication) (services.PublicationOutcome, error) {
	if m.fail != nil {
		return "", m.fail
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	existing, ok := m.entries[m.key(repo, k)]
	if !ok {
		m.entries[m.key(repo, k)] = p
		return services.PublicationInserted, nil
	}
	if existing.ResultCanonical == p.ResultCanonical {
		return services.PublicationIdentical, nil
	}
	return services.PublicationConflict, nil
}

func (m *mockBuildCacheService) DeleteEntry(_ context.Context, repo int64, k string, fence *buildcache.Fence) (bool, error) {
	if m.fail != nil {
		return false, m.fail
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.entries[m.key(repo, k)]
	if !ok {
		return false, nil
	}
	if fence != nil && (entry.RecordedRunID == nil || *entry.RecordedRunID != fence.RunID || *entry.RecordedEventSeq != fence.EventSeq) {
		return false, nil
	}
	delete(m.entries, m.key(repo, k))
	return true, nil
}

func (m *mockBuildCacheService) HasArtifact(_ context.Context, repo int64, digest string) (bool, error) {
	if m.fail != nil {
		return false, m.fail
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.artifacts[m.key(repo, digest)]
	return ok, nil
}

func (m *mockBuildCacheService) OpenArtifact(_ context.Context, repo int64, digest string) (io.ReadCloser, int64, bool, error) {
	if m.fail != nil {
		return nil, 0, false, m.fail
	}
	if m.block != nil {
		<-m.block
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	body, ok := m.artifacts[m.key(repo, digest)]
	if !ok {
		return nil, 0, false, nil
	}
	return io.NopCloser(bytes.NewReader(body)), int64(len(body)), true, nil
}

func (m *mockBuildCacheService) PutArtifact(_ context.Context, repo int64, digest string, body []byte) (services.ArtifactOutcome, error) {
	if m.fail != nil {
		return "", m.fail
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.artifacts[m.key(repo, digest)]; ok {
		return services.ArtifactPresent, nil
	}
	m.artifacts[m.key(repo, digest)] = body
	return services.ArtifactInserted, nil
}

func (m *mockBuildCacheService) PresentDigests(_ context.Context, repo int64, digests []string) (map[string]struct{}, error) {
	if m.fail != nil {
		return nil, m.fail
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	present := map[string]struct{}{}
	for _, d := range digests {
		if _, ok := m.artifacts[m.key(repo, d)]; ok {
			present[d] = struct{}{}
		}
	}
	return present, nil
}

func (m *mockBuildCacheService) Health(context.Context) error { return m.fail }

func (m *mockBuildCacheService) CreateReadToken(_ context.Context, actor *db.User, repository *db.Repository, fullName, name, endpoint, namespacePrefix string) (services.BuildCacheReadTokenCreated, error) {
	return services.BuildCacheReadTokenCreated{
		BuildCacheReadTokenResponse: services.BuildCacheReadTokenResponse{ID: 1, Repository: fullName, Name: name, LastEight: "deadbeef"},
		Token:                       buildcache.ReadTokenPrefix + strings.Repeat("0", 32) + "deadbeef",
		Endpoint:                    endpoint,
	}, nil
}

func (m *mockBuildCacheService) ListReadTokens(context.Context, *db.Repository, string) ([]services.BuildCacheReadTokenResponse, error) {
	return []services.BuildCacheReadTokenResponse{{ID: 1, Name: "ci"}}, nil
}

func (m *mockBuildCacheService) RevokeReadToken(_ context.Context, _ *db.Repository, id int64) error {
	if id != 1 {
		return errorsNotFound()
	}
	return nil
}

func (m *mockBuildCacheService) ResolveReadToken(context.Context, string) (db.BuildCacheReadToken, error) {
	return db.BuildCacheReadToken{}, errors.New("unused")
}

func errorsNotFound() error {
	return pkgerrors.NotFound("build cache token not found")
}

func cacheRequest(method, path string, body []byte, contentType string) *http.Request {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if body != nil {
		req.ContentLength = int64(len(body))
	}
	repo := &db.Repository{ID: 7, Name: "app"}
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{Owner: "acme", Repository: repo}, middleware.PermissionWrite)
	ctx = middleware.ContextWithBuildCacheCredential(ctx, middleware.BuildCacheCredentialWrite)
	return req.WithContext(ctx)
}

func withKey(req *http.Request, key string) *http.Request {
	return withRouteParams(req, map[string]string{"owner": "acme", "repo": "app", "keyDigest": key})
}

func withDigest(req *http.Request, digest string) *http.Request {
	return withRouteParams(req, map[string]string{"owner": "acme", "repo": "app", "digest": digest})
}

func TestBuildCacheHandler_ActionCacheStatusCodes(t *testing.T) {
	t.Parallel()
	svc := newMockBuildCacheService()
	h := &BuildCacheHandler{Service: svc}
	do := func(req *http.Request) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ActionCache(rec, req)
		return rec
	}

	rec := do(withKey(cacheRequest(http.MethodGet, "/ac/k1", nil, ""), "k1"))
	assert.Equal(t, http.StatusNotFound, rec.Code)

	body := []byte(`{"keyDigest":"k1","result":{"exitOk":true}}`)
	rec = do(withKey(cacheRequest(http.MethodPut, "/ac/k1", body, "application/json"), "k1"))
	assert.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.JSONEq(t, `{"keyDigest":"k1"}`, rec.Body.String())

	rec = do(withKey(cacheRequest(http.MethodPut, "/ac/k1", []byte(`{"result":{"exitOk":true},"keyDigest":"k1"}`), "application/json"), "k1"))
	assert.Equal(t, http.StatusOK, rec.Code, "identical re-publication")

	rec = do(withKey(cacheRequest(http.MethodPut, "/ac/k1", []byte(`{"keyDigest":"k1","result":{"exitOk":false}}`), "application/json"), "k1"))
	assert.Equal(t, http.StatusConflict, rec.Code)

	rec = do(withKey(cacheRequest(http.MethodGet, "/ac/k1", nil, ""), "k1"))
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	assert.Equal(t, string(body), rec.Body.String(), "a hit returns the published bytes verbatim")

	rec = do(withKey(cacheRequest(http.MethodPut, "/ac/k2", body, "text/plain"), "k2"))
	assert.Equal(t, http.StatusUnsupportedMediaType, rec.Code)

	rec = do(withKey(cacheRequest(http.MethodPut, "/ac/k2", []byte(`{`), "application/json"), "k2"))
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	rec = do(withKey(cacheRequest(http.MethodPut, "/ac/k2", []byte(`{"keyDigest":"other","result":1}`), "application/json"), "k2"))
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	oversized := cacheRequest(http.MethodPut, "/ac/k2", []byte(`{}`), "application/json")
	oversized.Header.Set("Content-Length", "2000000")
	oversized.ContentLength = 2000000
	rec = do(withKey(oversized, "k2"))
	assert.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)

	bad := cacheRequest(http.MethodPut, "/ac/k2", []byte(`{}`), "application/json")
	bad.Header.Set("Content-Length", "12.5")
	rec = do(withKey(bad, "k2"))
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	rec = do(withKey(cacheRequest(http.MethodDelete, "/ac/k1?recordedRunId=r", nil, ""), "k1"))
	assert.Equal(t, http.StatusBadRequest, rec.Code, "an orphan fence parameter is refused")
	rec = do(withKey(cacheRequest(http.MethodDelete, "/ac/k1", nil, ""), "k1"))
	assert.Equal(t, http.StatusOK, rec.Code)
	rec = do(withKey(cacheRequest(http.MethodDelete, "/ac/k1", nil, ""), "k1"))
	assert.Equal(t, http.StatusNotFound, rec.Code)

	rec = do(withKey(cacheRequest(http.MethodPatch, "/ac/k1", nil, ""), "k1"))
	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
	assert.Equal(t, "GET, PUT, DELETE", rec.Header().Get("Allow"))

	rec = do(withKey(cacheRequest(http.MethodGet, "/ac/", nil, ""), ""))
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	svc.fail = errors.New("db down")
	rec = do(withKey(cacheRequest(http.MethodGet, "/ac/k1", nil, ""), "k1"))
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code, "a tier failure is never a miss")
	assert.Contains(t, rec.Body.String(), `"code":"service_unavailable"`)
}

func TestBuildCacheHandler_ArtifactStatusCodes(t *testing.T) {
	t.Parallel()
	svc := newMockBuildCacheService()
	svc.max = 16
	h := &BuildCacheHandler{Service: svc}
	do := func(req *http.Request) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.Artifact(rec, req)
		return rec
	}
	payload := []byte("0123456789")
	digest := buildcache.SHA256Hex(payload)

	rec := do(withDigest(cacheRequest(http.MethodHead, "/cas/"+digest, nil, ""), digest))
	assert.Equal(t, http.StatusNotFound, rec.Code)

	rec = do(withDigest(cacheRequest(http.MethodPut, "/cas/"+digest, payload, "application/json"), digest))
	assert.Equal(t, http.StatusUnsupportedMediaType, rec.Code)

	ranged := cacheRequest(http.MethodPut, "/cas/"+digest, payload, "application/octet-stream")
	ranged.Header.Set("Content-Range", "bytes 0-9/10")
	rec = do(withDigest(ranged, digest))
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	rec = do(withDigest(cacheRequest(http.MethodPut, "/cas/"+strings.Repeat("0", 64), payload, "application/octet-stream"), strings.Repeat("0", 64)))
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "bytes digest to "+digest)

	rec = do(withDigest(cacheRequest(http.MethodPut, "/cas/"+digest, payload, "application/octet-stream"), digest))
	assert.Equal(t, http.StatusCreated, rec.Code)
	rec = do(withDigest(cacheRequest(http.MethodPut, "/cas/"+digest, payload, "application/octet-stream"), digest))
	assert.Equal(t, http.StatusOK, rec.Code)

	rec = do(withDigest(cacheRequest(http.MethodHead, "/cas/"+digest, nil, ""), digest))
	assert.Equal(t, http.StatusOK, rec.Code)

	rec = do(withDigest(cacheRequest(http.MethodGet, "/cas/"+digest, nil, ""), digest))
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "application/octet-stream", rec.Header().Get("Content-Type"))
	assert.Equal(t, payload, rec.Body.Bytes())

	big := bytes.Repeat([]byte("x"), 17)
	rec = do(withDigest(cacheRequest(http.MethodPut, "/cas/"+buildcache.SHA256Hex(big), big, "application/octet-stream"), buildcache.SHA256Hex(big)))
	assert.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)

	rec = do(withDigest(cacheRequest(http.MethodGet, "/cas/nothex", nil, ""), "nothex"))
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	rec = do(withDigest(cacheRequest(http.MethodDelete, "/cas/"+digest, nil, ""), digest))
	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
	assert.Equal(t, "GET, HEAD, PUT", rec.Header().Get("Allow"))
}

func TestBuildCacheHandler_FindMissing(t *testing.T) {
	t.Parallel()
	svc := newMockBuildCacheService()
	h := &BuildCacheHandler{Service: svc}
	present := buildcache.SHA256Hex([]byte("present"))
	absent := strings.Repeat("a", 64)
	svc.artifacts[svc.key(7, present)] = []byte("present")

	body := []byte(`{"digests":["` + absent + `","` + present + `","` + absent + `"]}`)
	rec := httptest.NewRecorder()
	h.FindMissing(rec, withRouteParams(cacheRequest(http.MethodPost, "/cas/findMissing", body, "application/json"), map[string]string{"owner": "acme", "repo": "app"}))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var got map[string][]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, []string{absent}, got["missing"])

	rec = httptest.NewRecorder()
	h.FindMissing(rec, cacheRequest(http.MethodPost, "/cas/findMissing", []byte(`{"digests":["nope"]}`), "application/json"))
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	many := make([]string, 0, buildcache.MaxFindMissingDigests+1)
	for i := 0; i <= buildcache.MaxFindMissingDigests; i++ {
		many = append(many, `"`+absent+`"`)
	}
	rec = httptest.NewRecorder()
	h.FindMissing(rec, cacheRequest(http.MethodPost, "/cas/findMissing", []byte(`{"digests":[`+strings.Join(many, ",")+`]}`), "application/json"))
	assert.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)

	rec = httptest.NewRecorder()
	h.FindMissing(rec, cacheRequest(http.MethodGet, "/cas/findMissing", nil, ""))
	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

func TestBuildCacheHandler_HealthAndAdmission(t *testing.T) {
	t.Parallel()
	svc := newMockBuildCacheService()
	h := &BuildCacheHandler{Service: svc}
	rec := httptest.NewRecorder()
	h.Health(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"ok":true}`, rec.Body.String())
	rec = httptest.NewRecorder()
	h.Health(rec, httptest.NewRequest(http.MethodHead, "/healthz", nil))
	assert.Equal(t, http.StatusOK, rec.Code)
	svc.fail = errors.New("no db")
	rec = httptest.NewRecorder()
	h.Health(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	svc.fail = nil

	// Two artifact transfers hold their slots; a third is refused with 429.
	digest := buildcache.SHA256Hex([]byte("blocked"))
	svc.artifacts[svc.key(7, digest)] = []byte("blocked")
	svc.block = make(chan struct{})
	var wg sync.WaitGroup
	started := make(chan struct{}, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			started <- struct{}{}
			h.Artifact(httptest.NewRecorder(), withDigest(cacheRequest(http.MethodGet, "/cas/"+digest, nil, ""), digest))
		}()
	}
	<-started
	<-started
	for h.activeTransfers.Load() < 2 {
	}
	rec = httptest.NewRecorder()
	h.Artifact(rec, withDigest(cacheRequest(http.MethodGet, "/cas/"+digest, nil, ""), digest))
	assert.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Equal(t, "1", rec.Header().Get("Retry-After"))
	close(svc.block)
	wg.Wait()
}

func TestBuildCacheHandler_ReadTokens(t *testing.T) {
	t.Parallel()
	h := &BuildCacheHandler{Service: newMockBuildCacheService()}
	req := cacheRequest(http.MethodPost, "/api/repos/acme/app/build-cache/tokens", []byte(`{"name":"ci"}`), "application/json")
	req.Host = "api.example.test"
	rec := httptest.NewRecorder()
	h.CreateReadToken(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code, "minting needs a signed-in user")

	rec = httptest.NewRecorder()
	h.CreateReadToken(rec, withTestUser(req, &db.User{ID: 1}))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	var created services.BuildCacheReadTokenCreated
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	assert.True(t, buildcache.IsReadToken(created.Token))
	assert.Equal(t, "https://api.example.test/api/repos/acme/app/build-cache", created.Endpoint)
	assert.Equal(t, "acme/app", created.Repository)

	rec = httptest.NewRecorder()
	h.ListReadTokens(rec, cacheRequest(http.MethodGet, "/tokens", nil, ""))
	assert.Equal(t, http.StatusOK, rec.Code)

	rec = httptest.NewRecorder()
	h.RevokeReadToken(rec, withRouteParams(cacheRequest(http.MethodDelete, "/tokens/1", nil, ""), map[string]string{"id": "1"}))
	assert.Equal(t, http.StatusNoContent, rec.Code)
	rec = httptest.NewRecorder()
	h.RevokeReadToken(rec, withRouteParams(cacheRequest(http.MethodDelete, "/tokens/2", nil, ""), map[string]string{"id": "2"}))
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

// typedRefusal decodes one build cache refusal and proves it is the registry's
// envelope and not the legacy `{"error": "..."}` one.
//
// The 240-byte ceiling is the Cloudflare Worker's: it classifies a refusal by
// reading only that much of the upstream body (pkg/errors.TestErrorBodyPuts-
// VerdictFirst pins the same fact for the shared writer). A cache refusal that
// pushed `code` past the ceiling would arrive unclassifiable, so every one of
// these bodies is checked at the head, not just after a full parse.
func typedRefusal(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, wantCode pkgerrors.Code) pkgerrors.APIError {
	t.Helper()
	const workerReadCeiling = 240
	require.Equal(t, wantStatus, rec.Code, rec.Body.String())
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	body := rec.Body.String()
	var decoded pkgerrors.APIError
	require.NoError(t, json.Unmarshal([]byte(body), &decoded), body)

	var legacy map[string]json.RawMessage
	require.NoError(t, json.Unmarshal([]byte(body), &legacy))
	assert.NotContains(t, legacy, "error", "the legacy build cache envelope must be gone")

	entry, registered := pkgerrors.Lookup(decoded.Code)
	require.True(t, registered, "code %q is not in the registry", decoded.Code)
	assert.Equal(t, wantCode, decoded.Code, body)
	assert.Equal(t, entry.Fault, decoded.Fault, "fault must come from the registry")
	assert.Equal(t, entry.Status, wantStatus, "the registry owns the status for %q", decoded.Code)
	assert.NotEmpty(t, decoded.Message, "a refusal still says something to a human")

	head := body
	if len(head) > workerReadCeiling {
		head = head[:workerReadCeiling]
	}
	assert.Contains(t, head, `"code":"`+string(decoded.Code)+`"`, "code must land inside the Worker's read ceiling")
	assert.Contains(t, head, `"fault":"`+string(decoded.Fault)+`"`, "fault must land inside the Worker's read ceiling")
	return decoded
}

func TestBuildCacheHandler_RefusalsCarryTheTypedEnvelope(t *testing.T) {
	t.Parallel()
	svc := newMockBuildCacheService()
	svc.max = 16
	h := &BuildCacheHandler{Service: svc}
	digest := buildcache.SHA256Hex([]byte("0123456789"))

	action := func(req *http.Request) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ActionCache(rec, req)
		return rec
	}
	artifact := func(req *http.Request) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.Artifact(rec, req)
		return rec
	}

	// Every user-fault refusal the protocol can raise.
	typedRefusal(t, action(withKey(cacheRequest(http.MethodGet, "/ac/", nil, ""), "")),
		http.StatusBadRequest, pkgerrors.CodeBadRequest)
	typedRefusal(t, action(withKey(cacheRequest(http.MethodPut, "/ac/k", []byte(`{`), "application/json"), "k")),
		http.StatusBadRequest, pkgerrors.CodeBadRequest)
	typedRefusal(t, action(withKey(cacheRequest(http.MethodDelete, "/ac/k?recordedRunId=r", nil, ""), "k")),
		http.StatusBadRequest, pkgerrors.CodeBadRequest)
	typedRefusal(t, action(withKey(cacheRequest(http.MethodPut, "/ac/k", []byte(`{}`), "text/plain"), "k")),
		http.StatusUnsupportedMediaType, pkgerrors.CodeUnsupportedMediaType)

	oversized := cacheRequest(http.MethodPut, "/ac/k", []byte(`{}`), "application/json")
	oversized.Header.Set("Content-Length", "2000000")
	oversized.ContentLength = 2000000
	typedRefusal(t, action(withKey(oversized, "k")),
		http.StatusRequestEntityTooLarge, pkgerrors.CodeRequestEntityTooLarge)

	malformedLength := cacheRequest(http.MethodPut, "/ac/k", []byte(`{}`), "application/json")
	malformedLength.Header.Set("Content-Length", "12.5")
	typedRefusal(t, action(withKey(malformedLength, "k")),
		http.StatusBadRequest, pkgerrors.CodeBadRequest)

	typedRefusal(t, artifact(withDigest(cacheRequest(http.MethodPut, "/cas/zz", []byte("x"), "application/octet-stream"), "zz")),
		http.StatusBadRequest, pkgerrors.CodeBadRequest)
	typedRefusal(t, artifact(withDigest(cacheRequest(http.MethodPut, "/cas/"+digest, []byte("x"), "application/json"), digest)),
		http.StatusUnsupportedMediaType, pkgerrors.CodeUnsupportedMediaType)

	ranged := cacheRequest(http.MethodPut, "/cas/"+digest, []byte("0123456789"), "application/octet-stream")
	ranged.Header.Set("Content-Range", "bytes 0-9/10")
	typedRefusal(t, artifact(withDigest(ranged, digest)),
		http.StatusBadRequest, pkgerrors.CodeBadRequest)
	typedRefusal(t, artifact(withDigest(cacheRequest(http.MethodPut, "/cas/"+digest, []byte("mismatched"), "application/octet-stream"), digest)),
		http.StatusBadRequest, pkgerrors.CodeBadRequest)

	// An APIError the service raised keeps the code the service chose instead
	// of being flattened back onto a bare status.
	tooBig := cacheRequest(http.MethodPut, "/cas/"+digest, bytes.Repeat([]byte("a"), 17), "application/octet-stream")
	typedRefusal(t, artifact(withDigest(tooBig, digest)),
		http.StatusRequestEntityTooLarge, pkgerrors.CodeRequestEntityTooLarge)

	findMissing := func(body []byte, contentType string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.FindMissing(rec, withRouteParams(cacheRequest(http.MethodPost, "/cas/findMissing", body, contentType), map[string]string{"owner": "acme", "repo": "app"}))
		return rec
	}
	typedRefusal(t, findMissing([]byte(`{"digests":["nope"]}`), "application/json"),
		http.StatusBadRequest, pkgerrors.CodeBadRequest)
	many := make([]string, 0, buildcache.MaxFindMissingDigests+1)
	for i := 0; i <= buildcache.MaxFindMissingDigests; i++ {
		many = append(many, `"`+strings.Repeat("a", 64)+`"`)
	}
	typedRefusal(t, findMissing([]byte(`{"digests":[`+strings.Join(many, ",")+`]}`), "application/json"),
		http.StatusRequestEntityTooLarge, pkgerrors.CodeRequestEntityTooLarge)

	// The tier itself failing is infra, never the caller's fault, and never a
	// miss: the client retries a 503 and would cache a 404 as an absence.
	svc.fail = errors.New("db down")
	tier := typedRefusal(t, action(withKey(cacheRequest(http.MethodGet, "/ac/k", nil, ""), "k")),
		http.StatusServiceUnavailable, pkgerrors.CodeServiceUnavailable)
	assert.Equal(t, pkgerrors.FaultInfra, tier.Fault)
	rec := httptest.NewRecorder()
	h.Health(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	typedRefusal(t, rec, http.StatusServiceUnavailable, pkgerrors.CodeServiceUnavailable)
	svc.fail = nil
}

// The admission ceiling is plue's own concurrency bound, shared across every
// caller: one request is refused because other principals hold the slots, not
// because this caller went over anything. So it may not borrow
// rate_limit_exceeded, which is a user fault; it is the same "wait, the slot
// is held" verdict desktop_busy carries, and it keeps its one-second pacing in
// both the header and the body.
func TestBuildCacheHandler_AdmissionRefusalIsAWaitWithPacing(t *testing.T) {
	t.Parallel()
	svc := newMockBuildCacheService()
	h := &BuildCacheHandler{Service: svc}
	digest := buildcache.SHA256Hex([]byte("blocked"))
	svc.artifacts[svc.key(7, digest)] = []byte("blocked")
	svc.block = make(chan struct{})
	var wg sync.WaitGroup
	started := make(chan struct{}, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			started <- struct{}{}
			h.Artifact(httptest.NewRecorder(), withDigest(cacheRequest(http.MethodGet, "/cas/"+digest, nil, ""), digest))
		}()
	}
	<-started
	<-started
	for h.activeTransfers.Load() < 2 {
	}
	rec := httptest.NewRecorder()
	h.Artifact(rec, withDigest(cacheRequest(http.MethodGet, "/cas/"+digest, nil, ""), digest))
	refusal := typedRefusal(t, rec, http.StatusTooManyRequests, pkgerrors.CodeBuildCacheBusy)
	assert.Equal(t, pkgerrors.FaultWait, refusal.Fault, "nobody is over budget; a slot is held")
	assert.Equal(t, 1, refusal.RetryAfter, "the body carries the pacing; the Worker drops upstream headers")
	assert.Equal(t, "1", rec.Header().Get("Retry-After"))
	close(svc.block)
	wg.Wait()
}

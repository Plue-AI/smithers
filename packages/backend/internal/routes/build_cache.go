package routes

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/buildcache"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// BuildCacheRouteService is the service surface behind the build cache
// protocol routes and the read-token management routes.
type BuildCacheRouteService interface {
	MaxArtifactBytes() int64
	GetEntry(ctx context.Context, repositoryID int64, keyDigest string) (string, bool, error)
	PutEntry(ctx context.Context, repositoryID int64, keyDigest string, publication buildcache.Publication) (services.PublicationOutcome, error)
	DeleteEntry(ctx context.Context, repositoryID int64, keyDigest string, fence *buildcache.Fence) (bool, error)
	HasArtifact(ctx context.Context, repositoryID int64, digest string) (bool, error)
	OpenArtifact(ctx context.Context, repositoryID int64, digest string) (io.ReadCloser, int64, bool, error)
	PutArtifact(ctx context.Context, repositoryID int64, digest string, body []byte) (services.ArtifactOutcome, error)
	PresentDigests(ctx context.Context, repositoryID int64, digests []string) (map[string]struct{}, error)
	Health(ctx context.Context) error
	CreateReadToken(ctx context.Context, actor *db.User, repository *db.Repository, repositoryFullName, name, endpoint, namespacePrefix string) (services.BuildCacheReadTokenCreated, error)
	ListReadTokens(ctx context.Context, repository *db.Repository, repositoryFullName string) ([]services.BuildCacheReadTokenResponse, error)
	RevokeReadToken(ctx context.Context, repository *db.Repository, id int64) error
	ResolveReadToken(ctx context.Context, token string) (db.BuildCacheReadToken, error)
}

// BuildCacheHandler serves /api/repos/{owner}/{repo}/build-cache/*.
//
// It is the HTTP half of the smithers build cache protocol: bounded body
// reads, the exact status codes the two real clients read, admission caps so
// one process bounds all cache work, and a 503 (never a 404) whenever the
// tier itself fails, because the client retries a refusal and must never read
// one as a miss.
type BuildCacheHandler struct {
	Service BuildCacheRouteService

	activeRequests     atomic.Int64
	activePublications atomic.Int64
	activeTransfers    atomic.Int64
	activeFindMissing  atomic.Int64
}

func buildCacheJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// buildCacheError answers with the one typed envelope every other plue
// surface answers with: code first, then fault and any pacing, then the human
// sentence. The registry owns the status, so the caller names the meaning and
// cannot disagree with it.
func buildCacheError(w http.ResponseWriter, code errors.Code, message string) {
	errors.WriteError(w, errors.New(code, message))
}

// buildCacheBusy refuses a request the admission ceiling has no slot for.
// CodeBuildCacheBusy carries the 429 and the one-second pacing, in the header
// and in the body, because the Worker in front of plue forwards neither
// upstream headers nor anything past the first 240 bytes.
func buildCacheBusy(w http.ResponseWriter, message string) {
	buildCacheError(w, errors.CodeBuildCacheBusy, message)
}

func buildCacheTierFailed(w http.ResponseWriter, what string, err error) {
	// Only an attribution is logged: the cause may embed the statement, the
	// object key, or the request that produced it.
	slog.Error("build cache request failed", "operation", what, "error_type", strings.TrimSpace(errorTypeName(err)))
	buildCacheError(w, errors.CodeServiceUnavailable, "the cache tier failed to answer")
}

func errorTypeName(err error) string {
	if err == nil {
		return "nil"
	}
	var apiErr *errors.APIError
	if stdErrors.As(err, &apiErr) {
		return "api:" + strconv.Itoa(apiErr.Status)
	}
	return "error"
}

func methodNotAllowed(w http.ResponseWriter, allowed string) {
	w.Header().Set("Allow", allowed)
	w.WriteHeader(http.StatusMethodNotAllowed)
}

func mediaType(r *http.Request) string {
	value := r.Header.Get("Content-Type")
	if i := strings.IndexByte(value, ';'); i >= 0 {
		value = value[:i]
	}
	return strings.ToLower(strings.TrimSpace(value))
}

func isJSONMediaType(value string) bool {
	if value == "application/json" {
		return true
	}
	return strings.HasPrefix(value, "application/") && strings.HasSuffix(value, "+json")
}

type boundedBodyError struct {
	code    errors.Code
	message string
}

// readBoundedBody reads at most limit bytes, refusing anything longer before
// it is retained. Content-Length is checked for syntax and size and then not
// trusted: the stream is what the bound is enforced against.
func readBoundedBody(r *http.Request, limit int64) ([]byte, *boundedBodyError) {
	var declared int64 = -1
	if header := r.Header.Get("Content-Length"); header != "" {
		for _, ch := range header {
			if ch < '0' || ch > '9' {
				return nil, &boundedBodyError{errors.CodeBadRequest, "invalid content-length"}
			}
		}
		value, err := strconv.ParseInt(header, 10, 64)
		if err != nil || value > limit {
			return nil, &boundedBodyError{errors.CodeRequestEntityTooLarge, "request body exceeds the configured bound"}
		}
		declared = value
	}
	if r.Body == nil {
		if declared <= 0 {
			return []byte{}, nil
		}
		return nil, &boundedBodyError{errors.CodeBadRequest, "content-length does not match the request body"}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, &boundedBodyError{errors.CodeBadRequest, "request body could not be read"}
	}
	if int64(len(body)) > limit {
		return nil, &boundedBodyError{errors.CodeRequestEntityTooLarge, "request body exceeds the configured bound"}
	}
	if declared >= 0 && int64(len(body)) != declared {
		return nil, &boundedBodyError{errors.CodeBadRequest, "content-length does not match the request body"}
	}
	return body, nil
}

func readJSONBody(w http.ResponseWriter, r *http.Request, limit int64) (string, bool) {
	if !isJSONMediaType(mediaType(r)) {
		buildCacheError(w, errors.CodeUnsupportedMediaType, "content-type must be application/json")
		return "", false
	}
	body, bodyErr := readBoundedBody(r, limit)
	if bodyErr != nil {
		buildCacheError(w, bodyErr.code, bodyErr.message)
		return "", false
	}
	return string(body), true
}

func (h *BuildCacheHandler) admit(counter *atomic.Int64, limit int64) bool {
	if counter.Add(1) > limit {
		counter.Add(-1)
		return false
	}
	return true
}

func buildCacheRepository(w http.ResponseWriter, r *http.Request) (*db.Repository, bool) {
	repository := middleware.RepoFromContext(r.Context())
	if repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return nil, false
	}
	return repository, true
}

// Health handles GET and HEAD .../build-cache/healthz.
func (h *BuildCacheHandler) Health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, "GET, HEAD")
		return
	}
	if !h.admit(&h.activeRequests, buildcache.MaxConcurrentCacheRequests) {
		buildCacheBusy(w, "too many simultaneous cache requests")
		return
	}
	defer h.activeRequests.Add(-1)
	if err := h.Service.Health(r.Context()); err != nil {
		buildCacheTierFailed(w, "health", err)
		return
	}
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	buildCacheJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ActionCache handles GET, PUT, and DELETE .../build-cache/ac/{keyDigest}.
func (h *BuildCacheHandler) ActionCache(w http.ResponseWriter, r *http.Request) {
	if !h.admit(&h.activeRequests, buildcache.MaxConcurrentCacheRequests) {
		buildCacheBusy(w, "too many simultaneous cache requests")
		return
	}
	defer h.activeRequests.Add(-1)
	repository, ok := buildCacheRepository(w, r)
	if !ok {
		return
	}
	keyDigest, decodeErr := url.PathUnescape(chi.URLParam(r, "keyDigest"))
	if decodeErr != nil {
		buildCacheError(w, errors.CodeBadRequest, "keyDigest must be valid URL encoding")
		return
	}
	if prefix := middleware.BuildCacheNamespacePrefixFromContext(r.Context()); prefix != "" && !strings.HasPrefix(keyDigest, prefix) {
		buildCacheError(w, errors.CodeForbidden, "this credential may not read that cache namespace")
		return
	}
	if err := buildcache.ValidateKeyDigest(keyDigest); err != nil {
		buildCacheError(w, errors.CodeBadRequest, err.Error())
		return
	}
	switch r.Method {
	case http.MethodGet:
		body, found, err := h.Service.GetEntry(r.Context(), repository.ID, keyDigest)
		if err != nil {
			buildCacheTierFailed(w, "ac.get", err)
			return
		}
		if !found {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, body)
	case http.MethodPut:
		if !h.admit(&h.activePublications, buildcache.MaxConcurrentActionCachePublications) {
			buildCacheBusy(w, "too many simultaneous action-cache publications")
			return
		}
		defer h.activePublications.Add(-1)
		text, ok := readJSONBody(w, r, buildcache.MaxActionCacheBodyBytes)
		if !ok {
			return
		}
		publication, err := buildcache.ParsePublication(keyDigest, text)
		if err != nil {
			buildCacheError(w, errors.CodeBadRequest, err.Error())
			return
		}
		outcome, err := h.Service.PutEntry(r.Context(), repository.ID, keyDigest, publication)
		if err != nil {
			buildCacheTierFailed(w, "ac.put", err)
			return
		}
		switch outcome {
		case services.PublicationInserted:
			buildCacheJSON(w, http.StatusCreated, map[string]string{"keyDigest": keyDigest})
		case services.PublicationIdentical:
			w.WriteHeader(http.StatusOK)
		case services.PublicationConflict:
			w.WriteHeader(http.StatusConflict)
		default:
			buildCacheTierFailed(w, "ac.put", stdErrors.New("invalid publication outcome"))
		}
	case http.MethodDelete:
		query := r.URL.Query()
		fence, err := buildcache.ParseFence(query["recordedRunId"], query["recordedEventSeq"])
		if err != nil {
			buildCacheError(w, errors.CodeBadRequest, err.Error())
			return
		}
		deleted, err := h.Service.DeleteEntry(r.Context(), repository.ID, keyDigest, fence)
		if err != nil {
			buildCacheTierFailed(w, "ac.delete", err)
			return
		}
		if deleted {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	default:
		methodNotAllowed(w, "GET, PUT, DELETE")
	}
}

// Artifact handles GET, HEAD, and PUT .../build-cache/cas/{digest}.
func (h *BuildCacheHandler) Artifact(w http.ResponseWriter, r *http.Request) {
	if middleware.BuildCacheNamespacePrefixFromContext(r.Context()) != "" {
		buildCacheError(w, errors.CodeForbidden, "this credential may not read unscoped cache artifacts")
		return
	}
	if !h.admit(&h.activeRequests, buildcache.MaxConcurrentCacheRequests) {
		buildCacheBusy(w, "too many simultaneous cache requests")
		return
	}
	defer h.activeRequests.Add(-1)
	repository, ok := buildCacheRepository(w, r)
	if !ok {
		return
	}
	digest := chi.URLParam(r, "digest")
	if !buildcache.IsHexDigest(digest) {
		buildCacheError(w, errors.CodeBadRequest, "digest must be 64 lowercase hex characters")
		return
	}
	switch r.Method {
	case http.MethodHead:
		present, err := h.Service.HasArtifact(r.Context(), repository.ID, digest)
		if err != nil {
			buildCacheTierFailed(w, "cas.head", err)
			return
		}
		if present {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	case http.MethodGet:
		if !h.admit(&h.activeTransfers, buildcache.MaxConcurrentArtifactTransfers) {
			buildCacheBusy(w, "too many simultaneous artifact transfers")
			return
		}
		defer h.activeTransfers.Add(-1)
		reader, size, found, err := h.Service.OpenArtifact(r.Context(), repository.ID, digest)
		if err != nil {
			buildCacheTierFailed(w, "cas.get", err)
			return
		}
		if !found {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		defer func() { _ = reader.Close() }()
		w.Header().Set("Content-Type", "application/octet-stream")
		if size >= 0 {
			w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.Copy(w, reader)
	case http.MethodPut:
		if !h.admit(&h.activeTransfers, buildcache.MaxConcurrentArtifactTransfers) {
			buildCacheBusy(w, "too many simultaneous artifact transfers")
			return
		}
		defer h.activeTransfers.Add(-1)
		// Partial PUT is not supported; RFC 9110 section 14.5 names 400 as the
		// answer, which the engine client reads as its cue to send the blob whole.
		if r.Header.Get("Content-Range") != "" {
			buildCacheError(w, errors.CodeBadRequest, "content-range is not supported; send the whole blob in one request")
			return
		}
		if mediaType(r) != "application/octet-stream" {
			buildCacheError(w, errors.CodeUnsupportedMediaType, "content-type must be application/octet-stream")
			return
		}
		body, bodyErr := readBoundedBody(r, h.Service.MaxArtifactBytes())
		if bodyErr != nil {
			buildCacheError(w, bodyErr.code, bodyErr.message)
			return
		}
		measured := buildcache.SHA256Hex(body)
		if measured != digest {
			buildCacheError(w, errors.CodeBadRequest, "bytes digest to "+measured)
			return
		}
		outcome, err := h.Service.PutArtifact(r.Context(), repository.ID, digest, body)
		if err != nil {
			// The service already chose a code for this refusal; writing the
			// APIError whole keeps it, instead of flattening the verdict back
			// onto a bare status the handler would have to re-guess.
			var apiErr *errors.APIError
			if stdErrors.As(err, &apiErr) {
				errors.WriteError(w, apiErr)
				return
			}
			buildCacheTierFailed(w, "cas.put", err)
			return
		}
		switch outcome {
		case services.ArtifactInserted:
			w.WriteHeader(http.StatusCreated)
		case services.ArtifactPresent, services.ArtifactRepaired:
			w.WriteHeader(http.StatusOK)
		default:
			buildCacheTierFailed(w, "cas.put", stdErrors.New("invalid artifact outcome"))
		}
	default:
		methodNotAllowed(w, "GET, HEAD, PUT")
	}
}

// FindMissing handles POST .../build-cache/cas/findMissing.
func (h *BuildCacheHandler) FindMissing(w http.ResponseWriter, r *http.Request) {
	if middleware.BuildCacheNamespacePrefixFromContext(r.Context()) != "" {
		buildCacheError(w, errors.CodeForbidden, "this credential may not probe unscoped cache artifacts")
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, "POST")
		return
	}
	if !h.admit(&h.activeRequests, buildcache.MaxConcurrentCacheRequests) {
		buildCacheBusy(w, "too many simultaneous cache requests")
		return
	}
	defer h.activeRequests.Add(-1)
	if !h.admit(&h.activeFindMissing, buildcache.MaxConcurrentFindMissingRequests) {
		buildCacheBusy(w, "too many simultaneous findMissing requests")
		return
	}
	defer h.activeFindMissing.Add(-1)
	repository, ok := buildCacheRepository(w, r)
	if !ok {
		return
	}
	text, ok := readJSONBody(w, r, buildcache.MaxFindMissingBodyBytes)
	if !ok {
		return
	}
	digests, err := buildcache.ParseFindMissing(text)
	if err != nil {
		if stdErrors.Is(err, buildcache.ErrTooManyDigests) {
			buildCacheError(w, errors.CodeRequestEntityTooLarge, err.Error())
			return
		}
		buildCacheError(w, errors.CodeBadRequest, err.Error())
		return
	}
	present, err := h.Service.PresentDigests(r.Context(), repository.ID, digests)
	if err != nil {
		buildCacheTierFailed(w, "cas.findMissing", err)
		return
	}
	missing := make([]string, 0, len(digests))
	for _, digest := range digests {
		if _, ok := present[digest]; !ok {
			missing = append(missing, digest)
		}
	}
	buildCacheJSON(w, http.StatusOK, map[string][]string{"missing": missing})
}

type createBuildCacheTokenRequest struct {
	Name            string `json:"name"`
	NamespacePrefix string `json:"namespace_prefix"`
}

func buildCacheEndpoint(r *http.Request, owner, repo string) string {
	return requestOrigin(r) + "/api/repos/" + owner + "/" + repo + "/build-cache"
}

// CreateReadToken handles POST .../build-cache/tokens.
func (h *BuildCacheHandler) CreateReadToken(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return
	}
	var input createBuildCacheTokenRequest
	if r.ContentLength != 0 && r.Body != nil {
		if !decodeJSONBody(w, r, &input) {
			return
		}
	}
	fullName := repoCtx.Owner + "/" + repoCtx.Repository.Name
	created, err := h.Service.CreateReadToken(r.Context(), user, repoCtx.Repository, fullName, input.Name, buildCacheEndpoint(r, repoCtx.Owner, repoCtx.Repository.Name), input.NamespacePrefix)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	errors.WriteJSON(w, http.StatusCreated, created)
}

// ListReadTokens handles GET .../build-cache/tokens.
func (h *BuildCacheHandler) ListReadTokens(w http.ResponseWriter, r *http.Request) {
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return
	}
	tokens, err := h.Service.ListReadTokens(r.Context(), repoCtx.Repository, repoCtx.Owner+"/"+repoCtx.Repository.Name)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, tokens)
}

// RevokeReadToken handles DELETE .../build-cache/tokens/{id}.
func (h *BuildCacheHandler) RevokeReadToken(w http.ResponseWriter, r *http.Request) {
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return
	}
	id, err := strconv.ParseInt(strings.TrimSpace(chi.URLParam(r, "id")), 10, 64)
	if err != nil || id <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid token id"))
		return
	}
	if err := h.Service.RevokeReadToken(r.Context(), repoCtx.Repository, id); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

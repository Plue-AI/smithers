package routes

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// isNilInterface checks if an interface is nil or holds a nil pointer.
// This is needed because in Go, an interface holding a nil concrete pointer
// is not nil itself - the interface wrapper is non-nil but the value is nil.
func isNilInterface(i interface{}) bool {
	if i == nil {
		return true
	}
	v := reflect.ValueOf(i)
	return v.Kind() == reflect.Pointer && v.IsNil()
}

// HealthzChecker can perform dependency health checks.
type HealthzChecker interface {
	// Ping verifies the database is reachable.
	Ping(ctx context.Context) error
}

// healthzResponse is the JSON response body for /healthz and /readyz.
type healthzResponse struct {
	Status string            `json:"status"`
	Checks map[string]string `json:"checks"`
}

// HealthzHandler handles GET /healthz (Kubernetes liveness probe).
// It performs dependency checks and returns a rich JSON status.
// Returns 200 when healthy, 503 when any dependency is unhealthy.
type HealthzHandler struct {
	DB        HealthzChecker
	RepoHost  string // base URL of repo-host, used for reachability check
	httpCheck func(url string) error
}

func defaultRepoHostHealthCheck(url string) error {
	client := observability.NewHTTPClient(3 * time.Second)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url+"/health", nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("repo-host health check returned status %d", resp.StatusCode)
	}
	return nil
}

// NewHealthzHandler creates a new HealthzHandler.
// db may be nil for tests (skips DB check).
func NewHealthzHandler(db HealthzChecker, repoHostURL string) *HealthzHandler {
	return &HealthzHandler{
		DB:        db,
		RepoHost:  repoHostURL,
		httpCheck: defaultRepoHostHealthCheck,
	}
}

// SetHTTPCheck overrides the HTTP check function (used in tests to avoid real network calls).
func (h *HealthzHandler) SetHTTPCheck(fn func(url string) error) {
	h.httpCheck = fn
}

// Healthz handles GET /healthz.
// Used by Kubernetes liveness probes. Returns JSON with per-component status.
func (h *HealthzHandler) Healthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	checks := make(map[string]string)
	overall := "ok"

	// Check database connectivity.
	if !isNilInterface(h.DB) {
		if err := h.DB.Ping(ctx); err != nil {
			checks["database"] = "error"
			overall = "unhealthy"
		} else {
			checks["database"] = "ok"
		}
	} else {
		checks["database"] = "unconfigured"
	}

	// Check repo-host reachability (best-effort, optional component).
	if h.RepoHost != "" && h.httpCheck != nil {
		if err := h.httpCheck(h.RepoHost); err != nil {
			checks["repo_host"] = "error"
			overall = "unhealthy"
		} else {
			checks["repo_host"] = "ok"
		}
	} else {
		checks["repo_host"] = "unconfigured"
	}

	resp := healthzResponse{
		Status: overall,
		Checks: checks,
	}

	statusCode := http.StatusOK
	if overall != "ok" {
		statusCode = http.StatusServiceUnavailable
	}

	pkgerrors.WriteJSON(w, statusCode, resp)
}

// ReadyzHandler handles GET /readyz (Kubernetes readiness probe).
// Semantically distinct from /healthz: this indicates the process is ready
// to serve traffic (DB pool warmed up, dependencies reachable).
type ReadyzHandler struct {
	DB           HealthzChecker
	RepoHost     string
	httpCheck    func(url string) error
	storageCheck func() error
}

// NewReadyzHandler creates a new ReadyzHandler.
func NewReadyzHandler(db HealthzChecker, repoHostURL string) *ReadyzHandler {
	return &ReadyzHandler{
		DB:        db,
		RepoHost:  repoHostURL,
		httpCheck: defaultRepoHostHealthCheck,
	}
}

// SetHTTPCheck overrides the HTTP check function (used in tests to avoid real network calls).
func (h *ReadyzHandler) SetHTTPCheck(fn func(url string) error) {
	h.httpCheck = fn
}

// SetStorageCheck adds a "storage" check: "full" when the check reports
// blob.ErrStorageFull, "error" for any other failure.
func (h *ReadyzHandler) SetStorageCheck(fn func() error) {
	h.storageCheck = fn
}

// Readyz handles GET /readyz.
// Used by Kubernetes readiness probes. Indicates the server is ready to serve traffic.
func (h *ReadyzHandler) Readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	checks := make(map[string]string)
	overall := "ready"

	// Database readiness check (pool must be warmed up).
	if !isNilInterface(h.DB) {
		if err := h.DB.Ping(ctx); err != nil {
			checks["database"] = "error"
			overall = "not_ready"
		} else {
			checks["database"] = "ok"
		}
	} else {
		checks["database"] = "unconfigured"
	}

	// Repo-host reachability check.
	if h.RepoHost != "" && h.httpCheck != nil {
		if err := h.httpCheck(h.RepoHost); err != nil {
			checks["repo_host"] = "error"
			overall = "not_ready"
		} else {
			checks["repo_host"] = "ok"
		}
	} else {
		checks["repo_host"] = "unconfigured"
	}

	if h.storageCheck != nil {
		switch err := h.storageCheck(); {
		case err == nil:
			checks["storage"] = "ok"
		case errors.Is(err, blob.ErrStorageFull):
			checks["storage"] = "full"
			overall = "not_ready"
		default:
			checks["storage"] = "error"
			overall = "not_ready"
		}
	}

	resp := healthzResponse{
		Status: overall,
		Checks: checks,
	}

	statusCode := http.StatusOK
	if overall != "ready" {
		statusCode = http.StatusServiceUnavailable
	}

	pkgerrors.WriteJSON(w, statusCode, resp)
}

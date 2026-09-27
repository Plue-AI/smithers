package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type RepositoryJobRouteService interface {
	Register(context.Context, string, string, string, services.RegisterRepositoryJobInput) (db.RegisterRepositoryJobRow, error)
	List(context.Context, int64, int64) ([]db.RepositoryJobRegistration, error)
	Pause(context.Context, int64, int64, string) ([]db.RepositoryJobRegistration, error)
	Dispatches(context.Context, int64, int64, string) ([]services.RepositoryJobDispatchReceipt, error)
	CreateTrial(context.Context, string, string, string, string, services.RepositoryJobTrialInput) (services.RepositoryJobTrialResult, error)
	CreateComment(context.Context, string, string, string, string, services.RepositoryJobCommentInput) (services.RepositoryJobCommentResult, error)
	Source(context.Context, int64, int64) (services.RepositorySource, error)
	RunManual(context.Context, string, string, string, string, services.RepositoryJobManualInput) (services.RepositoryJobManualResult, error)
	CreateCheckReceipt(context.Context, string, string, string, services.RepositoryCheckReceiptInput) (services.RepositoryCheckReceiptResponse, bool, error)
	RecordApproval(context.Context, int64, int64, string, services.RepositoryJobApprovalInput) (services.RepositoryJobApproval, error)
	Approvals(context.Context, int64, int64, string) ([]services.RepositoryJobApproval, error)
}

// RepositoryJobHandler serves repository jobs: the repository's own routes,
// and the callbacks a box's coding host makes under
// /api/gateways/{hostID}/repository-jobs/... with its flowhost binding ID
// (SMITHERS_GATEWAY_ID) and control credential (SMITHERS_API_KEY).
type RepositoryJobHandler struct {
	RepositoryJobs  RepositoryJobRouteService
	SourceRetention interface {
		Retain(context.Context, int64, int64, services.RepositorySourceRetentionInput) (services.RepositorySourceRetentionResult, error)
	}
}

// bearerToken is the credential of an Authorization: Bearer header, or "".
func bearerToken(header string) string {
	parts := strings.Fields(header)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return parts[1]
}

func (h *RepositoryJobHandler) PutRepositoryJob(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.RepositoryJobs == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "repository job registration unavailable"))
		return
	}
	var input services.RegisterRepositoryJobInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid repository job registration"))
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("registration must contain one JSON object"))
		return
	}
	result, err := h.RepositoryJobs.Register(r.Context(), chi.URLParam(r, "hostID"), bearerToken(r.Header.Get("Authorization")), chi.URLParam(r, "job"), input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{
		"registration_id": result.ID, "revision": result.Revision, "digest": result.Digest,
		"source_revision": result.SourceRevision, "mode": result.Mode, "enabled": result.Enabled,
		"schedule": result.Schedule, "next_fire_at": result.NextFireAt, "timezone": "UTC",
	})
}

func (h *RepositoryJobHandler) PutRepositoryJobTrial(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.RepositoryJobs == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "repository trials unavailable"))
		return
	}
	var input services.RepositoryJobTrialInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid repository trial request"))
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("trial must contain one JSON object"))
		return
	}
	result, err := h.RepositoryJobs.CreateTrial(r.Context(), chi.URLParam(r, "hostID"), bearerToken(r.Header.Get("Authorization")), chi.URLParam(r, "job"), chi.URLParam(r, "requestID"), input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

func (h *RepositoryJobHandler) PutRepositoryJobComment(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.RepositoryJobs == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "repository replies unavailable"))
		return
	}
	var input services.RepositoryJobCommentInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid repository reply request"))
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("reply must contain one JSON object"))
		return
	}
	result, err := h.RepositoryJobs.CreateComment(r.Context(), chi.URLParam(r, "hostID"), bearerToken(r.Header.Get("Authorization")), chi.URLParam(r, "job"), chi.URLParam(r, "step"), input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

func (h *RepositoryJobHandler) PutRepositoryJobManual(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.RepositoryJobs == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "manual repository jobs unavailable"))
		return
	}
	var input services.RepositoryJobManualInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid manual repository job request"))
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("manual request must contain one JSON object"))
		return
	}
	result, err := h.RepositoryJobs.RunManual(r.Context(), chi.URLParam(r, "hostID"), bearerToken(r.Header.Get("Authorization")), chi.URLParam(r, "job"), chi.URLParam(r, "requestID"), input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

func (h *RepositoryJobHandler) repositoryJobScope(w http.ResponseWriter, r *http.Request) (int64, int64, bool) {
	w.Header().Set("Cache-Control", "no-store")
	user, err := requireRouteUser(r)
	if err != nil {
		writeRouteError(w, r, err)
		return 0, 0, false
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return 0, 0, false
	}
	if h.RepositoryJobs == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "repository jobs unavailable"))
		return 0, 0, false
	}
	return repoCtx.Repository.ID, user.ID, true
}

func (h *RepositoryJobHandler) GetRepositoryJobs(w http.ResponseWriter, r *http.Request) {
	repo, user, ok := h.repositoryJobScope(w, r)
	if !ok {
		return
	}
	result, err := h.RepositoryJobs.List(r.Context(), repo, user)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

func (h *RepositoryJobHandler) GetRepositorySource(w http.ResponseWriter, r *http.Request) {
	repo, user, ok := h.repositoryJobScope(w, r)
	if !ok {
		return
	}
	result, err := h.RepositoryJobs.Source(r.Context(), repo, user)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

func (h *RepositoryJobHandler) PauseRepositoryJob(w http.ResponseWriter, r *http.Request) {
	repo, user, ok := h.repositoryJobScope(w, r)
	if !ok {
		return
	}
	result, err := h.RepositoryJobs.Pause(r.Context(), repo, user, chi.URLParam(r, "job"))
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

func (h *RepositoryJobHandler) PostRepositoryJobApproval(w http.ResponseWriter, r *http.Request) {
	repo, user, ok := h.repositoryJobScope(w, r)
	if !ok {
		return
	}
	var input services.RepositoryJobApprovalInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid repository job approval"))
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("approval must contain one JSON object"))
		return
	}
	result, err := h.RepositoryJobs.RecordApproval(r.Context(), repo, user, chi.URLParam(r, "job"), input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

func (h *RepositoryJobHandler) GetRepositoryJobApprovals(w http.ResponseWriter, r *http.Request) {
	repo, user, ok := h.repositoryJobScope(w, r)
	if !ok {
		return
	}
	result, err := h.RepositoryJobs.Approvals(r.Context(), repo, user, chi.URLParam(r, "job"))
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

func (h *RepositoryJobHandler) GetRepositoryJobDispatches(w http.ResponseWriter, r *http.Request) {
	repo, user, ok := h.repositoryJobScope(w, r)
	if !ok {
		return
	}
	result, err := h.RepositoryJobs.Dispatches(r.Context(), repo, user, chi.URLParam(r, "job"))
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

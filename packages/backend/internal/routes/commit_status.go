package routes

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type CommitStatusRouteService interface {
	CreateCommitStatus(ctx context.Context, repositoryID int64, sha string, input services.CreateCommitStatusInput) (db.CommitStatus, error)
	ListCommitStatuses(ctx context.Context, repositoryID int64, ref string, page, perPage int) ([]db.CommitStatus, int64, error)
}

type CommitStatusHandler struct {
	Service CommitStatusRouteService
}

type createCommitStatusRequest struct {
	Context         string  `json:"context"`
	Status          string  `json:"status"`
	Description     string  `json:"description"`
	TargetURL       string  `json:"target_url"`
	ChangeID        *string `json:"change_id,omitempty"`
	WorkflowRunID   *int64  `json:"workflow_run_id,omitempty"`
	TargetsAffected int64   `json:"targets_affected"`
	TargetsRan      int64   `json:"targets_ran"`
	TargetsCached   int64   `json:"targets_cached"`
	DurationMS      int64   `json:"duration_ms"`
	WorkspaceID     *string `json:"workspace_id,omitempty"`
}

type commitStatusResponse struct {
	ID              int64     `json:"id"`
	RepositoryID    int64     `json:"repository_id"`
	ChangeID        *string   `json:"change_id"`
	CommitSHA       *string   `json:"commit_sha"`
	Context         string    `json:"context"`
	Status          string    `json:"status"`
	Description     string    `json:"description"`
	TargetURL       string    `json:"target_url"`
	WorkflowRunID   *int64    `json:"workflow_run_id"`
	TargetsAffected int64     `json:"targets_affected"`
	TargetsRan      int64     `json:"targets_ran"`
	TargetsCached   int64     `json:"targets_cached"`
	DurationMS      int64     `json:"duration_ms"`
	WorkspaceID     *string   `json:"workspace_id"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

func toCommitStatusResponse(c db.CommitStatus) commitStatusResponse {
	return commitStatusResponse{
		ID:              c.ID,
		RepositoryID:    c.RepositoryID,
		ChangeID:        nullableText(c.ChangeID),
		CommitSHA:       nullableText(c.CommitSha),
		Context:         c.Context,
		Status:          c.Status,
		Description:     c.Description,
		TargetURL:       c.TargetUrl,
		WorkflowRunID:   nullableInt8(c.WorkflowRunID),
		TargetsAffected: c.TargetsAffected,
		TargetsRan:      c.TargetsRan,
		TargetsCached:   c.TargetsCached,
		DurationMS:      c.DurationMs,
		WorkspaceID:     nullableUUID(c.WorkspaceID),
		CreatedAt:       c.CreatedAt,
		UpdatedAt:       c.UpdatedAt,
	}
}

func nullableText(v pgtype.Text) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

func nullableInt8(v pgtype.Int8) *int64 {
	if !v.Valid {
		return nil
	}
	n := v.Int64
	return &n
}

func nullableUUID(v pgtype.UUID) *string {
	if !v.Valid {
		return nil
	}
	s := uuid.UUID(v.Bytes).String()
	return &s
}

func (h *CommitStatusHandler) GetCommitStatuses(w http.ResponseWriter, r *http.Request) {
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return
	}

	ref, err := routeParam(r, "ref", "ref is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	// Reject control chars / invalid UTF-8 before the ref reaches the UUID/text
	// query layer, which would otherwise 500 on a malformed byte sequence.
	if verr := validateRef(ref); verr != nil {
		errors.WriteError(w, verr)
		return
	}

	cursor, limit, err := parsePagination(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	statuses, total, err := h.Service.ListCommitStatuses(r.Context(), repoCtx.Repository.ID, ref, page, limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(statuses), total)
	resp := make([]commitStatusResponse, len(statuses))
	for i := range statuses {
		resp[i] = toCommitStatusResponse(statuses[i])
	}
	errors.WriteJSON(w, http.StatusOK, resp)
}

func (h *CommitStatusHandler) CreateCommitStatus(w http.ResponseWriter, r *http.Request) {
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

	sha, err := routeParam(r, "sha", "sha is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	// Reject control chars / invalid UTF-8 before the sha reaches the
	// service/storage layer, mirroring GetCommitStatuses' ref validation.
	if verr := validateRef(sha); verr != nil {
		errors.WriteError(w, verr)
		return
	}

	var req createCommitStatusRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	created, err := h.Service.CreateCommitStatus(r.Context(), repoCtx.Repository.ID, sha, services.CreateCommitStatusInput{
		Context:         req.Context,
		Status:          req.Status,
		Description:     req.Description,
		TargetURL:       req.TargetURL,
		ChangeID:        req.ChangeID,
		WorkflowRunID:   req.WorkflowRunID,
		TargetsAffected: req.TargetsAffected,
		TargetsRan:      req.TargetsRan,
		TargetsCached:   req.TargetsCached,
		DurationMS:      req.DurationMS,
		WorkspaceID:     req.WorkspaceID,
		Actor:           user,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusCreated, toCommitStatusResponse(created))
}

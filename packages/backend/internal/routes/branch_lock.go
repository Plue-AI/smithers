// Package routes — branch-lock HTTP handler.
//
// One person checks out a branch at a time. Exposes:
//
//	POST /api/repos/{owner}/{repo}/branch-locks/acquire          {branch, workspace_id?}
//	POST /api/repos/{owner}/{repo}/branch-locks/heartbeat        {branch}
//	POST /api/repos/{owner}/{repo}/branch-locks/release          {branch}
//	POST /api/repos/{owner}/{repo}/branch-locks/join-requests    {branch}
//	GET  /api/repos/{owner}/{repo}/branch-locks/join-requests?branch=
//	POST /api/repos/{owner}/{repo}/branch-locks/join-requests/{id}/decide  {decision}
//
// A live lock held by someone else answers acquire with 409
// (code branch_lock_held) whose details carry the holder, whether the caller
// may request to join (paid plan) or must upgrade first, and whether an ask
// is already pending — everything the client's occupied-branch dialog needs
// in one round trip. The handler stays a thin adapter; all lock semantics
// (staleness takeover, membership via approved requests, plan gating) live in
// services.BranchLockService.
package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// BranchLockRouteService is the service surface the handler needs. Narrow
// interface so tests can stub with a minimal mock.
type BranchLockRouteService interface {
	AcquireBranchLock(ctx context.Context, input services.AcquireBranchLockInput) (services.BranchLockResponse, error)
	HeartbeatBranchLock(ctx context.Context, input services.AcquireBranchLockInput) error
	ReleaseBranchLock(ctx context.Context, input services.AcquireBranchLockInput) error
	RequestBranchLockJoin(ctx context.Context, input services.RequestBranchLockJoinInput) (services.BranchLockJoinRequestResponse, error)
	ListPendingBranchLockJoinRequests(ctx context.Context, input services.AcquireBranchLockInput) ([]services.BranchLockJoinRequestResponse, error)
	DecideBranchLockJoin(ctx context.Context, input services.DecideBranchLockJoinInput) (services.BranchLockJoinRequestResponse, error)
}

// BranchLockHandler handles the repo-scoped branch-lock API.
type BranchLockHandler struct {
	Service BranchLockRouteService
}

type branchLockRequest struct {
	Branch      string `json:"branch"`
	WorkspaceID string `json:"workspace_id,omitempty"`
}

type decideBranchLockJoinRequest struct {
	Decision string `json:"decision"`
}

// repoAndUser resolves the two contexts every branch-lock route needs.
func repoAndUser(w http.ResponseWriter, r *http.Request) (int64, int64, string, bool) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return 0, 0, "", false
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return 0, 0, "", false
	}
	return repoCtx.Repository.ID, user.ID, user.Username, true
}

func decodeBranchLockRequest(w http.ResponseWriter, r *http.Request) (branchLockRequest, bool) {
	var req branchLockRequest
	// Small fixed-size body; prevent payload abuse.
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid JSON body"))
		return branchLockRequest{}, false
	}
	if req.Branch == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("branch is required"))
		return branchLockRequest{}, false
	}
	return req, true
}

// AcquireBranchLock handles POST /api/repos/{owner}/{repo}/branch-locks/acquire.
func (h *BranchLockHandler) AcquireBranchLock(w http.ResponseWriter, r *http.Request) {
	repositoryID, userID, _, ok := repoAndUser(w, r)
	if !ok {
		return
	}
	req, ok := decodeBranchLockRequest(w, r)
	if !ok {
		return
	}
	resp, svcErr := h.Service.AcquireBranchLock(r.Context(), services.AcquireBranchLockInput{
		RepositoryID: repositoryID,
		Branch:       req.Branch,
		UserID:       userID,
		WorkspaceID:  req.WorkspaceID,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}

// HeartbeatBranchLock handles POST /api/repos/{owner}/{repo}/branch-locks/heartbeat.
func (h *BranchLockHandler) HeartbeatBranchLock(w http.ResponseWriter, r *http.Request) {
	repositoryID, userID, _, ok := repoAndUser(w, r)
	if !ok {
		return
	}
	req, ok := decodeBranchLockRequest(w, r)
	if !ok {
		return
	}
	if svcErr := h.Service.HeartbeatBranchLock(r.Context(), services.AcquireBranchLockInput{
		RepositoryID: repositoryID,
		Branch:       req.Branch,
		UserID:       userID,
	}); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ReleaseBranchLock handles POST /api/repos/{owner}/{repo}/branch-locks/release.
func (h *BranchLockHandler) ReleaseBranchLock(w http.ResponseWriter, r *http.Request) {
	repositoryID, userID, _, ok := repoAndUser(w, r)
	if !ok {
		return
	}
	req, ok := decodeBranchLockRequest(w, r)
	if !ok {
		return
	}
	if svcErr := h.Service.ReleaseBranchLock(r.Context(), services.AcquireBranchLockInput{
		RepositoryID: repositoryID,
		Branch:       req.Branch,
		UserID:       userID,
	}); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RequestBranchLockJoin handles POST /api/repos/{owner}/{repo}/branch-locks/join-requests.
func (h *BranchLockHandler) RequestBranchLockJoin(w http.ResponseWriter, r *http.Request) {
	repositoryID, userID, username, ok := repoAndUser(w, r)
	if !ok {
		return
	}
	req, ok := decodeBranchLockRequest(w, r)
	if !ok {
		return
	}
	resp, svcErr := h.Service.RequestBranchLockJoin(r.Context(), services.RequestBranchLockJoinInput{
		RepositoryID: repositoryID,
		Branch:       req.Branch,
		UserID:       userID,
		Username:     username,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusCreated, resp)
}

// ListBranchLockJoinRequests handles GET /api/repos/{owner}/{repo}/branch-locks/join-requests?branch=.
func (h *BranchLockHandler) ListBranchLockJoinRequests(w http.ResponseWriter, r *http.Request) {
	repositoryID, userID, _, ok := repoAndUser(w, r)
	if !ok {
		return
	}
	branch := r.URL.Query().Get("branch")
	if branch == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("branch query parameter is required"))
		return
	}
	resp, svcErr := h.Service.ListPendingBranchLockJoinRequests(r.Context(), services.AcquireBranchLockInput{
		RepositoryID: repositoryID,
		Branch:       branch,
		UserID:       userID,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}

// DecideBranchLockJoin handles POST /api/repos/{owner}/{repo}/branch-locks/join-requests/{id}/decide.
func (h *BranchLockHandler) DecideBranchLockJoin(w http.ResponseWriter, r *http.Request) {
	repositoryID, userID, _, ok := repoAndUser(w, r)
	if !ok {
		return
	}
	joinRequestID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || joinRequestID <= 0 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("join request id required"))
		return
	}

	var req decideBranchLockJoinRequest
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid JSON body"))
		return
	}
	var approve bool
	switch req.Decision {
	case "approve", "approved":
		approve = true
	case "deny", "denied", "rejected":
		approve = false
	default:
		pkgerrors.WriteError(w, pkgerrors.BadRequest("decision must be 'approve' or 'deny'"))
		return
	}

	resp, svcErr := h.Service.DecideBranchLockJoin(r.Context(), services.DecideBranchLockJoinInput{
		RepositoryID:  repositoryID,
		JoinRequestID: joinRequestID,
		ResolverID:    userID,
		Approve:       approve,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}

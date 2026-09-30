package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/lfsauth"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// LFSJSONMediaType is the protocol media type sent and expected by git-lfs.
const LFSJSONMediaType = "application/vnd.git-lfs+json"

type LFSRouteService interface {
	Batch(ctx context.Context, actor *db.User, owner, repo string, input services.LFSBatchInput) (services.LFSBatchResponse, error)
	ConfirmUpload(ctx context.Context, actor *db.User, owner, repo string, input services.LFSConfirmUploadInput) (db.LfsObject, error)
	DeleteObject(ctx context.Context, actor *db.User, owner, repo, oid string) error
	ListObjects(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.LfsObject, int64, error)
}

type LFSHandler struct{ Service LFSRouteService }

type lfsBatchRequest struct {
	Operation string                    `json:"operation"`
	Objects   []services.LFSObjectInput `json:"objects"`
}

type lfsConfirmRequest struct {
	Oid  string `json:"oid"`
	Size int64  `json:"size"`
}

func (h *LFSHandler) PostBatch(w http.ResponseWriter, r *http.Request) {
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	var req lfsBatchRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	rows, svcErr := h.Service.Batch(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, services.LFSBatchInput{Operation: req.Operation, Objects: req.Objects})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	writeLFSJSON(w, http.StatusOK, rows)
}

func (h *LFSHandler) PostConfirm(w http.ResponseWriter, r *http.Request) {
	h.confirmUpload(w, r, http.StatusCreated, true, false)
}

// PostVerify implements the verify action from the Git LFS Basic Transfer
// protocol. git-lfs POSTs the same {oid,size} payload as the legacy confirm
// endpoint and only requires a successful 2xx response; an empty 200 response
// avoids exposing the internal metadata representation on this protocol path.
func (h *LFSHandler) PostVerify(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", LFSJSONMediaType)
	h.confirmUpload(w, r, http.StatusOK, false, true)
}

func (h *LFSHandler) confirmUpload(w http.ResponseWriter, r *http.Request, successStatus int, includeObject, allowScopedCredential bool) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		_, scoped := lfsauth.ClaimsFromContext(r.Context())
		if !allowScopedCredential || !scoped {
			_, err := requireRouteUser(r)
			errors.WriteError(w, err.(*errors.APIError))
			return
		}
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if scopedErr := validateLFSScopedRoute(r.Context(), owner, repo, lfsauth.OperationUpload, allowScopedCredential); scopedErr != nil {
		errors.WriteError(w, scopedErr)
		return
	}
	if authInfo := middleware.AuthInfoFromContext(r.Context()); authInfo != nil && authInfo.User != nil && authInfo.IsTokenAuth && !authInfo.Scopes.Has(middleware.ScopeWriteRepository) {
		errors.WriteError(w, errors.Forbidden("insufficient token scope"))
		return
	}
	var req lfsConfirmRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	obj, svcErr := h.Service.ConfirmUpload(r.Context(), actor, owner, repo, services.LFSConfirmUploadInput{Oid: req.Oid, Size: req.Size})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	if includeObject {
		errors.WriteJSON(w, successStatus, obj)
		return
	}
	w.WriteHeader(successStatus)
}

func validateLFSScopedRoute(ctx context.Context, owner, repo string, operation lfsauth.Operation, allowVerify bool) *errors.APIError {
	claims, ok := lfsauth.ClaimsFromContext(ctx)
	if !ok {
		return nil
	}
	if claims.Purpose == lfsauth.PurposeVerify && !allowVerify {
		return errors.Forbidden("lfs verify credential cannot authorize this operation")
	}
	owner = strings.ToLower(strings.TrimSpace(owner))
	repo = strings.ToLower(strings.TrimSpace(repo))
	if claims.Owner != owner || claims.Repository != repo || claims.Operation != operation {
		return errors.Forbidden("lfs credential does not authorize this repository operation")
	}
	return nil
}

func writeLFSJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", LFSJSONMediaType)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (h *LFSHandler) DeleteObject(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	oid, err := routeParam(r, "oid", "oid is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if svcErr := h.Service.DeleteObject(r.Context(), actor, owner, repo, oid); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *LFSHandler) GetObjects(w http.ResponseWriter, r *http.Request) {
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	page := cursorToPage(cursor, limit)
	rows, total, svcErr := h.Service.ListObjects(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, page, limit)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	setPaginationHeaders(w, r, cursor, limit, len(rows), total)
	errors.WriteJSON(w, http.StatusOK, rows)
}

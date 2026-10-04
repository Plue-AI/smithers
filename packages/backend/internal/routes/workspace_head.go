package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// WorkspaceHeadReportService is the optional service surface behind
// POST /api/repos/{owner}/{repo}/workspaces/{id}/head (RFD-004).
type WorkspaceHeadReportService interface {
	ReportWorkspaceHead(ctx context.Context, input services.ReportWorkspaceHeadInput) (services.WorkspaceResponse, error)
}

type reportWorkspaceHeadRequest struct {
	RetainSource     *repohost.WorkspaceSource            `json:"retain_source,omitempty"`
	ChangeID         string                               `json:"change_id"`
	CommitID         string                               `json:"commit_id"`
	Ahead            int32                                `json:"ahead"`
	Behind           int32                                `json:"behind"`
	CodingOperations []services.WorkspaceCodingProjection `json:"coding_operations,omitempty"`
}

func (request *reportWorkspaceHeadRequest) UnmarshalJSON(raw []byte) error {
	type plain reportWorkspaceHeadRequest
	var value plain
	if err := json.Unmarshal(raw, &value); err != nil {
		return err
	}
	if value.RetainSource != nil {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			return err
		}
		if len(fields) != 1 {
			return errors.New("retain_source must be the only head-report field")
		}
	}
	*request = reportWorkspaceHeadRequest(value)
	return nil
}

// ReportWorkspaceHead handles POST /api/repos/{owner}/{repo}/workspaces/{id}/head.
// The guest head reporter calls it with the workspace's own token after
// pushing refs/smithers/branches/{id}/head; the owner may call it too.
func (h *WorkspaceHandler) ReportWorkspaceHead(w http.ResponseWriter, r *http.Request) {
	service, ok := h.Service.(WorkspaceHeadReportService)
	if !ok || service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workspace head reports unavailable"))
		return
	}
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}
	workspaceID, err := routeParam(r, "id", "workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	var req reportWorkspaceHeadRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	tokenWorkspace := ""
	if info := middleware.AuthInfoFromContext(r.Context()); info != nil {
		tokenWorkspace = info.WorkspaceRestriction()
	}
	updated, svcErr := service.ReportWorkspaceHead(r.Context(), services.ReportWorkspaceHeadInput{
		WorkspaceID:      workspaceID,
		RetainSource:     req.RetainSource,
		RepositoryID:     repoCtx.Repository.ID,
		UserID:           user.ID,
		TokenWorkspaceID: tokenWorkspace,
		ChangeID:         req.ChangeID,
		CommitID:         req.CommitID,
		Ahead:            req.Ahead,
		Behind:           req.Behind,
		CodingOperations: req.CodingOperations,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, updated)
}

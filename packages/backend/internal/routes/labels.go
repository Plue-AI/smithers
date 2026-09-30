package routes

import (
	"context"
	"net/http"
	"strconv"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type LabelRouteService interface {
	CreateLabel(ctx context.Context, actor *db.User, owner, repo string, req services.CreateLabelInput) (db.Label, error)
	ListLabels(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.Label, int64, error)
	GetLabel(ctx context.Context, viewer *db.User, owner, repo string, id int64) (db.Label, error)
	UpdateLabel(ctx context.Context, actor *db.User, owner, repo string, id int64, req services.UpdateLabelInput) (db.Label, error)
	DeleteLabel(ctx context.Context, actor *db.User, owner, repo string, id int64) error
	AddLabelsToIssue(ctx context.Context, actor *db.User, owner, repo string, number int64, names []string) ([]db.Label, error)
	ListIssueLabels(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.Label, int64, error)
	RemoveIssueLabelByName(ctx context.Context, actor *db.User, owner, repo string, number int64, labelName string) error
}

type LabelHandler struct {
	Service LabelRouteService
}

type createLabelRequest struct {
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
}

type updateLabelRequest struct {
	Name        *string `json:"name,omitempty"`
	Color       *string `json:"color,omitempty"`
	Description *string `json:"description,omitempty"`
}

type postIssueLabelsRequest struct {
	Labels []string `json:"labels"`
}

func (h *LabelHandler) PostRepoLabel(w http.ResponseWriter, r *http.Request) {
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

	var req createLabelRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	created, err := h.Service.CreateLabel(r.Context(), actor, owner, repo, services.CreateLabelInput{
		Name:        req.Name,
		Color:       req.Color,
		Description: req.Description,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, created)
}

func (h *LabelHandler) GetRepoLabels(w http.ResponseWriter, r *http.Request) {
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
	labels, total, err := h.Service.ListLabels(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, page, limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(labels), total)
	errors.WriteJSON(w, http.StatusOK, labels)
}

func (h *LabelHandler) GetRepoLabel(w http.ResponseWriter, r *http.Request) {
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	id, err := parseInt64RouteParam(r, "id", "label id is required", "invalid label id")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	label, err := h.Service.GetLabel(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, id)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, label)
}

func (h *LabelHandler) PatchRepoLabel(w http.ResponseWriter, r *http.Request) {
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
	id, err := parseInt64RouteParam(r, "id", "label id is required", "invalid label id")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req updateLabelRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	updated, err := h.Service.UpdateLabel(r.Context(), actor, owner, repo, id, services.UpdateLabelInput{
		Name:        req.Name,
		Color:       req.Color,
		Description: req.Description,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, updated)
}

func (h *LabelHandler) DeleteRepoLabel(w http.ResponseWriter, r *http.Request) {
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
	id, err := parseInt64RouteParam(r, "id", "label id is required", "invalid label id")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	if err := h.Service.DeleteLabel(r.Context(), actor, owner, repo, id); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *LabelHandler) PostIssueLabels(w http.ResponseWriter, r *http.Request) {
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
	number, err := parseInt64RouteParam(r, "number", "issue number is required", "invalid issue number")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req postIssueLabelsRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	labels, err := h.Service.AddLabelsToIssue(r.Context(), actor, owner, repo, number, req.Labels)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, labels)
}

func (h *LabelHandler) GetIssueLabels(w http.ResponseWriter, r *http.Request) {
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	number, err := parseInt64RouteParam(r, "number", "issue number is required", "invalid issue number")
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
	labels, total, err := h.Service.ListIssueLabels(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, number, page, limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(labels), total)
	errors.WriteJSON(w, http.StatusOK, labels)
}

func (h *LabelHandler) DeleteIssueLabel(w http.ResponseWriter, r *http.Request) {
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
	number, err := parseInt64RouteParam(r, "number", "issue number is required", "invalid issue number")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	name, err := routeParam(r, "name", "label name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	if err := h.Service.RemoveIssueLabelByName(r.Context(), actor, owner, repo, number, name); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func parseInt64RouteParam(r *http.Request, key, missingMessage, invalidMessage string) (int64, error) {
	raw, err := routeParam(r, key, missingMessage)
	if err != nil {
		return 0, err
	}
	value, parseErr := strconv.ParseInt(raw, 10, 64)
	if parseErr != nil {
		return 0, errors.BadRequest(invalidMessage)
	}
	return value, nil
}

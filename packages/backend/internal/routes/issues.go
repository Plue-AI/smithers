package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type IssueRouteService interface {
	ListIssues(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.IssueResponse, string, int64, error)
	CreateIssue(ctx context.Context, actor *db.User, owner, repo string, req services.CreateIssueInput) (services.IssueResponse, error)
	GetIssue(ctx context.Context, viewer *db.User, owner, repo string, number int64) (services.IssueResponse, error)
	UpdateIssue(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.UpdateIssueInput) (services.IssueResponse, error)
	CreateIssueComment(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateIssueCommentInput) (services.IssueCommentResponse, error)
	ListIssueComments(ctx context.Context, viewer *db.User, owner, repo string, number int64, afterID int64, limit int) ([]services.IssueCommentResponse, string, int64, error)
	GetIssueComment(ctx context.Context, viewer *db.User, owner, repo string, commentID int64) (services.IssueCommentResponse, error)
	UpdateIssueComment(ctx context.Context, actor *db.User, owner, repo string, commentID int64, req services.UpdateIssueCommentInput) (services.IssueCommentResponse, error)
	DeleteIssueComment(ctx context.Context, actor *db.User, owner, repo string, commentID int64) error
}

type IssueHandler struct {
	Service    IssueRouteService
	LinearLink LinearIssueLinkRouteService
}

type createIssueRequest struct {
	IdempotencyKey string   `json:"idempotency_key,omitempty"`
	Kind           string   `json:"kind,omitempty"`
	Title          string   `json:"title"`
	Body           string   `json:"body"`
	Assignees      []string `json:"assignees,omitempty"`
	Labels         []string `json:"labels,omitempty"`
	Milestone      *int64   `json:"milestone,omitempty"`
}

type patchIssueRequest struct {
	Title     *string             `json:"title,omitempty"`
	Body      *string             `json:"body,omitempty"`
	State     *string             `json:"state,omitempty"`
	Assignees *[]string           `json:"assignees,omitempty"`
	Labels    *[]string           `json:"labels,omitempty"`
	Milestone issueMilestonePatch `json:"milestone"`
}

type createIssueCommentRequest struct {
	Persona        *services.IssuePersona `json:"persona,omitempty"`
	IdempotencyKey string                 `json:"idempotency_key,omitempty"`
	Body           string                 `json:"body"`
}

type patchIssueCommentRequest struct {
	Body string `json:"body"`
}

type issueMilestonePatch struct {
	Set   bool
	Value *int64
}

func (m *issueMilestonePatch) UnmarshalJSON(data []byte) error {
	m.Set = true
	if string(data) == "null" {
		m.Value = nil
		return nil
	}

	var id int64
	if err := json.Unmarshal(data, &id); err != nil {
		return err
	}
	m.Value = &id
	return nil
}

func (h *IssueHandler) ListIssues(w http.ResponseWriter, r *http.Request) {
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	afterNumber, limit, err := parseKeysetPagination(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	items, nextCursor, total, err := h.Service.ListIssues(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, afterNumber, limit, strings.TrimSpace(r.URL.Query().Get("state")))
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setFullCursorPaginationHeaders(w, r, limit, total, nextCursor)
	errors.WriteJSON(w, http.StatusOK, items)
}

func (h *IssueHandler) CreateIssue(w http.ResponseWriter, r *http.Request) {
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
	if aliasErr := refuseGitHubSourceWrite(r, "Opening an issue"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}

	var req createIssueRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	created, err := h.Service.CreateIssue(r.Context(), actor, owner, repo, services.CreateIssueInput{Kind: req.Kind, IdempotencyKey: req.IdempotencyKey,
		Title:     req.Title,
		Body:      req.Body,
		Assignees: req.Assignees,
		Labels:    req.Labels,
		Milestone: req.Milestone,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, created)
}

func (h *IssueHandler) GetIssue(w http.ResponseWriter, r *http.Request) {
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

	issue, err := h.Service.GetIssue(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, number)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, issue)
}

func (h *IssueHandler) PatchIssue(w http.ResponseWriter, r *http.Request) {
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
	if aliasErr := refuseGitHubSourceWrite(r, "Changing an issue"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}
	number, err := parseInt64RouteParam(r, "number", "issue number is required", "invalid issue number")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req patchIssueRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	var milestone *services.IssueMilestonePatch
	if req.Milestone.Set {
		milestone = &services.IssueMilestonePatch{Value: req.Milestone.Value}
	}

	updated, err := h.Service.UpdateIssue(r.Context(), actor, owner, repo, number, services.UpdateIssueInput{
		Title:     req.Title,
		Body:      req.Body,
		State:     req.State,
		Assignees: req.Assignees,
		Labels:    req.Labels,
		Milestone: milestone,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, updated)
}

func (h *IssueHandler) PostIssueComment(w http.ResponseWriter, r *http.Request) {
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
	if aliasErr := refuseGitHubSourceWrite(r, "Commenting"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}
	number, err := parseInt64RouteParam(r, "number", "issue number is required", "invalid issue number")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req createIssueCommentRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	created, err := h.Service.CreateIssueComment(r.Context(), actor, owner, repo, number, services.CreateIssueCommentInput{Body: req.Body, Persona: req.Persona, IdempotencyKey: req.IdempotencyKey})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, created)
}

func (h *IssueHandler) ListIssueComments(w http.ResponseWriter, r *http.Request) {
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
	if key := r.URL.Query().Get("idempotency_key"); key != "" {
		svc, ok := h.Service.(*services.IssueService)
		if !ok {
			errors.WriteError(w, errors.Internal("comment lookup unavailable"))
			return
		}
		comment, e := svc.FindIssueComment(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, number, key)
		if e != nil {
			writeRouteError(w, r, e)
			return
		}
		errors.WriteJSON(w, http.StatusOK, comment)
		return
	}
	afterID, limit, err := parseKeysetPagination(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	items, nextCursor, total, err := h.Service.ListIssueComments(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, number, afterID, limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setFullCursorPaginationHeaders(w, r, limit, total, nextCursor)
	errors.WriteJSON(w, http.StatusOK, items)
}

func (h *IssueHandler) GetIssueComment(w http.ResponseWriter, r *http.Request) {
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	id, err := parseInt64RouteParam(r, "id", "comment id is required", "invalid comment id")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	comment, err := h.Service.GetIssueComment(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, id)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, comment)
}

func (h *IssueHandler) PatchIssueComment(w http.ResponseWriter, r *http.Request) {
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
	if aliasErr := refuseGitHubSourceWrite(r, "Editing a comment"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}
	id, err := parseInt64RouteParam(r, "id", "comment id is required", "invalid comment id")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req patchIssueCommentRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	updated, err := h.Service.UpdateIssueComment(r.Context(), actor, owner, repo, id, services.UpdateIssueCommentInput{Body: req.Body})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, updated)
}

func (h *IssueHandler) DeleteIssueComment(w http.ResponseWriter, r *http.Request) {
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
	if aliasErr := refuseGitHubSourceWrite(r, "Deleting a comment"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}
	id, err := parseInt64RouteParam(r, "id", "comment id is required", "invalid comment id")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	if err := h.Service.DeleteIssueComment(r.Context(), actor, owner, repo, id); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

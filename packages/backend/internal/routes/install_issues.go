package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// InstallIssueRouteService reads the install repository's GitHub issues
// through the install's App.
type InstallIssueRouteService interface {
	InstallIssues(ctx context.Context, repositoryID int64, state string, page int) ([]services.InstallIssue, error)
	InstallIssue(ctx context.Context, repositoryID, number int64) (services.InstallIssueThread, error)
}

// InstallIssuesHandler serves the issue list card and the issue card on an
// install: GET /api/issues and GET /api/issues/{n}. Members read them by role
// (issue.read); the repository is the install's, never the caller's.
type InstallIssuesHandler struct {
	Queries *db.Queries
	Service InstallIssueRouteService
}

func (h *InstallIssuesHandler) authorize(w http.ResponseWriter, r *http.Request) (int64, bool) {
	if h == nil || h.Service == nil {
		todoRouteError(w, nil)
		return 0, false
	}
	repo, _, ok := authorizeInstallRepository(w, r, h.Queries, "issue.read")
	return repo, ok
}

// List answers one page of the repository's issues: ?state=open (default),
// closed or all, and ?page (1 by default), newest first.
func (h *InstallIssuesHandler) List(w http.ResponseWriter, r *http.Request) {
	repo, ok := h.authorize(w, r)
	if !ok {
		return
	}
	state := r.URL.Query().Get("state")
	if state == "" {
		state = "open"
	}
	page := 1
	if raw := r.URL.Query().Get("page"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			todoRouteError(w, &services.TodoControlError{Status: http.StatusBadRequest, Code: "invalid_issue_query", Class: "user", Message: "page is a number"})
			return
		}
		page = parsed
	}
	issues, err := h.Service.InstallIssues(r.Context(), repo, state, page)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(issues)
}

// Get answers issue n and its comments.
func (h *InstallIssuesHandler) Get(w http.ResponseWriter, r *http.Request) {
	repo, ok := h.authorize(w, r)
	if !ok {
		return
	}
	n, err := strconv.ParseInt(chi.URLParam(r, "n"), 10, 64)
	if err != nil || n <= 0 {
		todoRouteError(w, &services.TodoControlError{Status: http.StatusBadRequest, Code: "invalid_issue_query", Class: "user", Message: "Invalid issue number"})
		return
	}
	thread, err := h.Service.InstallIssue(r.Context(), repo, n)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(thread)
}

// Comment queues the canonical catalog command against the install repository.
func (h *InstallIssuesHandler) Comment(w http.ResponseWriter, r *http.Request) {
	repository, _, ok := authorizeInstallRepository(w, r, h.Queries, "issue.comment")
	if !ok {
		return
	}
	writer, ok := h.Service.(interface {
		RequestInstallIssueComment(context.Context, int64, int64, string, string) (jobs.RequestReceipt, error)
	})
	if !ok {
		todoRouteError(w, nil)
		return
	}
	number, err := strconv.ParseInt(chi.URLParam(r, "number"), 10, 64)
	if err != nil || number <= 0 {
		todoRouteError(w, &services.TodoControlError{Status: 400, Code: "invalid_issue_comment", Class: "user", Message: "Invalid issue number"})
		return
	}
	var input struct {
		Body string `json:"body"`
	}
	if !decodeStrictJSONBody(w, r, &input) {
		return
	}
	receipt, err := writer.RequestInstallIssueComment(r.Context(), repository, number, input.Body, r.Header.Get("Idempotency-Key"))
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	errors.WriteJSON(w, http.StatusAccepted, receipt)
}

// Create requests the issue.new write without waiting for GitHub.
func (h *InstallIssuesHandler) Create(w http.ResponseWriter, r *http.Request) {
	repository, _, ok := authorizeInstallRepository(w, r, h.Queries, "issue.new")
	if !ok {
		return
	}
	writer, ok := h.Service.(interface {
		RequestInstallIssueCreate(context.Context, int64, services.InstallIssueCreateInput, string) (jobs.RequestReceipt, error)
	})
	if !ok {
		todoRouteError(w, nil)
		return
	}
	var input services.InstallIssueCreateInput
	if !decodeStrictJSONBody(w, r, &input) {
		return
	}
	receipt, err := writer.RequestInstallIssueCreate(r.Context(), repository, input, r.Header.Get("Idempotency-Key"))
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	errors.WriteJSON(w, http.StatusAccepted, receipt)
}

func (h *InstallIssuesHandler) CreateStatus(w http.ResponseWriter, r *http.Request) {
	repository, _, ok := authorizeInstallRepository(w, r, h.Queries, "issue.read")
	if !ok {
		return
	}
	reader, ok := h.Service.(interface {
		InstallIssueCreateStatus(context.Context, int64, string) (map[string]any, error)
	})
	if !ok {
		todoRouteError(w, nil)
		return
	}
	result, err := reader.InstallIssueCreateStatus(r.Context(), repository, chi.URLParam(r, "id"))
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	errors.WriteJSON(w, http.StatusOK, result)
}

package routes

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type LandingRouteService interface {
	ListLandingRequests(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.LandingRequestResponse, string, int64, error)
	CreateLandingRequest(ctx context.Context, actor *db.User, owner, repo string, req services.CreateLandingRequestInput) (services.LandingRequestResponse, error)
	GetLandingRequest(ctx context.Context, viewer *db.User, owner, repo string, number int64) (services.LandingRequestResponse, error)
	UpdateLandingRequest(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.UpdateLandingRequestInput) (services.LandingRequestResponse, error)
	LandLandingRequest(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.LandLandingRequestInput) (services.LandLandingRequestAccepted, error)
	SetLandingRequestAutoLand(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.SetAutoLandInput) (services.LandingRequestResponse, error)
	ClearLandingRequestAutoLand(ctx context.Context, actor *db.User, owner, repo string, number int64) error
	CreateLandingReviewRequest(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateLandingReviewRequestInput) (services.LandingReviewRequestResponse, error)
	DismissLandingReviewRequest(ctx context.Context, actor *db.User, owner, repo string, number, requestID int64) error
	ListLandingReviews(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.LandingRequestReview, int64, error)
	CreateLandingReview(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateLandingReviewInput) (db.LandingRequestReview, error)
	DismissLandingReview(ctx context.Context, actor *db.User, owner, repo string, number, reviewID int64, req services.DismissLandingReviewInput) (db.LandingRequestReview, error)
	ListLandingComments(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]services.LandingCommentResponse, int64, error)
	CreateLandingComment(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateLandingCommentInput) (services.LandingCommentResponse, error)
	MarkLandingThreadDone(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error)
	AckLandingThread(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error)
	ReopenLandingThread(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error)
	ListLandingChanges(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]services.LandingChangeResponse, int64, error)
	GetLandingConflicts(ctx context.Context, viewer *db.User, owner, repo string, number int64) (services.LandingConflictsResponse, error)
	GetLandingDiff(ctx context.Context, viewer *db.User, owner, repo string, number int64, opts services.LandingDiffOptions) (services.LandingDiffResponse, error)
}

type LandingHandler struct {
	Service LandingRouteService
	// GitHubPull opens a landing's GitHub pull request. Nil when the
	// deployment has no GitHub App.
	GitHubPull LandingGitHubPullRouteService
}

// LandingGitHubPullRouteService opens the GitHub pull request of a landing.
type LandingGitHubPullRouteService interface {
	OpenLandingGitHubPull(ctx context.Context, actor *db.User, owner, repo string, number int64, input services.LandingGitHubPullInput) (services.LandingGitHubPull, error)
}

// OpenLandingGitHubPull serves PUT /landings/{number}/github/pull. Repeating
// it returns the same pull request; it never opens a second one.
func (h *LandingHandler) OpenLandingGitHubPull(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, number, err := landingRouteContext(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if aliasErr := refuseGitHubSourceWrite(r, "Opening a GitHub pull request"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}
	if h.GitHubPull == nil {
		errors.WriteError(w, errors.New(errors.CodeServiceUnavailable, "GitHub pull requests are not configured"))
		return
	}
	var req struct {
		CommitID string `json:"commit_id"`
		RunID    string `json:"run_id"`
	}
	if !decodeJSONBody(w, r, &req) {
		return
	}
	pull, svcErr := h.GitHubPull.OpenLandingGitHubPull(r.Context(), user, owner, repo, number, services.LandingGitHubPullInput{CommitID: req.CommitID, RunID: req.RunID})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	status := http.StatusOK
	if pull.Created {
		status = http.StatusCreated
	}
	errors.WriteJSON(w, status, pull)
}

type createLandingRequest struct {
	Title          string   `json:"title"`
	Body           string   `json:"body"`
	TargetBookmark string   `json:"target_bookmark"`
	SourceBookmark string   `json:"source_bookmark"`
	ChangeIDs      []string `json:"change_ids"`
}

type updateLandingRequest struct {
	Title          *string `json:"title,omitempty"`
	Body           *string `json:"body,omitempty"`
	State          *string `json:"state,omitempty"`
	TargetBookmark *string `json:"target_bookmark,omitempty"`
	SourceBookmark *string `json:"source_bookmark,omitempty"`
	ConflictStatus *string `json:"conflict_status,omitempty"`
}

type createLandingReviewRequest struct {
	IdempotencyKey   string `json:"idempotency_key"`
	Type             string `json:"type"`
	Body             string `json:"body"`
	Verdict          string `json:"verdict"`
	ConfidenceBucket string `json:"confidence_bucket"`
	Summary          string `json:"summary"`
	CommitID         string `json:"commit_id"`
}

type requestLandingReviewRequest struct {
	Reviewer string `json:"reviewer"`
	Agent    string `json:"agent"`
}

type setAutoLandRequest struct {
	Enabled *bool `json:"enabled"`
}

type dismissLandingReviewRequest struct {
	Message string `json:"message"`
}

type createLandingCommentRequest struct {
	IdempotencyKey string `json:"idempotency_key"`
	Path           string `json:"path"`
	Line           int64  `json:"line"`
	Side           string `json:"side"`
	Body           string `json:"body"`
	CommitID       string `json:"commit_id"`
}

func (h *LandingHandler) ListLandingRequests(w http.ResponseWriter, r *http.Request) {
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

	state := strings.TrimSpace(r.URL.Query().Get("state"))
	items, nextCursor, total, err := h.Service.ListLandingRequests(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, afterNumber, limit, state)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setFullCursorPaginationHeaders(w, r, limit, total, nextCursor)
	errors.WriteJSON(w, http.StatusOK, items)
}

func (h *LandingHandler) PutLandingRequest(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "request_uuid")
	if id == "" {
		errors.WriteError(w, errors.BadRequest("request_uuid is required"))
		return
	}
	h.createLandingRequest(w, r, id)
}
func (h *LandingHandler) CreateLandingRequest(w http.ResponseWriter, r *http.Request) {
	h.createLandingRequest(w, r, "")
}
func (h *LandingHandler) createLandingRequest(w http.ResponseWriter, r *http.Request, requestID string) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if aliasErr := refuseGitHubSourceWrite(r, "Opening a landing request"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}

	var req createLandingRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	created, err := h.Service.CreateLandingRequest(r.Context(), user, owner, repo, services.CreateLandingRequestInput{
		RequestID:      requestID,
		Title:          req.Title,
		Body:           req.Body,
		TargetBookmark: req.TargetBookmark,
		SourceBookmark: req.SourceBookmark,
		ChangeIDs:      req.ChangeIDs,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusCreated, created)
}

func (h *LandingHandler) GetLandingRequest(w http.ResponseWriter, r *http.Request) {
	owner, repo, number, err := landingRouteContext(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	landing, svcErr := h.Service.GetLandingRequest(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, number)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusOK, landing)
}

func (h *LandingHandler) PatchLandingRequest(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, number, err := landingRouteContext(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if aliasErr := refuseGitHubSourceWrite(r, "Changing a landing request"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}

	var req updateLandingRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	updated, svcErr := h.Service.UpdateLandingRequest(r.Context(), user, owner, repo, number, services.UpdateLandingRequestInput{
		Title:          req.Title,
		Body:           req.Body,
		State:          req.State,
		TargetBookmark: req.TargetBookmark,
		SourceBookmark: req.SourceBookmark,
		ConflictStatus: req.ConflictStatus,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusOK, updated)
}

// AppendLandingRequest exposes a distinct capability route: old servers return 404.
func (h *LandingHandler) AppendLandingRequest(w http.ResponseWriter, r *http.Request) {
	h.landLandingRequest(w, r, true)
}

func (h *LandingHandler) LandLandingRequest(w http.ResponseWriter, r *http.Request) {
	h.landLandingRequest(w, r, false)
}

func (h *LandingHandler) landLandingRequest(w http.ResponseWriter, r *http.Request, appendOnly bool) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, number, err := landingRouteContext(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if aliasErr := refuseGitHubSourceWrite(r, "Landing a change"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}

	var req struct {
		CommitID           string `json:"commit_id"`
		ExpectedCommitID   string `json:"expected_commit_id"`
		SourceBaseCommitID string `json:"source_base_commit_id"`
		Description        string `json:"description"`
	}
	if !decodeJSONBody(w, r, &req) {
		return
	}

	input := services.LandLandingRequestInput{CommitID: req.CommitID}
	if appendOnly {
		input.ExpectedCommitID = &req.ExpectedCommitID
		input.Append = &repohost.LandAppend{SourceCommitID: req.CommitID, SourceBaseCommitID: req.SourceBaseCommitID, Description: req.Description}
	} else if req.ExpectedCommitID != "" || req.SourceBaseCommitID != "" || req.Description != "" {
		errors.WriteError(w, errors.BadRequest("append requires the dedicated /land/append route"))
		return
	}
	updated, svcErr := h.Service.LandLandingRequest(r.Context(), user, owner, repo, number, input)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusAccepted, updated)
}

func (h *LandingHandler) SetLandingRequestAutoLand(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, number, err := landingRouteContext(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if aliasErr := refuseGitHubSourceWrite(r, "Enabling auto-land"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}
	var req setAutoLandRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	if req.Enabled == nil {
		errors.WriteError(w, errors.ValidationFailed(errors.FieldError{Resource: "LandingRequestAutoLand", Field: "enabled", Code: "missing_field"}))
		return
	}
	landing, svcErr := h.Service.SetLandingRequestAutoLand(r.Context(), user, owner, repo, number, services.SetAutoLandInput{Enabled: *req.Enabled})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusOK, landing)
}

func (h *LandingHandler) ClearLandingRequestAutoLand(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, number, err := landingRouteContext(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if aliasErr := refuseGitHubSourceWrite(r, "Clearing auto-land"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}
	if svcErr := h.Service.ClearLandingRequestAutoLand(r.Context(), user, owner, repo, number); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *LandingHandler) RequestLandingReview(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, number, err := landingRouteContext(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if aliasErr := refuseGitHubSourceWrite(r, "Requesting review"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}

	var req requestLandingReviewRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	created, svcErr := h.Service.CreateLandingReviewRequest(r.Context(), user, owner, repo, number, services.CreateLandingReviewRequestInput{
		Reviewer: req.Reviewer,
		Agent:    req.Agent,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, created)
}

func (h *LandingHandler) DeleteLandingReviewRequest(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, number, err := landingRouteContext(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if aliasErr := refuseGitHubSourceWrite(r, "Dismissing a review request"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}
	requestIDRaw, err := routeParam(r, "id", "review request id is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	requestID, parseErr := strconv.ParseInt(requestIDRaw, 10, 64)
	if parseErr != nil || requestID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid review request id"))
		return
	}
	if svcErr := h.Service.DismissLandingReviewRequest(r.Context(), user, owner, repo, number, requestID); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *LandingHandler) ListLandingReviews(w http.ResponseWriter, r *http.Request) {
	owner, repo, number, err := landingRouteContext(r)
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
	items, total, svcErr := h.Service.ListLandingReviews(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, number, page, limit)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	setPaginationHeaders(w, r, cursor, limit, len(items), total)
	w.Header().Set("X-Per-Page", strconv.Itoa(limit))
	errors.WriteJSON(w, http.StatusOK, items)
}

func (h *LandingHandler) PostLandingReview(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, number, err := landingRouteContext(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if aliasErr := refuseGitHubSourceWrite(r, "Reviewing"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}

	var req createLandingReviewRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	review, svcErr := h.Service.CreateLandingReview(r.Context(), user, owner, repo, number, services.CreateLandingReviewInput{
		IdempotencyKey:   req.IdempotencyKey,
		Type:             req.Type,
		Body:             req.Body,
		Verdict:          req.Verdict,
		ConfidenceBucket: req.ConfidenceBucket,
		Summary:          req.Summary,
		CommitID:         req.CommitID,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, review)
}

func (h *LandingHandler) DismissLandingReview(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, number, err := landingRouteContext(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	reviewIDRaw, err := routeParam(r, "review_id", "review_id is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	reviewID, parseErr := strconv.ParseInt(reviewIDRaw, 10, 64)
	if parseErr != nil || reviewID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid review_id"))
		return
	}

	var req dismissLandingReviewRequest
	if !decodeOptionalJSONBody(w, r, &req) {
		return
	}

	review, svcErr := h.Service.DismissLandingReview(r.Context(), user, owner, repo, number, reviewID, services.DismissLandingReviewInput{
		Message: req.Message,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusOK, review)
}

func (h *LandingHandler) GetLandingDiff(w http.ResponseWriter, r *http.Request) {
	owner, repo, number, err := landingRouteContext(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	diff, svcErr := h.Service.GetLandingDiff(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, number, services.LandingDiffOptions{
		IgnoreWhitespace: diffWhitespaceIgnored(r),
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusOK, diff)
}

func (h *LandingHandler) ListLandingComments(w http.ResponseWriter, r *http.Request) {
	owner, repo, number, err := landingRouteContext(r)
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
	items, total, svcErr := h.Service.ListLandingComments(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, number, page, limit)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	setPaginationHeaders(w, r, cursor, limit, len(items), total)
	w.Header().Set("X-Per-Page", strconv.Itoa(limit))
	errors.WriteJSON(w, http.StatusOK, items)
}

func (h *LandingHandler) PostLandingComment(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, number, err := landingRouteContext(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if aliasErr := refuseGitHubSourceWrite(r, "Commenting"); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}

	var req createLandingCommentRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	comment, svcErr := h.Service.CreateLandingComment(r.Context(), user, owner, repo, number, services.CreateLandingCommentInput{
		IdempotencyKey: req.IdempotencyKey,
		Path:           req.Path,
		Line:           req.Line,
		Side:           req.Side,
		Body:           req.Body,
		CommitID:       req.CommitID,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, comment)
}

func (h *LandingHandler) MarkLandingThreadDone(w http.ResponseWriter, r *http.Request) {
	h.updateLandingThread(w, r, "Marking a review comment done", h.Service.MarkLandingThreadDone)
}

func (h *LandingHandler) AckLandingThread(w http.ResponseWriter, r *http.Request) {
	h.updateLandingThread(w, r, "Acknowledging a review comment", h.Service.AckLandingThread)
}

func (h *LandingHandler) ReopenLandingThread(w http.ResponseWriter, r *http.Request) {
	h.updateLandingThread(w, r, "Reopening a review comment", h.Service.ReopenLandingThread)
}

func (h *LandingHandler) updateLandingThread(
	w http.ResponseWriter,
	r *http.Request,
	action string,
	update func(context.Context, *db.User, string, string, int64, int64) (db.LandingRequestComment, error),
) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, number, err := landingRouteContext(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if aliasErr := refuseGitHubSourceWrite(r, action); aliasErr != nil {
		errors.WriteError(w, aliasErr)
		return
	}
	threadIDRaw, err := routeParam(r, "id", "thread id is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	threadID, parseErr := strconv.ParseInt(threadIDRaw, 10, 64)
	if parseErr != nil || threadID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid thread id"))
		return
	}

	thread, svcErr := update(r.Context(), user, owner, repo, number, threadID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusOK, thread)
}

func (h *LandingHandler) ListLandingChanges(w http.ResponseWriter, r *http.Request) {
	owner, repo, number, err := landingRouteContext(r)
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
	items, total, svcErr := h.Service.ListLandingChanges(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, number, page, limit)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	setPaginationHeaders(w, r, cursor, limit, len(items), total)
	w.Header().Set("X-Per-Page", strconv.Itoa(limit))
	errors.WriteJSON(w, http.StatusOK, items)
}

func (h *LandingHandler) GetLandingConflicts(w http.ResponseWriter, r *http.Request) {
	owner, repo, number, err := landingRouteContext(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	resp, svcErr := h.Service.GetLandingConflicts(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, number)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusOK, resp)
}

func landingRouteContext(r *http.Request) (owner string, repo string, number int64, err error) {
	owner, repo, err = repoOwnerAndName(r)
	if err != nil {
		return "", "", 0, err
	}
	numberRaw, err := routeParam(r, "number", "landing number is required")
	if err != nil {
		return "", "", 0, err
	}
	parsed, parseErr := strconv.ParseInt(numberRaw, 10, 64)
	if parseErr != nil || parsed <= 0 {
		return "", "", 0, errors.BadRequest("invalid landing number")
	}
	return owner, repo, parsed, nil
}

package routes

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// repohostErrToAPIErr maps a repohost StatusError to the appropriate APIError.
// Non-StatusError values (e.g. network errors) become HTTP 500. The original
// error is logged server-side via the context logger; it is never included in
// the response body to avoid leaking internal implementation detail.
func repohostErrToAPIErr(ctx context.Context, err error, fallbackMsg string) *errors.APIError {
	if se, ok := repohost.IsStatusError(err); ok {
		switch se.StatusCode {
		case http.StatusNotFound:
			msg := se.Message
			if msg == "" {
				msg = fallbackMsg
			}
			return errors.NotFound(msg)
		case http.StatusBadRequest:
			msg := se.Message
			if msg == "" {
				msg = fallbackMsg
			}
			return errors.BadRequest(msg)
		case http.StatusConflict:
			msg := se.Message
			if msg == "" {
				msg = fallbackMsg
			}
			return errors.Conflict(msg)
		case http.StatusUnprocessableEntity:
			msg := se.Message
			if msg == "" {
				msg = fallbackMsg
			}
			return errors.UnprocessableEntity(msg)
		case http.StatusUnauthorized:
			return errors.Unauthorized("repo-host authorization failed")
		case http.StatusForbidden:
			return errors.Forbidden("repo-host permission denied")
		}
	}
	// Log the full error server-side; return a sanitized message to the client.
	middleware.LoggerFromContext(ctx).Error(fallbackMsg, "error", err)
	return errors.Internal(fallbackMsg)
}

// JJVCSHandler handles jj VCS API requests (bookmarks, changes, operations, diffs).
// It proxies calls through the repohost client which communicates with the repo-host service.
type JJVCSRepoResolver interface {
	GetRepoByOwnerAndName(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error)
	// ListAllProtectedBookmarksByRepo lets bookmark mutations enforce
	// protected-bookmark policy: protected bookmarks may only move through
	// the landing queue, never via direct create/delete.
	ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error)
}

type ChangeDetailService interface {
	GetChange(context.Context, int64, string, string, string) (services.ChangeDetailResponse, error)
	GetChangeDiff(context.Context, int64, string, string, string, services.ChangeDiffRequest) (repohost.ChangeDiff, error)
}

type ChangeFindingsService interface {
	GetFindings(context.Context, int64, string, string, string, string, int64) (services.ChangeFindingsResponse, error)
	SubmitFindingFeedback(context.Context, services.SubmitFindingFeedbackInput) (services.FindingFeedbackResponse, error)
	DispatchFinding(context.Context, services.DispatchFindingInput) (services.AgentSessionResponse, error)
}

type ChangeConflictResolutionService interface {
	ResolveConflict(context.Context, services.ResolveChangeConflictInput) (services.ResolveChangeConflictResponse, error)
}

type ChangeRevertService interface {
	RevertChange(context.Context, *db.User, int64, string, string, string) (services.ChangeRevertResponse, error)
}

type ChangeSplitService interface {
	SplitChange(context.Context, int64, string, string, string, services.SplitChangeInput) (services.SplitChangeResponse, error)
}

type ChangeOperationRouteService interface {
	ListOperations(context.Context, int64, string, *int64) ([]services.ChangeOperationResponse, error)
	PreviewUndo(context.Context, int64, int64, string, string) (services.OperationUndoPreview, error)
	Undo(context.Context, int64, int64, string, string, string, string) (services.OperationUndoResponse, error)
}

type ChangeWalkthroughService interface {
	GetWalkthrough(context.Context, int64, string, int64) (services.ChangeWalkthroughResponse, error)
	StoreWalkthrough(context.Context, int64, string, int64, services.ChangeWalkthroughResponse) (services.ChangeWalkthroughResponse, error)
}

type JJVCSHandler struct {
	RepoHost           *repohost.Client
	RepoResolver       JJVCSRepoResolver
	ChangeService      ChangeDetailService
	FindingsService    ChangeFindingsService
	ConflictResolver   ChangeConflictResolutionService
	ChangeReverter     ChangeRevertService
	ChangeSplitter     ChangeSplitService
	ChangeOperations   ChangeOperationRouteService
	WalkthroughService ChangeWalkthroughService
	Broker             *sse.Broker
	Metrics            *SmithersMetrics
	WebhookDispatcher  webhooks.Dispatcher
}

// ---------------------------------- Bookmarks ----------------------------------

// BookmarkResponse is the API response for a jj bookmark.
type BookmarkResponse struct {
	Name             string `json:"name"`
	TargetChangeID   string `json:"target_change_id"`
	TargetCommitID   string `json:"target_commit_id"`
	IsTrackingRemote bool   `json:"is_tracking_remote"`
}

// CreateBookmarkRequest is the API request for creating a bookmark.
type CreateBookmarkRequest struct {
	Name           string `json:"name"`
	TargetChangeID string `json:"target_change_id"`
}

func (h *JJVCSHandler) resolveRepository(ctx context.Context, owner, repoName string) (db.GetRepoByOwnerAndNameRow, *errors.APIError) {
	if h.RepoResolver == nil {
		return db.GetRepoByOwnerAndNameRow{}, errors.Internal("failed to resolve repository")
	}

	repo, err := h.RepoResolver.GetRepoByOwnerAndName(ctx, db.GetRepoByOwnerAndNameParams{
		Name:  repoName,
		Owner: owner,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.GetRepoByOwnerAndNameRow{}, errors.NotFound("repository not found")
		}
		return db.GetRepoByOwnerAndNameRow{}, errors.Internal("failed to resolve repository").WithCause(err)
	}

	return repo, nil
}

func buildBookmarkRefEventPayload(repo db.GetRepoByOwnerAndNameRow, owner string, actor *db.User, action string) webhooks.RepositoryEventPayload {
	sender := webhooks.UserPayload{}
	if actor != nil {
		sender = webhooks.UserPayload{
			ID:    actor.ID,
			Login: actor.Username,
		}
	}

	return webhooks.RepositoryEventPayload{
		Action: action,
		Repository: webhooks.RepositoryPayload{
			ID:       repo.ID,
			Name:     repo.Name,
			FullName: owner + "/" + repo.Name,
		},
		Sender: sender,
	}
}

// ListBookmarks handles GET /api/repos/{owner}/{repo}/bookmarks.
func (h *JJVCSHandler) ListBookmarks(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	cursor, limit, err := parsePagination(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	bookmarks, nextCursor, err := h.RepoHost.ListBookmarks(r.Context(), owner, repoName, cursor, limit)
	if err != nil {
		writeRouteError(w, r, repohostErrToAPIErr(r.Context(), err, "failed to list bookmarks"))
		return
	}

	resp := make([]BookmarkResponse, len(bookmarks))
	for i, b := range bookmarks {
		resp[i] = BookmarkResponse{
			Name:             b.Name,
			TargetChangeID:   b.TargetChangeID,
			TargetCommitID:   b.TargetCommitID,
			IsTrackingRemote: b.IsTrackingRemote,
		}
	}

	setCursorPaginationHeaders(w, r, limit, nextCursor)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(cursorResponse{Items: resp, NextCursor: nextCursor})
}

// CreateBookmark handles POST /api/repos/{owner}/{repo}/bookmarks.
func (h *JJVCSHandler) CreateBookmark(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		writeRouteError(w, r, errors.Unauthorized("authentication required"))
		return
	}

	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	var req CreateBookmarkRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeRouteError(w, r, errors.BadRequest("bookmark name is required"))
		return
	}
	if err := repohost.ValidateBookmarkName(name); err != nil {
		writeRouteError(w, r, errors.BadRequest("invalid bookmark name: "+err.Error()))
		return
	}
	if strings.TrimSpace(req.TargetChangeID) == "" {
		writeRouteError(w, r, errors.BadRequest("target_change_id is required"))
		return
	}

	repo, apiErr := h.resolveRepository(r.Context(), owner, repoName)
	if apiErr != nil {
		writeRouteError(w, r, apiErr)
		return
	}
	if err := services.RequireBookmarkNotProtected(r.Context(), h.RepoResolver, repo.ID, name); err != nil {
		writeRouteError(w, r, err)
		return
	}
	if err := requireAgentRunOffDefaultBookmark(r, name); err != nil {
		writeRouteError(w, r, err)
		return
	}

	bookmark, err := h.RepoHost.CreateBookmark(r.Context(), owner, repoName, repohost.CreateBookmarkRequest{
		Name:           name,
		TargetChangeID: req.TargetChangeID,
	})
	if err != nil {
		writeRouteError(w, r, repohostErrToAPIErr(r.Context(), err, "failed to create bookmark"))
		return
	}

	h.dispatchBookmarkEvent(r.Context(), repo, owner, actor, webhooks.EventTypeCreate, "created")

	resp := BookmarkResponse{
		Name:             bookmark.Name,
		TargetChangeID:   bookmark.TargetChangeID,
		TargetCommitID:   bookmark.TargetCommitID,
		IsTrackingRemote: bookmark.IsTrackingRemote,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(resp)
}

// requireAgentRunOffDefaultBookmark applies
// services.RequireAgentRunOffDefaultBookmark to the request's credential and
// repository.
func requireAgentRunOffDefaultBookmark(r *http.Request, bookmark string) error {
	kind := middleware.AuthInfoFromContext(r.Context()).CredentialKind()
	if kind != middleware.CredentialAgentRun {
		return nil
	}
	repository := middleware.RepoFromContext(r.Context())
	if repository == nil {
		return errors.Internal("repository context is not loaded")
	}
	return services.RequireAgentRunOffDefaultBookmark(kind, repository.DefaultBookmark, bookmark)
}

// DeleteBookmark handles DELETE /api/repos/{owner}/{repo}/bookmarks/{name}.
func (h *JJVCSHandler) DeleteBookmark(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		writeRouteError(w, r, errors.Unauthorized("authentication required"))
		return
	}

	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	name, err := routeParam(r, "name", "bookmark name is required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	repo, apiErr := h.resolveRepository(r.Context(), owner, repoName)
	if apiErr != nil {
		writeRouteError(w, r, apiErr)
		return
	}
	if err := services.RequireBookmarkNotProtected(r.Context(), h.RepoResolver, repo.ID, name); err != nil {
		writeRouteError(w, r, err)
		return
	}
	if err := requireAgentRunOffDefaultBookmark(r, name); err != nil {
		writeRouteError(w, r, err)
		return
	}

	deleteErr := h.RepoHost.DeleteBookmark(r.Context(), owner, repoName, name)
	if deleteErr != nil {
		writeRouteError(w, r, repohostErrToAPIErr(r.Context(), deleteErr, "failed to delete bookmark"))
		return
	}

	h.dispatchBookmarkEvent(r.Context(), repo, owner, actor, webhooks.EventTypeDelete, "deleted")

	w.WriteHeader(http.StatusNoContent)
}

// dispatchBookmarkEvent enqueues the bookmark webhook best-effort. The repo
// mutation has already committed by the time this runs, so an enqueue failure
// must not surface as a retryable error to the client — retrying would replay
// the already-applied mutation (conflict on create, 404 on delete).
func (h *JJVCSHandler) dispatchBookmarkEvent(ctx context.Context, repo db.GetRepoByOwnerAndNameRow, owner string, actor *db.User, eventType webhooks.EventType, action string) {
	if h.WebhookDispatcher == nil {
		return
	}
	payload := buildBookmarkRefEventPayload(repo, owner, actor, action)
	if err := h.WebhookDispatcher.DispatchEvent(ctx, repo.ID, eventType, payload); err != nil {
		middleware.LoggerFromContext(ctx).Error("failed to enqueue bookmark webhook delivery",
			"repo_id", repo.ID, "action", action, "error", err)
	}
}

// ---------------------------------- Changes ----------------------------------

// ChangeResponse is the API response for a jj change.
type ChangeResponse struct {
	ChangeID        string   `json:"change_id"`
	CommitID        string   `json:"commit_id"`
	Description     string   `json:"description"`
	AuthorName      string   `json:"author_name"`
	AuthorEmail     string   `json:"author_email"`
	Timestamp       string   `json:"timestamp"`
	HasConflict     bool     `json:"has_conflict"`
	IsEmpty         bool     `json:"is_empty"`
	ParentChangeIDs []string `json:"parent_change_ids"`
}

// ChangeDiffResponse is the API response for a change diff.
type ChangeDiffResponse struct {
	ChangeID  string         `json:"change_id"`
	FileDiffs []FileDiffItem `json:"file_diffs"`
}

// FileDiffItem describes a single file's change type in a diff.
type FileDiffItem struct {
	Path       string `json:"path"`
	OldPath    string `json:"old_path,omitempty"`
	ChangeType string `json:"change_type"`
	Patch      string `json:"patch,omitempty"`
	IsBinary   bool   `json:"is_binary"`
	TooLarge   bool   `json:"too_large,omitempty"`
	Language   string `json:"language,omitempty"`
	Additions  int    `json:"additions"`
	Deletions  int    `json:"deletions"`
	OldContent string `json:"old_content,omitempty"`
	NewContent string `json:"new_content,omitempty"`
}

// ChangeFileResponse is a changed file in a change.
type ChangeFileResponse struct {
	Path string `json:"path"`
}

// ChangeConflictResponse is a conflict in a change.
type ChangeConflictResponse struct {
	FilePath         string `json:"file_path"`
	ConflictType     string `json:"conflict_type"`
	BaseContent      string `json:"base_content,omitempty"`
	LeftContent      string `json:"left_content,omitempty"`
	RightContent     string `json:"right_content,omitempty"`
	Hunks            string `json:"hunks,omitempty"`
	ResolutionStatus string `json:"resolution_status,omitempty"`
}

type resolveChangeConflictRequest struct {
	Path string `json:"path"`
}

// ListChanges handles GET /api/repos/{owner}/{repo}/changes.
func (h *JJVCSHandler) ListChanges(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	cursor, limit, err := parsePagination(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	changes, nextCursor, err := h.RepoHost.ListChanges(r.Context(), owner, repoName, cursor, limit)
	if err != nil {
		writeRouteError(w, r, repohostErrToAPIErr(r.Context(), err, "failed to list changes"))
		return
	}

	resp := make([]ChangeResponse, len(changes))
	for i, c := range changes {
		resp[i] = ChangeResponse{
			ChangeID:        c.ChangeID,
			CommitID:        c.CommitID,
			Description:     c.Description,
			AuthorName:      c.AuthorName,
			AuthorEmail:     c.AuthorEmail,
			Timestamp:       c.Timestamp,
			HasConflict:     c.HasConflict,
			IsEmpty:         c.IsEmpty,
			ParentChangeIDs: c.ParentChangeIDs,
		}
	}

	setCursorPaginationHeaders(w, r, limit, nextCursor)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(cursorResponse{Items: resp, NextCursor: nextCursor})
}

// GetChange handles GET /api/repos/{owner}/{repo}/changes/{change_id}.
func (h *JJVCSHandler) GetChange(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	changeID, err := routeParam(r, "change_id", "change_id is required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.ChangeService == nil {
		writeRouteError(w, r, errors.Internal("change revision service not configured"))
		return
	}
	repository, apiErr := h.resolveRepository(r.Context(), owner, repoName)
	if apiErr != nil {
		writeRouteError(w, r, apiErr)
		return
	}
	resp, err := h.ChangeService.GetChange(r.Context(), repository.ID, owner, repoName, changeID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, resp)
}

// GetChangeFindings handles
// GET /api/repos/{owner}/{repo}/changes/{change_id}/findings[?rev=N].
func (h *JJVCSHandler) GetChangeFindings(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	changeID, err := routeParam(r, "change_id", "change_id is required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if h.FindingsService == nil {
		writeRouteError(w, r, errors.Internal("change findings service not configured"))
		return
	}
	repository, apiErr := h.resolveRepository(r.Context(), owner, repoName)
	if apiErr != nil {
		writeRouteError(w, r, apiErr)
		return
	}

	var userID int64
	if user := middleware.UserFromContext(r.Context()); user != nil {
		userID = user.ID
	}
	resp, err := h.FindingsService.GetFindings(r.Context(), repository.ID, owner, repoName, changeID, r.URL.Query().Get("rev"), userID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, resp)
}

type findingFeedbackRequest struct {
	Useful *bool   `json:"useful"`
	Note   *string `json:"note"`
}

// SubmitFindingFeedback handles
// POST /api/repos/{owner}/{repo}/changes/{change_id}/findings/{finding_id}/feedback.
func (h *JJVCSHandler) SubmitFindingFeedback(w http.ResponseWriter, r *http.Request) {
	if h.FindingsService == nil {
		writeRouteError(w, r, errors.Internal("change findings service not configured"))
		return
	}
	user, err := requireRouteUser(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	changeID, err := routeParam(r, "change_id", "change_id is required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	findingID, err := findingIDRouteParam(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		writeRouteError(w, r, errors.BadRequest("repository context required"))
		return
	}
	var request findingFeedbackRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	if request.Useful == nil {
		writeRouteError(w, r, errors.BadRequest("useful is required"))
		return
	}
	response, svcErr := h.FindingsService.SubmitFindingFeedback(r.Context(), services.SubmitFindingFeedbackInput{
		RepositoryID: repoCtx.Repository.ID,
		ChangeID:     changeID,
		FindingID:    findingID,
		UserID:       user.ID,
		Useful:       *request.Useful,
		Note:         request.Note,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusOK, response)
}

// DispatchFinding handles
// POST /api/repos/{owner}/{repo}/changes/{change_id}/findings/{finding_id}/dispatch.
func (h *JJVCSHandler) DispatchFinding(w http.ResponseWriter, r *http.Request) {
	if h.FindingsService == nil {
		writeRouteError(w, r, errors.Internal("change findings service not configured"))
		return
	}
	user, err := requireRouteUser(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if aliasErr := refuseGitHubSourceWrite(r, "Dispatching a finding"); aliasErr != nil {
		writeRouteError(w, r, aliasErr)
		return
	}
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	changeID, err := routeParam(r, "change_id", "change_id is required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	findingID, err := findingIDRouteParam(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		writeRouteError(w, r, errors.BadRequest("repository context required"))
		return
	}
	response, svcErr := h.FindingsService.DispatchFinding(r.Context(), services.DispatchFindingInput{
		RepositoryID: repoCtx.Repository.ID,
		UserID:       user.ID,
		Owner:        owner,
		Repo:         repoName,
		ChangeID:     changeID,
		FindingID:    findingID,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusAccepted, response)
}

func findingIDRouteParam(r *http.Request) (int64, error) {
	value, err := routeParam(r, "finding_id", "finding_id is required")
	if err != nil {
		return 0, err
	}
	findingID, parseErr := strconv.ParseInt(value, 10, 64)
	if parseErr != nil || findingID <= 0 {
		return 0, errors.BadRequest("finding_id must be a positive integer")
	}
	return findingID, nil
}

// RevertChange handles POST /api/repos/{owner}/{repo}/changes/{change_id}/revert.
func (h *JJVCSHandler) RevertChange(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		writeRouteError(w, r, errors.Unauthorized("authentication required"))
		return
	}
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	changeID, err := routeParam(r, "change_id", "change_id is required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if h.ChangeReverter == nil {
		writeRouteError(w, r, errors.Internal("change revert service not configured"))
		return
	}
	repository, apiErr := h.resolveRepository(r.Context(), owner, repoName)
	if apiErr != nil {
		writeRouteError(w, r, apiErr)
		return
	}
	response, err := h.ChangeReverter.RevertChange(r.Context(), actor, repository.ID, owner, repoName, changeID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, response)
}

// SplitChange handles POST /api/repos/{owner}/{repo}/changes/{change_id}/split.
func (h *JJVCSHandler) SplitChange(w http.ResponseWriter, r *http.Request) {
	if middleware.UserFromContext(r.Context()) == nil {
		writeRouteError(w, r, errors.Unauthorized("authentication required"))
		return
	}
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	changeID, err := routeParam(r, "change_id", "change_id is required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	var input services.SplitChangeInput
	if !decodeJSONBody(w, r, &input) {
		return
	}
	if len(input.Paths) == 0 {
		writeRouteError(w, r, errors.BadRequest("paths must not be empty"))
		return
	}
	for _, filePath := range input.Paths {
		if strings.TrimSpace(filePath) == "" {
			writeRouteError(w, r, errors.BadRequest("paths must not contain empty values"))
			return
		}
	}
	if h.ChangeSplitter == nil {
		writeRouteError(w, r, errors.Internal("change split service not configured"))
		return
	}
	repository, apiErr := h.resolveRepository(r.Context(), owner, repoName)
	if apiErr != nil {
		writeRouteError(w, r, apiErr)
		return
	}

	response, err := h.ChangeSplitter.SplitChange(r.Context(), repository.ID, owner, repoName, changeID, input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, response)
}

// GetChangeDiff handles GET /api/repos/{owner}/{repo}/changes/{change_id}/diff.
func (h *JJVCSHandler) GetChangeDiff(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	changeID, err := routeParam(r, "change_id", "change_id is required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.ChangeService == nil {
		writeRouteError(w, r, errors.Internal("change revision service not configured"))
		return
	}
	repository, apiErr := h.resolveRepository(r.Context(), owner, repoName)
	if apiErr != nil {
		writeRouteError(w, r, apiErr)
		return
	}
	diff, err := h.ChangeService.GetChangeDiff(r.Context(), repository.ID, owner, repoName, changeID, services.ChangeDiffRequest{
		From:             r.URL.Query().Get("from"),
		To:               r.URL.Query().Get("to"),
		Path:             r.URL.Query().Get("path"),
		IgnoreWhitespace: diffWhitespaceIgnored(r),
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	fileDiffs := make([]FileDiffItem, len(diff.FileDiffs))
	for i, fd := range diff.FileDiffs {
		fileDiffs[i] = FileDiffItem{
			Path:       fd.Path,
			OldPath:    fd.OldPath,
			ChangeType: fd.ChangeType,
			Patch:      fd.Patch,
			IsBinary:   fd.IsBinary,
			TooLarge:   fd.TooLarge,
			Language:   fd.Language,
			Additions:  fd.Additions,
			Deletions:  fd.Deletions,
			OldContent: fd.OldContent,
			NewContent: fd.NewContent,
		}
	}

	resp := ChangeDiffResponse{
		ChangeID:  diff.ChangeID,
		FileDiffs: fileDiffs,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

func diffWhitespaceIgnored(r *http.Request) bool {
	mode := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("whitespace")))
	return mode == "ignore" || mode == "hide"
}

// GetChangeFiles handles GET /api/repos/{owner}/{repo}/changes/{change_id}/files.
func (h *JJVCSHandler) GetChangeFiles(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	changeID, err := routeParam(r, "change_id", "change_id is required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	files, err := h.RepoHost.GetChangeFiles(r.Context(), owner, repoName, changeID)
	if err != nil {
		writeRouteError(w, r, repohostErrToAPIErr(r.Context(), err, "failed to get change files"))
		return
	}

	resp := make([]ChangeFileResponse, len(files))
	for i, f := range files {
		resp[i] = ChangeFileResponse{Path: f.Path}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// GetChangeConflicts handles GET /api/repos/{owner}/{repo}/changes/{change_id}/conflicts.
func (h *JJVCSHandler) GetChangeConflicts(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	changeID, err := routeParam(r, "change_id", "change_id is required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	conflicts, err := h.RepoHost.GetChangeConflicts(r.Context(), owner, repoName, changeID)
	if err != nil {
		writeRouteError(w, r, repohostErrToAPIErr(r.Context(), err, "failed to get change conflicts"))
		return
	}

	resp := make([]ChangeConflictResponse, len(conflicts))
	for i, c := range conflicts {
		resp[i] = ChangeConflictResponse{
			FilePath:         c.FilePath,
			ConflictType:     c.ConflictType,
			BaseContent:      c.BaseContent,
			LeftContent:      c.LeftContent,
			RightContent:     c.RightContent,
			Hunks:            c.Hunks,
			ResolutionStatus: c.ResolutionStatus,
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// ResolveChangeConflict handles
// POST /api/repos/{owner}/{repo}/changes/{change_id}/conflicts/resolve.
func (h *JJVCSHandler) ResolveChangeConflict(w http.ResponseWriter, r *http.Request) {
	if h.ConflictResolver == nil {
		writeRouteError(w, r, errors.Internal("change conflict resolver not configured"))
		return
	}
	user, err := requireRouteUser(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if aliasErr := refuseGitHubSourceWrite(r, "Resolving a conflict"); aliasErr != nil {
		writeRouteError(w, r, aliasErr)
		return
	}
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	changeID, err := routeParam(r, "change_id", "change_id is required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		writeRouteError(w, r, errors.BadRequest("repository context required"))
		return
	}

	var req resolveChangeConflictRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	response, svcErr := h.ConflictResolver.ResolveConflict(r.Context(), services.ResolveChangeConflictInput{
		RepositoryID: repoCtx.Repository.ID,
		UserID:       user.ID,
		Owner:        owner,
		Repo:         repoName,
		ChangeID:     changeID,
		Path:         req.Path,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	errors.WriteJSON(w, http.StatusAccepted, response)
}

// GetFileAtChange handles GET /api/repos/{owner}/{repo}/file/{change_id}/{*path}.
// It reads file content from the repo at the given change and returns the base64-
// encoded content plus the file path.
func (h *JJVCSHandler) GetFileAtChange(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	changeID, err := routeParam(r, "change_id", "change_id is required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	// Read the chi catch-all ("*"), not a "{path}" segment param: a nested path
	// like apps/cli/package.json spans multiple '/'-delimited segments, and a
	// regex param ({path:.*}) only ever matches ONE segment, so every 2+ segment
	// path fell through to a 404. The route registers "/file/{change_id}/*" to
	// capture the full remaining path (mirrors GetRepoContents "/contents/*").
	rawPath := chi.URLParam(r, "*")
	if strings.TrimSpace(rawPath) == "" {
		writeRouteError(w, r, errors.BadRequest("path is required"))
		return
	}

	content, err := h.RepoHost.GetFileAtChange(r.Context(), owner, repoName, changeID, rawPath)
	if err != nil {
		writeRouteError(w, r, repohostErrToAPIErr(r.Context(), err, "failed to get file content"))
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(content)
}

// ---------------------------------- Operations ----------------------------------

// OperationResponse is the API response for a jj operation log entry.
type OperationResponse struct {
	OperationID string `json:"operation_id"`
	Description string `json:"description"`
	Timestamp   string `json:"timestamp"`
}

// OperationsListResponse is the list payload for operation log entries.
type OperationsListResponse []OperationResponse

// ListOperations handles GET /api/repos/{owner}/{repo}/operations.
func (h *JJVCSHandler) ListOperations(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	cursor, limit, err := parsePagination(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	ops, nextCursor, err := h.RepoHost.ListOperations(r.Context(), owner, repoName, cursor, limit)
	if err != nil {
		writeRouteError(w, r, repohostErrToAPIErr(r.Context(), err, "failed to list operations"))
		return
	}

	items := make([]OperationResponse, len(ops))
	for i, op := range ops {
		items[i] = OperationResponse{
			OperationID: op.OperationID,
			Description: op.Description,
			Timestamp:   op.Timestamp,
		}
	}

	setCursorPaginationHeaders(w, r, limit, nextCursor)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(cursorResponse{Items: items, NextCursor: nextCursor})
}

// WorkingTreeChangeResponse is one changed path in the working tree.
type WorkingTreeChangeResponse struct {
	Path   string `json:"path"`
	Status string `json:"status"`
	Staged bool   `json:"staged"`
	Add    uint32 `json:"add"`
	Del    uint32 `json:"del"`
}

// WorkingTreeStatusResponse is the live working-tree status payload.
type WorkingTreeStatusResponse struct {
	Backend string                      `json:"backend"`
	Branch  string                      `json:"branch"`
	Head    string                      `json:"head"`
	Changes []WorkingTreeChangeResponse `json:"changes"`
}

// GetWorkingTreeStatus handles GET /api/repos/{owner}/{repo}/status.
func (h *JJVCSHandler) GetWorkingTreeStatus(w http.ResponseWriter, r *http.Request) {
	owner, repoName, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	status, err := h.RepoHost.GetWorkingTreeStatus(r.Context(), owner, repoName)
	if err != nil {
		writeRouteError(w, r, repohostErrToAPIErr(r.Context(), err, "failed to get working tree status"))
		return
	}

	changes := make([]WorkingTreeChangeResponse, len(status.Changes))
	for i, change := range status.Changes {
		changes[i] = WorkingTreeChangeResponse{
			Path:   change.Path,
			Status: change.Status,
			Staged: change.Staged,
			Add:    change.Add,
			Del:    change.Del,
		}
	}

	resp := WorkingTreeStatusResponse{
		Backend: status.Backend,
		Branch:  status.Branch,
		Head:    status.Head,
		Changes: changes,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

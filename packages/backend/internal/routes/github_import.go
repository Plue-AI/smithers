package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type GitHubImportRouteService interface {
	StartImport(ctx context.Context, input services.ImportGitHubRepoInput) (services.ImportJob, error)
	StartTemplateImport(ctx context.Context, input services.ImportTemplateRepoInput) (services.ImportJob, error)
	GetImportJob(ctx context.Context, userID int64, id string) (services.ImportJob, error)
	RetryImportJob(ctx context.Context, userID int64, id string) (services.ImportJob, error)
}

type GitHubImportHandler struct {
	Service GitHubImportRouteService
	Metrics *SmithersMetrics
}

var (
	githubImportStreamPollInterval = 500 * time.Millisecond
	githubImportStreamMaxDuration  = 5 * time.Minute
)

type startGitHubImportRequest struct {
	Owner  string `json:"owner"`
	Repo   string `json:"repo"`
	Branch string `json:"branch,omitempty"`
}

type startTemplateImportRequest struct {
	TemplateID string `json:"template_id"`
	Name       string `json:"name"`
}

func (h *GitHubImportHandler) StartImport(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github import service unavailable"))
		return
	}
	var req startGitHubImportRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	job, svcErr := h.Service.StartImport(r.Context(), services.ImportGitHubRepoInput{
		UserID: user.ID,
		Owner:  req.Owner,
		Repo:   req.Repo,
		Branch: req.Branch,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, job)
}

// StartTemplateImport handles POST /api/repos/from-template. Template imports
// use the same durable import job and status stream as GitHub mirror imports.
func (h *GitHubImportHandler) StartTemplateImport(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github import service unavailable"))
		return
	}
	var req startTemplateImportRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	job, svcErr := h.Service.StartTemplateImport(r.Context(), services.ImportTemplateRepoInput{
		UserID:     user.ID,
		TemplateID: req.TemplateID,
		Name:       req.Name,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, job)
}

func (h *GitHubImportHandler) GetImportJob(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github import service unavailable"))
		return
	}
	id := chi.URLParam(r, "id")
	if acceptsEventStream(r) {
		h.streamImportJob(w, r, user.ID, id)
		return
	}
	done := observeMirrorPoll(h.Metrics)
	job, svcErr := h.Service.GetImportJob(r.Context(), user.ID, id)
	done()
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, job)
}

func (h *GitHubImportHandler) RetryImportJob(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github import service unavailable"))
		return
	}
	job, svcErr := h.Service.RetryImportJob(r.Context(), user.ID, chi.URLParam(r, "id"))
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, job)
}

func acceptsEventStream(r *http.Request) bool {
	return strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/event-stream")
}

func (h *GitHubImportHandler) streamImportJob(w http.ResponseWriter, r *http.Request, userID int64, id string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		pkgerrors.WriteError(w, pkgerrors.Internal("streaming unsupported"))
		return
	}

	// Subscribe before fetching private status, then fence revocations that
	// happened after authentication but before the subscription was installed.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	var revoked <-chan revocation.Event
	var checker revocation.Checker
	principal := requestPrincipal(r, revocation.Principal{UserID: userID})
	if source := currentRevocationSource(); source != nil {
		revoked = source.Watch(ctx, principal)
		checker, _ = source.(revocation.Checker)
	}
	started := false
	endRevoked := func(event revocation.Event) {
		if !started {
			pkgerrors.WriteError(w, pkgerrors.Forbidden("stream authorization revoked"))
			return
		}
		writeImportStreamEvent(w, "revoked", event)
		flusher.Flush()
	}
	checkRevoked := func() bool {
		select {
		case event := <-revoked:
			endRevoked(event)
			return true
		default:
		}
		// The bus updates its cache before notifying watchers. Check both so
		// delayed fan-out cannot let a completed fetch expose private status.
		if checker != nil {
			if checker.IsTokenRevoked(principal.TokenHash) {
				endRevoked(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: principal.TokenHash})
				return true
			}
			if checker.IsUserDisabled(principal.UserID) {
				endRevoked(revocation.Event{Kind: revocation.KindUserDisabled, UserID: principal.UserID})
				return true
			}
		}
		return false
	}
	if checkRevoked() {
		return
	}
	job, svcErr := h.getObservedImportJob(ctx, userID, id)
	if checkRevoked() {
		return
	}
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	started = true
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	if !writeImportJobEvent(w, job) {
		return
	}
	flusher.Flush()
	if importJobTerminal(job) {
		return
	}

	ticker := time.NewTicker(githubImportStreamPollInterval)
	defer ticker.Stop()
	deadline := time.NewTimer(githubImportStreamMaxDuration)
	defer deadline.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case event := <-revoked:
			endRevoked(event)
			return
		case <-deadline.C:
			if checkRevoked() {
				return
			}
			writeImportStreamEvent(w, "timeout", map[string]string{
				"message": "import status stream timed out before a terminal job state",
			})
			flusher.Flush()
			return
		case <-ticker.C:
			if checkRevoked() {
				return
			}
			job, svcErr = h.getObservedImportJob(ctx, userID, id)
			if checkRevoked() {
				return
			}
			if svcErr != nil {
				writeImportStreamEvent(w, "error", map[string]string{
					"message": "failed to fetch import job status",
				})
				flusher.Flush()
				return
			}
			if !writeImportJobEvent(w, job) {
				return
			}
			flusher.Flush()
			if importJobTerminal(job) {
				return
			}
		}
	}
}

func (h *GitHubImportHandler) getObservedImportJob(ctx context.Context, userID int64, id string) (services.ImportJob, error) {
	done := observeMirrorPoll(h.Metrics)
	job, err := h.Service.GetImportJob(ctx, userID, id)
	done()
	return job, err
}

func writeImportJobEvent(w http.ResponseWriter, job services.ImportJob) bool {
	return writeImportStreamEvent(w, "import_job", job)
}

func writeImportStreamEvent(w http.ResponseWriter, event string, payload any) bool {
	data, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
	return err == nil
}

func importJobTerminal(job services.ImportJob) bool {
	return job.Status == "ready" || job.Status == "failed"
}

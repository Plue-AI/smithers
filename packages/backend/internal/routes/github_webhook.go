package routes

import (
	"context"
	stdErrors "errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	gitHubWebhookSignatureHeader = "X-Hub-Signature-256"
	gitHubWebhookEventHeader     = "X-GitHub-Event"
	gitHubWebhookDeliveryHeader  = "X-GitHub-Delivery"
	gitHubWebhookMaxBodyBytes    = 25 << 20
	// GitHub requires webhook receivers to return 2xx within 10 seconds.
	gitHubWebhookProcessingTimeout = 9 * time.Second
)

type GitHubWebhookRouteService interface {
	HandleGitHubWebhook(ctx context.Context, deliveryID, eventType, signature string, payload []byte) error
}

type GitHubWebhookHandler struct {
	Service GitHubWebhookRouteService
}

func (h *GitHubWebhookHandler) PostGitHubWebhook(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.Internal("github webhook service not configured"))
		return
	}

	payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, gitHubWebhookMaxBodyBytes))
	if err != nil {
		if middleware.IsMaxBytesError(err) {
			errors.WriteError(w, errors.RequestEntityTooLarge("request body too large"))
			return
		}
		errors.WriteError(w, errors.BadRequest("invalid github webhook payload"))
		return
	}

	eventType := strings.TrimSpace(r.Header.Get(gitHubWebhookEventHeader))
	if eventType == "" {
		errors.WriteError(w, errors.BadRequest("missing github event header"))
		return
	}

	deliveryID := strings.TrimSpace(r.Header.Get(gitHubWebhookDeliveryHeader))
	if deliveryID == "" {
		errors.WriteError(w, errors.BadRequest("missing github delivery id"))
		return
	}

	signature := strings.TrimSpace(r.Header.Get(gitHubWebhookSignatureHeader))
	ctx, cancel := context.WithTimeout(r.Context(), gitHubWebhookProcessingTimeout)
	defer cancel()

	if err := h.Service.HandleGitHubWebhook(ctx, deliveryID, eventType, signature, payload); err != nil {
		if stdErrors.Is(err, context.DeadlineExceeded) || stdErrors.Is(ctx.Err(), context.DeadlineExceeded) {
			errors.WriteError(w, errors.GatewayTimeout("github webhook processing timed out"))
			return
		}
		writeGitHubWebhookRouteError(w, err)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func writeGitHubWebhookRouteError(w http.ResponseWriter, err error) {
	var apiErr *errors.APIError
	if stdErrors.As(err, &apiErr) {
		errors.WriteError(w, apiErr)
		return
	}
	errors.WriteError(w, errors.Internal("internal server error"))
}

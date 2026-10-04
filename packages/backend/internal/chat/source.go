package chat

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/ports"
)

// SourceReadPath is the producer callback a turn's model host reads its
// repository through. The producer capability authorizes it, and the read
// runs as the turn's author.
const SourceReadPath = "/internal/chat/source/read"

// SourceReader serves app-agent reads of a repository's mirrored main for one
// member. The single-owner install composes it; a deployment without one
// offers the model no source tool and refuses the callback.
type SourceReader interface {
	// Source names the repository the member may read, or refuses with
	// ports.ErrSourceNotReady or ports.ErrSourceForbidden.
	Source(ctx context.Context, userID, repositoryID int64) (string, error)
	ReadSource(ctx context.Context, userID, repositoryID int64, path string) (ports.SourceFile, error)
}

type sourceReadRequest struct {
	TurnID     string `json:"turnId"`
	Generation int64  `json:"generation"`
	Path       string `json:"path"`
}

// SourceRead serves one file to a live producer. The read is the turn
// author's: a fenced, cancelled, expired or finished turn reads nothing.
func (h *Handler) SourceRead(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
		return
	}
	var request sourceReadRequest
	if !decodeBounded(w, r, &request) {
		return
	}
	token := bearerToken(r)
	if token == "" {
		writeProblem(w, http.StatusUnauthorized, "producer_fenced")
		return
	}
	scope, err := h.Store.Producer(r.Context(), request.TurnID, request.Generation, token)
	if err != nil {
		producerError(w, err)
		return
	}
	if h.Sources == nil {
		writeProblem(w, http.StatusServiceUnavailable, "source_unavailable")
		return
	}
	file, err := h.Sources.ReadSource(r.Context(), scope.UserID, scope.RepositoryID, request.Path)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, file)
	case errors.Is(err, ports.ErrSourceNotReady):
		writeProblem(w, http.StatusConflict, "source_not_ready")
	case errors.Is(err, ports.ErrSourcePathRefused):
		writeProblem(w, http.StatusBadRequest, "path_refused")
	case errors.Is(err, ports.ErrSourceForbidden):
		writeProblem(w, http.StatusForbidden, "forbidden")
	case errors.Is(err, ports.ErrSourceNotFound):
		writeProblem(w, http.StatusNotFound, "not_found")
	case errors.Is(err, ports.ErrSourceTooLarge):
		writeProblem(w, http.StatusRequestEntityTooLarge, "too_large")
	default:
		logger := h.logger
		if logger == nil {
			logger = slog.Default()
		}
		logger.Error("chat source read failed", "turn_id", request.TurnID, "error", err)
		writeProblem(w, http.StatusServiceUnavailable, "source_failed")
	}
}

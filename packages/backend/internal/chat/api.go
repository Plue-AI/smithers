package chat

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// APICallPath is the producer callback a turn's model host reads the
// install's API through for a host-run command. The producer capability
// names the turn, and the read runs as the credential that admitted it.
const APICallPath = "/internal/chat/api"

// CommandAPI serves the install API reads app-agent turns' host-run commands
// make, as the credential that admitted each turn, resolved again at each
// call. The single-owner install composes it; a deployment without one
// offers the model no command that reads the API and refuses the callback.
type CommandAPI interface {
	// Author names the person the turn's commands read as, by login, or
	// refuses with ports.ErrAPIForbidden.
	Author(ctx context.Context, credential middleware.Credential, userID int64) (string, error)
	// Call answers one GET of an install route, or refuses with
	// ports.ErrAPIForbidden or ports.ErrAPICallRefused.
	Call(ctx context.Context, credential middleware.Credential, userID int64, method, path string) (ports.ChatAPIAnswer, error)
}

type apiCallRequest struct {
	TurnID     string `json:"turnId"`
	Generation int64  `json:"generation"`
	Method     string `json:"method"`
	Path       string `json:"path"`
}

// APICall serves one install API read to a live producer, as the credential
// that admitted its turn, and answers the route's status and body. A fenced,
// cancelled, expired or finished turn, or one whose admitting credential is
// unknown here, reads nothing.
func (h *Handler) APICall(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
		return
	}
	var request apiCallRequest
	if !decodeBounded(w, r, &request) {
		return
	}
	turn, ok := h.liveProducer(w, r, request.TurnID, request.Generation)
	if !ok {
		return
	}
	if h.API == nil {
		writeProblem(w, http.StatusServiceUnavailable, "api_unavailable")
		return
	}
	credential, ok := h.admittingCredential(w, turn)
	if !ok {
		return
	}
	answer, err := h.API.Call(r.Context(), credential, turn.UserID, request.Method, request.Path)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, answer)
	case errors.Is(err, ports.ErrAPIForbidden):
		writeProblem(w, http.StatusForbidden, "forbidden")
	case errors.Is(err, ports.ErrAPICallRefused):
		writeProblem(w, http.StatusBadRequest, "call_refused")
	default:
		logger := h.logger
		if logger == nil {
			logger = slog.Default()
		}
		logger.Error("chat API call failed", "turn_id", request.TurnID, "error", err)
		writeProblem(w, http.StatusServiceUnavailable, "api_failed")
	}
}

// liveProducer resolves a producer callback's capability to its live turn,
// or states why it is fenced.
func (h *Handler) liveProducer(w http.ResponseWriter, r *http.Request, turnID string, generation int64) (ProducerTurn, bool) {
	token := bearerToken(r)
	if token == "" {
		writeProblem(w, http.StatusUnauthorized, "producer_fenced")
		return ProducerTurn{}, false
	}
	turn, err := h.Store.Producer(r.Context(), turnID, generation, token)
	if err != nil {
		producerError(w, err)
		return ProducerTurn{}, false
	}
	return turn, true
}

// admittingCredential is the credential that admitted a live producer's turn
// in this process; a turn admitted elsewhere, or before a restart, has none.
func (h *Handler) admittingCredential(w http.ResponseWriter, turn ProducerTurn) (middleware.Credential, bool) {
	credential, admitted := h.credentials.credential(turnKey{userID: turn.UserID, runID: turn.RunID, legID: turn.LegID})
	if !admitted {
		writeProblem(w, http.StatusForbidden, "forbidden")
	}
	return credential, admitted
}

package chat

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// CommandAPI owns a claimed producer's author-bound API credential.
// Commands themselves call the production public API, never a privileged callback.
type CommandAPI interface {
	Begin(context.Context, middleware.Credential, int64, string, int64) (ports.ChatTurnAPI, error)
	End(context.Context, int64, int64) error
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

// admittingCredential resolves the live producer's current credential: the
// original admission until PortHost binds its generation-bound bearer.
func (h *Handler) admittingCredential(w http.ResponseWriter, turn ProducerTurn) (middleware.Credential, bool) {
	credential, admitted := h.credentials.credential(turnKey{userID: turn.UserID, runID: turn.RunID, legID: turn.LegID})
	if !admitted {
		writeProblem(w, http.StatusForbidden, "forbidden")
	}
	return credential, admitted
}

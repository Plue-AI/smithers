package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type MainResetRouteService interface {
	ResetMainAttention(context.Context, int64, string, string, string) error
}

type MainResetHandler struct {
	Queries *db.Queries
	Service MainResetRouteService
}

// Reset is the main.reset-to-github catalog door. Authorization precedes
// decoding and provider access, so delegated callers cannot ask for confirmation.
func (h *MainResetHandler) Reset(w http.ResponseWriter, r *http.Request) {
	if _, err := services.Authorize(r.Context(), h.Queries, "main.reset-to-github"); err != nil {
		writeRouteError(w, r, err)
		return
	}
	var input struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	if !decodeStrictJSONBody(w, r, &input) {
		return
	}
	if input.Old == "" || input.New == "" || input.Old == input.New {
		todoRouteError(w, &services.TodoControlError{Status: 409, Class: "conflict", Code: "stale_attention", Message: "Main changed"})
		return
	}
	repository, err := services.InstallRepositoryID(r.Context(), h.Queries)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	sync := &GitHubSyncHandler{}
	if h.Service == nil {
		sync.unavailable(w)
		return
	}
	if err := h.Service.ResetMainAttention(r.Context(), repository, chi.URLParam(r, "id"), input.Old, input.New); err != nil {
		sync.writeError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		State string `json:"state"`
	}{"settled"})
}

// StackAttentionCommand selects the bound flow and preserves its body for the
// handler. The authorizer and route use the same resolver.
func StackAttentionCommand(w http.ResponseWriter, r *http.Request) (string, bool) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
	if err != nil {
		writeJSONDecodeError(w, "invalid request body", err)
		return "", false
	}
	var input map[string]json.RawMessage
	if err := decodeSingleJSONDocument(json.NewDecoder(bytes.NewReader(raw)), &input); err != nil {
		writeJSONDecodeError(w, "invalid request body", err)
		return "", false
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	_, old := input["old"]
	_, next := input["new"]
	if old || next {
		return "main.reset-to-github", true
	}
	return "order.ok", true
}

type StackAttentionHandler struct {
	Reset *MainResetHandler
	Order *TodoHandler
}

func (h *StackAttentionHandler) Answer(w http.ResponseWriter, r *http.Request) {
	command, ok := StackAttentionCommand(w, r)
	if !ok {
		return
	}
	if command == "main.reset-to-github" {
		h.Reset.Reset(w, r)
		return
	}
	h.Order.OrderOK(w, r)
}

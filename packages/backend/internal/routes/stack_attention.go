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

type StackAttentionService interface {
	OrderOK(context.Context, int64, string, int64) error
}
type StackAttentionHandler struct {
	Queries *db.Queries
	Service StackAttentionService
	Reset   *MainResetHandler
}

// Both attention actions share the catalog's route. Select only the payload
// contract here; each existing handler authorizes its action before effects.
func (h *StackAttentionHandler) Handle(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
	if err != nil {
		body = nil
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(body, &fields)
	_, revision := fields["revision"]
	_, old := fields["old"]
	_, next := fields["new"]
	if !revision && (old || next) && h.Reset != nil {
		h.Reset.Reset(w, r)
		return
	}
	h.OK(w, r)
}

func (h *StackAttentionHandler) OK(w http.ResponseWriter, r *http.Request) {
	repo, _, ok := authorizeInstallRepository(w, r, h.Queries, "order.ok")
	if !ok {
		return
	}
	if err := services.MergeCredential(r.Context(), r.Header.Get("Smithers-Via")); err != nil {
		todoRouteError(w, err)
		return
	}
	if h.Service == nil {
		todoRouteError(w, nil)
		return
	}
	var input struct {
		Revision int64 `json:"revision"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &input); err != nil || input.Revision < 1 {
		todoRouteError(w, &services.TodoControlError{Status: 400, Code: "invalid_attention", Class: "user", Message: "Invalid attention revision"})
		return
	}
	if err := h.Service.OrderOK(r.Context(), repo, chi.URLParam(r, "id"), input.Revision); err != nil {
		todoRouteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

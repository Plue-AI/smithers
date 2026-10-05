package routes

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// TodoAmend is intentionally unmounted until the shared install dispatcher
// supplies confirmation; it is not authorized by this handler. No revision or
// confirmation is fabricated while unavailable.
func (h *MythicalHandler) TodoAmend(w http.ResponseWriter, r *http.Request) {
	var input services.TodoAmendInput
	h.todoMutation(w, r, &input, func(number int64) error {
		var service *services.MythicalService
		return service.AmendTodo(r.Context(), number, input)
	})
}

func (h *MythicalHandler) todoMutation(w http.ResponseWriter, r *http.Request, input any, refuse func(int64) error) {
	fail := func(status int, code, class, message string) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(&services.TodoControlError{Status: status, Code: code, Class: class, Message: message})
	}
	number, err := strconv.ParseInt(chi.URLParam(r, "n"), 10, 64)
	if err != nil || number <= 0 {
		fail(http.StatusBadRequest, "invalid_todo", "user", "Invalid TODO number")
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(input); err != nil {
		fail(http.StatusBadRequest, "invalid_control", "user", "Invalid TODO control")
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		fail(http.StatusBadRequest, "invalid_control", "user", "Invalid TODO control")
		return
	}
	if r.Header.Get("Idempotency-Key") == "" {
		fail(http.StatusBadRequest, "idempotency_key_required", "user", "Idempotency-Key is required")
		return
	}
	refusal := refuse(number).(*services.TodoControlError)
	fail(refusal.Status, refusal.Code, refusal.Class, refusal.Message)
}

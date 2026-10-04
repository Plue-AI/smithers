package routes

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// TodoControl is intentionally unmounted until T-CAT-01/T-ACC-03 supply the
// shared install dispatcher. No local authorization or confirmation policy is
// substituted; even a valid request refuses before any subject/effect access.
func (h *MythicalHandler) TodoControl(w http.ResponseWriter, r *http.Request) {
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
	var input services.TodoControlInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
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
	// A nil service deliberately refuses too; neither a route nor a launcher
	// can bypass the absent shared dispatcher. No fabricated accepted receipt.
	var service *services.MythicalService
	err = service.ControlTodo(r.Context(), number, input)
	refusal := err.(*services.TodoControlError)
	fail(refusal.Status, refusal.Code, refusal.Class, refusal.Message)
}

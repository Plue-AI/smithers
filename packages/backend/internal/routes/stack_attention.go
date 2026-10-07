package routes

import (
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
)

// StackAttentionHandler is the shared door for the two typed attention actions.
// Each provider owns its revision codec and refuses another attention kind.
type StackAttentionHandler struct {
	Order *TodoHandler
	Reset http.Handler
}

func (h *StackAttentionHandler) Answer(w http.ResponseWriter, r *http.Request) {
	command, err := middleware.StackAttentionCommand(w, r)
	if err != nil {
		todoRouteError(w, &services.TodoControlError{Status: 400, Class: "user", Code: "invalid_attention", Message: "Invalid attention"})
		return
	}
	if command == "order.ok" {
		if h.Order == nil {
			todoRouteError(w, nil)
			return
		}
		h.Order.OrderOK(w, r)
		return
	}
	if h.Reset == nil {
		todoRouteError(w, nil)
		return
	}
	h.Reset.ServeHTTP(w, r)
}

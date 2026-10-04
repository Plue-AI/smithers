package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type TodoRouteService interface {
	FileTodo(context.Context, int64, int64, services.MythicalTodoInput) (services.MythicalItemView, error)
	Todo(context.Context, int64, int64) (map[string]any, error)
	Todos(context.Context, int64) ([]map[string]any, error)
}

// TodoHandler resolves the install's persisted GitHub repository, never a
// caller-supplied repository or actor. S1 admits only the live owner session.
type TodoHandler struct {
	Queries *db.Queries
	Service TodoRouteService
}

func todoRouteError(w http.ResponseWriter, err error) {
	failure := &services.TodoControlError{Status: 503, Code: "todo_unavailable", Class: "infra", Message: "TODO service unavailable"}
	var typed *services.TodoControlError
	if errors.As(err, &typed) {
		failure = typed
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(failure.Status)
	_ = json.NewEncoder(w).Encode(failure)
}
func (h *TodoHandler) authorize(w http.ResponseWriter, r *http.Request) (int64, int64, bool) {
	if h == nil || h.Queries == nil || h.Service == nil {
		todoRouteError(w, nil)
		return 0, 0, false
	}
	info := middleware.AuthInfoFromContext(r.Context())
	if info == nil || info.User == nil || info.IsTokenAuth || info.IsAgent() || info.SessionHash == "" {
		todoRouteError(w, &services.TodoControlError{Status: 403, Code: "permission", Class: "permission", Message: "Install owner session required"})
		return 0, 0, false
	}
	owner, err := h.Queries.GetSelfHostOwner(r.Context())
	if err != nil || owner.ID != info.User.ID {
		todoRouteError(w, &services.TodoControlError{Status: 403, Code: "permission", Class: "permission", Message: "Install owner session required"})
		return 0, 0, false
	}
	setting, err := h.Queries.GetInstallSetting(r.Context(), "github.repository")
	if err != nil {
		todoRouteError(w, err)
		return 0, 0, false
	}
	var binding struct {
		Owner string `json:"owner_login"`
		Name  string `json:"repository_name"`
	}
	if err = json.Unmarshal(setting.Value, &binding); err != nil || binding.Owner == "" || binding.Name == "" {
		todoRouteError(w, err)
		return 0, 0, false
	}
	repo, err := h.Queries.GetRepoByOwnerAndName(r.Context(), db.GetRepoByOwnerAndNameParams{Owner: binding.Owner, Name: binding.Name})
	if err != nil {
		todoRouteError(w, err)
		return 0, 0, false
	}
	return repo.ID, owner.ID, true
}
func (h *TodoHandler) Create(w http.ResponseWriter, r *http.Request) {
	repo, user, ok := h.authorize(w, r)
	if !ok {
		return
	}
	var input services.MythicalTodoInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &input); err != nil {
		todoRouteError(w, &services.TodoControlError{Status: 400, Code: "invalid_todo", Class: "user", Message: "Invalid TODO request"})
		return
	}
	input.Request = r.Header.Get("Idempotency-Key")
	item, err := h.Service.FileTodo(r.Context(), repo, user, input)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]any{"state": "accepted", "n": item.Number, "rev": 1})
}
func (h *TodoHandler) Get(w http.ResponseWriter, r *http.Request) {
	repo, _, ok := h.authorize(w, r)
	if !ok {
		return
	}
	n, err := strconv.ParseInt(chi.URLParam(r, "n"), 10, 64)
	if err != nil || n <= 0 {
		todoRouteError(w, &services.TodoControlError{Status: 400, Code: "invalid_todo", Class: "user", Message: "Invalid TODO number"})
		return
	}
	view, err := h.Service.Todo(r.Context(), repo, n)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(view)
}
func (h *TodoHandler) List(w http.ResponseWriter, r *http.Request) {
	repo, _, ok := h.authorize(w, r)
	if !ok {
		return
	}
	views, err := h.Service.Todos(r.Context(), repo)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(views)
}

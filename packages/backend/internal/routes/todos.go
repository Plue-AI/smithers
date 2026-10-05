package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type TodoRouteService interface {
	FileTodo(context.Context, int64, int64, services.MythicalTodoInput) (services.MythicalItemView, error)
	Todo(context.Context, int64, int64) (map[string]any, error)
	Todos(context.Context, int64) ([]map[string]any, error)
	MergeTodo(context.Context, int64, int64, int64, services.MythicalMergeInput) (services.MythicalItemView, error)
	AnswerTodo(context.Context, int64, int64, int64, services.TodoAnswerInput) error
	ControlTodo(context.Context, int64, services.TodoControlInput) (services.TodoControlReceipt, error)
}

// TodoHandler resolves the install's persisted GitHub repository, never a
// caller-supplied repository or actor. Each route authorizes its command for
// the person's browser session by roster role.
type TodoHandler struct {
	Queries *db.Queries
	Service TodoRouteService
}

func todoRouteError(w http.ResponseWriter, err error) {
	failure := &services.TodoControlError{Status: 503, Code: "todo_unavailable", Class: "infra", Message: "TODO service unavailable"}
	var stale *services.MythicalStaleHeadError
	if errors.As(err, &stale) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(stale.Status)
		_ = json.NewEncoder(w).Encode(stale)
		return
	}
	var answered *services.TodoAnsweredError
	if errors.As(err, &answered) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(answered)
		return
	}
	var access *services.AccessError
	if errors.As(err, &access) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(access.Status)
		_ = json.NewEncoder(w).Encode(access)
		return
	}
	var typed *services.TodoControlError
	if errors.As(err, &typed) {
		failure = typed
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(failure.Status)
	_ = json.NewEncoder(w).Encode(failure)
}

// authorize decides command for the request's person (services.Authorize:
// members create, read, answer and steer TODOs; maintainers merge; a
// terminal's credential answers and steers its own branch's TODO and
// confirms a new one in the app), then resolves the install's repository.
func (h *TodoHandler) authorize(w http.ResponseWriter, r *http.Request, command string) (int64, int64, bool) {
	if h == nil || h.Service == nil {
		todoRouteError(w, nil)
		return 0, 0, false
	}
	return authorizeInstallRepository(w, r, h.Queries, command)
}

// authorizeInstallRepository decides command for the request's person
// (services.Authorize), then resolves the install's persisted repository,
// never a caller-supplied one. It writes the refusal itself.
func authorizeInstallRepository(w http.ResponseWriter, r *http.Request, queries *db.Queries, command string) (int64, int64, bool) {
	if queries == nil {
		todoRouteError(w, nil)
		return 0, 0, false
	}
	decision, err := services.Authorize(r.Context(), queries, command)
	if err != nil {
		todoRouteError(w, err)
		return 0, 0, false
	}
	setting, err := queries.GetInstallSetting(r.Context(), "github.repository")
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
	repo, err := queries.GetRepoByOwnerAndName(r.Context(), db.GetRepoByOwnerAndNameParams{Owner: binding.Owner, Name: binding.Name})
	if err != nil {
		todoRouteError(w, err)
		return 0, 0, false
	}
	return repo.ID, decision.UserID, true
}
func (h *TodoHandler) Create(w http.ResponseWriter, r *http.Request) {
	repo, user, ok := h.authorize(w, r, "todo.new")
	if !ok {
		return
	}
	var input services.MythicalTodoInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &input); err != nil {
		var refusal *services.TodoControlError
		if !errors.As(err, &refusal) {
			refusal = &services.TodoControlError{Status: 400, Code: "invalid_todo", Class: "user", Message: "Invalid TODO request"}
		}
		todoRouteError(w, refusal)
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
	repo, _, ok := h.authorize(w, r, "todo.read")
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
	repo, _, ok := h.authorize(w, r, "todo.read")
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

// Answer settles one open question of TODO n with the person's answer and
// resumes the run that asked. 202 records the first answer, or answers the
// same person's same answer again; a question someone else already
// answered is 409 {answered_by}.
func (h *TodoHandler) Answer(w http.ResponseWriter, r *http.Request) {
	repo, user, ok := h.authorize(w, r, "todo.answer")
	if !ok {
		return
	}
	n, err := strconv.ParseInt(chi.URLParam(r, "n"), 10, 64)
	if err != nil || n <= 0 {
		todoRouteError(w, &services.TodoControlError{Status: 400, Code: "invalid_todo", Class: "user", Message: "Invalid TODO number"})
		return
	}
	if err = services.AuthorizeTodoBranch(r.Context(), h.Queries, repo, n); err != nil {
		todoRouteError(w, err)
		return
	}
	var input services.TodoAnswerInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &input); err != nil {
		todoRouteError(w, &services.TodoControlError{Status: 400, Code: "invalid_answer", Class: "user", Message: "An answer and its question are required"})
		return
	}
	if err := h.Service.AnswerTodo(r.Context(), repo, user, n, input); err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]string{"state": "accepted"})
}

// Merge resolves the repository number through the same persisted install
// binding as the card. Any credential but a browser session is refused
// before a read. 202 records the approval and the merge fence, or answers
// the same Idempotency-Key's earlier request again; the TODO is Merged only
// once GitHub reports the merge and main contains it.
func (h *TodoHandler) Merge(w http.ResponseWriter, r *http.Request) {
	if err := services.MergeCredential(r.Context(), r.Header.Get("Smithers-Via")); err != nil {
		todoRouteError(w, err)
		return
	}
	repo, user, ok := h.authorize(w, r, "merge")
	if !ok {
		return
	}
	n, err := strconv.ParseInt(chi.URLParam(r, "n"), 10, 64)
	if err != nil || n <= 0 {
		todoRouteError(w, &services.TodoControlError{Status: 400, Code: "invalid_todo", Class: "user", Message: "Invalid TODO number"})
		return
	}
	var input services.MythicalMergeInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &input); err != nil {
		todoRouteError(w, &services.TodoControlError{Status: 400, Code: "invalid_reviewed_head_sha", Class: "user", Message: "reviewed_head_sha must be a 40-character hexadecimal commit SHA"})
		return
	}
	input.Request = r.Header.Get("Idempotency-Key")
	_, err = h.Service.MergeTodo(r.Context(), repo, user, n, input)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]string{"state": "accepted"})
}

// todoControlCommands is each TODO control's command (§6.15: members steer,
// stop, resume, retry, drop and move TODOs). A steer has no op.
var todoControlCommands = map[string]string{"": "todo.steer", "stop": "todo.stop", "resume": "todo.resume", "retry": "todo.retry", "retry-current-flow": "todo.retry", "drop": "todo.drop", "move": "stack.move"}

// Control is POST /api/todos/{n}: steer the coding agent, or stop, resume,
// retry (with an optional steer), drop or move (with a direction, up or down)
// the TODO. The app sends a steer as {"op":"steer","text":...}; the service's
// input is {"steer":...} with no op. The control's command authorizes the
// person (a terminal's credential only steers, and only its own branch's
// TODO), then the service runs the op for the install's repository as that
// person under the request's Idempotency-Key; an op it has no service for is
// 503 unavailable.
func (h *TodoHandler) Control(w http.ResponseWriter, r *http.Request) {
	n, err := strconv.ParseInt(chi.URLParam(r, "n"), 10, 64)
	if err != nil || n <= 0 {
		todoRouteError(w, &services.TodoControlError{Status: 400, Code: "invalid_todo", Class: "user", Message: "Invalid TODO number"})
		return
	}
	var body struct {
		Op        string  `json:"op"`
		Steer     *string `json:"steer,omitempty"`
		Text      *string `json:"text,omitempty"`
		Direction string  `json:"direction,omitempty"`
	}
	invalid := &services.TodoControlError{Status: 400, Code: "invalid_control", Class: "user", Message: "Invalid TODO control"}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &body); err != nil {
		todoRouteError(w, invalid)
		return
	}
	input := services.TodoControlInput{Op: body.Op, Steer: body.Steer, Direction: body.Direction}
	switch {
	case body.Op == "steer" && body.Steer == nil:
		input = services.TodoControlInput{Steer: body.Text, Direction: body.Direction}
	case body.Text != nil || body.Op == "steer":
		todoRouteError(w, invalid)
		return
	}
	command, known := todoControlCommands[input.Op]
	if !known {
		todoRouteError(w, &services.TodoControlError{Status: 400, Code: "invalid_control", Class: "user", Message: "Unknown TODO control"})
		return
	}
	if r.Header.Get("Idempotency-Key") == "" {
		todoRouteError(w, &services.TodoControlError{Status: 400, Code: "idempotency_key_required", Class: "user", Message: "Idempotency-Key is required"})
		return
	}
	repo, user, ok := h.authorize(w, r, command)
	if !ok {
		return
	}
	if err := services.AuthorizeTodoBranch(r.Context(), h.Queries, repo, n); err != nil {
		todoRouteError(w, err)
		return
	}
	input.Repository, input.Actor, input.Request = repo, user, r.Header.Get("Idempotency-Key")
	receipt, err := h.Service.ControlTodo(r.Context(), n, input)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(receipt)
}

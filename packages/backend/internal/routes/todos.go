package routes

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// TodoRouteService is the TODO service the /api/todos routes serve.
type TodoRouteService interface {
	Create(ctx context.Context, repositoryID int64, actor services.TodoActor, key string, input services.CreateTodoInput) (services.TodoView, bool, error)
	List(ctx context.Context, repositoryID int64) ([]services.TodoView, error)
	Get(ctx context.Context, repositoryID, number int64) (services.TodoView, error)
	StackRepositories(ctx context.Context) ([]int64, error)
	MemberOf(ctx context.Context, userID int64) (int64, error)
	RepositorySlug(ctx context.Context, repositoryID int64) (string, string, error)
	BranchActivity(ctx context.Context, branchID string) (int64, []services.ActivityView, error)
	BranchRepository(ctx context.Context, branchID string) (int64, error)
}

// TodoHandler serves /api/todos (spec §6.3) and a branch's activity. An
// install serves one repository, so the routes name none: the repository is
// the branch's, the one the `repo=owner/name` query names, or else the only
// repository with a stack. TODO numbers count per repository. Each Resolve* middleware names it to
// the repository context and permission middleware that follow it, so these
// routes are authorized exactly as /api/repos/{owner}/{repo} routes are.
type TodoHandler struct {
	Service TodoRouteService
}

// TodoCreateAnswer is POST /api/todos's answer: the request is persisted
// (spec §6.2.2); the TODO's state arrives as projection events.
type TodoCreateAnswer struct {
	State string            `json:"state"`
	Todo  services.TodoView `json:"todo"`
}

// TodoList is GET /api/todos's answer.
type TodoList struct {
	Todos []services.TodoView `json:"todos"`
}

// BranchActivityList is GET /api/branches/{b}/activity's answer.
type BranchActivityList struct {
	Entries []services.ActivityView `json:"entries"`
}

// todoCreateBytes bounds a create body: the prompt and acceptance bounds
// plus the JSON around them.
const todoCreateBytes = 40 << 10

// ResolveStackRepository names the repository of /api/todos and
// /api/todos/{n}: the `repo=owner/name` query, else the only repository with
// a stack.
func (h *TodoHandler) ResolveStackRepository(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if named := strings.TrimSpace(r.URL.Query().Get("repo")); named != "" {
			owner, name, ok := strings.Cut(named, "/")
			if !ok || owner == "" || name == "" || strings.Contains(name, "/") {
				pkgerrors.WriteError(w, pkgerrors.BadRequest("repo must be owner/name"))
				return
			}
			nameRepository(r, owner, name)
			next.ServeHTTP(w, r)
			return
		}
		stacks, err := h.Service.StackRepositories(r.Context())
		if err != nil {
			writeRouteError(w, r, err)
			return
		}
		switch len(stacks) {
		case 0:
			pkgerrors.WriteError(w, pkgerrors.NotFound("no repository has a stack yet"))
			return
		case 1:
		default:
			pkgerrors.WriteError(w, pkgerrors.BadRequest("this server serves several repositories: name one with repo=owner/name"))
			return
		}
		if !h.nameRepositoryByID(w, r, stacks[0]) {
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ResolveBranchRepository names the repository of the branch {b}.
func (h *TodoHandler) ResolveBranchRepository(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		repositoryID, err := h.Service.BranchRepository(r.Context(), chi.URLParam(r, "b"))
		if err != nil {
			writeRouteError(w, r, err)
			return
		}
		if !h.nameRepositoryByID(w, r, repositoryID) {
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *TodoHandler) nameRepositoryByID(w http.ResponseWriter, r *http.Request, repositoryID int64) bool {
	owner, name, err := h.Service.RepositorySlug(r.Context(), repositoryID)
	if err != nil {
		writeRouteError(w, r, err)
		return false
	}
	nameRepository(r, owner, name)
	return true
}

// nameRepository sets the {owner} and {repo} route parameters
// middleware.LoadRepoContext reads.
func nameRepository(r *http.Request, owner, name string) {
	if route := chi.RouteContext(r.Context()); route != nil {
		route.URLParams.Add("owner", owner)
		route.URLParams.Add("repo", name)
	}
}

// todoNumberParam reads {n} as a TODO number: 12 or T12.
func todoNumberParam(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, "n"))
	raw = strings.TrimPrefix(strings.TrimPrefix(raw, "T"), "t")
	number, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || number <= 0 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("a TODO is named by its number, like 12 or T12"))
		return 0, false
	}
	return number, true
}

func (h *TodoHandler) repository(w http.ResponseWriter, r *http.Request) (*middleware.RepoContext, bool) {
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return nil, false
	}
	return repoCtx, true
}

// List answers the repository's TODOs in stack order.
func (h *TodoHandler) List(w http.ResponseWriter, r *http.Request) {
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	todos, err := h.Service.List(r.Context(), repoCtx.Repository.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, TodoList{Todos: todos})
}

// Create places a TODO at the end of the stack for the signed-in member.
// It requires an Idempotency-Key (spec §6.2.1): a repeat answers the TODO
// the first request made. It answers 202 requested (§6.2.2).
func (h *TodoHandler) Create(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key == "" {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeIdempotencyKeyRequired, "send an Idempotency-Key header"))
		return
	}
	var body services.CreateTodoInput
	if !decodeMythicalBody(w, r, todoCreateBytes, &body) {
		return
	}
	member, err := h.Service.MemberOf(r.Context(), user.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	todo, _, err := h.Service.Create(r.Context(), repoCtx.Repository.ID, services.TodoPerson(member, ""), key, body)
	if err != nil {
		writeTodoError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, TodoCreateAnswer{State: "requested", Todo: todo})
}

// Get answers the TODO card of T{n}.
func (h *TodoHandler) Get(w http.ResponseWriter, r *http.Request) {
	number, ok := todoNumberParam(w, r)
	if !ok {
		return
	}
	repoCtx, ok := h.repository(w, r)
	if !ok {
		return
	}
	todo, err := h.Service.Get(r.Context(), repoCtx.Repository.ID, number)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, todo)
}

// BranchActivity answers the branch's newest activity entries, oldest first.
func (h *TodoHandler) BranchActivity(w http.ResponseWriter, r *http.Request) {
	_, entries, err := h.Service.BranchActivity(r.Context(), chi.URLParam(r, "b"))
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, BranchActivityList{Entries: entries})
}

// writeTodoError answers a refused transition with its typed code.
func writeTodoError(w http.ResponseWriter, r *http.Request, err error) {
	var refused *services.TodoTransitionRefused
	if errors.As(err, &refused) {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeTodoTransitionRefused, refused.Error()))
		return
	}
	writeRouteError(w, r, err)
}

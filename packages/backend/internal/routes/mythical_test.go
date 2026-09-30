package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type fakeMythicalRoute struct {
	bootstraps []string
	main       string
	lanes      []services.MythicalLaneSubmission
	parallel   int32
	retried    string
	backfills  int
	wikis      int
	wikiErr    error
	viewers    []services.MythicalViewer
	todos      []services.MythicalTodoInput
	todoUsers  []int64
	todoErr    error
}

func (f *fakeMythicalRoute) FileTodo(_ context.Context, _, userID int64, input services.MythicalTodoInput) (services.MythicalItemView, error) {
	if f.todoErr != nil {
		return services.MythicalItemView{}, f.todoErr
	}
	f.todos, f.todoUsers = append(f.todos, input), append(f.todoUsers, userID)
	return services.MythicalItemView{ID: "item-1", State: "queued", Issue: &services.MythicalIssueView{Number: 12, Title: input.Title},
		DependsOn: []string{}}, nil
}

func (f *fakeMythicalRoute) RequestWiki(context.Context, int64) error {
	if f.wikiErr != nil {
		return f.wikiErr
	}
	f.wikis++
	return nil
}

func (f *fakeMythicalRoute) Backfill(context.Context, int64) (services.MythicalBackfillCounts, error) {
	f.backfills++
	return services.MythicalBackfillCounts{}, nil
}

func (f *fakeMythicalRoute) SubmitLane(_ context.Context, _, _ int64, input services.MythicalLaneSubmission) (services.MythicalLaneReceipt, error) {
	f.lanes = append(f.lanes, input)
	return services.MythicalLaneReceipt{ItemID: "item", State: "integrating", Source: input.Source}, nil
}

func (f *fakeMythicalRoute) SetMaxParallel(_ context.Context, _ int64, n int32) error {
	f.parallel = n
	return nil
}

func (f *fakeMythicalRoute) Item(_ context.Context, repositoryID int64, ref string) (services.MythicalItemView, error) {
	if ref != "12" {
		return services.MythicalItemView{}, pkgerrors.NotFound("item not found")
	}
	return services.MythicalItemView{ID: "item-12", State: "blocked", Issue: &services.MythicalIssueView{Number: 12, Title: "Fix login"},
		DependsOn: []string{}}, nil
}

func (f *fakeMythicalRoute) RetryItem(_ context.Context, _ int64, id string) (services.MythicalItemView, error) {
	f.retried = id
	return services.MythicalItemView{ID: id, State: "queued", DependsOn: []string{}}, nil
}

func (f *fakeMythicalRoute) Snapshot(_ context.Context, id int64, slug, main string, viewer services.MythicalViewer) (services.MythicalStackView, error) {
	f.main = main
	f.viewers = append(f.viewers, viewer)
	state := "absent"
	if len(f.bootstraps) > 0 {
		state = "bootstrapping"
	}
	return services.MythicalStackView{Repository: slug, State: state, Changes: []services.MythicalChangeView{},
		Items: []services.MythicalItemView{}, Lanes: []services.MythicalLaneView{}, Limits: services.MythicalLimitsView{MaxParallel: 2}}, nil
}

func (f *fakeMythicalRoute) RequestBootstrap(_ context.Context, id, actor int64, depth int32, reset bool) (db.MythicalStack, error) {
	f.bootstraps = append(f.bootstraps, strings.Join([]string{"repo", "depth", "reset"}, ":"))
	return db.MythicalStack{RepositoryID: id, BootstrapDepth: depth}, nil
}

func TestMythicalRoutes(t *testing.T) {
	service := &fakeMythicalRoute{}
	handler := &MythicalHandler{Service: service, MainHead: func(context.Context, string, string, string) (string, error) {
		return "abc", nil
	}}
	withRepo := func(r *http.Request, user bool) *http.Request {
		ctx := middleware.ContextWithRepoContext(r.Context(), &middleware.RepoContext{Owner: "smithers-canary",
			Repository: &db.Repository{ID: 19, Name: "smithers", DefaultBookmark: "main"}}, middleware.PermissionAdmin)
		if user {
			ctx = context.WithValue(ctx, middleware.UserContextKey, &db.User{ID: 7})
		}
		return r.WithContext(ctx)
	}

	rec := httptest.NewRecorder()
	handler.GetStack(rec, withRepo(httptest.NewRequest(http.MethodGet, "/", nil), false))
	require.Equal(t, http.StatusOK, rec.Code)
	var view map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &view))
	assert.Equal(t, "absent", view["state"])
	assert.Equal(t, "smithers-canary/smithers", view["repository"])
	assert.Contains(t, rec.Body.String(), `"mainBehind":false`)
	assert.Contains(t, rec.Body.String(), `"limits":{"maxParallel":2}`)
	assert.Equal(t, "abc", service.main)
	assert.Equal(t, []services.MythicalViewer{{Admin: true}}, service.viewers)

	// A signed-in admin is named, so their own accounts are shown to them.
	rec = httptest.NewRecorder()
	handler.GetStack(rec, withRepo(httptest.NewRequest(http.MethodGet, "/", nil), true))
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, services.MythicalViewer{UserID: 7, Admin: true}, service.viewers[1])

	// A reader (a public repository's visitor) is nobody's owner.
	rec = httptest.NewRecorder()
	reader := httptest.NewRequest(http.MethodGet, "/", nil)
	handler.GetStack(rec, reader.WithContext(middleware.ContextWithRepoContext(reader.Context(), &middleware.RepoContext{Owner: "smithers-canary",
		Repository: &db.Repository{ID: 19, Name: "smithers", IsPublic: true}}, middleware.PermissionRead)))
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, services.MythicalViewer{}, service.viewers[2])

	rec = httptest.NewRecorder()
	handler.Bootstrap(rec, withRepo(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"depth":50}`)), false))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	rec = httptest.NewRecorder()
	handler.Bootstrap(rec, withRepo(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"depth":900}`)), true))
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	rec = httptest.NewRecorder()
	handler.Bootstrap(rec, withRepo(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"unknown":1}`)), true))
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Empty(t, service.bootstraps)

	rec = httptest.NewRecorder()
	handler.Bootstrap(rec, withRepo(httptest.NewRequest(http.MethodPost, "/", nil), true))
	require.Equal(t, http.StatusAccepted, rec.Code)
	assert.Len(t, service.bootstraps, 1)
	assert.Contains(t, rec.Body.String(), `"state":"bootstrapping"`)
}

func TestMythicalItemRoute(t *testing.T) {
	handler := &MythicalHandler{Service: &fakeMythicalRoute{}}
	get := func(ref string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		chiCtx := chi.NewRouteContext()
		chiCtx.URLParams.Add("ref", ref)
		ctx := context.WithValue(r.Context(), chi.RouteCtxKey, chiCtx)
		ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{Owner: "o",
			Repository: &db.Repository{ID: 19, Name: "r", IsPublic: true}}, middleware.PermissionRead)
		rec := httptest.NewRecorder()
		handler.GetItem(rec, r.WithContext(ctx))
		return rec
	}
	rec := get("12")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	assert.JSONEq(t, `{"id":"item-12","issue":{"number":12,"title":"Fix login","url":""},"state":"blocked","attempt":0,"runs":{},"dependsOn":[],"updatedAt":""}`,
		rec.Body.String())
	assert.Equal(t, http.StatusNotFound, get("13").Code)
}

func TestMythicalWriteRoutes(t *testing.T) {
	service := &fakeMythicalRoute{}
	handler := &MythicalHandler{Service: service}
	withRepo := func(r *http.Request) *http.Request {
		ctx := middleware.ContextWithRepoContext(r.Context(), &middleware.RepoContext{Owner: "o",
			Repository: &db.Repository{ID: 19, Name: "r"}}, middleware.PermissionAdmin)
		return r.WithContext(context.WithValue(ctx, middleware.UserContextKey, &db.User{ID: 7}))
	}
	rec := httptest.NewRecorder()
	body := `{"workspaceId":"0b2f3c1e-4c7a-4a6e-9d7e-2f3a1b4c5d6e","base":"` + strings.Repeat("1", 40) + `","source":"` +
		strings.Repeat("2", 40) + `","requestRunId":"run","summary":"✨ feat: x"}`
	handler.Lanes(rec, withRepo(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(body))))
	require.Equal(t, http.StatusAccepted, rec.Code)
	assert.Contains(t, rec.Body.String(), `"itemId":"item"`)
	require.Len(t, service.lanes, 1)

	rec = httptest.NewRecorder()
	handler.Lanes(rec, withRepo(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"workspaceId":"x","extra":1}`))))
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	rec = httptest.NewRecorder()
	handler.Config(rec, withRepo(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"maxParallel":4}`))))
	require.Equal(t, http.StatusOK, rec.Code)
	assert.EqualValues(t, 4, service.parallel)

	rec = httptest.NewRecorder()
	handler.Backfill(rec, withRepo(httptest.NewRequest(http.MethodPost, "/", nil)))
	require.Equal(t, http.StatusAccepted, rec.Code)
	assert.Equal(t, 1, service.backfills)
	// A run credential cannot ask for a backfill; the stack's own sweep runs in-process.
	rec = httptest.NewRecorder()
	req := withRepo(httptest.NewRequest(http.MethodPost, "/", nil))
	handler.Backfill(rec, req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 7}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "write:repository"})))
	assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	assert.Equal(t, 1, service.backfills)

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/", nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "item-9")
	handler.Retry(rec, withRepo(req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))))
	require.Equal(t, http.StatusAccepted, rec.Code)
	assert.Equal(t, "item-9", service.retried)
}

func TestMythicalWikiRoute(t *testing.T) {
	service := &fakeMythicalRoute{}
	handler := &MythicalHandler{Service: service}
	request := func(user bool) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/", nil)
		ctx := middleware.ContextWithRepoContext(r.Context(), &middleware.RepoContext{Owner: "o",
			Repository: &db.Repository{ID: 19, Name: "r"}}, middleware.PermissionWrite)
		if user {
			ctx = context.WithValue(ctx, middleware.UserContextKey, &db.User{ID: 7})
		}
		return r.WithContext(ctx)
	}
	rec := httptest.NewRecorder()
	handler.Wiki(rec, request(false))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Zero(t, service.wikis)

	// Requested, not done: the snapshot answers at once.
	rec = httptest.NewRecorder()
	handler.Wiki(rec, request(true))
	require.Equal(t, http.StatusAccepted, rec.Code)
	assert.Equal(t, 1, service.wikis)
	assert.Contains(t, rec.Body.String(), `"repository":"o/r"`)

	service.wikiErr = pkgerrors.Conflict("this repository declares no wiki in .smithers/coding-project.json")
	rec = httptest.NewRecorder()
	handler.Wiki(rec, request(true))
	assert.Equal(t, http.StatusConflict, rec.Code)
	assert.Contains(t, rec.Body.String(), "declares no wiki")
}

// A person files a TODO: 201 with its queued item; the service's refusal
// is the answer, and a malformed or oversized body never reaches it.
func TestMythicalTodosRoute(t *testing.T) {
	service := &fakeMythicalRoute{}
	handler := &MythicalHandler{Service: service}
	request := func(body string, user bool) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		ctx := middleware.ContextWithRepoContext(r.Context(), &middleware.RepoContext{Owner: "o",
			Repository: &db.Repository{ID: 19, Name: "r"}}, middleware.PermissionWrite)
		if user {
			ctx = context.WithValue(ctx, middleware.UserContextKey, &db.User{ID: 7})
		}
		return r.WithContext(ctx)
	}
	rec := httptest.NewRecorder()
	handler.Todos(rec, request(`{"title":"t"}`, false))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	for _, body := range []string{`{"title":"t","labels":["x"]}`, `not json`, `{"title":"` + strings.Repeat("x", 64<<10) + `"}`} {
		rec = httptest.NewRecorder()
		handler.Todos(rec, request(body, true))
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	}
	assert.Empty(t, service.todos)

	rec = httptest.NewRecorder()
	handler.Todos(rec, request(`{"title":"Add the footer link","body":"Make it findable."}`, true))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.Equal(t, []services.MythicalTodoInput{{Title: "Add the footer link", Body: "Make it findable."}}, service.todos)
	assert.Equal(t, []int64{7}, service.todoUsers)
	assert.Contains(t, rec.Body.String(), `"issue":{"number":12,"title":"Add the footer link","url":""}`)
	assert.Contains(t, rec.Body.String(), `"state":"queued"`)

	service.todoErr = pkgerrors.Forbidden("only a maintainer the factory's policy names files a TODO")
	rec = httptest.NewRecorder()
	handler.Todos(rec, request(`{"title":"t"}`, true))
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Contains(t, rec.Body.String(), "only a maintainer")

	rec = httptest.NewRecorder()
	(&MythicalHandler{}).Todos(rec, request(`{"title":"t"}`, true))
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

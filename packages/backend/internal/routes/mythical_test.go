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
	wikis      int
	wikiErr    error
	viewers    []services.MythicalViewer
	todoUsers  []int64
	lands      []services.MythicalMergeInput
	landItems  []string
	landErr    error
}

func (f *fakeMythicalRoute) Merge(_ context.Context, _, userID int64, id string, input services.MythicalMergeInput) (services.MythicalItemView, error) {
	if f.landErr != nil {
		return services.MythicalItemView{}, f.landErr
	}
	f.lands, f.landItems, f.todoUsers = append(f.lands, input), append(f.landItems, id), append(f.todoUsers, userID)
	return services.MythicalItemView{ID: id, State: "proposed", Automerge: true, DependsOn: []string{}}, nil
}

func (f *fakeMythicalRoute) RequestWiki(context.Context, int64) error {
	if f.wikiErr != nil {
		return f.wikiErr
	}
	f.wikis++
	return nil
}

func (f *fakeMythicalRoute) SubmitLane(_ context.Context, _, _ int64, input services.MythicalLaneSubmission) (services.MythicalLaneReceipt, error) {
	f.lanes = append(f.lanes, input)
	return services.MythicalLaneReceipt{ItemID: "item", State: "integrating", Source: input.Source}, nil
}

func (f *fakeMythicalRoute) Item(_ context.Context, repositoryID int64, ref string) (services.MythicalItemView, error) {
	if ref != "12" {
		return services.MythicalItemView{}, pkgerrors.NotFound("item not found")
	}
	return services.MythicalItemView{ID: "item-12", State: "blocked", Issue: &services.MythicalIssueView{Number: 12, Title: "Fix login"},
		DependsOn: []string{}}, nil
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

// refusal is the answer, and a malformed body never reaches it.
func TestMythicalMergeRoute(t *testing.T) {
	service := &fakeMythicalRoute{}
	handler := &MythicalHandler{Service: service}
	request := func(body string, user bool) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		r.Header.Set("Idempotency-Key", "press-1")
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("id", "item-9")
		ctx := context.WithValue(r.Context(), chi.RouteCtxKey, routeCtx)
		ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{Owner: "o",
			Repository: &db.Repository{ID: 19, Name: "r"}}, middleware.PermissionWrite)
		if user {
			ctx = context.WithValue(ctx, middleware.UserContextKey, &db.User{ID: 7})
			ctx = middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: 7}, SessionHash: "browser-session"})
		}
		return r.WithContext(ctx)
	}
	head := strings.Repeat("a", 40)
	rec := httptest.NewRecorder()
	handler.Merge(rec, request(`{"reviewed_head_sha":"`+head+`"}`, false))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	for _, body := range []string{`{"reviewed_head_sha":"x","merge":true}`, `not json`, `{"reviewed_head_sha":"` + strings.Repeat("x", 4<<10) + `"}`} {
		rec = httptest.NewRecorder()
		handler.Merge(rec, request(body, true))
		assert.Equal(t, http.StatusBadRequest, rec.Code, body)
	}
	assert.Empty(t, service.lands)

	rec = httptest.NewRecorder()
	handler.Merge(rec, request(`{"reviewed_head_sha":"`+head+`"}`, true))
	require.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())
	assert.Equal(t, []services.MythicalMergeInput{{Head: head, Request: "press-1"}}, service.lands, "the Idempotency-Key reaches the service")
	assert.Equal(t, []string{"item-9"}, service.landItems)
	assert.Equal(t, []int64{7}, service.todoUsers)
	assert.Contains(t, rec.Body.String(), `"automerge":true`)

	service.landErr = pkgerrors.Conflict("the pull request changed since you saw it")
	rec = httptest.NewRecorder()
	handler.Merge(rec, request(`{"reviewed_head_sha":"`+head+`"}`, true))
	assert.Equal(t, http.StatusConflict, rec.Code)
	assert.Contains(t, rec.Body.String(), "changed since you saw it")

	rec = httptest.NewRecorder()
	(&MythicalHandler{}).Merge(rec, request(`{"reviewed_head_sha":"`+head+`"}`, true))
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestMythicalMergeRejectsTokensBeforeRepositoryReads(t *testing.T) {
	permission := `{"code":"permission","class":"permission","message":"Merge requires an owner or maintainer browser session"}`
	for _, tc := range []struct {
		info   *middleware.AuthInfo
		status int
		body   string
		via    string
	}{
		{nil, http.StatusUnauthorized, `{"code":"unauthenticated","class":"permission","message":"Sign in to merge"}`, ""},
		{&middleware.AuthInfo{User: &db.User{ID: 7}, SessionHash: "session"}, http.StatusForbidden, `{"code":"never","class":"never","message":"Only a person can do this"}`, "smithers"},
		{&middleware.AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: true}, http.StatusForbidden, permission, ""},
		{&middleware.AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: true, TokenSystemIssued: true}, http.StatusForbidden, permission, ""},
		{&middleware.AuthInfo{User: &db.User{ID: 7, UserType: "bot"}, SessionHash: "session"}, http.StatusForbidden, permission, ""},
	} {
		service := &fakeMythicalRoute{}
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
		if tc.via != "" {
			request.Header.Set("Smithers-Via", tc.via)
		}
		ctx := context.WithValue(request.Context(), middleware.UserContextKey, &db.User{ID: 7})
		ctx = middleware.ContextWithAuthInfo(ctx, tc.info)
		rec := httptest.NewRecorder()
		(&MythicalHandler{Service: service}).Merge(rec, request.WithContext(ctx))
		assert.Equal(t, tc.status, rec.Code)
		assert.JSONEq(t, tc.body, rec.Body.String())
		assert.Empty(t, service.lands)
	}
}

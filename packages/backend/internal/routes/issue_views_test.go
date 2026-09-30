package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// viewIssueRouteService is the issue service with saved views.
type viewIssueRouteService struct {
	mockIssueRouteService
	listViewsFn func(ctx context.Context, viewer *db.User, owner, repo string) ([]services.IssueView, error)
	inViewFn    func(ctx context.Context, viewer *db.User, owner, repo, view string, afterNumber int64, limit int) ([]services.IssueResponse, string, int64, error)
}

func (m *viewIssueRouteService) ListIssueViews(ctx context.Context, viewer *db.User, owner, repo string) ([]services.IssueView, error) {
	return m.listViewsFn(ctx, viewer, owner, repo)
}

func (m *viewIssueRouteService) ListIssuesInView(ctx context.Context, viewer *db.User, owner, repo, view string, afterNumber int64, limit int) ([]services.IssueResponse, string, int64, error) {
	return m.inViewFn(ctx, viewer, owner, repo, view, afterNumber, limit)
}

func serveIssues(h IssueHandler, handler func(IssueHandler, http.ResponseWriter, *http.Request), target string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()
	handler(h, rec, req)
	return rec
}

func listIssues(h IssueHandler, w http.ResponseWriter, r *http.Request)     { h.ListIssues(w, r) }
func listIssueViews(h IssueHandler, w http.ResponseWriter, r *http.Request) { h.ListIssueViews(w, r) }

func TestIssueHandler_ListIssuesInView(t *testing.T) {
	t.Parallel()

	t.Run("lists through the named view with the plain list's pagination", func(t *testing.T) {
		t.Parallel()
		service := &viewIssueRouteService{inViewFn: func(_ context.Context, viewer *db.User, owner, repo, view string, afterNumber int64, limit int) ([]services.IssueResponse, string, int64, error) {
			assert.Nil(t, viewer)
			assert.Equal(t, "alice/demo", owner+"/"+repo)
			assert.Equal(t, "bugs", view)
			assert.Equal(t, int64(0), afterNumber)
			assert.Equal(t, 2, limit)
			items := []services.IssueResponse{sampleIssueResponse(), sampleIssueResponse()}
			return items, "next", 9, nil
		}}
		service.listIssuesFn = func(context.Context, *db.User, string, string, int64, int, string) ([]services.IssueResponse, string, int64, error) {
			t.Fatal("a view never reaches the plain list")
			return nil, "", 0, nil
		}
		rec := serveIssues(IssueHandler{Service: service}, listIssues, "/api/repos/alice/demo/issues?view=+bugs+&limit=2")
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "9", rec.Header().Get("X-Total-Count"))
		assert.Contains(t, rec.Header().Get("Link"), `rel="next"`)
		assert.Contains(t, rec.Header().Get("Link"), "view=")
		var body []services.IssueResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Len(t, body, 2)
	})

	refused := map[string]string{
		"an empty view":       "/api/repos/alice/demo/issues?view=",
		"a view with a state": "/api/repos/alice/demo/issues?view=bugs&state=open",
		"a blank view":        "/api/repos/alice/demo/issues?view=%20&state=open",
	}
	for name, target := range refused {
		t.Run("refuses "+name, func(t *testing.T) {
			t.Parallel()
			service := &viewIssueRouteService{inViewFn: func(context.Context, *db.User, string, string, string, int64, int) ([]services.IssueResponse, string, int64, error) {
				t.Fatal("a refused view lists nothing")
				return nil, "", 0, nil
			}}
			rec := serveIssues(IssueHandler{Service: service}, listIssues, target)
			assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
		})
	}

	t.Run("an undeclared view and a service without views are not found", func(t *testing.T) {
		t.Parallel()
		service := &viewIssueRouteService{inViewFn: func(context.Context, *db.User, string, string, string, int64, int) ([]services.IssueResponse, string, int64, error) {
			return nil, "", 0, pkgerrors.NotFound(`issue view "gone" not found`)
		}}
		rec := serveIssues(IssueHandler{Service: service}, listIssues, "/api/repos/alice/demo/issues?view=gone")
		assert.Equal(t, http.StatusNotFound, rec.Code)
		rec = serveIssues(IssueHandler{Service: &mockIssueRouteService{}}, listIssues, "/api/repos/alice/demo/issues?view=bugs")
		assert.Equal(t, http.StatusNotFound, rec.Code)
		assert.Contains(t, rec.Body.String(), `issue view \"bugs\" not found`)
	})

	t.Run("a malformed projection fails the list visibly", func(t *testing.T) {
		t.Parallel()
		service := &viewIssueRouteService{inViewFn: func(context.Context, *db.User, string, string, string, int64, int) ([]services.IssueResponse, string, int64, error) {
			return nil, "", 0, pkgerrors.UnprocessableEntity(".smithers/factory.json declares an invalid issue view id")
		}}
		rec := serveIssues(IssueHandler{Service: service}, listIssues, "/api/repos/alice/demo/issues?view=bugs")
		assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	})

	t.Run("without a view the state filter still reaches the plain list", func(t *testing.T) {
		t.Parallel()
		called := false
		service := &viewIssueRouteService{}
		service.listIssuesFn = func(_ context.Context, _ *db.User, _, _ string, _ int64, _ int, state string) ([]services.IssueResponse, string, int64, error) {
			called = true
			assert.Equal(t, "closed", state)
			return nil, "", 0, nil
		}
		rec := serveIssues(IssueHandler{Service: service}, listIssues, "/api/repos/alice/demo/issues?state=closed")
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, called)
	})
}

func TestIssueHandler_ListIssueViews(t *testing.T) {
	t.Parallel()

	t.Run("answers the declared views in order", func(t *testing.T) {
		t.Parallel()
		service := &viewIssueRouteService{listViewsFn: func(_ context.Context, viewer *db.User, owner, repo string) ([]services.IssueView, error) {
			assert.Nil(t, viewer)
			assert.Equal(t, "alice/demo", owner+"/"+repo)
			return []services.IssueView{{ID: "bugs", Title: "Bugs", State: "open", Labels: []string{"bug"}}, {ID: "all", Title: "All"}}, nil
		}}
		rec := serveIssues(IssueHandler{Service: service}, listIssueViews, "/api/repos/alice/demo/issue-views")
		require.Equal(t, http.StatusOK, rec.Code)
		assert.JSONEq(t, `[{"id":"bugs","title":"Bugs","state":"open","labels":["bug"]},{"id":"all","title":"All"}]`, rec.Body.String())
	})

	t.Run("a service without views answers none", func(t *testing.T) {
		t.Parallel()
		rec := serveIssues(IssueHandler{Service: &mockIssueRouteService{}}, listIssueViews, "/api/repos/alice/demo/issue-views")
		require.Equal(t, http.StatusOK, rec.Code)
		assert.JSONEq(t, `[]`, rec.Body.String())
	})

	t.Run("service errors keep their status", func(t *testing.T) {
		t.Parallel()
		for status, err := range map[int]error{
			http.StatusForbidden:           pkgerrors.Forbidden("permission denied"),
			http.StatusUnprocessableEntity: pkgerrors.UnprocessableEntity("bad projection"),
			http.StatusInternalServerError: pkgerrors.Internal("read failed"),
		} {
			service := &viewIssueRouteService{listViewsFn: func(context.Context, *db.User, string, string) ([]services.IssueView, error) {
				return nil, err
			}}
			rec := serveIssues(IssueHandler{Service: service}, listIssueViews, "/api/repos/alice/demo/issue-views")
			assert.Equal(t, status, rec.Code)
		}
	})

	t.Run("a missing owner is refused", func(t *testing.T) {
		t.Parallel()
		req := httptest.NewRequest(http.MethodGet, "/api/repos//demo/issue-views", nil)
		req = withRouteParams(req, map[string]string{"owner": "", "repo": "demo"})
		rec := httptest.NewRecorder()
		h := IssueHandler{Service: &mockIssueRouteService{}}
		h.ListIssueViews(rec, req)
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

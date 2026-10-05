package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

type learningReadRoute struct {
	fakeMythicalRoute
	calls      int
	repo, todo int64
	run        string
	err        error
}

func (f *learningReadRoute) LearningSnapshot(ctx context.Context, repo, todo int64, run string) (services.LearningSnapshot, error) {
	f.calls++
	f.repo, f.todo, f.run = repo, todo, run
	return services.LearningSnapshot{Repository: "owner/demo", Todo: todo, Run: run, State: "merged", Change: "T7", Commit: strings.Repeat("a", 40), Attempts: []string{}, Journal: []services.LearningJournalRow{}, Outcomes: []services.LearningOutcome{}}, f.err
}
func learningRequest(h *MythicalHandler, path string) *httptest.ResponseRecorder {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{Owner: "owner", Repository: &db.Repository{ID: 42, Name: "demo"}})
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.Get("/learning/{todo}", h.Learning)
	response := httptest.NewRecorder()
	r.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
	return response
}
func TestLearningReadHTTPBoundary(t *testing.T) {
	service := &learningReadRoute{}
	handler := &MythicalHandler{Service: service}
	response := learningRequest(handler, "/learning/7?run=learn-7")
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, 1, service.calls)
	require.Equal(t, int64(42), service.repo)
	require.Equal(t, int64(7), service.todo)
	require.Equal(t, "learn-7", service.run)
	require.Contains(t, response.Body.String(), `"state":"merged"`)
	require.Contains(t, response.Body.String(), `"run":"learn-7"`)
	for _, path := range []string{"/learning/0?run=x", "/learning/-1?run=x", "/learning/nope?run=x", "/learning/7", "/learning/7?run=", "/learning/7?run=a&run=b", "/learning/9223372036854775808?run=x", "/learning/7?run=" + strings.Repeat("x", 513)} {
		require.Equal(t, http.StatusBadRequest, learningRequest(handler, path).Code, path)
	}
	require.Equal(t, 1, service.calls, "malformed reads never reach service")
	service.err = pkgerrors.Forbidden("wrong run")
	require.Equal(t, http.StatusForbidden, learningRequest(handler, "/learning/7?run=other").Code)
	unavailable := &MythicalHandler{Service: &fakeMythicalRoute{}}
	require.Equal(t, http.StatusServiceUnavailable, learningRequest(unavailable, "/learning/7?run=x").Code)
}
func FuzzLearningReadHTTPParser(f *testing.F) {
	f.Add("7", "learn-7")
	f.Fuzz(func(t *testing.T, todo, run string) {
		if len(todo) > 100 || len(run) > 600 {
			return
		}
		service := &learningReadRoute{}
		response := learningRequest(&MythicalHandler{Service: service}, "/learning/"+url.PathEscape(todo)+"?run="+url.QueryEscape(run))
		require.LessOrEqual(t, service.calls, 1)
		if response.Code == http.StatusOK {
			require.Positive(t, service.todo)
			require.NotEmpty(t, service.run)
			require.LessOrEqual(t, len(service.run), 512)
		}
	})
}

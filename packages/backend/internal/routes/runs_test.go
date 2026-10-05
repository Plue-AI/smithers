package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestRunsRejectInvalidDocuments(t *testing.T) {
	handler := &RunsHandler{Queries: db.New(nil)}
	for _, body := range []string{``, `null`, `{}`, `{"op":"stop"}`, `{"op":"retry","actor":1}`, `{"op":"retry"} {}`, `{"op":"retry"}` + strings.Repeat(" ", 1024)} {
		w := httptest.NewRecorder()
		handler.Control(w, httptest.NewRequest(http.MethodPost, "/api/runs/1", strings.NewReader(body)))
		require.Equal(t, 400, w.Code, body)
	}
}
func TestRunsRequireSession(t *testing.T) {
	handler := &RunsHandler{Queries: db.New(nil)}
	for _, op := range []string{"retry", "dismiss"} {
		w := httptest.NewRecorder()
		handler.Control(w, httptest.NewRequest(http.MethodPost, "/api/runs/1", strings.NewReader(`{"op":"`+op+`"}`)))
		require.Equal(t, 401, w.Code)
	}
	w := httptest.NewRecorder()
	handler.List(w, httptest.NewRequest(http.MethodGet, "/api/runs", nil))
	require.Equal(t, 401, w.Code)
}
func FuzzRunsControlDocument(f *testing.F) {
	for _, body := range []string{`{"op":"retry"}`, `null`, `{}`, `{"op":"dismiss"}`, `{"op":"stop"}`, `{"op":"retry"} {}`} {
		f.Add(body)
	}
	f.Fuzz(func(t *testing.T, body string) {
		w := httptest.NewRecorder()
		(&RunsHandler{Queries: db.New(nil)}).Control(w, httptest.NewRequest(http.MethodPost, "/api/runs/1", strings.NewReader(body)))
		require.Contains(t, []int{400, 401}, w.Code)
	})
}

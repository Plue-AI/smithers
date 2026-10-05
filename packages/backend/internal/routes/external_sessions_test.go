package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/externalsessions"
)

// An agent session is read only for a person the install can authorize,
// and a handler composed without its finder says it is unavailable rather
// than answering an empty session.
func TestExternalSessionsReadRefusesBeforeReading(t *testing.T) {
	finder := &externalsessions.Finder{Home: t.TempDir()}
	for _, tc := range []struct {
		name    string
		handler *ExternalSessionsHandler
		status  int
		body    string
	}{
		{"no handler", nil, http.StatusServiceUnavailable, `{"class":"infra","code":"external_unavailable","message":"Agent sessions are unavailable"}`},
		{"no store", &ExternalSessionsHandler{Sessions: finder}, http.StatusServiceUnavailable, `{"class":"infra","code":"external_unavailable","message":"Agent sessions are unavailable"}`},
		{"no finder", &ExternalSessionsHandler{Queries: db.New(nil)}, http.StatusServiceUnavailable, `{"class":"infra","code":"external_unavailable","message":"Agent sessions are unavailable"}`},
		{"signed out", &ExternalSessionsHandler{Queries: db.New(nil), Sessions: finder}, http.StatusUnauthorized, `{"class":"permission","code":"unauthenticated","message":"Sign in"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			tc.handler.Read(w, httptest.NewRequest(http.MethodGet, "/api/external/sessions?agent=codex&session=0199e2e0", nil))
			require.Equal(t, tc.status, w.Code)
			require.JSONEq(t, tc.body, w.Body.String())
		})
	}
}

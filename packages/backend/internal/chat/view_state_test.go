package chat

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

func TestViewStateRefusesAgentAuthorityBeforeStorage(t *testing.T) {
	for _, test := range []struct {
		name string
		auth *middleware.AuthInfo
	}{
		{"signed out", nil},
		{"delegated", &middleware.AuthInfo{User: &db.User{ID: 1, Username: "ben"}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "write:user,read:user,via:smithers"}},
		{"run", &middleware.AuthInfo{User: &db.User{ID: 1, Username: "ben"}, IsTokenAuth: true, TokenSystemIssued: true}},
		{"agent account", &middleware.AuthInfo{User: &db.User{ID: 1, Username: "agent", UserType: "bot"}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, method := range []string{http.MethodGet, http.MethodPut} {
				req := httptest.NewRequest(method, "/api/conversations/main/view-state", nil)
				if test.auth != nil {
					req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), test.auth))
				}
				response := httptest.NewRecorder()
				// A nil store makes accidental private storage access observable.
				(&Handler{}).ViewState(response, req)
				if response.Code != http.StatusForbidden {
					t.Fatalf("%s: status=%d body=%s", method, response.Code, response.Body.String())
				}
			}
		})
	}
}

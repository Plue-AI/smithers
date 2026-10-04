package compose

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

type installOwnerFixture struct{ err error }

func (f installOwnerFixture) GetSelfHostOwner(context.Context) (db.User, error) {
	return db.User{ID: 7}, f.err
}
func TestInstallModelOwnerBeforeAnyWrite(t *testing.T) {
	for _, test := range []struct {
		name     string
		auth     *middleware.AuthInfo
		ownerErr error
		want     int
	}{
		{"missing", nil, nil, 403}, {"member", &middleware.AuthInfo{User: &db.User{ID: 8}, SessionHash: "session"}, nil, 403},
		{"owner PAT", &middleware.AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: true}, nil, 403},
		{"no browser session", &middleware.AuthInfo{User: &db.User{ID: 7}}, nil, 403},
		{"bot", &middleware.AuthInfo{User: &db.User{ID: 7, UserType: "bot"}, SessionHash: "session"}, nil, 403},
		{"owner unavailable", &middleware.AuthInfo{User: &db.User{ID: 7}, SessionHash: "session"}, errors.New("offline"), 403},
		{"owner browser", &middleware.AuthInfo{User: &db.User{ID: 7}, SessionHash: "session"}, nil, 204},
	} {
		t.Run(test.name, func(t *testing.T) {
			writes := 0
			handler := installModelOwner(installOwnerFixture{test.ownerErr})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writes++; w.WriteHeader(204) }))
			r := httptest.NewRequest("POST", "/api/model/credential", nil)
			if test.auth != nil {
				r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), test.auth))
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			require.Equal(t, test.want, w.Code)
			if test.want == 403 {
				require.Zero(t, writes)
				require.Contains(t, w.Body.String(), `"class":"permission"`)
			} else {
				require.Equal(t, 1, writes)
			}
		})
	}
}

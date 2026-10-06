package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// An uninitialized pool panics if reached. Each missing-provider refusal must
// happen before authorization, querying the roster, or a handler effect.
func TestMembersMissingProvidersRefuseBeforeEffects(t *testing.T) {
	for _, service := range []*services.Members{nil, {}, {Pool: &pgxpool.Pool{}}} {
		handler := &MembersHandler{Service: service}
		for _, method := range []string{"GET", "POST", "PATCH", "DELETE"} {
			request := httptest.NewRequest(method, "/api/members", strings.NewReader(`{"login":"alice"}`))
			response := httptest.NewRecorder()
			if method == "GET" {
				handler.List(response, request)
			} else {
				handler.Mutate(response, request)
			}
			require.Equal(t, http.StatusServiceUnavailable, response.Code)
			require.JSONEq(t, `{"class":"infra","code":"unavailable","message":"Members unavailable"}`, response.Body.String())
		}
	}
}

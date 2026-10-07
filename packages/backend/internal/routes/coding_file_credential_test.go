package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// The issuer is replaced only to exercise decoder/HTTP failure branches;
// production issuance and revocation have PostgreSQL/composed-route tests.
type codingFileIssuerFixture struct {
	calls int
	fail  bool
}

func (f *codingFileIssuerFixture) Mint(context.Context, string, string, services.CodingFileGrantInput) (services.CodingFileGrant, error) {
	f.calls++
	if f.fail {
		return services.CodingFileGrant{}, pkgerrors.Forbidden("refused")
	}
	return services.CodingFileGrant{Token: "fixture"}, nil
}
func (f *codingFileIssuerFixture) Revoke(context.Context, string, int64, string) error {
	f.calls++
	if f.fail {
		return pkgerrors.Forbidden("refused")
	}
	return nil
}
func TestCodingFileGrantRouteFailures(t *testing.T) {
	for _, tc := range []struct {
		name, method, id, body string
		absent, fail           bool
		want, calls            int
	}{
		{name: "issuer absent", method: "POST", absent: true, want: 503},
		{name: "cleanup absent", method: "DELETE", id: "1", absent: true, want: 503},
		{name: "malformed", method: "POST", body: `{`, want: 400},
		{name: "unknown field", method: "POST", body: `{"actor":1}`, want: 400},
		{name: "trailing value", method: "POST", body: `{} {}`, want: 400},
		{name: "refused mint", method: "POST", body: `{}`, fail: true, want: 403, calls: 1},
		{name: "minted", method: "POST", body: `{}`, want: 201, calls: 1},
		{name: "invalid token id", method: "DELETE", id: "bad", want: 400},
		{name: "zero token id", method: "DELETE", id: "0", want: 400},
		{name: "refused cleanup", method: "DELETE", id: "1", fail: true, want: 403, calls: 1},
		{name: "cleaned", method: "DELETE", id: "1", want: 204, calls: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			issuer := &codingFileIssuerFixture{fail: tc.fail}
			handler := &WorkspaceHandler{}
			if !tc.absent {
				handler.CodingFiles = issuer
			}
			router := chi.NewRouter()
			router.Post("/{hostID}", handler.MintCodingFileGrant)
			router.Delete("/{hostID}/{tokenID}", handler.RevokeCodingFileGrant)
			path := "/host"
			if tc.method == http.MethodDelete {
				path += "/" + tc.id
			}
			req := httptest.NewRequest(tc.method, path, strings.NewReader(tc.body))
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			require.Equal(t, tc.want, rec.Code, rec.Body.String())
			require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
			require.Equal(t, tc.calls, issuer.calls)
		})
	}
}

package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// Replace only the database seam so the handler exercises real service policy
// and HTTP serialization. The fake applies the visibility statement's rule;
// its SQL is covered against PostgreSQL in services and compose.
type orgVisibilityRouteQuerier struct {
	services.OrgQuerier
	visibleFn func(context.Context, db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error)
}

func (q orgVisibilityRouteQuerier) GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	return q.visibleFn(ctx, arg)
}

func TestOrgHandler_GetOrg_VisibilityWithRealService(t *testing.T) {
	t.Parallel()
	const notFoundBody = "{\"code\":\"not_found\",\"fault\":\"user\",\"message\":\"organization not found\"}\n"
	for _, tc := range []struct {
		name, visibility, role string
		authenticated, missing bool
		storeErr               error
		status                 int
		body                   string
	}{
		{name: "anonymous private", visibility: "private", status: http.StatusNotFound, body: notFoundBody},
		{name: "outsider private", visibility: "private", authenticated: true, status: http.StatusNotFound, body: notFoundBody},
		{name: "owner private", visibility: "private", authenticated: true, role: "owner", status: http.StatusOK},
		{name: "member private", visibility: "private", authenticated: true, role: "member", status: http.StatusOK},
		{name: "store unavailable", visibility: "private", authenticated: true, storeErr: errors.New("database unavailable"), status: http.StatusInternalServerError, body: "{\"code\":\"internal\",\"fault\":\"bug\",\"message\":\"internal server error\"}\n"},
		{name: "anonymous missing", missing: true, status: http.StatusNotFound, body: notFoundBody},
		{name: "signed in missing", authenticated: true, missing: true, status: http.StatusNotFound, body: notFoundBody},
		{name: "anonymous public", visibility: "public", status: http.StatusOK},
		{name: "outsider public", visibility: "public", authenticated: true, status: http.StatusOK},
		{name: "anonymous limited", visibility: "limited", status: http.StatusForbidden, body: "{\"code\":\"forbidden\",\"class\":\"permission\",\"fault\":\"user\",\"message\":\"organization membership required\"}\n"},
		{name: "outsider limited", visibility: "limited", authenticated: true, status: http.StatusForbidden, body: "{\"code\":\"forbidden\",\"class\":\"permission\",\"fault\":\"user\",\"message\":\"insufficient organization permissions\"}\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			calls := 0
			org := sampleOrg()
			org.Visibility = tc.visibility
			wantViewer := int64(0)
			if tc.authenticated {
				wantViewer = 7
			}
			q := orgVisibilityRouteQuerier{visibleFn: func(_ context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
				calls++
				require.Equal(t, db.GetVisibleOrgForViewerParams{ViewerID: wantViewer, LowerName: "acme"}, arg)
				if tc.storeErr != nil {
					return db.GetVisibleOrgForViewerRow{}, tc.storeErr
				}
				if tc.missing || (tc.visibility == "private" && tc.role == "") {
					return db.GetVisibleOrgForViewerRow{}, pgx.ErrNoRows
				}
				return db.GetVisibleOrgForViewerRow{Organization: org, ViewerRole: tc.role}, nil
			}}
			h := OrgHandler{Service: services.NewOrgService(q)}
			req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/orgs/acme", nil), map[string]string{"org": "acme"})
			if tc.authenticated {
				req = withAuth(req, 7, "viewer")
			}
			rec := httptest.NewRecorder()
			h.GetOrg(rec, req)
			require.Equal(t, tc.status, rec.Code, rec.Body.String())
			require.Equal(t, "application/json", rec.Header().Get("Content-Type"))
			require.Equal(t, 1, calls, "one statement per request")
			if tc.body != "" {
				require.Equal(t, tc.body, rec.Body.String())
			} else {
				var got db.Organization
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
				require.Equal(t, org, got)
			}
		})
	}
}

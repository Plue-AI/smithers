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
// and HTTP serialization. Database failures cannot be forced in the SQL fixture.
type orgVisibilityRouteQuerier struct {
	services.OrgQuerier
	getOrgFn    func(context.Context, string) (db.Organization, error)
	getMemberFn func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error)
}

func (q orgVisibilityRouteQuerier) GetOrgByLowerName(ctx context.Context, name string) (db.Organization, error) {
	return q.getOrgFn(ctx, name)
}

func (q orgVisibilityRouteQuerier) GetOrgMember(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
	return q.getMemberFn(ctx, arg)
}

func TestOrgHandler_GetOrg_VisibilityWithRealService(t *testing.T) {
	t.Parallel()
	const notFoundBody = "{\"code\":\"not_found\",\"fault\":\"user\",\"message\":\"organization not found\"}\n"
	for _, tc := range []struct {
		name, visibility, role string
		authenticated, missing bool
		memberErr              error
		status                 int
		body                   string
		memberCalls            int
	}{
		{name: "anonymous private", visibility: "private", status: http.StatusNotFound, body: notFoundBody},
		{name: "outsider private", visibility: "private", authenticated: true, memberErr: pgx.ErrNoRows, status: http.StatusNotFound, body: notFoundBody, memberCalls: 1},
		{name: "owner private", visibility: "private", authenticated: true, role: "owner", status: http.StatusOK, memberCalls: 1},
		{name: "member private", visibility: "private", authenticated: true, role: "member", status: http.StatusOK, memberCalls: 1},
		{name: "membership unavailable", visibility: "private", authenticated: true, memberErr: errors.New("membership database unavailable"), status: http.StatusInternalServerError, body: "{\"code\":\"internal\",\"fault\":\"bug\",\"message\":\"internal server error\"}\n", memberCalls: 1},
		{name: "anonymous missing", missing: true, status: http.StatusNotFound, body: notFoundBody},
		{name: "signed in missing", authenticated: true, missing: true, status: http.StatusNotFound, body: notFoundBody},
		{name: "anonymous public", visibility: "public", status: http.StatusOK},
		{name: "outsider public", visibility: "public", authenticated: true, status: http.StatusOK},
		{name: "anonymous limited", visibility: "limited", status: http.StatusForbidden, body: "{\"code\":\"forbidden\",\"fault\":\"user\",\"message\":\"organization membership required\"}\n"},
		{name: "outsider limited", visibility: "limited", authenticated: true, memberErr: pgx.ErrNoRows, status: http.StatusForbidden, body: "{\"code\":\"forbidden\",\"fault\":\"user\",\"message\":\"insufficient organization permissions\"}\n", memberCalls: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			calls := 0
			org := sampleOrg()
			org.Visibility = tc.visibility
			q := orgVisibilityRouteQuerier{
				getOrgFn: func(_ context.Context, name string) (db.Organization, error) {
					require.Equal(t, "acme", name)
					if tc.missing {
						return db.Organization{}, pgx.ErrNoRows
					}
					return org, nil
				},
				getMemberFn: func(_ context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
					calls++
					require.Equal(t, org.ID, arg.OrganizationID)
					require.Equal(t, int64(7), arg.UserID)
					return db.OrgMember{OrganizationID: org.ID, UserID: arg.UserID, Role: tc.role}, tc.memberErr
				},
			}
			h := OrgHandler{Service: services.NewOrgService(q)}
			req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/orgs/acme", nil), map[string]string{"org": "acme"})
			if tc.authenticated {
				req = withAuth(req, 7, "viewer")
			}
			rec := httptest.NewRecorder()
			h.GetOrg(rec, req)
			require.Equal(t, tc.status, rec.Code, rec.Body.String())
			require.Equal(t, "application/json", rec.Header().Get("Content-Type"))
			require.Equal(t, tc.memberCalls, calls)
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

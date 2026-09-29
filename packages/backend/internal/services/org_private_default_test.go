package services

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestOrgService_CreateOrg_PrivateDefaultPaths(t *testing.T) {
	for _, transactional := range []bool{false, true} {
		for _, tc := range []struct {
			name, input, want string
		}{
			{"omitted", "", "private"},
			{"blank", " \t\n", "private"},
			{"explicit public", "public", "public"},
			{"explicit limited", "limited", "limited"},
			{"explicit private", "private", "private"},
			{"trimmed public", " public ", "public"},
		} {
			t.Run(fmt.Sprintf("transaction=%t/%s", transactional, tc.name), func(t *testing.T) {
				created, added, committed := false, false, false
				create := func(_ context.Context, arg db.CreateOrganizationParams) (db.Organization, error) {
					created = true
					require.Equal(t, tc.want, arg.Visibility)
					return db.Organization{ID: 71, Name: arg.Name, LowerName: arg.LowerName, Visibility: arg.Visibility}, nil
				}
				add := func(_ context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error) {
					added = true
					require.Equal(t, db.AddOrgMemberParams{OrganizationID: 71, UserID: 42, Role: "owner"}, arg)
					return db.OrgMember{}, nil
				}
				svc := NewOrgService(&mockOrgQuerier{createOrganizationFn: create, addOrgMemberFn: add})
				if transactional {
					svc.queries = &mockOrgQuerier{
						createOrganizationFn: func(context.Context, db.CreateOrganizationParams) (db.Organization, error) {
							t.Fatal("transactional creation used the direct path")
							return db.Organization{}, nil
						},
					}
					svc.txManager = &mockOrgCreateTxManager{beginCreateTxFn: func(context.Context) (orgCreateTx, error) {
						return &mockOrgCreateTx{createOrganizationFn: create, addOrgMemberFn: add, commitFn: func(context.Context) error {
							committed = true
							return nil
						}}, nil
					}}
				}
				org, err := svc.CreateOrg(context.Background(), testOrgUser(42, "owner"), CreateOrgRequest{Name: "acme", Visibility: tc.input})
				require.NoError(t, err)
				require.Equal(t, tc.want, org.Visibility)
				require.True(t, created)
				require.True(t, added)
				require.Equal(t, transactional, committed)
			})
		}
	}
}

// The fake isolates infrastructure failures and wrapped no-rows errors, which
// cannot be produced reliably by the real PostgreSQL access tests below.
func TestOrgService_GetOrg_PrivateNotFoundAndMembershipFailures(t *testing.T) {
	ctx := context.Background()
	for _, viewer := range []*db.User{nil, testOrgUser(42, "outsider")} {
		t.Run(fmt.Sprintf("authenticated=%t", viewer != nil), func(t *testing.T) {
			missingService := NewOrgService(&mockOrgQuerier{})
			_, missingErr := missingService.GetOrg(ctx, viewer, "missing")
			missingPayload := orgPrivacyErrorPayload(t, missingErr, 404)
			for _, membershipErr := range []error{pgx.ErrNoRows, fmt.Errorf("lookup: %w", pgx.ErrNoRows)} {
				calls := 0
				svc := NewOrgService(&mockOrgQuerier{
					getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) { return testOrg("private"), nil },
					getOrgMemberFn: func(_ context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
						calls++
						require.Equal(t, db.GetOrgMemberParams{OrganizationID: 7, UserID: 42}, arg)
						return db.OrgMember{}, membershipErr
					},
				})
				org, err := svc.GetOrg(ctx, viewer, "acme")
				require.Equal(t, db.Organization{}, org)
				require.Equal(t, missingPayload, orgPrivacyErrorPayload(t, err, 404))
				if viewer == nil {
					require.Zero(t, calls)
				} else {
					require.Equal(t, 1, calls)
				}
			}
		})
	}
	for _, visibility := range []string{"private", "limited"} {
		t.Run(visibility+" membership unavailable", func(t *testing.T) {
			cause := errors.New("membership database unavailable")
			svc := NewOrgService(&mockOrgQuerier{
				getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) { return testOrg(visibility), nil },
				getOrgMemberFn:      func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) { return db.OrgMember{}, cause },
			})
			org, err := svc.GetOrg(ctx, testOrgUser(42, "viewer"), "acme")
			require.Equal(t, db.Organization{}, org)
			orgPrivacyErrorPayload(t, err, 500)
			require.Same(t, cause, err.(*pkgerrors.APIError).Cause())
		})
	}
}

func orgPrivacyErrorPayload(t *testing.T, err error, status int) string {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, status, apiErr.Status)
	w := httptest.NewRecorder()
	pkgerrors.WriteError(w, apiErr)
	return w.Body.String()
}

func TestOrgService_PrivateDefaultAndAccess_PostgreSQL(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	users := make([]*db.User, 3)
	for i, username := range []string{"privacy-owner", "privacy-member", "privacy-outsider"} {
		users[i] = &db.User{Username: username, LowerUsername: username}
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ($1, $1) RETURNING id`, username).Scan(&users[i].ID))
	}
	for _, transactional := range []bool{false, true} {
		for _, tc := range []struct{ name, visibility, want string }{
			{"omitted", "", "private"}, {"blank", " \t", "private"},
			{"public", "public", "public"}, {"limited", "limited", "limited"}, {"private", "private", "private"},
		} {
			t.Run(fmt.Sprintf("transaction=%t/%s", transactional, tc.name), func(t *testing.T) {
				svc := NewOrgService(q)
				if transactional {
					svc = NewOrgServiceWithPool(q, pool)
				}
				name := fmt.Sprintf("privacy-%t-%s", transactional, tc.name)
				org, err := svc.CreateOrg(ctx, users[0], CreateOrgRequest{Name: name, Visibility: tc.visibility})
				require.NoError(t, err)
				require.Equal(t, tc.want, org.Visibility)
				stored, err := q.GetOrgByLowerName(ctx, name)
				require.NoError(t, err)
				require.Equal(t, org, stored)
				owner, err := q.GetOrgMember(ctx, db.GetOrgMemberParams{OrganizationID: org.ID, UserID: users[0].ID})
				require.NoError(t, err)
				require.Equal(t, "owner", owner.Role)
				_, err = q.AddOrgMember(ctx, db.AddOrgMemberParams{OrganizationID: org.ID, UserID: users[1].ID, Role: "member"})
				require.NoError(t, err)
				for _, viewer := range []*db.User{nil, users[2], users[0], users[1]} {
					got, err := svc.GetOrg(ctx, viewer, name)
					if tc.want == "public" || (viewer != nil && viewer.ID != users[2].ID) {
						require.NoError(t, err)
						require.Equal(t, stored, got)
						continue
					}
					if tc.want == "private" {
						_, missingErr := svc.GetOrg(ctx, viewer, "missing")
						require.Equal(t, orgPrivacyErrorPayload(t, missingErr, 404), orgPrivacyErrorPayload(t, err, 404))
					} else {
						orgPrivacyErrorPayload(t, err, 403)
					}
					require.Equal(t, db.Organization{}, got)
				}
			})
		}
	}
}

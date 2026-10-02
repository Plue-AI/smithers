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
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// orgScopedErrorResponse renders err as the HTTP layer would, so two calls
// compare by status, code, and body rather than by Go identity.
func orgScopedErrorResponse(t *testing.T, err error) string {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	w := httptest.NewRecorder()
	pkgerrors.WriteError(w, apiErr)
	return fmt.Sprintf("%d %s", w.Code, w.Body.String())
}

// orgStatementFake stands in for the GetVisibleOrgForViewer statement.
type orgStatementFake struct {
	row   db.GetVisibleOrgForViewerRow
	err   error
	calls []db.GetVisibleOrgForViewerParams
}

func (f *orgStatementFake) GetVisibleOrgForViewer(_ context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error) {
	f.calls = append(f.calls, arg)
	return f.row, f.err
}

// One statement decides visibility: a hidden and an absent organization are
// the same "no row", cost the same single round trip, and fail the same way.
// The real statement's semantics are covered against PostgreSQL below.
func TestResolveOrgForViewer_OneStatementDecidesVisibility(t *testing.T) {
	ctx := context.Background()
	outsider := &db.User{ID: 42, Username: "outsider"}

	for _, noRow := range []error{pgx.ErrNoRows, fmt.Errorf("lookup: %w", pgx.ErrNoRows)} {
		for _, viewer := range []*db.User{nil, outsider} {
			fake := &orgStatementFake{err: noRow}
			org, membership, err := resolveOrgForViewer(ctx, fake, viewer, " ACME ")
			require.Equal(t, orgNotFoundResponse, orgScopedErrorResponse(t, err))
			require.Equal(t, db.Organization{}, org)
			require.Equal(t, orgMembership{}, membership)
			wantViewer := int64(0)
			if viewer != nil {
				wantViewer = viewer.ID
			}
			require.Equal(t, []db.GetVisibleOrgForViewerParams{{ViewerID: wantViewer, LowerName: "acme"}}, fake.calls)
		}
	}

	for _, tc := range []struct {
		role string
		want orgMembership
	}{
		{"", orgMembership{}},
		{"member", orgMembership{Member: true, Role: "member"}},
		{" Owner ", orgMembership{Member: true, Role: "owner"}},
	} {
		row := db.GetVisibleOrgForViewerRow{Organization: db.Organization{ID: 7, Name: "acme", Visibility: "limited"}, ViewerRole: tc.role}
		org, membership, err := resolveOrgForViewer(ctx, &orgStatementFake{row: row}, outsider, "acme")
		require.NoError(t, err)
		require.Equal(t, row.Organization, org)
		require.Equal(t, tc.want, membership)
	}

	cause := errors.New("database unavailable")
	_, _, err := resolveOrgForViewer(ctx, &orgStatementFake{err: cause}, outsider, "acme")
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, 500, apiErr.Status)
	require.Same(t, cause, apiErr.Cause())

	blank := &orgStatementFake{}
	_, _, err = resolveOrgForViewer(ctx, blank, outsider, " \t")
	require.Contains(t, orgScopedErrorResponse(t, err), "400 ")
	require.Empty(t, blank.calls)
}

// orgNotFoundResponse is the exact answer for a name that does not exist.
const orgNotFoundResponse = "404 {\"code\":\"not_found\",\"fault\":\"user\",\"message\":\"organization not found\"}\n"

type recordingOrgDispatcher struct{ events int }

func (d *recordingOrgDispatcher) DispatchEvent(context.Context, int64, webhooks.EventType, any) error {
	d.events++
	return nil
}

func (d *recordingOrgDispatcher) DispatchOrgEvent(context.Context, int64, webhooks.EventType, any) error {
	d.events++
	return nil
}

// orgScopedState fingerprints every table an organization-scoped write could
// touch, so a refused call is proven to have changed nothing.
func orgScopedState(t *testing.T, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) map[string]string {
	t.Helper()
	state := map[string]string{}
	for _, table := range []string{
		"organizations", "org_members", "teams", "team_members", "team_repos", "repositories",
		"repository_storage_operations", "organization_secrets", "organization_variables", "changesets",
		"changeset_members", "provider_connections", "billing_accounts", "webhook_deliveries", "revocation_events",
	} {
		var digest string
		require.NoError(t, pool.QueryRow(context.Background(), `SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM `+table+` t`).Scan(&digest))
		state[table] = digest
	}
	return state
}

// Every organization-scoped service path, read or write, answers a caller who
// may not see a private organization exactly as it answers a name that does
// not exist (plue#542): visibility is decided before agent restrictions,
// input validation, and any side effect. Members keep their reads.
func TestOrgScopedPaths_PrivateOrganizationMatchesMissing_PostgreSQL(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	users := map[string]*db.User{}
	for _, u := range []struct{ name, kind string }{{"hidden-owner", "user"}, {"hidden-member", "user"}, {"hidden-outsider", "user"}, {"hidden-robot", "bot"}} {
		user := &db.User{Username: u.name, LowerUsername: u.name, UserType: u.kind}
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username, user_type) VALUES ($1, $1, $2) RETURNING id`, u.name, u.kind).Scan(&user.ID))
		users[u.name] = user
	}
	owner, member, outsider, robot := users["hidden-owner"], users["hidden-member"], users["hidden-outsider"], users["hidden-robot"]

	dispatched := &recordingOrgDispatcher{}
	orgs := NewOrgServiceWithPool(q, pool, WithOrgWebhookDispatcher(dispatched))
	org, err := orgs.CreateOrg(ctx, owner, CreateOrgRequest{Name: "hidden"})
	require.NoError(t, err)
	require.Equal(t, "private", org.Visibility)
	_, err = q.AddOrgMember(ctx, db.AddOrgMemberParams{OrganizationID: org.ID, UserID: member.ID, Role: "member"})
	require.NoError(t, err)
	_, err = orgs.CreateTeam(ctx, owner, "hidden", CreateTeamRequest{Name: "core"})
	require.NoError(t, err)
	require.NoError(t, orgs.AddTeamMember(ctx, owner, "hidden", "core", member.Username))

	secrets := NewSecretService(q, nil)
	variables := NewVariableService(q)
	_, err = secrets.SetOrgSecret(ctx, owner, "hidden", "API_TOKEN", "value", nil)
	require.NoError(t, err)
	_, err = variables.SetOrgVariable(ctx, owner, "hidden", "REGION", "iad")
	require.NoError(t, err)
	changesets := NewChangesetService(q, nil, nil, pool)
	connections := NewProviderConnectionService(q, nil, nil, WithSubscriptionConnectionsEnabled(true))
	repos := NewRepoService(q, nil, "")
	billing := NewBillingService(q, nil, BillingServiceConfig{})

	type path struct {
		name string
		// anonymous is the status an anonymous caller gets for both names.
		anonymous int
		// reader is the least-privileged caller entitled to a successful read;
		// nil for writes and for reads whose success needs more fixtures.
		reader *db.User
		call   func(viewer *db.User, orgName string) error
	}
	ignore := func(_ any, err error) error { return err }
	ignore2 := func(_, _ any, err error) error { return err }
	paths := []path{
		{"GetOrg", 404, member, func(v *db.User, o string) error { return ignore(orgs.GetOrg(ctx, v, o)) }},
		{"ListOrgRepos", 404, member, func(v *db.User, o string) error { return ignore2(orgs.ListOrgRepos(ctx, v, o, 1, 30)) }},
		{"ListOrgMembers", 401, member, func(v *db.User, o string) error { return ignore2(orgs.ListOrgMembers(ctx, v, o, 1, 30)) }},
		{"ListOrgTeams", 401, member, func(v *db.User, o string) error { return ignore2(orgs.ListOrgTeams(ctx, v, o, 1, 30)) }},
		{"GetTeam", 401, member, func(v *db.User, o string) error { return ignore(orgs.GetTeam(ctx, v, o, "core")) }},
		{"ListTeamMembers", 401, member, func(v *db.User, o string) error { return ignore2(orgs.ListTeamMembers(ctx, v, o, "core", 1, 30)) }},
		{"ListTeamRepos", 401, member, func(v *db.User, o string) error { return ignore2(orgs.ListTeamRepos(ctx, v, o, "core", 1, 30)) }},
		{"ListOrgSecrets", 401, owner, func(v *db.User, o string) error { return ignore(secrets.ListOrgSecrets(ctx, v, o)) }},
		{"ListOrgVariables", 401, owner, func(v *db.User, o string) error { return ignore(variables.ListOrgVariables(ctx, v, o)) }},
		{"ListChangesets", 401, member, func(v *db.User, o string) error { return ignore(changesets.ListChangesets(ctx, v, o, 1, 30)) }},
		{"GetChangeset", 401, nil, func(v *db.User, o string) error { return ignore(changesets.GetChangeset(ctx, v, o, 1)) }},
		{"ListOrgProviderConnections", 401, member, func(v *db.User, o string) error { return ignore(connections.ListForOrg(ctx, v, o)) }},
		{"GetOrgBilling", 401, nil, func(v *db.User, o string) error { return ignore(billing.GetOrgOverview(ctx, v, o)) }},

		{"UpdateOrg", 401, nil, func(v *db.User, o string) error {
			return ignore(orgs.UpdateOrg(ctx, v, o, UpdateOrgRequest{Description: "changed"}))
		}},
		{"UpdateOrg invalid visibility", 401, nil, func(v *db.User, o string) error {
			return ignore(orgs.UpdateOrg(ctx, v, o, UpdateOrgRequest{Visibility: "secret"}))
		}},
		{"AddOrgMember", 401, nil, func(v *db.User, o string) error { return orgs.AddOrgMember(ctx, v, o, outsider.ID, "member") }},
		{"RemoveOrgMember", 401, nil, func(v *db.User, o string) error { return orgs.RemoveOrgMember(ctx, v, o, member.Username) }},
		{"CreateTeam", 401, nil, func(v *db.User, o string) error {
			return ignore(orgs.CreateTeam(ctx, v, o, CreateTeamRequest{Name: "intruders"}))
		}},
		{"UpdateTeam", 401, nil, func(v *db.User, o string) error {
			return ignore(orgs.UpdateTeam(ctx, v, o, "core", UpdateTeamRequest{Description: "changed"}))
		}},
		{"DeleteTeam", 401, nil, func(v *db.User, o string) error { return orgs.DeleteTeam(ctx, v, o, "core") }},
		{"AddTeamMember", 401, nil, func(v *db.User, o string) error { return orgs.AddTeamMember(ctx, v, o, "core", outsider.Username) }},
		{"RemoveTeamMember", 401, nil, func(v *db.User, o string) error { return orgs.RemoveTeamMember(ctx, v, o, "core", member.Username) }},
		{"AddTeamRepo", 401, nil, func(v *db.User, o string) error { return orgs.AddTeamRepo(ctx, v, o, "core", o, "repo") }},
		{"RemoveTeamRepo", 401, nil, func(v *db.User, o string) error { return orgs.RemoveTeamRepo(ctx, v, o, "core", o, "repo") }},
		{"SetOrgSecret", 401, nil, func(v *db.User, o string) error {
			return ignore(secrets.SetOrgSecret(ctx, v, o, "API_TOKEN", "stolen", nil))
		}},
		{"SetOrgSecret invalid name", 401, nil, func(v *db.User, o string) error {
			return ignore(secrets.SetOrgSecret(ctx, v, o, "1 bad", "", nil))
		}},
		{"DeleteOrgSecret", 401, nil, func(v *db.User, o string) error { return secrets.DeleteOrgSecret(ctx, v, o, "API_TOKEN") }},
		{"SetOrgVariable", 401, nil, func(v *db.User, o string) error {
			return ignore(variables.SetOrgVariable(ctx, v, o, "REGION", "stolen"))
		}},
		{"SetOrgVariable invalid name", 401, nil, func(v *db.User, o string) error {
			return ignore(variables.SetOrgVariable(ctx, v, o, "1 bad", ""))
		}},
		{"DeleteOrgVariable", 401, nil, func(v *db.User, o string) error { return variables.DeleteOrgVariable(ctx, v, o, "REGION") }},
		{"CreateChangeset", 401, nil, func(v *db.User, o string) error {
			return ignore(changesets.CreateChangeset(ctx, v, o, CreateChangesetInput{Description: "x"}))
		}},
		{"LandChangeset", 401, nil, func(v *db.User, o string) error { return ignore(changesets.LandChangeset(ctx, v, o, 1)) }},
		{"AuthorizeChangesetRevert", 401, nil, func(v *db.User, o string) error {
			return changesets.AuthorizeChangesetRevert(ctx, v, o, nil)
		}},
		{"ConnectOrgProvider", 401, nil, func(v *db.User, o string) error {
			return ignore(connections.ConnectForOrg(ctx, v, o, ConnectProviderInput{}))
		}},
		{"CreateOrgRepo", 401, nil, func(v *db.User, o string) error {
			return ignore(repos.CreateOrgRepo(ctx, v, o, "intruder", "", false, "main", false))
		}},
		{"CreateOrgRepo invalid name", 401, nil, func(v *db.User, o string) error {
			return ignore(repos.CreateOrgRepo(ctx, v, o, "../bad", "", false, "main", false))
		}},
		{"OrgBillingCheckout", 401, nil, func(v *db.User, o string) error {
			return ignore(billing.CreateOrgCheckout(ctx, v, o, "team", "monthly"))
		}},
		{"OrgBillingPortal", 401, nil, func(v *db.User, o string) error { return ignore(billing.CreateOrgPortal(ctx, v, o)) }},
		{"OrgBillingRefresh", 401, nil, func(v *db.User, o string) error { return ignore(billing.RefreshOrgBilling(ctx, v, o)) }},
	}
	before := orgScopedState(t, pool)
	dispatched.events = 0
	for _, p := range paths {
		t.Run(p.name, func(t *testing.T) {
			for _, viewer := range []*db.User{nil, outsider, robot} {
				missing := orgScopedErrorResponse(t, p.call(viewer, "absent"))
				hidden := orgScopedErrorResponse(t, p.call(viewer, "hidden"))
				require.Equal(t, missing, hidden, "viewer=%v", viewer)
				if viewer != nil {
					require.Equal(t, orgNotFoundResponse, hidden, viewer.Username)
				} else if p.anonymous == 404 {
					require.Equal(t, orgNotFoundResponse, hidden)
				} else {
					require.Contains(t, hidden, fmt.Sprintf("%d ", p.anonymous))
				}
			}
		})
	}
	require.Equal(t, before, orgScopedState(t, pool), "a refused call changed state")
	require.Zero(t, dispatched.events, "a refused call dispatched a webhook")

	for _, p := range paths {
		if p.reader != nil {
			require.NoError(t, p.call(p.reader, "hidden"), p.name)
		}
	}
	// Membership is the only thing the visibility check grants; a member who
	// may see the organization still gets the owner-only 403 it always got.
	_, err = secrets.ListOrgSecrets(ctx, member, "hidden")
	require.Contains(t, orgScopedErrorResponse(t, err), "403 ")
	err = orgs.AddOrgMember(ctx, member, "hidden", outsider.ID, "member")
	require.Contains(t, orgScopedErrorResponse(t, err), "403 ")
	_, err = billing.GetOrgOverview(ctx, member, "hidden")
	require.Contains(t, orgScopedErrorResponse(t, err), "403 ")
}

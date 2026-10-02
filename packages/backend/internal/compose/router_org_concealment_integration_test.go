package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

type concealmentDispatcher struct{ events int }

func (d *concealmentDispatcher) DispatchEvent(context.Context, int64, webhooks.EventType, any) error {
	d.events++
	return nil
}

func (d *concealmentDispatcher) DispatchOrgEvent(context.Context, int64, webhooks.EventType, any) error {
	d.events++
	return nil
}

// Every organization route the router mounts answers a caller who may not see
// a private organization exactly as it answers a missing name: status, body,
// content type, and pagination headers, with no state change (plue#542).
func TestRouterPrivateOrganizationRoutesMatchMissingPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	newUser := func(name string) db.User {
		user, err := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name, DisplayName: name})
		require.NoError(t, err)
		return user
	}
	owner, member, outsider := newUser("conceal-owner"), newUser("conceal-member"), newUser("conceal-outsider")
	org, err := q.CreateOrganization(ctx, db.CreateOrganizationParams{Name: "hidden", LowerName: "hidden", Visibility: "private"})
	require.NoError(t, err)
	for _, m := range []struct {
		id   int64
		role string
	}{{owner.ID, "owner"}, {member.ID, "member"}} {
		_, err = q.AddOrgMember(ctx, db.AddOrgMemberParams{OrganizationID: org.ID, UserID: m.id, Role: m.role})
		require.NoError(t, err)
	}
	_, err = q.CreateOrgRepo(ctx, db.CreateOrgRepoParams{OrgID: pgtype.Int8{Int64: org.ID, Valid: true}, Name: "inner", LowerName: "inner", DefaultBookmark: "main"})
	require.NoError(t, err)

	dispatched := &concealmentDispatcher{}
	orgService := services.NewOrgServiceWithPool(q, pool, services.WithOrgWebhookDispatcher(dispatched))
	_, err = orgService.CreateTeam(ctx, &owner, "hidden", services.CreateTeamRequest{Name: "core"})
	require.NoError(t, err)
	require.NoError(t, orgService.AddTeamMember(ctx, &owner, "hidden", "core", member.Username))
	secrets := services.NewSecretService(q, nil)
	_, err = secrets.SetOrgSecret(ctx, &owner, "hidden", "API_TOKEN", "value", nil)
	require.NoError(t, err)
	variables := services.NewVariableService(q)
	_, err = variables.SetOrgVariable(ctx, &owner, "hidden", "REGION", "iad")
	require.NoError(t, err)
	dispatched.events = 0

	cfg := testConfigAllFlagsOn()
	cfg.FeatureFlags.SubscriptionConnections = true
	router := buildRouter(
		cfg, q, pool,
		&routes.RepoHandler{Service: services.NewRepoService(q, nil, "")},
		nil, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, nil, &routes.LabelHandler{},
		&routes.OrgHandler{Service: orgService},
		&routes.LandingHandler{},
		nil, nil,
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil,
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil,
		&routes.SecretHandler{Service: secrets},
		&routes.ProviderConnectionHandler{Service: services.NewProviderConnectionService(q, nil, nil, services.WithSubscriptionConnectionsEnabled(true))},
		&routes.VariableHandler{Service: variables},
		&routes.BillingHandler{Service: services.NewBillingService(q, nil, services.BillingServiceConfig{})},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, nil, nil,
		routerExtras{BillingCapabilities: services.BillingCapabilities{Overview: true, Checkout: true, Portal: true}},
	)

	tokenFor := func(user db.User, name string) string {
		sum := sha256.Sum256([]byte(name))
		token := "smithers_" + hex.EncodeToString(sum[:])[:40]
		hash := sha256.Sum256([]byte(token))
		digest := hex.EncodeToString(hash[:])
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: user.ID, Name: name, TokenHash: digest, TokenLastEight: digest[len(digest)-8:],
			Scopes:    "read:organization,write:organization,read:repository,write:repository,read:user,write:user",
			ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		return token
	}
	sessionFor := func(user db.User, name string) string {
		hash := sha256.Sum256([]byte(name))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: user.ID, Username: user.Username, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return name
	}
	type caller struct{ token, session string }
	do := func(c caller, method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if c.token != "" {
			req.Header.Set("Authorization", "Bearer "+c.token)
		}
		if c.session != "" {
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: c.session})
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	const notFound = `{"code":"not_found","fault":"user","message":"organization not found"}`
	type route struct {
		method, path, body string
		publicRead         bool // anonymous callers reach the service
		memberReads        bool // a member gets 200
	}
	orgRoutes := []route{
		{"GET", "/api/orgs/%s", "", true, true},
		{"GET", "/api/orgs/%s/repos?page=1&per_page=1", "", true, true},
		{"PATCH", "/api/orgs/%s", `{"description":"changed"}`, false, false},
		{"POST", "/api/orgs/%s/repos", `{"name":"intruder"}`, false, false},
		{"GET", "/api/orgs/%s/members?page=1&per_page=1", "", false, true},
		{"POST", "/api/orgs/%s/members", fmt.Sprintf(`{"user_id":%d,"role":"member"}`, outsider.ID), false, false},
		{"DELETE", "/api/orgs/%s/members/conceal-member", "", false, false},
		{"GET", "/api/orgs/%s/teams?page=1&per_page=1", "", false, true},
		{"POST", "/api/orgs/%s/teams", `{"name":"intruders"}`, false, false},
		{"GET", "/api/orgs/%s/teams/core", "", false, true},
		{"PATCH", "/api/orgs/%s/teams/core", `{"description":"changed"}`, false, false},
		{"DELETE", "/api/orgs/%s/teams/core", "", false, false},
		{"GET", "/api/orgs/%s/teams/core/members?page=1&per_page=1", "", false, true},
		{"PUT", "/api/orgs/%s/teams/core/members/conceal-outsider", "", false, false},
		{"DELETE", "/api/orgs/%s/teams/core/members/conceal-member", "", false, false},
		{"GET", "/api/orgs/%s/teams/core/repos?page=1&per_page=1", "", false, true},
		{"PUT", "/api/orgs/%s/teams/core/repos/hidden/inner", "", false, false},
		{"DELETE", "/api/orgs/%s/teams/core/repos/hidden/inner", "", false, false},
		{"GET", "/api/orgs/%s/secrets", "", false, false},
		{"POST", "/api/orgs/%s/secrets", `{"name":"API_TOKEN","value":"stolen"}`, false, false},
		{"DELETE", "/api/orgs/%s/secrets/API_TOKEN", "", false, false},
		{"GET", "/api/orgs/%s/variables", "", false, false},
		{"POST", "/api/orgs/%s/variables", `{"name":"REGION","value":"stolen"}`, false, false},
		{"DELETE", "/api/orgs/%s/variables/REGION", "", false, false},
		{"GET", "/api/orgs/%s/provider-connections", "", false, true},
		{"POST", "/api/orgs/%s/provider-connections", `{}`, false, false},
		{"GET", "/api/orgs/%s/billing", "", false, false},
		{"POST", "/api/orgs/%s/billing/checkout", `{"plan":"team","interval":"monthly"}`, false, false},
		{"POST", "/api/orgs/%s/billing/portal", "", false, false},
		{"POST", "/api/orgs/%s/billing/refresh", "", false, false},
	}
	stateTables := []string{"organizations", "org_members", "teams", "team_members", "team_repos", "repositories",
		"repository_storage_operations", "organization_secrets", "organization_variables", "changesets",
		"provider_connections", "billing_accounts", "webhook_deliveries", "revocation_events"}
	state := func() map[string]string {
		out := map[string]string{}
		for _, table := range stateTables {
			var digest string
			require.NoError(t, pool.QueryRow(ctx, `SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM `+table+` t`).Scan(&digest))
			out[table] = digest
		}
		return out
	}

	outsiderToken := tokenFor(outsider, "conceal-outsider-token")
	outsiderSession := sessionFor(outsider, "conceal-outsider-session")
	before := state()
	for _, rt := range orgRoutes {
		for name, c := range map[string]caller{"anonymous": {}, "outsider-token": {token: outsiderToken}, "outsider-session": {session: outsiderSession}} {
			if c.session != "" && rt.method != "GET" {
				continue // session writes stop at CSRF; tokens cover the writes
			}
			t.Run(rt.method+" "+rt.path+" "+name, func(t *testing.T) {
				absent := do(c, rt.method, fmt.Sprintf(rt.path, "absent"), rt.body)
				hidden := do(c, rt.method, fmt.Sprintf(rt.path, "hidden"), rt.body)
				require.Equal(t, absent.Code, hidden.Code, hidden.Body.String())
				require.Equal(t, absent.Body.String(), hidden.Body.String())
				for _, header := range []string{"Content-Type", "Link", "X-Total-Count"} {
					require.Equal(t, absent.Header().Values(header), hidden.Header().Values(header), header)
				}
				if name == "anonymous" && !rt.publicRead {
					require.Equal(t, http.StatusUnauthorized, hidden.Code, hidden.Body.String())
					return
				}
				require.Equal(t, http.StatusNotFound, hidden.Code, hidden.Body.String())
				require.JSONEq(t, notFound, hidden.Body.String())
			})
		}
	}
	require.Equal(t, before, state(), "a concealed request changed state")
	require.Zero(t, dispatched.events, "a concealed request dispatched a webhook")

	memberToken := tokenFor(member, "conceal-member-token")
	for _, rt := range orgRoutes {
		if rt.memberReads {
			rec := do(caller{token: memberToken}, rt.method, fmt.Sprintf(rt.path, "hidden"), rt.body)
			require.Equal(t, http.StatusOK, rec.Code, rt.path+": "+rec.Body.String())
		}
	}
	ownerToken := tokenFor(owner, "conceal-owner-token")
	for _, path := range []string{"/api/orgs/hidden/secrets", "/api/orgs/hidden/variables"} {
		rec := do(caller{token: ownerToken}, "GET", path, "")
		require.Equal(t, http.StatusOK, rec.Code, path+": "+rec.Body.String())
	}
}

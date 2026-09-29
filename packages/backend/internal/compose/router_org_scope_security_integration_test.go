package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// Use the actual assembled router, auth loader, OrgService and product SQL.
// A restricted PAT sees the anonymous view, even when its owner is a member.
func TestRouterOrganizationReadsRespectTokenScopePostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "org-owner", LowerUsername: "org-owner", DisplayName: "Org owner"})
	require.NoError(t, err)
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "org-member", LowerUsername: "org-member", DisplayName: "Org member"})
	require.NoError(t, err)
	outsider, err := q.CreateUser(ctx, db.CreateUserParams{Username: "org-outsider", LowerUsername: "org-outsider", DisplayName: "Outsider"})
	require.NoError(t, err)
	for _, visibility := range []string{"public", "private"} {
		org, err := q.CreateOrganization(ctx, db.CreateOrganizationParams{Name: visibility, LowerName: visibility, Visibility: visibility})
		require.NoError(t, err)
		_, err = q.AddOrgMember(ctx, db.AddOrgMemberParams{OrganizationID: org.ID, UserID: owner.ID, Role: "owner"})
		require.NoError(t, err)
		_, err = q.AddOrgMember(ctx, db.AddOrgMemberParams{OrganizationID: org.ID, UserID: member.ID, Role: "member"})
		require.NoError(t, err)
		for _, public := range []bool{true, false} {
			name := "member-only"
			if public {
				name = "public-repo"
			}
			_, err = q.CreateOrgRepo(ctx, db.CreateOrgRepoParams{OrgID: pgtype.Int8{Int64: org.ID, Valid: true}, Name: name, LowerName: name, IsPublic: public, DefaultBookmark: "main"})
			require.NoError(t, err)
		}
	}
	router := buildRouterCompat(
		testConfigAllFlagsOn(),  // cfg
		q,                       // queries
		pool,                    // pool
		&routes.RepoHandler{},   // repoHandler
		&routes.AuthHandler{},   // authHandler
		&routes.UserHandler{},   // userHandler
		&routes.SSHKeyHandler{}, // sshKeyHandler
		&routes.LabelHandler{},  // labelHandler
		&routes.OrgHandler{Service: services.NewOrgServiceWithPool(q, pool)}, // orgHandler
		&routes.LandingHandler{},                                   // landingHandler
		&routes.SearchHandler{Service: &mockRouterSearchService{}}, // searchHandler
		&routes.IssueHandler{},                                     // issueHandler
		nil,                                                        // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}}, // gitHandler
		nil, // notificationHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminRepoHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)
	newToken := func(userID int64, name, scopes string) string {
		sum := sha256.Sum256([]byte(name))
		token := "smithers_" + hex.EncodeToString(sum[:])[:40]
		hash := sha256.Sum256([]byte(token))
		hashString := hex.EncodeToString(hash[:])
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: userID, Name: name, TokenHash: hashString, TokenLastEight: hashString[len(hashString)-8:], Scopes: scopes, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		return token
	}
	for _, tc := range []struct {
		name, scopes   string
		user           db.User
		session        bool
		canReadPrivate bool
	}{
		{name: "anonymous"},
		{name: "owner-read-user", scopes: "read:user", user: owner},
		{name: "owner-scopeless", user: owner},
		{name: "owner-repo-bound", scopes: "read:organization,repo:1", user: owner},
		{name: "owner-org-reader", scopes: "read:organization", user: owner, canReadPrivate: true},
		{name: "member-org-reader", scopes: "read:organization", user: member, canReadPrivate: true},
		{name: "outsider-org-reader", scopes: "read:organization", user: outsider},
		{name: "owner-session", user: owner, session: true, canReadPrivate: true},
		{name: "member-session", user: member, session: true, canReadPrivate: true},
		{name: "outsider-session", user: outsider, session: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token, session := "", ""
			if tc.session {
				session = "org-session-" + tc.name
				hash := sha256.Sum256([]byte(session))
				_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: tc.user.ID, Username: tc.user.Username, ExpiresAt: time.Now().Add(time.Hour)})
				require.NoError(t, err)
			} else if tc.user.ID != 0 {
				token = newToken(tc.user.ID, tc.name, tc.scopes)
			}
			request := func(path string) *httptest.ResponseRecorder {
				req := httptest.NewRequest(http.MethodGet, path, nil)
				if token != "" {
					req.Header.Set("Authorization", "Bearer "+token)
				}
				if session != "" {
					req.AddCookie(&http.Cookie{Name: "smithers_session", Value: session})
				}
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, req)
				return rec
			}
			missing := request("/api/orgs/missing")
			require.Equal(t, http.StatusNotFound, missing.Code, missing.Body.String())
			require.JSONEq(t, `{"code":"not_found","fault":"user","message":"organization not found"}`, missing.Body.String())
			rec := request("/api/orgs/private")
			if tc.canReadPrivate {
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
				var org db.Organization
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &org))
				require.Equal(t, "private", org.Name)
				require.Equal(t, "private", org.Visibility)
			} else {
				require.Equal(t, missing.Code, rec.Code, rec.Body.String())
				require.Equal(t, missing.Body.String(), rec.Body.String())
				require.Equal(t, missing.Header().Get("Content-Type"), rec.Header().Get("Content-Type"))
			}
			// This subresource retains its current membership-denial contract.
			rec = request("/api/orgs/private/repos")
			if tc.canReadPrivate {
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
				var repos []routes.RepoResponse
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &repos))
				require.Len(t, repos, 2)
			} else {
				require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
			}
			rec = request("/api/orgs/public")
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			var org db.Organization
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &org))
			require.Equal(t, "public", org.Visibility)
			rec = request("/api/orgs/public/repos")
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			var repos []routes.RepoResponse
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &repos))
			expectedCount := 1
			if tc.canReadPrivate {
				expectedCount = 2
			}
			require.Len(t, repos, expectedCount, rec.Body.String())
			if !tc.canReadPrivate {
				require.Equal(t, "public-repo", repos[0].Name)
			}
		})
	}

	t.Run("create without visibility", func(t *testing.T) {
		token := newToken(owner.ID, "create-private-default", "write:organization")
		req := httptest.NewRequest(http.MethodPost, "/api/orgs", strings.NewReader(`{"name":"default-private","description":"Created over HTTP"}`))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
		var created db.Organization
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
		require.Equal(t, "private", created.Visibility)
		persisted, err := q.GetOrgByLowerName(ctx, "default-private")
		require.NoError(t, err)
		require.Equal(t, created.ID, persisted.ID)
		require.Equal(t, "private", persisted.Visibility)
		membership, err := q.GetOrgMember(ctx, db.GetOrgMemberParams{OrganizationID: created.ID, UserID: owner.ID})
		require.NoError(t, err)
		require.Equal(t, "owner", membership.Role)
		anonymous := httptest.NewRecorder()
		router.ServeHTTP(anonymous, httptest.NewRequest(http.MethodGet, "/api/orgs/default-private", nil))
		require.Equal(t, http.StatusNotFound, anonymous.Code, anonymous.Body.String())
		require.JSONEq(t, `{"code":"not_found","fault":"user","message":"organization not found"}`, anonymous.Body.String())
	})
}

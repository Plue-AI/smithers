package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Exercise actual HTTP authentication, repository middleware, service and SQL.
func TestWikiProductRouterPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "wiki-owner", LowerUsername: "wiki-owner"})
	require.NoError(t, err)
	outsider, err := q.CreateUser(ctx, db.CreateUserParams{Username: "wiki-outsider", LowerUsername: "wiki-outsider"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "wiki", LowerName: "wiki", IsPublic: true, DefaultBookmark: "main"})
	require.NoError(t, err)
	token := func(user db.User, scope string) string {
		value := fmt.Sprintf("smithers_%040x", user.ID*100+int64(len(scope)))
		digest := sha256.Sum256([]byte(value))
		hash := hex.EncodeToString(digest[:])
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: user.ID, Name: scope, TokenHash: hash, TokenLastEight: hash[len(hash)-8:], Scopes: scope, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		return value
	}
	ownerToken, outsiderToken, restrictedToken := token(owner, "write:repository,read:repository"), token(outsider, "read:repository"), token(owner, "read:user")
	wikiService := services.NewWikiService(q, nil, services.WithWikiContent(blob.NewMemoryStore()), services.WithWikiCollaboration(q, nil))
	router := buildRouterCompat(
		testConfigAllFlagsOn(),
		q,
		pool, // pool
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		wikiService,
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
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
	request := func(method, suffix, auth, body, media string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/repos/wiki-owner/wiki/wiki"+suffix, strings.NewReader(body))
		if auth != "" {
			req.Header.Set("Authorization", "Bearer "+auth)
		}
		if media != "" {
			req.Header.Set("Content-Type", media)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	var privatePage services.WikiPageResponse
	for _, scope := range []string{"public", "private"} {
		rec := request("POST", "?visibility="+scope, ownerToken, `{"title":"Home","path":"Guides/Home.md","body":"`+scope+` [[Home#Section|alias]]"}`, "application/json")
		require.Equal(t, 201, rec.Code, rec.Body.String())
		if scope == "private" {
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &privatePage))
		}
	}
	for _, auth := range []string{"", outsiderToken, restrictedToken} {
		for _, suffix := range []string{"/home", "/navigation/index", "/history/events", "?q=private", "/home/revisions", "/home/document", fmt.Sprintf("/home/updates?page_id=%d", privatePage.ID), fmt.Sprintf("/home/stream?page_id=%d", privatePage.ID)} {
			separator := "?"
			if strings.Contains(suffix, "?") {
				separator = "&"
			}
			rec := request("GET", suffix+separator+"visibility=private", auth, "", "")
			require.True(t, rec.Code == 403 || rec.Code == 401, "%s: %d %s", suffix, rec.Code, rec.Body.String())
			require.NotContains(t, rec.Body.String(), "private [[Home")
			if auth == outsiderToken && rec.Code == 403 {
				// A readable repository's private space refuses with its own code.
				require.Contains(t, rec.Body.String(), `"code":"wiki_space_unreadable"`, suffix)
			}
		}
	}
	rec := request("GET", "/home", "", "", "")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "public [[Home")
	require.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
	rec = request("GET", "/navigation/index?visibility=private", ownerToken, "", "")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var index services.WikiIndex
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &index))
	require.Len(t, index.Pages, 1)
	require.Len(t, index.Pages[0].Backlinks, 1)
	rec = request("GET", "/home?visibility=bogus", ownerToken, "", "")
	require.Equal(t, 400, rec.Code)
	// New collection routes must not shadow previously valid page slugs.
	for _, slug := range []string{"index", "events", "history", "navigation"} {
		rec = request("POST", "", ownerToken, `{"title":"`+slug+`","body":"page"}`, "application/json")
		require.Equal(t, 201, rec.Code, rec.Body.String())
		rec = request("GET", "/"+slug, "", "", "")
		require.Equal(t, 200, rec.Code, rec.Body.String())
		require.Contains(t, rec.Body.String(), `"body":"page"`)
	}
	payload := "<svg onload='alert(1)'></svg>"
	rec = request("PUT", "/attachments/image?visibility=private&path=assets/image.svg&expected_revision=0", ownerToken, payload, "image/svg+xml")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var file services.WikiPageResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &file))
	contentPath := fmt.Sprintf("/history/%d/1/content", file.ID)
	for _, tc := range []struct {
		scope, auth string
		status      int
	}{{"public", ownerToken, 404}, {"private", outsiderToken, 403}, {"private", ownerToken, 200}} {
		rec = request("GET", contentPath+"?visibility="+tc.scope, tc.auth, "", "")
		require.Equal(t, tc.status, rec.Code, rec.Body.String())
		if tc.status == 200 {
			require.Equal(t, payload, rec.Body.String())
			require.Contains(t, rec.Header().Get("Content-Disposition"), "attachment")
			require.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"))
			require.Contains(t, rec.Header().Get("Content-Security-Policy"), "sandbox")
		}
	}
	rec = request("PUT", "/attachments/image?visibility=private&path=assets/image.svg&expected_revision=0", ownerToken, payload, "image/svg+xml")
	require.Equal(t, 409, rec.Code)
	rec = request("DELETE", "/image?visibility=private", ownerToken, "", "")
	require.Equal(t, 204, rec.Code, rec.Body.String())
	rec = request("GET", fmt.Sprintf("/history/%d?visibility=private", file.ID), ownerToken, "", "")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), `"deleted":true`)
	rec = request("GET", contentPath+"?visibility=private", ownerToken, "", "")
	require.Equal(t, 200, rec.Code)
	rec = request("GET", "/history/events?visibility=private", ownerToken, "", "")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var events []services.WikiEvent
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &events))
	require.Len(t, events, 3)
	// Binary uploads exceed the JSON group's 1 MiB cap, but retain write auth.
	large := strings.Repeat("x", (1<<20)+1)
	rec = request("PUT", "/attachments/large?path=large.bin&expected_revision=0", outsiderToken, large, "application/octet-stream")
	require.Equal(t, 403, rec.Code, rec.Body.String())
	rec = request("PUT", "/attachments/large?path=large.bin&expected_revision=0", ownerToken, large, "application/octet-stream")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	// Making the repository private also hides its public wiki.
	_, err = pool.Exec(ctx, `UPDATE repositories SET is_public=false WHERE id=$1`, repo.ID)
	require.NoError(t, err)
	rec = request("GET", "/home", "", "", "")
	require.NotEqual(t, 200, rec.Code)
	// A private repository never names its private space to an outsider.
	rec = request("GET", "/navigation/index?visibility=private", outsiderToken, "", "")
	require.NotEqual(t, 200, rec.Code)
	require.NotContains(t, rec.Body.String(), "wiki_space_unreadable")
}

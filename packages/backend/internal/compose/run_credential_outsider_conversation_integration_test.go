package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// A run started from an outsider's approved text works from the pinned copy
// in its inputs. Through the assembled router, its box's run credentials read
// no issue, comment or landing conversation of the repository; a
// maintainer-started run's credential and the owner's own token still do.
func TestOutsiderRunCredentialReadsNoConversationPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "pinned-owner", LowerUsername: "pinned-owner", DisplayName: "Pinned owner"})
	require.NoError(t, err)
	repoID := ciTestRepo(t, pool, owner.ID, "app")
	_, err = pool.Exec(ctx, `INSERT INTO issues(repository_id,number,title,body,author_id) VALUES($1,1,'approved title','live body',$2)`, repoID, owner.ID)
	require.NoError(t, err)
	landing, err := q.CreateLandingRequest(ctx, db.CreateLandingRequestParams{RepositoryID: repoID, Title: "change", AuthorID: owner.ID, TargetBookmark: "main", StackSize: 1})
	require.NoError(t, err)
	require.NoError(t, q.MarkOutsiderWorkspace(ctx, repoID, "ws-outsider"))

	token := func(name, scopes string, systemIssued bool) string {
		plaintext := "smithers_" + hex.EncodeToString([]byte(name + "-token-padding-bytes-xx"))[:40]
		sum := sha256.Sum256([]byte(plaintext))
		hash := hex.EncodeToString(sum[:])
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{
			UserID: owner.ID, Name: name, TokenHash: hash, TokenLastEight: hash[len(hash)-8:],
			SystemIssued: systemIssued, Scopes: scopes,
			ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
		})
		require.NoError(t, err)
		return plaintext
	}
	// The coding host's landing credential, as box_host.go mints it.
	landingScopes := func(workspace string) string {
		return string(middleware.ScopeWriteRepository) + "," + middleware.RepositoryRestrictionScope(repoID) + "," +
			middleware.LandingWorkspaceScope(workspace) + "," + middleware.PathRestrictionScopes([]string{"**"})[0]
	}
	outsiderRun := token("outsider-host", landingScopes("ws-outsider"), true)
	maintainerRun := token("maintainer-host", landingScopes("ws-maintainer"), true)
	person := token("owner-pat", string(middleware.ScopeWriteRepository), false)

	router := buildRouter(
		testConfigAllFlagsOn(), q, pool,
		&routes.RepoHandler{Service: services.NewRepoService(q, nil, "")},
		nil,
		&routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{},
		&routes.DeployKeyHandler{Service: services.NewDeployKeyService(q)},
		&routes.LabelHandler{}, &routes.OrgHandler{},
		&routes.LandingHandler{Service: services.NewLandingService(q, reviewTestRepoHost{})},
		nil, nil, nil,
		&routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{Service: services.NewIssueService(q)},
		nil,
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil,
		nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil,
		&routes.ProtectedBookmarkHandler{Service: services.NewProtectedBookmarkService(q)},
		nil, nil,
		&routes.JJVCSHandler{RepoResolver: q},
		&routes.AgentInternalHandler{},
		nil, nil,
		&routes.ApprovalsHandler{Enabled: true},
		nil, nil,
		nil, nil, nil,
		nil, nil, nil,
		&routes.RepositoryJobHandler{},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
	)
	serve := func(bearer, method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/repos/pinned-owner/app"+path, bytes.NewBufferString(body))
		req.Header.Set("Authorization", "Bearer "+bearer)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	landingPath := "/landings/" + strconv.FormatInt(landing.Number, 10)
	for _, read := range [][2]string{
		{http.MethodGet, "/issues"},
		{http.MethodGet, "/issues/1"},
		{http.MethodGet, "/issues/1/comments"},
		{http.MethodGet, "/issues/1/events"},
		{http.MethodPatch, "/issues/1"},
		{http.MethodPost, "/issues/1/comments"},
		{http.MethodGet, landingPath + "/comments"},
		{http.MethodGet, landingPath + "/reviews"},
	} {
		rec := serve(outsiderRun, read[0], read[1], `{}`)
		assert.Equal(t, http.StatusForbidden, rec.Code, "%v: %s", read, rec.Body.String())
		assert.NotContains(t, rec.Body.String(), "live body", "%v", read)
	}
	for _, bearer := range []string{maintainerRun, person} {
		rec := serve(bearer, http.MethodGet, "/issues/1", "")
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.Contains(t, rec.Body.String(), "live body")
		rec = serve(bearer, http.MethodGet, landingPath+"/comments", "")
		assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}
}

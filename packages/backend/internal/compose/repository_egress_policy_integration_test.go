package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// egressReloadSpy is the provider's live reload, recording each call.
type egressReloadSpy struct {
	mu    sync.Mutex
	calls map[string][]string
}

func (s *egressReloadSpy) ReloadEgress(_ context.Context, sandboxID string, req sandbox.EgressReloadRequest) (sandbox.EgressReloadResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls[sandboxID] = req.AllowDomains
	return sandbox.EgressReloadResult{SandboxID: sandboxID, AllowDomains: req.AllowDomains}, nil
}

// The composed router admits only the repository's owner to its egress
// allowlist: an admin collaborator and the owner's own run credential are
// refused before the service runs, and the owner's write reaches the
// running sandbox of the repository without a restart.
func TestRepositoryEgressPolicyRouteIsOwnerOnlyAndReloadsRunningSandboxesPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner", DisplayName: "Owner"})
	require.NoError(t, err)
	admin, err := q.CreateUser(ctx, db.CreateUserParams{Username: "admin", LowerUsername: "admin", DisplayName: "Admin"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators (repository_id, user_id, permission) VALUES ($1, $2, 'admin')`, repo.ID, admin.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO workspaces (id, repository_id, user_id, status, vm_id) VALUES ($1, $2, $3, 'running', 'vm-running')`, uuid.NewString(), repo.ID, owner.ID)
	require.NoError(t, err)

	token := func(user db.User, name, fill string, systemIssued bool) string {
		raw := "smithers_" + strings.Repeat(fill, 40)
		hash := sha256.Sum256([]byte(raw))
		digest := hex.EncodeToString(hash[:])
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: user.ID, Name: name, TokenHash: digest, TokenLastEight: digest[len(digest)-8:],
			Scopes: "write:repository", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}, SystemIssued: systemIssued})
		require.NoError(t, err)
		return raw
	}
	ownerToken := token(owner, "owner", "b", false)
	adminToken := token(admin, "admin", "a", false)
	runToken := token(owner, "run", "c", true)

	spy := &egressReloadSpy{calls: map[string][]string{}}
	egress := services.NewRepositoryEgressPolicyService(q, spy)
	router := buildRouterCompat(testConfigAllFlagsOn(), q, pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		routerExtras{EgressPolicy: &routes.RepositoryEgressPolicyHandler{Service: egress}})
	call := func(method, bearer, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/repos/owner/app/egress-policy", strings.NewReader(body))
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	put := `{"allow_domains":["Registry.Example.com","*.pkg.dev","registry.example.com"]}`

	require.Equal(t, http.StatusForbidden, call(http.MethodGet, adminToken, "").Code)
	require.Equal(t, http.StatusForbidden, call(http.MethodPut, adminToken, put).Code)
	// The owner's own run credential is capped below owner.
	require.Equal(t, http.StatusForbidden, call(http.MethodGet, runToken, "").Code)
	require.Equal(t, http.StatusForbidden, call(http.MethodPut, runToken, put).Code)
	require.Contains(t, []int{http.StatusUnauthorized, http.StatusNotFound}, call(http.MethodGet, "", "").Code, "anonymous")
	_, err = q.GetRepositoryEgressPolicy(ctx, repo.ID)
	require.Error(t, err, "a refused write stored a policy")
	require.Empty(t, spy.calls, "a refused write reached a sandbox")

	rec := call(http.MethodGet, ownerToken, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"allow_domains":[]}`, rec.Body.String())

	rec = call(http.MethodPut, ownerToken, put)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var update services.RepositoryEgressPolicyUpdate
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &update))
	require.Equal(t, []string{"*.pkg.dev", "registry.example.com"}, update.AllowDomains)
	require.Equal(t, []services.RepositoryEgressReload{{SandboxID: "vm-running", Reloaded: true}}, update.Reloads)
	require.Equal(t, map[string][]string{"vm-running": {"*.pkg.dev", "registry.example.com"}}, spy.calls)
	stored, err := q.GetRepositoryEgressPolicy(ctx, repo.ID)
	require.NoError(t, err)
	require.Equal(t, update.AllowDomains, stored.AllowDomains)
	require.Equal(t, owner.ID, stored.UpdatedBy.Int64)

	rec = call(http.MethodGet, ownerToken, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), `"allow_domains":["*.pkg.dev","registry.example.com"]`)

	for body, status := range map[string]int{
		`{}`:                                 http.StatusBadRequest,
		`{"allow_domains":["*"]}`:            http.StatusBadRequest,
		`{"allow_domains":["10.0.0.0/8"]}`:   http.StatusBadRequest,
		`{"allow_domains":[],"extra":true}`:  http.StatusBadRequest,
		`{"allow_domains":["a.example"]}{}`:  http.StatusBadRequest,
		`{"allow_domains":["https://x.io"]}`: http.StatusBadRequest,
	} {
		require.Equal(t, status, call(http.MethodPut, ownerToken, body).Code, body)
	}
	stored, err = q.GetRepositoryEgressPolicy(ctx, repo.ID)
	require.NoError(t, err)
	require.Equal(t, []string{"*.pkg.dev", "registry.example.com"}, stored.AllowDomains, "a refused body changed the policy")
}

package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The real router, token loader, repository checks and submission service run
// against PostgreSQL. A scope without its stored lane/item grants no authority.
// Real retained-source admission is covered by TestInstallCandidateAuthorizationPostgres.
func TestCodingDeliveryComposedCredentialBoundaryPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx, q := t.Context(), db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "delivery-owner", LowerUsername: "delivery-owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	other, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "other", LowerName: "other", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"delivery-owner","repository_name":"app","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339)))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: binding}))
	}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://127.0.0.1:4000"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: services.NewMythicalService(pool, nil)})
	const workspace = "11111111-1111-4111-8111-111111111111"
	const foreignWorkspace = "22222222-2222-4222-8222-222222222222"
	path := "/api/repos/delivery-owner/app/mythical/lanes"
	scopes := strings.Join([]string{"write:repository", middleware.RepositoryRestrictionScope(repo.ID), middleware.LandingWorkspaceScope(workspace), middleware.PathRestrictionScopes([]string{"**"})[0]}, ",")
	for i, tc := range []struct {
		name, scopes, method, path, workspace string
		system, expired                       bool
		want                                  int
	}{
		{"unstored delivery binding", scopes, "PUT", path, workspace, true, false, 403},
		{"another workspace", scopes, "PUT", path, foreignWorkspace, true, false, 403},
		{"another repository door", scopes, "PUT", "/api/repos/delivery-owner/other/mythical/lanes", workspace, true, false, 403},
		// The command authorizer rejects a foreign grant before resolving the route repository.
		{"another repository grant", strings.Replace(scopes, middleware.RepositoryRestrictionScope(repo.ID), middleware.RepositoryRestrictionScope(other.ID), 1), "PUT", path, workspace, true, false, 403},
		{"personal token cannot mint binding", scopes, "PUT", path, workspace, false, false, 401},
		{"delegated token", scopes + ",via:codex", "PUT", path, workspace, true, false, 403},
		{"sync token", scopes + ",credential:sync", "PUT", path, workspace, true, false, 403},
		{"no repository binding", strings.Replace(scopes, middleware.RepositoryRestrictionScope(repo.ID), "", 1), "PUT", path, workspace, true, false, 403},
		{"no workspace binding", strings.Replace(scopes, middleware.LandingWorkspaceScope(workspace), "", 1), "PUT", path, workspace, true, false, 403},
		{"narrow paths", strings.Replace(scopes, middleware.PathRestrictionScopes([]string{"**"})[0], middleware.PathRestrictionScopes([]string{"docs"})[0], 1), "PUT", path, workspace, true, false, 403},
		{"read-only grant", strings.Replace(scopes, "write:repository", "read:repository", 1), "PUT", path, workspace, true, false, 403},
		{"wrong method", scopes, "POST", path, workspace, true, false, 403},
		{"unrelated owner write", scopes, "POST", "/api/repos/delivery-owner/app/archive", workspace, true, false, 403},
		{"expired grant", scopes, "PUT", path, workspace, true, true, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := fmt.Sprintf("smithers_%040x", i+1)
			sum := sha256.Sum256([]byte(raw))
			hash := hex.EncodeToString(sum[:])
			expires := time.Now().Add(time.Hour)
			if tc.expired {
				expires = time.Now().Add(-time.Hour)
			}
			_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: tc.name, TokenHash: hash, TokenLastEight: hash[len(hash)-8:], Scopes: tc.scopes, SystemIssued: tc.system, ExpiresAt: pgtype.Timestamptz{Time: expires, Valid: true}})
			require.NoError(t, err)
			body, err := json.Marshal(services.MythicalLaneSubmission{WorkspaceID: tc.workspace, Base: strings.Repeat("a", 40), Source: strings.Repeat("b", 40), RequestRunID: "request-1", Summary: "A result"})
			require.NoError(t, err)
			req := httptest.NewRequest(tc.method, cfg.Server.PublicURL+tc.path, strings.NewReader(string(body)))
			req.RemoteAddr = "127.0.0.1:50000"
			req.Header.Set("Authorization", "Bearer "+raw)
			req.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			require.Equal(t, tc.want, response.Code, response.Body.String())
			if tc.name == "unstored delivery binding" {
				require.Contains(t, response.Body.String(), `"code":"permission"`)
				_, err = pool.Exec(ctx, `DELETE FROM access_tokens WHERE token_hash=$1`, hash)
				require.NoError(t, err)
				again := httptest.NewRequest(tc.method, cfg.Server.PublicURL+tc.path, strings.NewReader(string(body)))
				again.RemoteAddr = req.RemoteAddr
				again.Header = req.Header.Clone()
				dead := httptest.NewRecorder()
				router.ServeHTTP(dead, again)
				require.Equal(t, 401, dead.Code, "revoked delivery: %s", dead.Body.String())
			}
			var items, approvals int
			require.NoError(t, pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM mythical_items), (SELECT count(*) FROM approvals)`).Scan(&items, &approvals))
			require.Zero(t, items)
			require.Zero(t, approvals)
		})
	}
}

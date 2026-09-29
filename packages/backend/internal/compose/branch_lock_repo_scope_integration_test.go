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
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// A holder who loses access to a private organization repository cannot
// decide its pending requests by routing the same ID through a repo they own.
func TestBranchLockDecisionRequiresRoutedRepositoryPostgres(t *testing.T) {
	for _, decision := range []string{"approve", "deny"} {
		t.Run(decision, func(t *testing.T) {
			pool, _ := postgresfixture.NewProductDatabase(t)
			ctx := context.Background()
			q := db.New(pool)
			owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner", DisplayName: "Owner"})
			require.NoError(t, err)
			holder, err := q.CreateUser(ctx, db.CreateUserParams{Username: "holder", LowerUsername: "holder", DisplayName: "Holder"})
			require.NoError(t, err)
			org, err := q.CreateOrganization(ctx, db.CreateOrganizationParams{Name: "acme", LowerName: "acme", Visibility: "private"})
			require.NoError(t, err)
			for _, member := range []db.User{owner, holder} {
				_, err = q.AddOrgMember(ctx, db.AddOrgMemberParams{OrganizationID: org.ID, UserID: member.ID, Role: "owner"})
				require.NoError(t, err)
			}
			repoA, err := q.CreateOrgRepo(ctx, db.CreateOrgRepoParams{OrgID: pgtype.Int8{Int64: org.ID, Valid: true}, Name: "private", LowerName: "private", DefaultBookmark: "main"})
			require.NoError(t, err)
			repoB, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: holder.ID, Valid: true}, Name: "other", LowerName: "other", DefaultBookmark: "main"})
			require.NoError(t, err)
			require.NotEqual(t, repoA.ID, repoB.ID)

			lockService := services.NewBranchLockService(q)
			_, err = lockService.AcquireBranchLock(ctx, services.AcquireBranchLockInput{RepositoryID: repoA.ID, Branch: "main", UserID: holder.ID})
			require.NoError(t, err)
			lock, err := q.GetBranchLock(ctx, db.GetBranchLockParams{RepositoryID: repoA.ID, Branch: "main"})
			require.NoError(t, err)
			newRequest := func() db.BranchLockJoinRequest {
				request, err := q.CreateBranchLockJoinRequest(ctx, db.CreateBranchLockJoinRequestParams{RepositoryID: repoA.ID, Branch: "main", RequesterID: owner.ID, LockGeneration: lock.Generation})
				require.NoError(t, err)
				return request
			}
			token := "smithers_" + strings.Repeat("a", 40)
			hash := sha256.Sum256([]byte(token))
			hashString := hex.EncodeToString(hash[:])
			_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: holder.ID, Name: "holder", TokenHash: hashString, TokenLastEight: hashString[len(hashString)-8:], Scopes: "write:repository", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
			require.NoError(t, err)
			router := buildRouterCompat(testConfigAllFlagsOn(), q, pool,
				&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
				&routes.OrgHandler{Service: services.NewOrgServiceWithPool(q, pool)}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
				nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
			nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
				&routes.BranchLockHandler{Service: lockService})
			post := func(path, id string) *httptest.ResponseRecorder {
				req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/repos/%s/branch-locks/join-requests/%s/decide", path, id), strings.NewReader(fmt.Sprintf(`{"decision":%q}`, decision)))
				req.Header.Set("Authorization", "Bearer "+token)
				req.Header.Set("Content-Type", "application/json")
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, req)
				return rec
			}
			ordinary := newRequest()
			rec := post("acme/private", fmt.Sprint(ordinary.ID))
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			persisted, err := q.GetBranchLockJoinRequest(ctx, ordinary.ID)
			require.NoError(t, err)
			expected := "approved"
			if decision == "deny" {
				expected = "denied"
			}
			require.Equal(t, expected, persisted.Status)

			pending := newRequest()
			require.NoError(t, services.NewOrgServiceWithPool(q, pool).RemoveOrgMember(ctx, &owner, "acme", "holder"))
			rec = post("acme/private", fmt.Sprint(pending.ID))
			require.Equal(t, http.StatusNotFound, rec.Code, "revoked member must not see private repository: %s", rec.Body.String())
			rec = post("holder/other", fmt.Sprint(pending.ID))
			require.Equal(t, http.StatusNotFound, rec.Code, "foreign URL must not resolve request: %s", rec.Body.String())
			persisted, err = q.GetBranchLockJoinRequest(ctx, pending.ID)
			require.NoError(t, err)
			require.Equal(t, "pending", persisted.Status)
			require.False(t, persisted.ResolverID.Valid)
			require.False(t, persisted.ResolvedAt.Valid)
		})
	}
}

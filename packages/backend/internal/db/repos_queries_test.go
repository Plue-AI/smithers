package db

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCreateAndDeleteRepo(t *testing.T) {
	q, pool := newQueries(t)
	ownerID := mustCreateUser(t, pool, "repo-query-owner")

	repo, err := q.CreateRepo(context.Background(), CreateRepoParams{
		UserID:          pgtype.Int8{Int64: ownerID, Valid: true},
		Name:            "query-repo",
		LowerName:       "query-repo",
		Description:     "repo via query",
		IsPublic:        true,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)
	assert.True(t, repo.UserID.Valid)
	assert.Equal(t, ownerID, repo.UserID.Int64)
	assert.Equal(t, "main", repo.DefaultBookmark)

	mustDurablyDeleteRepoForTest(t, pool, repo.ID)

	var count int64
	err = pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM repositories WHERE id = $1`, repo.ID).Scan(&count)
	require.NoError(t, err)
	assert.Equal(t, int64(0), count)
}

func TestCreateOrgRepo(t *testing.T) {
	q, pool := newQueries(t)

	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "repo-query-org",
		LowerName:   "repo-query-org",
		Description: "",
		Visibility:  "public",
	})
	require.NoError(t, err)

	repo, err := q.CreateOrgRepo(context.Background(), CreateOrgRepoParams{
		OrgID:           pgtype.Int8{Int64: org.ID, Valid: true},
		Name:            "org-repo",
		LowerName:       "org-repo",
		Description:     "org owned",
		IsPublic:        true,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)
	assert.True(t, repo.OrgID.Valid)
	assert.Equal(t, org.ID, repo.OrgID.Int64)
	assert.False(t, repo.UserID.Valid)

	// Same org namespace + same name must conflict.
	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreateOrgRepo(context.Background(), CreateOrgRepoParams{
			OrgID:           pgtype.Int8{Int64: org.ID, Valid: true},
			Name:            "org-repo",
			LowerName:       "org-repo",
			Description:     "",
			IsPublic:        true,
			DefaultBookmark: "main",
		})
		return err
	})

	var ownerOrgID int64
	err = pool.QueryRow(context.Background(), `SELECT org_id FROM repositories WHERE id = $1`, repo.ID).Scan(&ownerOrgID)
	require.NoError(t, err)
	assert.Equal(t, org.ID, ownerOrgID)
}

func TestRepoLookupListUpdateAndCountQueries(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "repo-surface-user")
	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "repo-surface-org",
		LowerName:   "repo-surface-org",
		Description: "",
		Visibility:  "public",
	})
	require.NoError(t, err)

	userRepo, err := q.CreateRepo(context.Background(), CreateRepoParams{
		UserID:          pgtype.Int8{Int64: userID, Valid: true},
		Name:            "SurfaceRepo",
		LowerName:       "surfacerepo",
		Description:     "user repo",
		IsPublic:        true,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)

	orgRepo, err := q.CreateOrgRepo(context.Background(), CreateOrgRepoParams{
		OrgID:           pgtype.Int8{Int64: org.ID, Valid: true},
		Name:            "OrgSurfaceRepo",
		LowerName:       "orgsurfacerepo",
		Description:     "org repo",
		IsPublic:        true,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)

	repoByID, err := q.GetRepoByID(context.Background(), userRepo.ID)
	require.NoError(t, err)
	assert.Equal(t, userRepo.ID, repoByID.ID)

	repoByOwner, err := q.GetRepoByOwnerAndLowerName(context.Background(), GetRepoByOwnerAndLowerNameParams{
		Owner:     "repo-surface-user",
		LowerName: "surfacerepo",
	})
	require.NoError(t, err)
	assert.Equal(t, userRepo.ID, repoByOwner.ID)

	updatedRepo, err := q.UpdateRepo(context.Background(), UpdateRepoParams{
		ID:                         userRepo.ID,
		Name:                       userRepo.Name,
		LowerName:                  userRepo.LowerName,
		Description:                "updated description",
		IsPublic:                   false,
		DefaultBookmark:            "release",
		Topics:                     []string{"jj", "smithers"},
		LandingQueueMode:           userRepo.LandingQueueMode,
		LandingQueueRequiredChecks: userRepo.LandingQueueRequiredChecks,
	})
	require.NoError(t, err)
	assert.Equal(t, userRepo.Name, updatedRepo.Name)
	assert.Equal(t, userRepo.LowerName, updatedRepo.LowerName)
	assert.Equal(t, "updated description", updatedRepo.Description)
	assert.False(t, updatedRepo.IsPublic)
	assert.Equal(t, "release", updatedRepo.DefaultBookmark)

	userRepos, err := q.ListUserRepos(context.Background(), ListUserReposParams{
		UserID:     pgtype.Int8{Int64: userID, Valid: true},
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	require.Len(t, userRepos, 1)
	assert.Equal(t, updatedRepo.ID, userRepos[0].ID)

	orgRepos, err := q.ListOrgRepos(context.Background(), ListOrgReposParams{
		OrgID:      pgtype.Int8{Int64: org.ID, Valid: true},
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	require.Len(t, orgRepos, 1)
	assert.Equal(t, orgRepo.ID, orgRepos[0].ID)

	userRepoCount, err := q.CountUserRepos(context.Background(), pgtype.Int8{Int64: userID, Valid: true})
	require.NoError(t, err)
	assert.Equal(t, int64(1), userRepoCount)

	orgRepoCount, err := q.CountOrgRepos(context.Background(), pgtype.Int8{Int64: org.ID, Valid: true})
	require.NoError(t, err)
	assert.Equal(t, int64(1), orgRepoCount)
}

func TestListPublicOrgRepos_FiltersPrivateRepos(t *testing.T) {
	q, _ := newQueries(t)

	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "public-repos-org",
		LowerName:   "public-repos-org",
		Description: "",
		Visibility:  "public",
	})
	require.NoError(t, err)

	publicRepo, err := q.CreateOrgRepo(context.Background(), CreateOrgRepoParams{
		OrgID:           pgtype.Int8{Int64: org.ID, Valid: true},
		Name:            "public-repo",
		LowerName:       "public-repo",
		Description:     "visible to all",
		IsPublic:        true,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)

	_, err = q.CreateOrgRepo(context.Background(), CreateOrgRepoParams{
		OrgID:           pgtype.Int8{Int64: org.ID, Valid: true},
		Name:            "private-repo",
		LowerName:       "private-repo",
		Description:     "hidden",
		IsPublic:        false,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)

	repos, err := q.ListPublicOrgRepos(context.Background(), ListPublicOrgReposParams{
		OrgID:      pgtype.Int8{Int64: org.ID, Valid: true},
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, publicRepo.ID, repos[0].ID)

	count, err := q.CountPublicOrgRepos(context.Background(), pgtype.Int8{Int64: org.ID, Valid: true})
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)
}

func TestListReadableReposForUser_TeamOfOtherOrgDoesNotLeak(t *testing.T) {
	for _, permission := range []string{"read", "write", "admin"} {
		t.Run(permission, func(t *testing.T) {
			q, db := newQueries(t)
			ctx := context.Background()

			userID := mustCreateUser(t, db, "team-cross-org-user")
			teamOrgID := mustCreateOrganization(t, db, "team-cross-org-a")
			otherOrgID := mustCreateOrganization(t, db, "team-cross-org-b")
			mustAddOrgMember(t, db, teamOrgID, userID, "member")

			teamID := mustCreateTeam(t, db, teamOrgID, "team-cross-org-team")
			_, err := db.Exec(ctx, `UPDATE teams SET permission = $1 WHERE id = $2`, permission, teamID)
			require.NoError(t, err)
			mustAddTeamMember(t, db, teamID, userID)

			publicOrgID := mustCreateOrganization(t, db, "team-cross-org-public")
			publicRepoIDs := make([]int64, 0, 12)
			for i := range 12 {
				publicRepoIDs = append(publicRepoIDs, mustCreateOrgRepo(t, db, publicOrgID, fmt.Sprintf("unrelated-public-%d", i), true))
			}
			baselineCount, err := q.CountReadableReposForUser(ctx, userID)
			require.NoError(t, err)

			sameOrgRepoID := mustCreateOrgRepo(t, db, teamOrgID, "same-org-private", false)
			otherOrgRepoID := mustCreateOrgRepo(t, db, otherOrgID, "other-org-private", false)
			mustAddTeamRepo(t, db, teamID, sameOrgRepoID)
			mustAddTeamRepo(t, db, teamID, otherOrgRepoID)

			count, err := q.CountReadableReposForUser(ctx, userID)
			require.NoError(t, err)
			assert.Equal(t, baselineCount+1, count)

			seen := make(map[int64]struct{})
			for offset := int32(0); ; offset += 10 {
				repos, err := q.ListReadableReposForUser(ctx, ListReadableReposForUserParams{
					UserID: userID, PageSize: 10, PageOffset: offset,
				})
				require.NoError(t, err)
				for _, repo := range repos {
					seen[repo.ID] = struct{}{}
				}
				if len(repos) < 10 {
					break
				}
			}
			assert.Equal(t, count, int64(len(seen)))
			assert.Contains(t, seen, sameOrgRepoID)
			assert.NotContains(t, seen, otherOrgRepoID)
			for _, publicRepoID := range publicRepoIDs {
				assert.Contains(t, seen, publicRepoID)
			}
		})
	}
}

func TestReadableReposForUser_FormerOrgMemberRetainsStaleTeamRow(t *testing.T) {
	for _, permission := range []string{"read", "write", "admin"} {
		t.Run(permission, func(t *testing.T) {
			q, db := newQueries(t)
			ctx := context.Background()

			userID := mustCreateUser(t, db, "former-org-team-user")
			// Earlier tests in this binary commit public repos that every user can
			// read, so counts are relative to this baseline.
			baselineCount, err := q.CountReadableReposForUser(ctx, userID)
			require.NoError(t, err)
			orgID := mustCreateOrganization(t, db, "former-org-team-org")
			mustAddOrgMember(t, db, orgID, userID, "member")

			teamID := mustCreateTeam(t, db, orgID, "former-org-team")
			_, err = db.Exec(ctx, `UPDATE teams SET permission = $1 WHERE id = $2`, permission, teamID)
			require.NoError(t, err)
			mustAddTeamMember(t, db, teamID, userID)
			teamRepoID := mustCreateOrgRepo(t, db, orgID, "former-org-private", false)
			mustAddTeamRepo(t, db, teamID, teamRepoID)

			collaboratorRepoID := mustCreateOrgRepo(t, db, orgID, "former-org-collaborator", false)
			mustAddTeamRepo(t, db, teamID, collaboratorRepoID)
			_, err = db.Exec(ctx,
				`INSERT INTO collaborators (repository_id, user_id, permission) VALUES ($1, $2, 'read')`,
				collaboratorRepoID, userID)
			require.NoError(t, err)
			publicRepoID := mustCreateOrgRepo(t, db, orgID, "former-org-public", true)
			mustAddTeamRepo(t, db, teamID, publicRepoID)

			fixtureRepoIDs := map[int64]struct{}{teamRepoID: {}, collaboratorRepoID: {}, publicRepoID: {}}
			// listIDs pages through every readable repo and keeps this test's fixtures.
			listIDs := func() []int64 {
				t.Helper()
				ids := make([]int64, 0, len(fixtureRepoIDs))
				for offset := int32(0); ; offset += 100 {
					repos, err := q.ListReadableReposForUser(ctx, ListReadableReposForUserParams{
						UserID: userID, PageSize: 100, PageOffset: offset,
					})
					require.NoError(t, err)
					for _, repo := range repos {
						if _, ok := fixtureRepoIDs[repo.ID]; ok {
							ids = append(ids, repo.ID)
						}
					}
					if len(repos) < 100 {
						return ids
					}
				}
			}

			assert.ElementsMatch(t, []int64{teamRepoID, collaboratorRepoID, publicRepoID}, listIDs())
			count, err := q.CountReadableReposForUser(ctx, userID)
			require.NoError(t, err)
			assert.Equal(t, baselineCount+3, count)

			// Deliberately bypass normal removal cleanup to retain a stale team grant.
			deleted, err := db.Exec(ctx,
				`DELETE FROM org_members WHERE organization_id = $1 AND user_id = $2`, orgID, userID)
			require.NoError(t, err)
			require.EqualValues(t, 1, deleted.RowsAffected())
			var staleTeamRows int64
			err = db.QueryRow(ctx,
				`SELECT COUNT(*) FROM team_members WHERE team_id = $1 AND user_id = $2`,
				teamID, userID).Scan(&staleTeamRows)
			require.NoError(t, err)
			require.Equal(t, int64(1), staleTeamRows)

			assert.ElementsMatch(t, []int64{collaboratorRepoID, publicRepoID}, listIDs())
			count, err = q.CountReadableReposForUser(ctx, userID)
			require.NoError(t, err)
			assert.Equal(t, baselineCount+2, count)
		})
	}
}

func TestDeleteOrganizationCascadesRepos(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)

	org, err := q.CreateOrganization(ctx, CreateOrganizationParams{
		Name:        "delete-repo-org",
		LowerName:   "delete-repo-org",
		Description: "",
		Visibility:  "public",
	})
	require.NoError(t, err)

	repo, err := q.CreateOrgRepo(ctx, CreateOrgRepoParams{
		OrgID:           pgtype.Int8{Int64: org.ID, Valid: true},
		Name:            "cascade-repo",
		LowerName:       "cascade-repo",
		Description:     "",
		IsPublic:        true,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)

	// Product repository ownership is fenced by the durable deletion journal.
	deleteErr := mustExpectQueryError(t, pool, func(spQ *Queries) error {
		return spQ.DeleteOrganization(ctx, org.ID)
	})
	var pgErr *pgconn.PgError
	require.ErrorAs(t, deleteErr, &pgErr)
	assert.Equal(t, "55006", pgErr.Code)

	mustDurablyDeleteRepoForTest(t, pool, repo.ID)
	require.NoError(t, q.DeleteOrganization(ctx, org.ID))

	_, err = q.GetRepoByID(ctx, repo.ID)
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

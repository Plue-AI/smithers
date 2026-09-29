package db

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Ticket 0135 + 0136 DB tests. These run against real Postgres (make
// docker-up) so reviewers know:
//   - the cross-repo listing query actually walks the owner/org/team/
//     collaborator/public branches,
//   - a revoked collaborator grant actually hides a row,
//   - tombstoned workspaces never appear,
//   - last_accessed_at drives ordering when present and COALESCE-falls-back
//     to last_activity_at / created_at otherwise.

func TestTouchWorkspaceLastAccessed_BumpsColumn(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)

	userID := mustCreateUser(t, tx, "la-user")
	repoID := mustCreateRepoForUser(t, tx, userID, "la-repo")

	ws, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID,
		UserID:       userID,
		Name:         "primary",
		Status:       "pending",
	})
	require.NoError(t, err)
	// last_accessed_at should start NULL.
	require.False(t, ws.LastAccessedAt.Valid)

	require.NoError(t, q.TouchWorkspaceLastAccessed(ctx, ws.ID))

	reread, err := q.GetWorkspace(ctx, ws.ID)
	require.NoError(t, err)
	require.True(t, reread.LastAccessedAt.Valid, "TouchWorkspaceLastAccessed should populate the column")
	assert.WithinDuration(t, time.Now(), reread.LastAccessedAt.Time, 10*time.Second)
}

func TestWorkspaceTargetBookmark_RoundTrips(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)
	userID := mustCreateUser(t, tx, "bookmark-user")
	repoID := mustCreateRepoForUser(t, tx, userID, "bookmark-repo")

	created, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID:   repoID,
		UserID:         userID,
		Name:           "primary",
		TargetBookmark: "landing/demo-123",
		Status:         "pending",
	})
	require.NoError(t, err)
	assert.Equal(t, "landing/demo-123", created.TargetBookmark)

	reread, err := q.GetWorkspace(ctx, created.ID)
	require.NoError(t, err)
	assert.Equal(t, "landing/demo-123", reread.TargetBookmark)

	defaulted, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID,
		UserID:       userID,
		Name:         "fork",
		IsFork:       true,
		Status:       "pending",
	})
	require.NoError(t, err)
	assert.Equal(t, "main", defaulted.TargetBookmark)
}

func TestListIdleWorkspaces_ExcludesFreshPendingSession(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)
	userID := mustCreateUser(t, tx, "idle-pending-user")
	repoID := mustCreateRepoForUser(t, tx, userID, "idle-pending-repo")

	created, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID,
		UserID:       userID,
		Name:         "idle-pending",
		Status:       "starting",
	})
	require.NoError(t, err)
	workspace, err := q.UpdateWorkspaceExecutionInfo(ctx, UpdateWorkspaceExecutionInfoParams{
		ID:     created.ID,
		VmID:   "vm-idle-pending",
		Status: "running",
	})
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE workspaces SET last_activity_at = NOW() - interval '2 hours', idle_timeout_secs = 60 WHERE id = $1`, workspace.ID)
	require.NoError(t, err)

	session, err := q.CreateWorkspaceSession(ctx, CreateWorkspaceSessionParams{
		WorkspaceID:  workspace.ID,
		RepositoryID: repoID,
		UserID:       userID,
		Cols:         80,
		Rows:         24,
	})
	require.NoError(t, err)

	rows, err := q.ListIdleWorkspaces(ctx)
	require.NoError(t, err)
	assert.Empty(t, rows)

	_, err = q.UpdateWorkspaceSessionStatus(ctx, UpdateWorkspaceSessionStatusParams{
		ID:     session.ID,
		Status: "failed",
	})
	require.NoError(t, err)

	rows, err = q.ListIdleWorkspaces(ctx)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, workspace.ID, rows[0].ID)
}

func TestListRunningWorkspaces_IncludesActiveAcrossOwnersOnly(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })
	q := New(tx)
	firstOwner := mustCreateUser(t, tx, "hours-cap-first-owner")
	secondOwner := mustCreateUser(t, tx, "hours-cap-second-owner")

	create := func(owner int64, name, status string, deleted bool) Workspace {
		repo := mustCreateRepoForUser(t, tx, owner, "hours-cap-"+name)
		ws, createErr := q.CreateWorkspace(ctx, CreateWorkspaceParams{
			RepositoryID: repo, UserID: owner, Name: name, Status: status,
		})
		require.NoError(t, createErr)
		if deleted {
			_, deleteErr := tx.Exec(ctx, `UPDATE workspaces SET deleted_at = NOW() WHERE id = $1`, ws.ID)
			require.NoError(t, deleteErr)
		}
		return ws
	}
	active := create(firstOwner, "active", "running", false)
	otherOwner := create(secondOwner, "other-owner", "running", false)
	stopped := create(firstOwner, "stopped", "stopped", false)
	suspended := create(firstOwner, "suspended", "suspended", false)
	pending := create(firstOwner, "pending", "pending", false)
	deleted := create(firstOwner, "deleted", "running", true)

	rows, err := q.ListRunningWorkspaces(ctx)
	require.NoError(t, err)
	byID := make(map[string]Workspace, len(rows))
	for _, row := range rows {
		byID[row.ID] = row
	}
	assert.Equal(t, firstOwner, byID[active.ID].UserID)
	assert.Equal(t, secondOwner, byID[otherOwner.ID].UserID)
	for _, absent := range []Workspace{stopped, suspended, pending, deleted} {
		assert.NotContains(t, byID, absent.ID)
	}
}

func TestWorkspaceLastAccessedBackfill_SeedsFromLastActivity(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)

	userID := mustCreateUser(t, tx, "backfill-user")
	repoA := mustCreateRepoForUser(t, tx, userID, "backfill-a")
	repoB := mustCreateRepoForUser(t, tx, userID, "backfill-b")

	needsBackfill, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoA,
		UserID:       userID,
		Name:         "needs-backfill",
		Status:       "pending",
	})
	require.NoError(t, err)
	alreadySet, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoB,
		UserID:       userID,
		Name:         "already-set",
		Status:       "pending",
	})
	require.NoError(t, err)

	backfillSource := time.Date(2026, 4, 24, 10, 15, 0, 0, time.UTC)
	preservedAccess := time.Date(2026, 4, 24, 9, 0, 0, 0, time.UTC)
	preservedActivity := time.Date(2026, 4, 24, 11, 45, 0, 0, time.UTC)

	_, err = tx.Exec(ctx, `UPDATE workspaces SET last_activity_at = $2, last_accessed_at = NULL WHERE id = $1`, needsBackfill.ID, backfillSource)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE workspaces SET last_activity_at = $2, last_accessed_at = $3 WHERE id = $1`, alreadySet.ID, preservedActivity, preservedAccess)
	require.NoError(t, err)

	// Exact backfill statement from migration 000032.
	_, err = tx.Exec(ctx, `UPDATE workspaces SET last_accessed_at = last_activity_at WHERE last_accessed_at IS NULL`)
	require.NoError(t, err)

	backfilled, err := q.GetWorkspace(ctx, needsBackfill.ID)
	require.NoError(t, err)
	require.True(t, backfilled.LastAccessedAt.Valid)
	assert.Equal(t, backfillSource, backfilled.LastAccessedAt.Time.UTC())

	preserved, err := q.GetWorkspace(ctx, alreadySet.ID)
	require.NoError(t, err)
	require.True(t, preserved.LastAccessedAt.Valid)
	assert.Equal(t, preservedAccess, preserved.LastAccessedAt.Time.UTC())
}

func TestListUserWorkspacesAcrossRepos_OwnerRepo(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)

	userID := mustCreateUser(t, tx, "own-user")
	repoID := mustCreateRepoForUser(t, tx, userID, "own-repo")

	_, err = q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID, UserID: userID, Name: "", Status: "pending",
	})
	require.NoError(t, err)

	rows, err := q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{
		UserID: userID, PageOffset: 0, PageSize: 100,
	})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, repoID, rows[0].RepositoryID)
	assert.Equal(t, "own-user", rows[0].RepositoryOwner)
	// Unnamed workspace falls back to repo name as the switcher title.
	assert.Equal(t, "own-repo", rows[0].WorkspaceTitle)

	count, err := q.CountUserWorkspacesAcrossRepos(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)
}

func TestListUserWorkspacesAcrossRepos_ExcludesTombstonedAndOrphaned(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)

	userID := mustCreateUser(t, tx, "tomb-user")
	repoID := mustCreateRepoForUser(t, tx, userID, "tomb-repo")

	alive, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID, UserID: userID, Name: "alive", IsFork: false, Status: "pending",
	})
	require.NoError(t, err)
	dead, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID, UserID: userID, Name: "dead", IsFork: true, Status: "pending",
	})
	require.NoError(t, err)

	// Tombstone the second workspace.
	_, err = q.SoftDeleteWorkspace(ctx, dead.ID)
	require.NoError(t, err)

	rows, err := q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{
		UserID: userID, PageOffset: 0, PageSize: 100,
	})
	require.NoError(t, err)
	require.Len(t, rows, 1, "tombstoned workspace must not appear in the switcher")
	assert.Equal(t, alive.ID, rows[0].WorkspaceID)

	count, err := q.CountUserWorkspacesAcrossRepos(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)
}

func TestListUserWorkspacesAcrossRepos_OrderingAndLastActivityAt(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)

	userID := mustCreateUser(t, tx, "order-user")
	repoA := mustCreateRepoForUser(t, tx, userID, "repo-a")
	repoB := mustCreateRepoForUser(t, tx, userID, "repo-b")

	// Workspace A created first, touched last_accessed_at most recently.
	// Workspace B created second, never touched.
	// The switcher should order A before B because last_accessed_at wins
	// over last_activity_at via COALESCE.
	wsA, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoA, UserID: userID, Name: "A", IsFork: false, Status: "pending",
	})
	require.NoError(t, err)

	_, err = q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoB, UserID: userID, Name: "B", IsFork: false, Status: "pending",
	})
	require.NoError(t, err)

	// Age B's last_activity_at slightly into the future past A.
	_, err = tx.Exec(ctx, `UPDATE workspaces SET last_activity_at = NOW() + interval '1 hour' WHERE repository_id = $1`, repoB)
	require.NoError(t, err)

	// Now touch A's last_accessed_at to "now + 2 hours" — this should make A
	// win via COALESCE(last_accessed_at, last_activity_at, created_at).
	_, err = tx.Exec(ctx, `UPDATE workspaces SET last_accessed_at = NOW() + interval '2 hours' WHERE id = $1`, wsA.ID)
	require.NoError(t, err)

	rows, err := q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{
		UserID: userID, PageOffset: 0, PageSize: 100,
	})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	assert.Equal(t, "A", rows[0].WorkspaceTitle, "last_accessed_at must beat last_activity_at via COALESCE")
	assert.Equal(t, "B", rows[1].WorkspaceTitle)
	assert.False(t, rows[0].LastActivityAt.IsZero())
	assert.False(t, rows[1].LastActivityAt.IsZero())
}

func TestListUserWorkspacesAcrossRepos_FallsBackWhenNoLastAccessed(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)

	userID := mustCreateUser(t, tx, "fall-user")
	repoA := mustCreateRepoForUser(t, tx, userID, "fall-a")
	repoB := mustCreateRepoForUser(t, tx, userID, "fall-b")

	// Neither workspace has last_accessed_at; ordering should fall through
	// to last_activity_at DESC.
	_, err = q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoA, UserID: userID, Name: "older", IsFork: false, Status: "pending",
	})
	require.NoError(t, err)

	_, err = q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoB, UserID: userID, Name: "newer", IsFork: false, Status: "pending",
	})
	require.NoError(t, err)

	// Age repoA's row into the past so "newer" wins.
	_, err = tx.Exec(ctx, `UPDATE workspaces SET last_activity_at = NOW() - interval '1 day', created_at = NOW() - interval '1 day' WHERE repository_id = $1`, repoA)
	require.NoError(t, err)

	rows, err := q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{
		UserID: userID, PageOffset: 0, PageSize: 100,
	})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	assert.Equal(t, "newer", rows[0].WorkspaceTitle)
	assert.Equal(t, "older", rows[1].WorkspaceTitle)
}

func TestListUserWorkspacesAcrossRepos_TieBreaksByWorkspaceIDDesc(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)

	userID := mustCreateUser(t, tx, "tie-user")
	repoA := mustCreateRepoForUser(t, tx, userID, "tie-a")
	repoB := mustCreateRepoForUser(t, tx, userID, "tie-b")

	wsA, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoA, UserID: userID, Name: "tie-a", IsFork: false, Status: "pending",
	})
	require.NoError(t, err)
	wsB, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoB, UserID: userID, Name: "tie-b", IsFork: false, Status: "pending",
	})
	require.NoError(t, err)

	// Force an identical COALESCE() value for both rows so ordering must
	// deterministically fall through to workspace_id DESC.
	_, err = tx.Exec(ctx, `UPDATE workspaces SET last_accessed_at = '2026-04-24T12:00:00Z' WHERE id = ANY($1::uuid[])`, []string{wsA.ID, wsB.ID})
	require.NoError(t, err)

	rows, err := q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{
		UserID: userID, PageOffset: 0, PageSize: 100,
	})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	assert.True(t, rows[0].SortTimestamp.Equal(rows[1].SortTimestamp))
	assert.Greater(t, rows[0].WorkspaceID, rows[1].WorkspaceID, "tie-breaking must be deterministic on workspace_id DESC")
}

func TestListUserWorkspacesAcrossRepos_CollaboratorRepoShows_RevokeHides(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)

	ownerID := mustCreateUser(t, tx, "collab-owner")
	collabID := mustCreateUser(t, tx, "collab-user")
	// Collaborator-accessible repo is owned by someone else and NOT public —
	// only the collaborator grant opens access.
	var repoID int64
	err = tx.QueryRow(ctx,
		`INSERT INTO repositories (user_id, name, lower_name, is_public) VALUES ($1, $2, $3, FALSE) RETURNING id`,
		ownerID, "collab-repo", "collab-repo",
	).Scan(&repoID)
	require.NoError(t, err)

	_, err = tx.Exec(ctx,
		`INSERT INTO collaborators (repository_id, user_id, permission) VALUES ($1, $2, 'read')`,
		repoID, collabID,
	)
	require.NoError(t, err)

	// Collaborator-owned workspace on that repo — the collaborator created a
	// sandbox against a repo they can merely read.
	_, err = q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID, UserID: collabID, Name: "collab-ws", IsFork: false, Status: "pending",
	})
	require.NoError(t, err)

	rows, err := q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{
		UserID: collabID, PageOffset: 0, PageSize: 100,
	})
	require.NoError(t, err)
	require.Len(t, rows, 1, "collaborator should see their own workspace on a readable repo")
	assert.Equal(t, "collab-ws", rows[0].WorkspaceTitle)

	// Revoke the collaborator grant — the row must disappear, even though the
	// user still owns the workspace row. This is the "repo-access-revoked
	// hides a row you used to own" acceptance test.
	_, err = tx.Exec(ctx, `DELETE FROM collaborators WHERE repository_id = $1 AND user_id = $2`, repoID, collabID)
	require.NoError(t, err)

	rows, err = q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{
		UserID: collabID, PageOffset: 0, PageSize: 100,
	})
	require.NoError(t, err)
	require.Len(t, rows, 0, "revoked collaborator access must hide the workspace row")
}

func TestListUserWorkspacesAcrossRepos_OrgOwnerAndTeamAccess(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)

	orgOwnerID := mustCreateUser(t, tx, "org-owner-user")
	teamUserID := mustCreateUser(t, tx, "org-team-user")
	orgID := mustCreateOrganization(t, tx, "org-access")

	mustAddOrgMember(t, tx, orgID, orgOwnerID, "owner")
	mustAddOrgMember(t, tx, orgID, teamUserID, "member")

	orgOwnerRepoID := mustCreateOrgRepo(t, tx, orgID, "org-owner-repo", false)
	teamRepoID := mustCreateOrgRepo(t, tx, orgID, "org-team-repo", false)

	teamID := mustCreateTeam(t, tx, orgID, "org-core")
	mustAddTeamMember(t, tx, teamID, teamUserID)
	mustAddTeamRepo(t, tx, teamID, teamRepoID)

	_, err = q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: orgOwnerRepoID, UserID: orgOwnerID, Name: "owner-ws", IsFork: false, Status: "pending",
	})
	require.NoError(t, err)
	_, err = q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: teamRepoID, UserID: teamUserID, Name: "team-ws", IsFork: false, Status: "pending",
	})
	require.NoError(t, err)

	ownerRows, err := q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{
		UserID: orgOwnerID, PageOffset: 0, PageSize: 100,
	})
	require.NoError(t, err)
	require.Len(t, ownerRows, 1)
	assert.Equal(t, orgOwnerRepoID, ownerRows[0].RepositoryID, "org owner should read org-owned private repo")

	teamRows, err := q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{
		UserID: teamUserID, PageOffset: 0, PageSize: 100,
	})
	require.NoError(t, err)
	require.Len(t, teamRows, 1)
	assert.Equal(t, teamRepoID, teamRows[0].RepositoryID, "team member should read team-granted private repo")
}

func TestListUserWorkspacesAcrossRepos_RejectsStaleAndCrossOrgTeamGrants(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)
	userID := mustCreateUser(t, tx, "stale-team-user")
	repoOrgID := mustCreateOrganization(t, tx, "stale-team-repo-org")
	otherOrgID := mustCreateOrganization(t, tx, "stale-team-other-org")
	mustAddOrgMember(t, tx, repoOrgID, userID, "member")
	mustAddOrgMember(t, tx, otherOrgID, userID, "member")

	validRepoID := mustCreateOrgRepo(t, tx, repoOrgID, "stale-team-valid-repo", false)
	crossOrgRepoID := mustCreateOrgRepo(t, tx, repoOrgID, "stale-team-cross-repo", false)
	validTeamID := mustCreateTeam(t, tx, repoOrgID, "stale-team-valid")
	crossOrgTeamID := mustCreateTeam(t, tx, otherOrgID, "stale-team-cross")
	mustAddTeamMember(t, tx, validTeamID, userID)
	mustAddTeamMember(t, tx, crossOrgTeamID, userID)
	mustAddTeamRepo(t, tx, validTeamID, validRepoID)
	// This deliberately models a historical transfer/removal race: relational
	// FKs permit the stale mapping, but it must not grant visibility because
	// the team no longer belongs to the repository's current organization.
	mustAddTeamRepo(t, tx, crossOrgTeamID, crossOrgRepoID)

	_, err = q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: validRepoID, UserID: userID, Name: "valid-team-ws", Status: "pending",
	})
	require.NoError(t, err)
	_, err = q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: crossOrgRepoID, UserID: userID, Name: "cross-org-team-ws", Status: "pending",
	})
	require.NoError(t, err)

	rows, err := q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{
		UserID: userID, PageOffset: 0, PageSize: 100,
	})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, validRepoID, rows[0].RepositoryID)
	count, err := q.CountUserWorkspacesAcrossRepos(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), count, "count must reject a cross-organization team mapping just like list")

	// Leave team_members/team_repos behind while removing current org
	// membership. Both list and count must revoke access immediately.
	_, err = tx.Exec(ctx, `DELETE FROM org_members WHERE organization_id = $1 AND user_id = $2`, repoOrgID, userID)
	require.NoError(t, err)
	rows, err = q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{
		UserID: userID, PageOffset: 0, PageSize: 100,
	})
	require.NoError(t, err)
	assert.Empty(t, rows)
	count, err = q.CountUserWorkspacesAcrossRepos(ctx, userID)
	require.NoError(t, err)
	assert.Zero(t, count, "count must reject stale team rows after org-membership removal")
}

func TestListUserWorkspacesAcrossRepos_PublicRepoShowsOwnerScoped(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)

	ownerID := mustCreateUser(t, tx, "pub-owner")
	readerID := mustCreateUser(t, tx, "pub-reader")

	// Public repo owned by pub-owner. pub-reader has workspaces against it
	// (they opened a sandbox on a public repo). pub-reader should see them.
	var repoID int64
	err = tx.QueryRow(ctx,
		`INSERT INTO repositories (user_id, name, lower_name, is_public) VALUES ($1, $2, $3, TRUE) RETURNING id`,
		ownerID, "pub-repo", "pub-repo",
	).Scan(&repoID)
	require.NoError(t, err)

	_, err = q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID, UserID: readerID, Name: "reader-ws", IsFork: false, Status: "pending",
	})
	require.NoError(t, err)
	// Owner shouldn't see reader-ws via owner-scope (user_id = $1 filters it
	// out). This validates "do not expose other users' workspaces just
	// because the repo is readable."
	_, err = q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID, UserID: ownerID, Name: "owner-ws", IsFork: false, Status: "pending",
	})
	require.NoError(t, err)

	readerRows, err := q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{
		UserID: readerID, PageOffset: 0, PageSize: 100,
	})
	require.NoError(t, err)
	require.Len(t, readerRows, 1)
	assert.Equal(t, "reader-ws", readerRows[0].WorkspaceTitle)

	ownerRows, err := q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{
		UserID: ownerID, PageOffset: 0, PageSize: 100,
	})
	require.NoError(t, err)
	require.Len(t, ownerRows, 1)
	assert.Equal(t, "owner-ws", ownerRows[0].WorkspaceTitle)
}

func TestListUserWorkspacesAcrossRepos_Pagination(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)

	userID := mustCreateUser(t, tx, "page-user")
	// Spread 5 workspaces across 5 repos so the quota index uq_workspaces_active
	// (one primary per user+repo) can't trip over duplicates.
	for i := 0; i < 5; i++ {
		repoID := mustCreateRepoForUser(t, tx, userID, "page-repo-"+string(rune('a'+i)))
		_, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
			RepositoryID: repoID, UserID: userID, Name: "ws-" + string(rune('a'+i)), IsFork: false, Status: "pending",
		})
		require.NoError(t, err)
	}

	first, err := q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{
		UserID: userID, PageOffset: 0, PageSize: 2,
	})
	require.NoError(t, err)
	require.Len(t, first, 2)

	second, err := q.ListUserWorkspacesAcrossRepos(ctx, ListUserWorkspacesAcrossReposParams{
		UserID: userID, PageOffset: 2, PageSize: 2,
	})
	require.NoError(t, err)
	require.Len(t, second, 2)
	// Pages must not overlap.
	seen := map[string]struct{}{}
	for _, r := range append(first, second...) {
		_, dup := seen[r.WorkspaceID]
		assert.False(t, dup, "pagination returned the same row twice")
		seen[r.WorkspaceID] = struct{}{}
	}

	total, err := q.CountUserWorkspacesAcrossRepos(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, int64(5), total)
}

func TestListReadableReposForUser_Matrix(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)

	userID := mustCreateUser(t, tx, "read-user")
	otherID := mustCreateUser(t, tx, "read-other")

	// Owner repo — private.
	var ownerRepoID int64
	err = tx.QueryRow(ctx,
		`INSERT INTO repositories (user_id, name, lower_name, is_public) VALUES ($1, 'mine', 'mine', FALSE) RETURNING id`,
		userID,
	).Scan(&ownerRepoID)
	require.NoError(t, err)

	// Org-owner repo — private org repo, user can read by org ownership.
	orgOwnerOrgID := mustCreateOrganization(t, tx, "rr-org-owner")
	mustAddOrgMember(t, tx, orgOwnerOrgID, userID, "owner")
	orgOwnerRepoID := mustCreateOrgRepo(t, tx, orgOwnerOrgID, "rr-org-owner-repo", false)

	// Team-access repo — private org repo, user can read by team membership.
	teamOrgID := mustCreateOrganization(t, tx, "rr-team-org")
	mustAddOrgMember(t, tx, teamOrgID, userID, "member")
	teamRepoID := mustCreateOrgRepo(t, tx, teamOrgID, "rr-team-repo", false)
	teamID := mustCreateTeam(t, tx, teamOrgID, "rr-team")
	mustAddTeamMember(t, tx, teamID, userID)
	mustAddTeamRepo(t, tx, teamID, teamRepoID)

	// Collaborator repo — private, other user's.
	var collabRepoID int64
	err = tx.QueryRow(ctx,
		`INSERT INTO repositories (user_id, name, lower_name, is_public) VALUES ($1, 'collab', 'collab', FALSE) RETURNING id`,
		otherID,
	).Scan(&collabRepoID)
	require.NoError(t, err)
	_, err = tx.Exec(ctx,
		`INSERT INTO collaborators (repository_id, user_id, permission) VALUES ($1, $2, 'read')`,
		collabRepoID, userID)
	require.NoError(t, err)

	// Public repo — user has no grant, public-read should carry them.
	var publicRepoID int64
	err = tx.QueryRow(ctx,
		`INSERT INTO repositories (user_id, name, lower_name, is_public) VALUES ($1, 'open', 'open', TRUE) RETURNING id`,
		otherID,
	).Scan(&publicRepoID)
	require.NoError(t, err)

	// Private repo belonging to other user, NO grant — must NOT appear.
	var hiddenRepoID int64
	err = tx.QueryRow(ctx,
		`INSERT INTO repositories (user_id, name, lower_name, is_public) VALUES ($1, 'hidden', 'hidden', FALSE) RETURNING id`,
		otherID,
	).Scan(&hiddenRepoID)
	require.NoError(t, err)

	rows, err := q.ListReadableReposForUser(ctx, ListReadableReposForUserParams{
		UserID: userID, PageOffset: 0, PageSize: 100,
	})
	require.NoError(t, err)

	ids := map[int64]struct{}{}
	for _, r := range rows {
		ids[r.ID] = struct{}{}
	}
	assert.Contains(t, ids, ownerRepoID, "owner repo must be readable")
	assert.Contains(t, ids, orgOwnerRepoID, "org owner repo must be readable")
	assert.Contains(t, ids, teamRepoID, "team-granted repo must be readable")
	assert.Contains(t, ids, collabRepoID, "collaborator repo must be readable")
	assert.Contains(t, ids, publicRepoID, "public repo must be readable")
	assert.NotContains(t, ids, hiddenRepoID, "private repo with no grant must NOT be readable")

	total, err := q.CountReadableReposForUser(ctx, userID)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, total, int64(5))

	// Revoke collaborator + team grants and verify those rows disappear.
	_, err = tx.Exec(ctx, `DELETE FROM collaborators WHERE repository_id = $1 AND user_id = $2`, collabRepoID, userID)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, teamID, userID)
	require.NoError(t, err)

	rowsAfterRevoke, err := q.ListReadableReposForUser(ctx, ListReadableReposForUserParams{
		UserID: userID, PageOffset: 0, PageSize: 100,
	})
	require.NoError(t, err)
	idsAfterRevoke := map[int64]struct{}{}
	for _, r := range rowsAfterRevoke {
		idsAfterRevoke[r.ID] = struct{}{}
	}
	assert.NotContains(t, idsAfterRevoke, collabRepoID, "revoked collaborator repo must disappear")
	assert.NotContains(t, idsAfterRevoke, teamRepoID, "revoked team repo must disappear")
	assert.Contains(t, idsAfterRevoke, ownerRepoID)
	assert.Contains(t, idsAfterRevoke, orgOwnerRepoID)
	assert.Contains(t, idsAfterRevoke, publicRepoID)
}

// mustCreateRepoForUser_TrimmedName re-exports the lowercase for our callers
// — kept private to this file.
var _ = strings.ToLower

package db

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// dbSuite is this test binary's own product database; sharedPool is its pool,
// reused across all tests.
var (
	dbSuite    = postgresfixture.Suite{MaxConns: 20, Whole: true}
	sharedPool *pgxpool.Pool
)

func TestMain(m *testing.M) {
	os.Exit(dbSuite.Run(m, func(ctx context.Context, pool *pgxpool.Pool) error {
		sharedPool = pool
		return resetTestData(ctx, pool)
	}))
}

func resetTestData(ctx context.Context, db DBTX) error {
	var tableList string
	err := db.QueryRow(ctx, `SELECT string_agg(format('%I.%I', schemaname, tablename), ', ' ORDER BY tablename)
		FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'smithers_product_migrations'`).Scan(&tableList)
	if err != nil {
		return fmt.Errorf("list product test tables: %w", err)
	}
	if tableList == "" {
		return errors.New("product test database has no tables")
	}
	_, err = db.Exec(ctx, "TRUNCATE "+tableList+" RESTART IDENTITY CASCADE")
	return err
}

func newQueries(t *testing.T) (*Queries, DBTX) {
	t.Helper()

	tx, err := sharedPool.Begin(context.Background())
	require.NoError(t, err, "failed to start test transaction")

	t.Cleanup(func() {
		err := tx.Rollback(context.Background())
		if err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			require.NoError(t, err, "failed to rollback test transaction")
		}
	})

	return New(tx), tx
}

func mustCreateUser(t *testing.T, pool DBTX, username string) int64 {
	t.Helper()

	lowerUsername := strings.ToLower(username)
	lowerEmail := lowerUsername + "@example.com"

	var id int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO users (username, lower_username, email, lower_email, display_name) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		username,
		lowerUsername,
		username+"@example.com",
		lowerEmail,
		username,
	).Scan(&id)
	require.NoError(t, err)

	return id
}

func mustCreateRepo(t *testing.T, pool DBTX, userID int64, name string) int64 {
	t.Helper()

	lowerName := strings.ToLower(name)

	var id int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number) VALUES ($1, $2, $3, '', TRUE, 'main', 1) RETURNING id`,
		userID,
		name,
		lowerName,
	).Scan(&id)
	require.NoError(t, err)

	return id
}

// newRepositoryStorageOperationToken returns the same 64-character lowercase
// token shape used by repo-host journals in production. Tests must exercise the
// database authorization boundary instead of bypassing the durable-operation
// trigger with an ad-hoc session setting.
func newRepositoryStorageOperationToken(t *testing.T) string {
	t.Helper()
	var raw [32]byte
	_, err := rand.Read(raw[:])
	require.NoError(t, err)
	return hex.EncodeToString(raw[:])
}

// mustDurablyDeleteRepoForTest performs the metadata half of the production
// delete protocol: persist the exact stable-id/source identity, authorize only
// this transaction, delete the row, then remove the settled intent. It does not
// contact repo-host and is therefore only suitable for database tests.
func mustDurablyDeleteRepoForTest(t *testing.T, tx DBTX, repositoryID int64) {
	t.Helper()
	pgxTx, ok := tx.(pgx.Tx)
	require.True(t, ok, "durable repository test helper requires one explicit transaction")
	tx = pgxTx
	ctx := context.Background()
	var (
		name   string
		owner  string
		userID pgtype.Int8
		orgID  pgtype.Int8
	)
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT r.name, COALESCE(u.username, o.name), r.user_id, r.org_id
		FROM repositories r
		LEFT JOIN users u ON u.id = r.user_id
		LEFT JOIN organizations o ON o.id = r.org_id
		WHERE r.id = $1
		FOR UPDATE OF r
	`, repositoryID).Scan(&name, &owner, &userID, &orgID))

	token := newRepositoryStorageOperationToken(t)
	_, err := tx.Exec(ctx, `
		INSERT INTO repository_storage_operations (
			repository_id, operation_type, token, storage_route_key,
			source_owner, source_repo, source_user_id, source_org_id
		) VALUES ($1, 'delete', $2, 's1', $3, $4, $5, $6)
	`, repositoryID, token, owner, name, userID, orgID)
	require.NoError(t, err)
	_, err = tx.Exec(ctx,
		`SELECT set_config('smithers.repository_storage_operation_token', $1, TRUE)`, token)
	require.NoError(t, err)
	require.NoError(t, New(tx).DeleteRepo(ctx, repositoryID))
	commandTag, err := tx.Exec(ctx,
		`DELETE FROM repository_storage_operations WHERE repository_id = $1 AND token = $2`,
		repositoryID, token)
	require.NoError(t, err)
	require.EqualValues(t, 1, commandTag.RowsAffected())
}

func mustDurablyDeleteRepoCommittedForTest(t *testing.T, pool *pgxpool.Pool, repositoryID int64) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below closes the transaction
	var exists bool
	require.NoError(t, tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM repositories WHERE id = $1)`, repositoryID).Scan(&exists))
	if exists {
		mustDurablyDeleteRepoForTest(t, tx, repositoryID)
	}
	require.NoError(t, tx.Commit(ctx))
}

// mustDurablyMoveRepoForTest performs the metadata half of an authorized
// ownership transfer. Exactly one target owner must be supplied.
func mustDurablyMoveRepoForTest(
	t *testing.T,
	tx DBTX,
	repositoryID int64,
	targetUserID pgtype.Int8,
	targetOrgID pgtype.Int8,
) {
	t.Helper()
	pgxTx, ok := tx.(pgx.Tx)
	require.True(t, ok, "durable repository test helper requires one explicit transaction")
	tx = pgxTx
	require.NotEqual(t, targetUserID.Valid, targetOrgID.Valid, "move target must have exactly one owner")
	ctx := context.Background()
	var (
		name        string
		sourceOwner string
		sourceUser  pgtype.Int8
		sourceOrg   pgtype.Int8
		targetOwner string
	)
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT r.name, COALESCE(u.username, o.name), r.user_id, r.org_id
		FROM repositories r
		LEFT JOIN users u ON u.id = r.user_id
		LEFT JOIN organizations o ON o.id = r.org_id
		WHERE r.id = $1
		FOR UPDATE OF r
	`, repositoryID).Scan(&name, &sourceOwner, &sourceUser, &sourceOrg))
	if targetUserID.Valid {
		require.NoError(t, tx.QueryRow(ctx,
			`SELECT username FROM users WHERE id = $1`, targetUserID.Int64).Scan(&targetOwner))
	} else {
		require.NoError(t, tx.QueryRow(ctx,
			`SELECT name FROM organizations WHERE id = $1`, targetOrgID.Int64).Scan(&targetOwner))
	}

	token := newRepositoryStorageOperationToken(t)
	_, err := tx.Exec(ctx, `
		INSERT INTO repository_storage_operations (
			repository_id, operation_type, token, storage_route_key,
			source_owner, source_repo, source_user_id, source_org_id,
			target_owner, target_repo, target_user_id, target_org_id
		) VALUES ($1, 'move', $2, 's1',
			$3, $4, $5, $6, $7, $4, $8, $9)
	`, repositoryID, token, sourceOwner, name, sourceUser, sourceOrg,
		targetOwner, targetUserID, targetOrgID)
	require.NoError(t, err)
	_, err = tx.Exec(ctx,
		`SELECT set_config('smithers.repository_storage_operation_token', $1, TRUE)`, token)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `
		UPDATE repositories SET user_id = $1, org_id = $2 WHERE id = $3
	`, targetUserID, targetOrgID, repositoryID)
	require.NoError(t, err)
	commandTag, err := tx.Exec(ctx,
		`DELETE FROM repository_storage_operations WHERE repository_id = $1 AND token = $2`,
		repositoryID, token)
	require.NoError(t, err)
	require.EqualValues(t, 1, commandTag.RowsAffected())
}

// mustCreateUserAndRepo creates a parent user and a repository owned by that user
// in a single call. It returns both IDs so callers always use dynamically assigned
// IDs instead of hard-coded values. This prevents FK constraint violations from
// missing parent entities — the root cause of SCHEMA-3.
func mustCreateUserAndRepo(t *testing.T, pool DBTX, username, repoName string) (userID int64, repoID int64) {
	t.Helper()

	userID = mustCreateUser(t, pool, username)
	repoID = mustCreateRepo(t, pool, userID, repoName)
	return userID, repoID
}

func mustCreateIssue(t *testing.T, q *Queries, repoID, authorID int64, title string) Issue {
	t.Helper()
	issue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        title,
		Body:         "",
		AuthorID:     authorID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)
	return issue
}

func mustCreateLandingRequest(t *testing.T, q *Queries, repoID, authorID int64, title string) LandingRequest {
	t.Helper()
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          title,
		Body:           "",
		AuthorID:       authorID,
		TargetBookmark: "main",
		StackSize:      0,
	})
	require.NoError(t, err)
	return lr
}

func mustExec(t *testing.T, pool DBTX, query string, args ...any) {
	t.Helper()
	_, err := pool.Exec(context.Background(), query, args...)
	require.NoError(t, err)
}

// --- Unique identifier helpers ---
// These generate globally unique test identifiers to eliminate interference
// between tests that share the same database, even when running in parallel
// or when truncateAll is not called between subtests.

// testSeqCounter is an atomic counter for generating unique identifiers.
var testSeqCounter atomic.Int64

func randSlug(t *testing.T) string {
	t.Helper()
	b := make([]byte, 16)
	_, err := rand.Read(b)
	require.NoError(t, err)
	return hex.EncodeToString(b)
}

// uniqueTestUsername generates a unique username scoped to the calling test.
// Format: "t-{testName}-{seq}" truncated to fit database constraints.
func uniqueTestUsername(t *testing.T) string {
	t.Helper()
	seq := testSeqCounter.Add(1)
	// Use a short hash of test name to keep within reasonable length
	name := strings.ReplaceAll(t.Name(), "/", "-")
	// Truncate name part to keep total under 255 chars
	if len(name) > 40 {
		name = name[:40]
	}
	return fmt.Sprintf("t-%s-%d", strings.ToLower(name), seq)
}

// uniqueTestEmail generates a unique email address scoped to the calling test.
func uniqueTestEmail(t *testing.T) string {
	t.Helper()
	seq := testSeqCounter.Add(1)
	name := strings.ReplaceAll(t.Name(), "/", "-")
	if len(name) > 40 {
		name = name[:40]
	}
	return fmt.Sprintf("t-%s-%d@test.example.com", strings.ToLower(name), seq)
}

// uniqueTestRepoName generates a unique repository name scoped to the calling test.
func uniqueTestRepoName(t *testing.T) string {
	t.Helper()
	seq := testSeqCounter.Add(1)
	name := strings.ReplaceAll(t.Name(), "/", "-")
	if len(name) > 40 {
		name = name[:40]
	}
	return fmt.Sprintf("r-%s-%d", strings.ToLower(name), seq)
}

// TestMustCreateRepo_FailsWithoutParentUser verifies that the product foreign
// key rejects a repository with no parent user.
func TestMustCreateRepo_FailsWithoutParentUser(t *testing.T) {
	_, pool := newQueries(t)

	// Use a user ID that was never inserted.
	const invalidUserID int64 = 999999

	lowerName := strings.ToLower("orphan-repo")
	var id int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number) VALUES ($1, $2, $3, '', TRUE, 'main', 1) RETURNING id`,
		invalidUserID,
		"orphan-repo",
		lowerName,
	).Scan(&id)

	require.Error(t, err, "creating a repo without a valid parent user should fail")
	errMsg := strings.ToLower(err.Error())
	assert.Contains(t, errMsg, "repositories_user_id_fkey")
}

// mustExpectError runs fn inside a savepoint so that any PostgreSQL error
// (e.g. unique-constraint violation) is rolled back without poisoning the
// outer transaction. It asserts that fn returned a non-nil error and returns
// that error so callers can make further assertions (e.g. ErrorIs).
func mustExpectError(t *testing.T, db DBTX, fn func(sp DBTX) error) error {
	t.Helper()
	tx := db.(pgx.Tx)
	sp, err := tx.Begin(context.Background())
	require.NoError(t, err, "failed to create savepoint")
	fnErr := fn(sp)
	if fnErr != nil {
		_ = sp.Rollback(context.Background())
	} else {
		_ = sp.Commit(context.Background())
	}
	require.Error(t, fnErr, "expected an error from the savepoint operation")
	return fnErr
}

// mustExpectQueryError is like mustExpectError but provides a *Queries backed
// by the savepoint transaction so callers can use sqlc-generated methods.
func mustExpectQueryError(t *testing.T, db DBTX, fn func(spQ *Queries) error) error {
	t.Helper()
	return mustExpectError(t, db, func(sp DBTX) error {
		return fn(New(sp))
	})
}

// mustCreateWorkspace creates a root workspace with a unique name, since
// uq_workspaces_active allows one live root workspace per name (#2924).
func mustCreateWorkspace(t *testing.T, pool DBTX, userID, repoID int64) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO workspaces (repository_id, user_id, name) VALUES ($1, $2, $3) RETURNING id`,
		repoID, userID, "ws-"+randSlug(t),
	).Scan(&id)
	require.NoError(t, err)
	return id
}

// mustCreateForkWorkspace creates an explicit fork of parentID, which is
// independent of the parent's named identity.
func mustCreateForkWorkspace(t *testing.T, pool DBTX, userID, repoID int64, parentID string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO workspaces (repository_id, user_id, is_fork, parent_workspace_id) VALUES ($1, $2, TRUE, $3) RETURNING id`,
		repoID, userID, parentID,
	).Scan(&id)
	require.NoError(t, err)
	return id
}

package db

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSchemaLoadsCurrentDDL(t *testing.T) {
	// Schema is loaded once in TestMain; verify it's working by checking
	// that the shared pool can query information_schema.
	var tableCount int
	err := sharedPool.QueryRow(
		context.Background(),
		`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'`,
	).Scan(&tableCount)
	require.NoError(t, err)
	assert.Greater(t, tableCount, 0, "no tables found after schema load")
}

func TestSchemaContract_RequiredTablesExist(t *testing.T) {
	_, pool := newQueries(t)

	requiredTables := []string{
		"auth_sessions", "auth_nonces", "oauth_states", "linear_oauth_setups", "email_addresses", "email_verification_tokens", "oauth_accounts",
		"organizations", "org_members", "teams", "team_members", "team_repos",
		"issues", "issue_comments", "labels", "issue_labels", "milestones", "issue_assignees", "issue_events", "issue_dependencies", "pinned_issues", "reactions", "mentions",
		"landing_requests", "landing_request_changes", "landing_request_reviews", "landing_request_comments",
		"bookmarks", "changes", "conflicts", "protected_bookmarks", "jj_operations",
		"lfs_objects", "lfs_locks",
		"workflow_definitions", "workflow_runs", "workflow_steps", "workflow_tasks", "workflow_logs", "workflow_run_logs", "commit_statuses",
		"agent_sessions", "agent_messages", "agent_parts",
		"notifications", "stars", "watches", "webhooks", "webhook_deliveries",
	}

	for _, table := range requiredTables {
		table := table
		t.Run(table, func(t *testing.T) {
			exists := tableExists(t, pool, table)
			assert.Truef(t, exists, "expected table %q to exist", table)
		})
	}
}

func TestSchemaContract_NoBranchCentricTables(t *testing.T) {
	_, pool := newQueries(t)

	disallowedTables := []string{"branches", "protected_branches", "renamed_branches", "todo_workspaces"}
	for _, table := range disallowedTables {
		table := table
		t.Run(table, func(t *testing.T) {
			exists := tableExists(t, pool, table)
			assert.Falsef(t, exists, "expected branch-centric table %q to not exist", table)
		})
	}
}

func TestSchemaContract_RepositoryUsesDefaultBookmark(t *testing.T) {
	_, pool := newQueries(t)

	assert.True(t, columnExists(t, pool, "repositories", "default_bookmark"))
	assert.False(t, columnExists(t, pool, "repositories", "default_branch"))
	assert.Equal(t, "character varying", columnDataType(t, pool, "repositories", "default_bookmark"))
}

func TestSchemaContract_LandingStackColumnsExist(t *testing.T) {
	_, pool := newQueries(t)

	assert.True(t, columnExists(t, pool, "landing_requests", "target_bookmark"))
	assert.True(t, columnExists(t, pool, "landing_requests", "stack_size"))
	assert.True(t, columnExists(t, pool, "landing_request_changes", "change_id"))
	assert.True(t, columnExists(t, pool, "landing_request_changes", "position_in_stack"))

	assert.Equal(t, "character varying", columnDataType(t, pool, "landing_requests", "target_bookmark"))
	assert.Equal(t, "bigint", columnDataType(t, pool, "landing_requests", "stack_size"))
	assert.Equal(t, "character varying", columnDataType(t, pool, "landing_request_changes", "change_id"))
	assert.Equal(t, "bigint", columnDataType(t, pool, "landing_request_changes", "position_in_stack"))
}

func TestSchemaContract_LandingCommentThreadStateColumnsExist(t *testing.T) {
	_, pool := newQueries(t)

	expected := map[string]string{
		"state":                "character varying",
		"done_at":              "timestamp with time zone",
		"done_by":              "bigint",
		"resolved_in_revision": "jsonb",
		"resolved_at":          "timestamp with time zone",
		"resolved_by":          "bigint",
	}
	for column, dataType := range expected {
		assert.True(t, columnExists(t, pool, "landing_request_comments", column))
		assert.Equal(t, dataType, columnDataType(t, pool, "landing_request_comments", column))
	}
}

func TestSchemaContract_SearchVectorColumnsExist(t *testing.T) {
	_, pool := newQueries(t)

	assert.True(t, columnExists(t, pool, "repositories", "search_vector"))
	assert.True(t, columnExists(t, pool, "issues", "search_vector"))
	assert.True(t, columnExists(t, pool, "users", "search_vector"))

	assert.Equal(t, "tsvector", columnDataType(t, pool, "repositories", "search_vector"))
	assert.Equal(t, "tsvector", columnDataType(t, pool, "issues", "search_vector"))
	assert.Equal(t, "tsvector", columnDataType(t, pool, "users", "search_vector"))
}

func TestSchemaContract_SearchVectorGINIndexesExist(t *testing.T) {
	_, pool := newQueries(t)

	tests := []struct {
		table  string
		column string
	}{
		{table: "repositories", column: "search_vector"},
		{table: "issues", column: "search_vector"},
		{table: "users", column: "search_vector"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.table, func(t *testing.T) {
			var count int64
			err := pool.QueryRow(
				context.Background(),
				`SELECT COUNT(*)
				 FROM pg_indexes
				 WHERE schemaname = 'public'
				   AND tablename = $1
				   AND indexdef ILIKE '%USING gin%'
				   AND indexdef ILIKE '%' || $2 || '%'`,
				tc.table,
				tc.column,
			).Scan(&count)
			require.NoError(t, err)
			assert.Greaterf(t, count, int64(0), "expected GIN index on %s.%s", tc.table, tc.column)
		})
	}
}

func TestSchemaContract_SearchVectorTriggersExist(t *testing.T) {
	_, pool := newQueries(t)

	tests := []string{
		"repositories",
		"issues",
		"users",
	}

	for _, table := range tests {
		table := table
		t.Run(table, func(t *testing.T) {
			var count int64
			err := pool.QueryRow(
				context.Background(),
				`SELECT COUNT(*)
				 FROM information_schema.triggers
				 WHERE event_object_schema = 'public'
				   AND event_object_table = $1
				   AND trigger_name ILIKE '%search_vector%'`,
				table,
			).Scan(&count)
			require.NoError(t, err)
			assert.Greaterf(t, count, int64(0), "expected search vector trigger on %s", table)
		})
	}
}

func TestSchemaContract_WorkflowTasksQueueColumns(t *testing.T) {
	_, pool := newQueries(t)

	assert.True(t, columnExists(t, pool, "workflow_tasks", "priority"))
	assert.Equal(t, "smallint", columnDataType(t, pool, "workflow_tasks", "priority"))

	var priorityDefault string
	err := pool.QueryRow(
		context.Background(),
		`SELECT column_default
		 FROM information_schema.columns
		 WHERE table_schema = 'public'
		   AND table_name = 'workflow_tasks'
		   AND column_name = 'priority'`,
	).Scan(&priorityDefault)
	require.NoError(t, err)
	assert.Contains(t, priorityDefault, "1")

	assert.True(t, columnExists(t, pool, "workflow_tasks", "runner_id"))
	assert.Equal(t, "bigint", columnDataType(t, pool, "workflow_tasks", "runner_id"))
	assert.True(t, columnExists(t, pool, "workflow_tasks", "assigned_at"))
	assert.False(t, columnExists(t, pool, "workflow_tasks", "claimed_by"))
	assert.False(t, columnExists(t, pool, "workflow_tasks", "claimed_at"))

	var privateRunnerFKs int
	err = pool.QueryRow(
		context.Background(),
		`SELECT count(*)
		 FROM information_schema.table_constraints tc
		 JOIN information_schema.key_column_usage kcu
		   ON tc.constraint_name = kcu.constraint_name
		  AND tc.table_schema = kcu.table_schema
		 JOIN information_schema.constraint_column_usage ccu
		   ON tc.constraint_name = ccu.constraint_name
		  AND tc.table_schema = ccu.table_schema
		 WHERE tc.table_schema = 'public'
		   AND tc.table_name = 'workflow_tasks'
		   AND tc.constraint_type = 'FOREIGN KEY'
		   AND kcu.column_name = 'runner_id'`,
	).Scan(&privateRunnerFKs)
	require.NoError(t, err)
	assert.Zero(t, privateRunnerFKs, "product tasks must not depend on the private runner pool")

	rows, err := pool.Query(
		context.Background(),
		`SELECT pg_get_constraintdef(oid)
		 FROM pg_constraint
		 WHERE conrelid = 'workflow_tasks'::regclass
		   AND contype = 'c'`,
	)
	require.NoError(t, err)
	defer rows.Close()

	var checks []string
	for rows.Next() {
		var checkDef string
		require.NoError(t, rows.Scan(&checkDef))
		checks = append(checks, strings.ToLower(checkDef))
	}
	require.NoError(t, rows.Err())
	require.NotEmpty(t, checks)

	checkJoined := strings.Join(checks, "\n")
	assert.Contains(t, checkJoined, "status")
	assert.Contains(t, checkJoined, "pending")
	assert.Contains(t, checkJoined, "assigned")
	assert.Contains(t, checkJoined, "priority")
	assert.Contains(t, checkJoined, ">= 0")
	assert.Contains(t, checkJoined, "<= 3")
}

func TestSchemaContract_WorkflowTasksPendingDequeueIndex(t *testing.T) {
	_, pool := newQueries(t)

	var indexDef string
	err := pool.QueryRow(
		context.Background(),
		`SELECT indexdef
		 FROM pg_indexes
		 WHERE schemaname = 'public'
		   AND tablename = 'workflow_tasks'
		   AND indexname = 'idx_workflow_tasks_pending_dequeue'`,
	).Scan(&indexDef)
	require.NoError(t, err)

	lowerDef := strings.ToLower(indexDef)
	assert.Contains(t, lowerDef, "priority desc")
	assert.Contains(t, lowerDef, "available_at")
	assert.Contains(t, lowerDef, "created_at")
	assert.Contains(t, lowerDef, "id")
	assert.Contains(t, lowerDef, "where")
	assert.Contains(t, lowerDef, "'pending'")
}

func TestSchemaContract_WorkflowTasksRunnerIndex(t *testing.T) {
	_, pool := newQueries(t)

	var indexDef string
	err := pool.QueryRow(
		context.Background(),
		`SELECT indexdef
		 FROM pg_indexes
		 WHERE schemaname = 'public'
		   AND tablename = 'workflow_tasks'
		   AND indexname = 'idx_workflow_tasks_runner_id'`,
	).Scan(&indexDef)
	require.NoError(t, err)

	lowerDef := strings.ToLower(indexDef)
	assert.Contains(t, lowerDef, "runner_id")
}

func TestSchemaContract_BookmarksConstraints(t *testing.T) {
	_, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "bookmarks-constraints-user")
	repoID := mustCreateRepo(t, pool, userID, "bookmarks-constraints-repo")

	var bookmarkID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO bookmarks (repository_id, name, target_change_id, is_default)
		 VALUES ($1, 'main', 'change-main', TRUE) RETURNING id`,
		repoID,
	).Scan(&bookmarkID)
	require.NoError(t, err)
	assert.Positive(t, bookmarkID)

	mustExpectError(t, pool, func(sp DBTX) error {
		_, err := sp.Exec(
			context.Background(),
			`INSERT INTO bookmarks (repository_id, name, target_change_id, is_default)
			 VALUES ($1, 'main', 'change-main-2', FALSE)`,
			repoID,
		)
		return err
	})

	_, err = pool.Exec(
		context.Background(),
		`INSERT INTO bookmarks (repository_id, name, target_change_id, is_default)
		 VALUES ($1, 'trunk', 'change-trunk', TRUE)`,
		repoID,
	)
	require.Error(t, err)
}

func TestSchemaContract_ChangesConstraints(t *testing.T) {
	_, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "changes-constraints-user")
	repoID := mustCreateRepo(t, pool, userID, "changes-constraints-repo")

	var changeID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO changes (
			repository_id, change_id, commit_id, description, author_name, author_email, parent_change_ids
		) VALUES (
			$1, 'kabc123', 'commit-1', 'Initial change', 'Alice', 'alice@example.com', '[]'::jsonb
		) RETURNING id`,
		repoID,
	).Scan(&changeID)
	require.NoError(t, err)
	assert.Positive(t, changeID)

	mustExpectError(t, pool, func(sp DBTX) error {
		_, err := sp.Exec(
			context.Background(),
			`INSERT INTO changes (
				repository_id, change_id, commit_id, description, author_name, author_email, parent_change_ids
			) VALUES (
				$1, 'kabc123', 'commit-2', 'Duplicate change', 'Alice', 'alice@example.com', '[]'::jsonb
			)`,
			repoID,
		)
		return err
	})

	_, err = pool.Exec(
		context.Background(),
		`INSERT INTO changes (
			repository_id, change_id, commit_id, description, author_name, author_email, parent_change_ids
		) VALUES (
			$1, 'kbadjson', 'commit-3', 'Bad shape', 'Alice', 'alice@example.com', '{"parent":"oops"}'::jsonb
		)`,
		repoID,
	)
	require.Error(t, err)
}

func TestSchemaContract_ChangesListIndexMatchesListQueryOrder(t *testing.T) {
	_, pool := newQueries(t)

	var indexDef string
	err := pool.QueryRow(
		context.Background(),
		`SELECT indexdef
		 FROM pg_indexes
		 WHERE schemaname = 'public'
		   AND tablename = 'changes'
		   AND indexname = 'idx_changes_repo_id_desc'`,
	).Scan(&indexDef)
	require.NoError(t, err)
	assert.Contains(t, indexDef, "(repository_id, id DESC)")
}

func TestSchemaContract_ConflictsConstraints(t *testing.T) {
	_, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "conflicts-constraints-user")
	repoID := mustCreateRepo(t, pool, userID, "conflicts-constraints-repo")

	var conflictID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO conflicts (repository_id, change_id, file_path, conflict_type)
		 VALUES ($1, 'kabc123', 'README.md', 'content') RETURNING id`,
		repoID,
	).Scan(&conflictID)
	require.NoError(t, err)
	assert.Positive(t, conflictID)

	_, err = pool.Exec(
		context.Background(),
		`INSERT INTO conflicts (repository_id, change_id, file_path, conflict_type)
		 VALUES ($1, 'kabc123', 'README.md', 'content')`,
		repoID,
	)
	require.Error(t, err)
}

func TestSchemaContract_ProtectedBookmarksConstraints(t *testing.T) {
	_, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "protected-bookmarks-constraints-user")
	repoID := mustCreateRepo(t, pool, userID, "protected-bookmarks-constraints-repo")

	var ruleID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO protected_bookmarks (repository_id, pattern, require_review, require_human_approvals)
		 VALUES ($1, 'main', TRUE, 1) RETURNING id`,
		repoID,
	).Scan(&ruleID)
	require.NoError(t, err)
	assert.Positive(t, ruleID)

	_, err = pool.Exec(
		context.Background(),
		`INSERT INTO protected_bookmarks (repository_id, pattern, require_review, require_human_approvals)
		 VALUES ($1, 'main', TRUE, 2)`,
		repoID,
	)
	require.Error(t, err)
}

func TestSchemaContract_JjOperationsConstraints(t *testing.T) {
	_, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "jj-operations-constraints-user")
	repoID := mustCreateRepo(t, pool, userID, "jj-operations-constraints-repo")

	var operationRowID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO jj_operations (repository_id, operation_id, operation_type, description, user_id)
		 VALUES ($1, 'op-1', 'rebase', 'first operation', $2) RETURNING id`,
		repoID,
		userID,
	).Scan(&operationRowID)
	require.NoError(t, err)
	assert.Positive(t, operationRowID)

	_, err = pool.Exec(
		context.Background(),
		`INSERT INTO jj_operations (repository_id, operation_id, operation_type, description, user_id)
		 VALUES ($1, 'op-1', 'describe', 'duplicate operation id', $2)`,
		repoID,
		userID,
	)
	require.Error(t, err)
}

func TestSchemaContract_IDAndTimestampConventions(t *testing.T) {
	_, pool := newQueries(t)

	idTables := []string{
		"users", "repositories", "access_tokens", "ssh_keys", "email_addresses", "organizations", "issues", "landing_requests", "workflow_runs", "notifications", "webhooks",
	}

	for _, table := range idTables {
		table := table
		t.Run(fmt.Sprintf("%s.id_is_bigint", table), func(t *testing.T) {
			dt := columnDataType(t, pool, table, "id")
			assert.Equal(t, "bigint", dt)
		})
	}

	timestampColumns := []struct {
		table  string
		column string
	}{
		{table: "users", column: "created_at"},
		{table: "users", column: "updated_at"},
		{table: "repositories", column: "created_at"},
		{table: "repositories", column: "updated_at"},
		{table: "issues", column: "created_at"},
		{table: "issues", column: "updated_at"},
		{table: "landing_requests", column: "created_at"},
		{table: "landing_requests", column: "updated_at"},
		{table: "workflow_runs", column: "created_at"},
		{table: "notifications", column: "created_at"},
	}

	for _, tc := range timestampColumns {
		tc := tc
		t.Run(fmt.Sprintf("%s.%s_is_timestamptz", tc.table, tc.column), func(t *testing.T) {
			dt := columnDataType(t, pool, tc.table, tc.column)
			assert.Equal(t, "timestamp with time zone", dt)
		})
	}

	t.Run("auth_sessions.session_key_is_text", func(t *testing.T) {
		dt := columnDataType(t, pool, "auth_sessions", "session_key")
		assert.Equal(t, "text", dt)
	})

	t.Run("agent_sessions.id_is_uuid", func(t *testing.T) {
		dt := columnDataType(t, pool, "agent_sessions", "id")
		assert.Equal(t, "uuid", dt)
	})
}

func TestSchemaContract_RepoScopedNumberingAndJoinUniqueness(t *testing.T) {
	_, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "schema-contract-user")
	repoID := mustCreateRepo(t, pool, userID, "schema-contract-repo")

	var issueID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO issues (repository_id, number, title, body, state, author_id) VALUES ($1, 1, 'Issue 1', '', 'open', $2) RETURNING id`,
		repoID,
		userID,
	).Scan(&issueID)
	require.NoError(t, err)

	mustExpectError(t, pool, func(sp DBTX) error {
		_, err := sp.Exec(
			context.Background(),
			`INSERT INTO issues (repository_id, number, title, body, state, author_id) VALUES ($1, 1, 'Issue duplicate', '', 'open', $2)`,
			repoID,
			userID,
		)
		return err
	})

	var labelID int64
	err = pool.QueryRow(
		context.Background(),
		`INSERT INTO labels (repository_id, name, color) VALUES ($1, 'bug', '#ff0000') RETURNING id`,
		repoID,
	).Scan(&labelID)
	require.NoError(t, err)

	mustExec(t, pool, `INSERT INTO issue_labels (issue_id, label_id) VALUES ($1, $2)`, issueID, labelID)
	mustExpectError(t, pool, func(sp DBTX) error {
		_, err := sp.Exec(context.Background(), `INSERT INTO issue_labels (issue_id, label_id) VALUES ($1, $2)`, issueID, labelID)
		return err
	})

	var teamID int64
	err = pool.QueryRow(
		context.Background(),
		`INSERT INTO organizations (name, lower_name, description) VALUES ('Acme', 'acme', '') RETURNING id`,
	).Scan(&teamID)
	require.NoError(t, err)

	var realTeamID int64
	err = pool.QueryRow(
		context.Background(),
		`INSERT INTO teams (organization_id, name, lower_name, permission) VALUES ($1, 'core', 'core', 'write') RETURNING id`,
		teamID,
	).Scan(&realTeamID)
	require.NoError(t, err)

	mustExec(t, pool, `INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, realTeamID, userID)
	mustExpectError(t, pool, func(sp DBTX) error {
		_, err := sp.Exec(context.Background(), `INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, realTeamID, userID)
		return err
	})

	mustExec(t, pool, `INSERT INTO team_repos (team_id, repository_id) VALUES ($1, $2)`, realTeamID, repoID)
	_, err = pool.Exec(context.Background(), `INSERT INTO team_repos (team_id, repository_id) VALUES ($1, $2)`, realTeamID, repoID)
	require.Error(t, err)
}

func TestSchemaContract_RepositoryOwnershipAndBookmarkNaming(t *testing.T) {
	_, pool := newQueries(t)
	userA := mustCreateUser(t, pool, "owner-a")

	var orgID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO organizations (name, lower_name, description, visibility) VALUES ('org-repo', 'org-repo', '', 'public') RETURNING id`,
	).Scan(&orgID)
	require.NoError(t, err)

	var defaultBookmarkDataType string
	err = pool.QueryRow(
		context.Background(),
		`SELECT data_type FROM information_schema.columns
		 WHERE table_schema='public' AND table_name='repositories' AND column_name='default_bookmark'`,
	).Scan(&defaultBookmarkDataType)
	require.NoError(t, err)
	assert.Equal(t, "character varying", defaultBookmarkDataType)

	var legacyBranchColumnCount int64
	err = pool.QueryRow(
		context.Background(),
		`SELECT COUNT(*) FROM information_schema.columns
		 WHERE table_schema='public' AND table_name='repositories' AND column_name='default_branch'`,
	).Scan(&legacyBranchColumnCount)
	require.NoError(t, err)
	assert.Equal(t, int64(0), legacyBranchColumnCount)

	// Namespace uniqueness for org repos: same org + same lower_name must conflict even across different users.
	mustExec(t, pool, `
		INSERT INTO repositories (org_id, name, lower_name, description, is_public, default_bookmark) VALUES ($1, 'shared', 'shared', '', TRUE, 'main')
	`, orgID)

	mustExpectError(t, pool, func(sp DBTX) error {
		_, err := sp.Exec(
			context.Background(),
			`INSERT INTO repositories (org_id, name, lower_name, description, is_public, default_bookmark) VALUES ($1, 'shared', 'shared', '', TRUE, 'main')`,
			orgID,
		)
		return err
	})

	// Repository owner must be exactly one namespace (user or org), not both or neither.
	mustExpectError(t, pool, func(sp DBTX) error {
		_, err := sp.Exec(
			context.Background(),
			`INSERT INTO repositories (name, lower_name, description, is_public, default_bookmark) VALUES ('no-owner', 'no-owner', '', TRUE, 'main')`,
		)
		return err
	})

	_, err = pool.Exec(
		context.Background(),
		`INSERT INTO repositories (user_id, org_id, name, lower_name, description, is_public, default_bookmark) VALUES ($1, $2, 'dual-owner', 'dual-owner', '', TRUE, 'main')`,
		userA,
		orgID,
	)
	require.Error(t, err)
}

func TestSchemaContract_OAuthTokensNotStoredAsPlaintextColumns(t *testing.T) {
	_, pool := newQueries(t)

	var accessTokenType string
	err := pool.QueryRow(
		context.Background(),
		`SELECT data_type FROM information_schema.columns
		 WHERE table_schema='public' AND table_name='oauth_accounts' AND column_name='access_token_encrypted'`,
	).Scan(&accessTokenType)
	require.NoError(t, err)
	assert.Equal(t, "bytea", accessTokenType)

	var refreshTokenType string
	err = pool.QueryRow(
		context.Background(),
		`SELECT data_type FROM information_schema.columns
		 WHERE table_schema='public' AND table_name='oauth_accounts' AND column_name='refresh_token_encrypted'`,
	).Scan(&refreshTokenType)
	require.NoError(t, err)
	assert.Equal(t, "bytea", refreshTokenType)

	var plaintextColumns int64
	err = pool.QueryRow(
		context.Background(),
		`SELECT COUNT(*) FROM information_schema.columns
		 WHERE table_schema='public' AND table_name='oauth_accounts' AND column_name IN ('access_token', 'refresh_token')`,
	).Scan(&plaintextColumns)
	require.NoError(t, err)
	assert.Equal(t, int64(0), plaintextColumns)
}

func tableExists(t *testing.T, pool DBTX, table string) bool {
	t.Helper()

	var exists bool
	err := pool.QueryRow(
		context.Background(),
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = $1
		)`,
		table,
	).Scan(&exists)
	require.NoError(t, err)
	return exists
}

func columnDataType(t *testing.T, pool DBTX, table, column string) string {
	t.Helper()

	var dataType string
	err := pool.QueryRow(
		context.Background(),
		`SELECT data_type
		 FROM information_schema.columns
		 WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
		table,
		column,
	).Scan(&dataType)
	require.NoErrorf(t, err, "missing %s.%s", table, column)
	return dataType
}

func TestSchemaContract_UserWalletAddressUniqueWhenNonNull(t *testing.T) {
	_, pool := newQueries(t)

	// Create two users with wallet addresses
	userA := mustCreateUser(t, pool, "wallet-uniq-a")
	userB := mustCreateUser(t, pool, "wallet-uniq-b")

	wallet := "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	mustExec(t, pool, `UPDATE users SET wallet_address = $1 WHERE id = $2`, wallet, userA)

	// Duplicate wallet_address must be rejected
	mustExpectError(t, pool, func(sp DBTX) error {
		_, err := sp.Exec(
			context.Background(),
			`UPDATE users SET wallet_address = $1 WHERE id = $2`,
			wallet,
			userB,
		)
		return err
	})

	// NULL wallet_address should not conflict
	userC := mustCreateUser(t, pool, "wallet-uniq-c")
	_ = userC // wallet_address is NULL by default — no conflict expected

	// Verify the unique index exists and is partial (WHERE wallet_address IS NOT NULL)
	var indexDef string
	err := pool.QueryRow(
		context.Background(),
		`SELECT indexdef FROM pg_indexes
		 WHERE schemaname = 'public'
		   AND tablename = 'users'
		   AND indexname = 'uq_users_wallet_address'`,
	).Scan(&indexDef)
	require.NoError(t, err)
	lowerDef := strings.ToLower(indexDef)
	assert.Contains(t, lowerDef, "unique")
	assert.Contains(t, lowerDef, "wallet_address")
	assert.Contains(t, lowerDef, "where")
	assert.Contains(t, lowerDef, "is not null")
}

func TestSchemaContract_LandingRequestsQueueColumnsAndStateCheck(t *testing.T) {
	_, pool := newQueries(t)

	// Columns must exist with correct types
	assert.True(t, columnExists(t, pool, "landing_requests", "queued_by"), "queued_by column must exist")
	assert.True(t, columnExists(t, pool, "landing_requests", "queued_at"), "queued_at column must exist")
	assert.True(t, columnExists(t, pool, "landing_requests", "landing_started_at"), "landing_started_at column must exist")

	assert.Equal(t, "bigint", columnDataType(t, pool, "landing_requests", "queued_by"))
	assert.Equal(t, "timestamp with time zone", columnDataType(t, pool, "landing_requests", "queued_at"))
	assert.Equal(t, "timestamp with time zone", columnDataType(t, pool, "landing_requests", "landing_started_at"))

	// queued_by must have FK to users(id) with ON DELETE SET NULL
	var referencedTable string
	var referencedColumn string
	err := pool.QueryRow(
		context.Background(),
		`SELECT ccu.table_name, ccu.column_name
		 FROM information_schema.table_constraints tc
		 JOIN information_schema.key_column_usage kcu
		   ON tc.constraint_name = kcu.constraint_name
		  AND tc.table_schema = kcu.table_schema
		 JOIN information_schema.constraint_column_usage ccu
		   ON tc.constraint_name = ccu.constraint_name
		  AND tc.table_schema = ccu.table_schema
		 WHERE tc.table_schema = 'public'
		   AND tc.table_name = 'landing_requests'
		   AND tc.constraint_type = 'FOREIGN KEY'
		   AND kcu.column_name = 'queued_by'`,
	).Scan(&referencedTable, &referencedColumn)
	require.NoError(t, err, "queued_by must have a FK constraint")
	assert.Equal(t, "users", referencedTable)
	assert.Equal(t, "id", referencedColumn)

	// Verify ON DELETE SET NULL behavior for queued_by FK
	var deleteAction string
	err = pool.QueryRow(
		context.Background(),
		`SELECT rc.delete_rule
		 FROM information_schema.referential_constraints rc
		 JOIN information_schema.key_column_usage kcu
		   ON rc.constraint_name = kcu.constraint_name
		  AND rc.constraint_schema = kcu.constraint_schema
		 WHERE kcu.table_schema = 'public'
		   AND kcu.table_name = 'landing_requests'
		   AND kcu.column_name = 'queued_by'`,
	).Scan(&deleteAction)
	require.NoError(t, err)
	assert.Equal(t, "SET NULL", deleteAction)

	// CHECK constraint for state must include all 6 values: open, closed, merged, draft, queued, landing
	rows, err := pool.Query(
		context.Background(),
		`SELECT pg_get_constraintdef(oid)
		 FROM pg_constraint
		 WHERE conrelid = 'landing_requests'::regclass
		   AND contype = 'c'`,
	)
	require.NoError(t, err)
	defer rows.Close()

	var checks []string
	for rows.Next() {
		var checkDef string
		require.NoError(t, rows.Scan(&checkDef))
		checks = append(checks, strings.ToLower(checkDef))
	}
	require.NoError(t, rows.Err())
	require.NotEmpty(t, checks, "landing_requests must have CHECK constraints")

	checkJoined := strings.Join(checks, "\n")
	// Verify the state CHECK includes all required values
	for _, requiredState := range []string{"open", "closed", "merged", "draft", "queued", "landing"} {
		assert.Contains(t, checkJoined, requiredState, "state CHECK must include '%s'", requiredState)
	}
}

func TestSchemaContract_UserLowerEmailUniqueWhenNonNull(t *testing.T) {
	_, pool := newQueries(t)

	// Create two users with lower_email
	userA := mustCreateUser(t, pool, "email-uniq-a")
	userB := mustCreateUser(t, pool, "email-uniq-b")

	email := "shared@example.com"
	mustExec(t, pool, `UPDATE users SET email = $1, lower_email = $2 WHERE id = $3`, email, email, userA)

	// Duplicate lower_email must be rejected
	mustExpectError(t, pool, func(sp DBTX) error {
		_, err := sp.Exec(
			context.Background(),
			`UPDATE users SET email = $1, lower_email = $2 WHERE id = $3`,
			email,
			email,
			userB,
		)
		return err
	})

	// NULL lower_email should not conflict
	userC := mustCreateUser(t, pool, "email-uniq-c")
	_ = userC // lower_email is NULL by default — no conflict expected

	// Verify the unique index exists and is partial (WHERE lower_email IS NOT NULL)
	var indexDef string
	err := pool.QueryRow(
		context.Background(),
		`SELECT indexdef FROM pg_indexes
		 WHERE schemaname = 'public'
		   AND tablename = 'users'
		   AND indexname = 'uq_users_lower_email'`,
	).Scan(&indexDef)
	require.NoError(t, err)
	lowerDef := strings.ToLower(indexDef)
	assert.Contains(t, lowerDef, "unique")
	assert.Contains(t, lowerDef, "lower_email")
	assert.Contains(t, lowerDef, "where")
	assert.Contains(t, lowerDef, "is not null")
}

// --- can_view_repository() SQL function tests ---

func callCanViewRepository(t *testing.T, pool DBTX, repoID, viewerID int64) bool {
	t.Helper()
	var result bool
	err := pool.QueryRow(
		context.Background(),
		`SELECT can_view_repository($1, $2)`,
		repoID, viewerID,
	).Scan(&result)
	require.NoError(t, err)
	return result
}

func mustAddCollaborator(t *testing.T, pool DBTX, repoID, userID int64, permission string) {
	t.Helper()
	mustExec(t, pool,
		`INSERT INTO collaborators (repository_id, user_id, permission) VALUES ($1, $2, $3)`,
		repoID, userID, permission,
	)
}

func TestCanViewRepository_PublicRepoVisibleToAnonymousAndUsers(t *testing.T) {
	_, pool := newQueries(t)

	ownerID := mustCreateUser(t, pool, "cvr-public-owner")
	otherID := mustCreateUser(t, pool, "cvr-public-other")
	repoID := mustCreateRepo(t, pool, ownerID, "cvr-public-repo")

	// Public repo visible to anonymous (viewer_id=0)
	assert.True(t, callCanViewRepository(t, pool, repoID, 0),
		"public repo should be visible to anonymous viewer")

	// Public repo visible to authenticated non-owner
	assert.True(t, callCanViewRepository(t, pool, repoID, otherID),
		"public repo should be visible to authenticated user")

	// Public repo visible to owner
	assert.True(t, callCanViewRepository(t, pool, repoID, ownerID),
		"public repo should be visible to owner")
}

func TestCanViewRepository_PrivateUserRepoOwnerAllowedOutsiderDenied(t *testing.T) {
	_, pool := newQueries(t)

	ownerID := mustCreateUser(t, pool, "cvr-priv-owner")
	outsiderID := mustCreateUser(t, pool, "cvr-priv-outsider")

	var repoID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark) VALUES ($1, 'cvr-priv-repo', 'cvr-priv-repo', '', FALSE, 'main') RETURNING id`,
		ownerID,
	).Scan(&repoID)
	require.NoError(t, err)

	// Owner can view
	assert.True(t, callCanViewRepository(t, pool, repoID, ownerID),
		"private repo owner should be able to view")

	// Outsider cannot view
	assert.False(t, callCanViewRepository(t, pool, repoID, outsiderID),
		"outsider should not be able to view private user repo")

	// Anonymous cannot view
	assert.False(t, callCanViewRepository(t, pool, repoID, 0),
		"anonymous should not be able to view private user repo")
}

func TestCanViewRepository_PrivateOrgRepoMemberWithoutTeamDenied(t *testing.T) {
	_, pool := newQueries(t)

	memberID := mustCreateUser(t, pool, "cvr-orgmember-noteam")
	orgID := mustCreateOrganization(t, pool, "CVR-NoTeam-Org")
	repoID := mustCreateOrgRepo(t, pool, orgID, "cvr-org-private", false)

	// Add user as org member with role='member' (not owner)
	mustAddOrgMember(t, pool, orgID, memberID, "member")

	// Org member without team assignment should NOT see private repo
	assert.False(t, callCanViewRepository(t, pool, repoID, memberID),
		"org member without team assignment should not see private org repo")
}

func TestCanViewRepository_PrivateOrgRepoOrgOwnerAllowed(t *testing.T) {
	_, pool := newQueries(t)

	ownerID := mustCreateUser(t, pool, "cvr-orgowner")
	orgID := mustCreateOrganization(t, pool, "CVR-Owner-Org")
	repoID := mustCreateOrgRepo(t, pool, orgID, "cvr-org-owner-repo", false)

	// Add user as org owner
	mustAddOrgMember(t, pool, orgID, ownerID, "owner")

	// Org owner should see all org repos
	assert.True(t, callCanViewRepository(t, pool, repoID, ownerID),
		"org owner should be able to view private org repo")
}

func TestCanViewRepository_PrivateOrgRepoTeamMemberAllowed(t *testing.T) {
	_, pool := newQueries(t)

	teamUserID := mustCreateUser(t, pool, "cvr-team-member")
	orgID := mustCreateOrganization(t, pool, "CVR-Team-Org")
	repoID := mustCreateOrgRepo(t, pool, orgID, "cvr-team-repo", false)

	// Add user as org member (role='member')
	mustAddOrgMember(t, pool, orgID, teamUserID, "member")

	// Create team, add user to team, assign repo to team
	teamID := mustCreateTeam(t, pool, orgID, "CVR-Core")
	mustAddTeamMember(t, pool, teamID, teamUserID)
	mustAddTeamRepo(t, pool, teamID, repoID)

	// Team member with repo assigned should see private repo
	assert.True(t, callCanViewRepository(t, pool, repoID, teamUserID),
		"team member with repo assignment should be able to view private org repo")
}

func TestCanViewRepository_PrivateUserRepoCollaboratorAllowed(t *testing.T) {
	_, pool := newQueries(t)

	ownerID := mustCreateUser(t, pool, "cvr-collab-owner")
	collaboratorID := mustCreateUser(t, pool, "cvr-collab-user")
	outsiderID := mustCreateUser(t, pool, "cvr-collab-outsider")

	var repoID int64
	err := pool.QueryRow(
		context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark) VALUES ($1, 'cvr-collab-repo', 'cvr-collab-repo', '', FALSE, 'main') RETURNING id`,
		ownerID,
	).Scan(&repoID)
	require.NoError(t, err)

	assert.False(t, callCanViewRepository(t, pool, repoID, collaboratorID),
		"user should not be able to view private user repo before collaborator assignment")

	mustAddCollaborator(t, pool, repoID, collaboratorID, "read")

	assert.True(t, callCanViewRepository(t, pool, repoID, collaboratorID),
		"explicit collaborator should be able to view private user repo")
	assert.False(t, callCanViewRepository(t, pool, repoID, outsiderID),
		"non-collaborator outsider should not be able to view private user repo")
}

func TestCanViewRepository_PrivateOrgRepoCollaboratorAllowedWithoutTeamMembership(t *testing.T) {
	_, pool := newQueries(t)

	orgID := mustCreateOrganization(t, pool, "CVR-Collab-Org")
	repoID := mustCreateOrgRepo(t, pool, orgID, "cvr-org-collab-repo", false)
	collaboratorID := mustCreateUser(t, pool, "cvr-org-collab-user")
	outsiderID := mustCreateUser(t, pool, "cvr-org-collab-outsider")

	assert.False(t, callCanViewRepository(t, pool, repoID, collaboratorID),
		"user should not be able to view private org repo before collaborator assignment")

	mustAddCollaborator(t, pool, repoID, collaboratorID, "read")

	assert.True(t, callCanViewRepository(t, pool, repoID, collaboratorID),
		"explicit collaborator should be able to view private org repo without team assignment")
	assert.False(t, callCanViewRepository(t, pool, repoID, outsiderID),
		"non-collaborator outsider should not be able to view private org repo")
}

func columnExists(t *testing.T, pool DBTX, table, column string) bool {
	t.Helper()

	var exists bool
	err := pool.QueryRow(
		context.Background(),
		`SELECT EXISTS (
			SELECT 1
			FROM information_schema.columns
			WHERE table_schema = 'public'
			  AND table_name = $1
			  AND column_name = $2
		)`,
		table,
		column,
	).Scan(&exists)
	require.NoError(t, err)
	return exists
}

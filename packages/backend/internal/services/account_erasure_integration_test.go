package services

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type erasureFixture struct {
	admin, a, b          int64
	aName, bName         string
	aRepo, bRepo         int64
	aRepoName, bRepoName string
	aWorkspace, aVM      string
	bIssue, aComment     int64
	creditAccount        int64
}

// seedErasureFixture seeds user A with owned data across the data classes an
// erase must remove or retain, and user B with a repository of its own that A
// commented on.
func seedErasureFixture(t *testing.T, pool *pgxpool.Pool) erasureFixture {
	t.Helper()
	ctx := context.Background()
	base := time.Now().UnixNano()
	f := erasureFixture{
		admin: base, a: base + 1, b: base + 2,
		aName: fmt.Sprintf("erase-a-%d", base), bName: fmt.Sprintf("erase-b-%d", base),
		aRepoName: "a-repo", bRepoName: "b-repo",
		aWorkspace: uuid.NewString(), aVM: fmt.Sprintf("vm-%d", base),
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err, sql)
	}
	exec(`INSERT INTO users(id,username,lower_username,is_admin) VALUES ($1,$2,$2,true)`, f.admin, fmt.Sprintf("erase-admin-%d", base))
	exec(`INSERT INTO users(id,username,lower_username,email,lower_email,display_name,bio,avatar_url)
	      VALUES ($1,$2,$2,$3,$3,'Alice Example','alice bio','https://example.com/a.png')`, f.a, f.aName, f.aName+"@example.com")
	exec(`INSERT INTO users(id,username,lower_username,email,lower_email,display_name) VALUES ($1,$2,$2,$3,$3,'Bob')`, f.b, f.bName, f.bName+"@example.com")
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,$2,$2) RETURNING id`, f.a, f.aRepoName).Scan(&f.aRepo))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,$2,$2) RETURNING id`, f.b, f.bRepoName).Scan(&f.bRepo))
	exec(`INSERT INTO workspaces(id,user_id,repository_id,name,kind,status,vm_id) VALUES ($1,$2,$3,'dev','vm','running',$4)`, f.aWorkspace, f.a, f.aRepo, f.aVM)
	exec(`INSERT INTO access_tokens(user_id,token_hash,name) VALUES ($1,$2,'cli')`, f.a, fmt.Sprintf("hash-%d", base))
	exec(`INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')`, fmt.Sprintf("sess-%d", base), f.a, f.aName)
	exec(`INSERT INTO ssh_keys(user_id,name,fingerprint,public_key) VALUES ($1,'laptop',$2,'ssh-ed25519 AAAA')`, f.a, fmt.Sprintf("SHA256:%d", base))
	exec(`INSERT INTO provider_connections(owner_type,user_id,provider,kind,access_token_encrypted) VALUES ('user',$1,'claude','oauth','\x00')`, f.a)
	exec(`INSERT INTO chat_turns(id,repository_id,user_id,run_id,leg_id,request_hash,access_hash,state) VALUES ($1,$2,$3,'run','leg','rh','ah','completed')`, uuid.NewString(), f.aRepo, f.a)
	// B comments on A's repository; A comments on B's repository.
	var aIssue int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO issues(repository_id,number,title,author_id) VALUES ($1,1,'a issue',$2) RETURNING id`, f.aRepo, f.a).Scan(&aIssue))
	exec(`INSERT INTO issue_comments(issue_id,user_id,body) VALUES ($1,$2,'b on a')`, aIssue, f.b)
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO issues(repository_id,number,title,author_id) VALUES ($1,1,'b issue',$2) RETURNING id`, f.bRepo, f.b).Scan(&f.bIssue))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO issue_comments(issue_id,user_id,body) VALUES ($1,$2,'a on b') RETURNING id`, f.bIssue, f.a).Scan(&f.aComment))
	// Billing, ledger and tax records are retained by law.
	exec(`INSERT INTO billing_accounts(owner_type,owner_id,stripe_customer_id) VALUES ('user',$1,$2)`, f.a, fmt.Sprintf("cus_%d", base))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO credit_accounts(owner_type,owner_id) VALUES ('user',$1) RETURNING id`, f.a).Scan(&f.creditAccount))
	exec(`INSERT INTO credit_grants(account_id,source_key,original_nanos,available_nanos) VALUES ($1,'signup',100,100)`, f.creditAccount)
	return f
}

// userReferences counts rows in every table whose foreign key names a users
// row, keyed by table.column, for the given user.
func userReferences(t *testing.T, pool *pgxpool.Pool, userID int64) map[string]int64 {
	t.Helper()
	ctx := context.Background()
	rows, err := pool.Query(ctx, `
SELECT c.conrelid::regclass::text, a.attname
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass AND cardinality(c.conkey) = 1`)
	require.NoError(t, err)
	type ref struct{ table, column string }
	var refs []ref
	for rows.Next() {
		var r ref
		require.NoError(t, rows.Scan(&r.table, &r.column))
		refs = append(refs, r)
	}
	require.NoError(t, rows.Err())
	out := map[string]int64{}
	for _, r := range refs {
		var n int64
		sql := fmt.Sprintf(`SELECT count(*) FROM %s WHERE %s = $1`, pgx.Identifier{r.table}.Sanitize(), pgx.Identifier{r.column}.Sanitize())
		require.NoError(t, pool.QueryRow(ctx, sql, userID).Scan(&n))
		if n > 0 {
			out[r.table+"."+r.column] = n
		}
	}
	return out
}

func TestAdminEraseUserRemovesOwnedDataKeepsBilling(t *testing.T) {
	pool := setupTestPool(t)
	f := seedErasureFixture(t, pool)
	ctx := ContextWithAdminAuditActor(context.Background(), AdminAuditActor{UserID: f.admin, Username: "ops-admin"})
	q := db.New(pool)

	var deletedRepos, deletedVMs []string
	// The repo host is the git storage process; the fake records the staged
	// delete the repository service journals and executes.
	repos := NewProductRepoServiceWithPool(q, &preparedRepoHost{
		mockRepoHostClient: &mockRepoHostClient{},
		prepareDeleteFn: func(_ context.Context, owner, repo string) (repohost.StagedDelete, error) {
			return repohost.StagedDelete{BaseURL: "http://s1.test", StorageRouteKey: "static", Token: strings.Repeat("e", 64), Owner: owner, Repo: repo}, nil
		},
		executeDeleteFn: func(_ context.Context, staged repohost.StagedDelete) error {
			deletedRepos = append(deletedRepos, staged.Owner+"/"+staged.Repo)
			return nil
		},
	}, pool)
	workspaces := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		deleteVMFn: func(_ context.Context, vmID string) error {
			deletedVMs = append(deletedVMs, vmID)
			return nil
		},
	}))
	svc := NewAdminUserService(q, WithAccountErasure(AccountErasure{Pool: pool, Repos: repos, Workspaces: workspaces}))

	bRows := func() string {
		var s string
		require.NoError(t, pool.QueryRow(ctx, `SELECT concat_ws('|', (SELECT u::text FROM users u WHERE id=$1), (SELECT r::text FROM repositories r WHERE id=$2),
			(SELECT i::text FROM issues i WHERE id=$3), (SELECT count(*) FROM owner_namespaces WHERE user_id=$1))`, f.b, f.bRepo, f.bIssue).Scan(&s))
		return s
	}
	bBefore := bRows()
	requested := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)

	first, err := svc.EraseUser(ctx, strings.ToUpper(f.aName), EraseUserRequest{RequestedAt: requested})
	require.NoError(t, err)
	require.Equal(t, f.a, first.UserID)
	require.False(t, first.AlreadyErased)
	require.Positive(t, first.RowsChanged)

	require.Equal(t, []string{f.aName + "/" + f.aRepoName}, deletedRepos, "owned repository storage is deleted through the repo host")
	require.Equal(t, []string{f.aVM}, deletedVMs, "the sandbox provider receives the delete")

	// The users row survives as a scrubbed tombstone; only A's comment in a
	// repository A does not own still names it.
	var username, displayName, bio, avatar string
	var email *string
	var active, prohibit bool
	var deletedAt *time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT username,email,display_name,bio,avatar_url,is_active,prohibit_login,deleted_at FROM users WHERE id=$1`, f.a).
		Scan(&username, &email, &displayName, &bio, &avatar, &active, &prohibit, &deletedAt))
	require.Equal(t, first.Tombstone, username)
	require.True(t, strings.HasPrefix(username, "erased-"))
	require.NotContains(t, username, f.aName)
	require.Nil(t, email)
	require.Equal(t, "Deleted user", displayName)
	require.Empty(t, bio)
	require.Empty(t, avatar)
	require.False(t, active)
	require.True(t, prohibit)
	require.NotNil(t, deletedAt)
	// A's comment on B's issue and the event it raised stay, attributed to the tombstone.
	require.Equal(t, map[string]int64{"issue_comments.user_id": 1, "issue_events.actor_id": 1}, userReferences(t, pool, f.a))
	var commentBody string
	require.NoError(t, pool.QueryRow(ctx, `SELECT body FROM issue_comments WHERE id=$1 AND user_id=$2`, f.aComment, f.a).Scan(&commentBody))
	require.Equal(t, "a on b", commentBody)

	counts := func(sql string, args ...any) int64 {
		t.Helper()
		var n int64
		require.NoError(t, pool.QueryRow(ctx, sql, args...).Scan(&n))
		return n
	}
	require.Zero(t, counts(`SELECT count(*) FROM chat_turns WHERE user_id=$1`, f.a))
	require.Zero(t, counts(`SELECT count(*) FROM repositories WHERE id=$1`, f.aRepo))
	require.Zero(t, counts(`SELECT count(*) FROM owner_namespaces WHERE lower_slug=$1`, f.aName), "the username is free for reuse")
	// Billing, ledger and tax rows are retained unchanged.
	require.Equal(t, int64(1), counts(`SELECT count(*) FROM billing_accounts WHERE owner_type='user' AND owner_id=$1`, f.a))
	require.Equal(t, int64(1), counts(`SELECT count(*) FROM credit_accounts WHERE id=$1 AND owner_id=$2`, f.creditAccount, f.a))
	require.Equal(t, int64(1), counts(`SELECT count(*) FROM credit_grants WHERE account_id=$1 AND available_nanos=100`, f.creditAccount))
	// B's account, repository and issue are unchanged; B's comment inside A's
	// repository went with that repository.
	require.Equal(t, bBefore, bRows())
	require.Zero(t, counts(`SELECT count(*) FROM issue_comments WHERE user_id=$1`, f.b))

	// A second erase finds the tombstone, changes no rows, and still audits.
	snapshot := func() string {
		var s string
		require.NoError(t, pool.QueryRow(ctx, `SELECT u::text FROM users u WHERE id=$1`, f.a).Scan(&s))
		return fmt.Sprint(s, userReferences(t, pool, f.a), counts(`SELECT count(*) FROM billing_accounts WHERE owner_id=$1`, f.a))
	}
	before := snapshot()
	second, err := svc.EraseUser(ctx, f.aName, EraseUserRequest{RequestedAt: requested})
	require.NoError(t, err)
	require.Equal(t, f.a, second.UserID)
	require.True(t, second.AlreadyErased)
	require.Zero(t, second.RowsChanged)
	require.Equal(t, before, snapshot())
	require.Len(t, deletedRepos, 1)
	require.Len(t, deletedVMs, 1)

	rows, err := pool.Query(ctx, `SELECT actor_id, actor_name, target_name, metadata->>'request_date', metadata->>'operator', (metadata->>'already_erased')::bool
		FROM audit_log WHERE event_type='admin.user.erase' AND target_id=$1 ORDER BY id`, f.a)
	require.NoError(t, err)
	defer rows.Close()
	var already []bool
	for rows.Next() {
		var actorID int64
		var actorName, target, requestDate, operator string
		var was bool
		require.NoError(t, rows.Scan(&actorID, &actorName, &target, &requestDate, &operator, &was))
		require.Equal(t, f.admin, actorID)
		require.Equal(t, "ops-admin", actorName)
		require.Equal(t, "ops-admin", operator)
		require.Equal(t, first.Tombstone, target)
		require.Equal(t, "2026-09-01", requestDate)
		already = append(already, was)
	}
	require.NoError(t, rows.Err())
	require.Equal(t, []bool{false, true}, already)

	_, err = svc.EraseUser(ctx, "never-existed-"+f.aName, EraseUserRequest{RequestedAt: requested})
	require.True(t, isNotFound(err), "an unknown username is not found, got %v", err)
	_, err = svc.EraseUser(ctx, f.aName, EraseUserRequest{})
	require.Error(t, err, "the request date is required")

	// A suspended account whose chosen name looks like a tombstone is still erased.
	lookalike := fmt.Sprintf("erased-0123456789abcdef-%d", f.b)
	_, err = pool.Exec(ctx, `INSERT INTO users(id,username,lower_username,is_active,deleted_at) VALUES ($1,$2,$2,false,now())`, f.admin+10, lookalike)
	require.NoError(t, err)
	third, err := svc.EraseUser(ctx, lookalike, EraseUserRequest{RequestedAt: requested})
	require.NoError(t, err)
	require.False(t, third.AlreadyErased)
	require.NotEqual(t, lookalike, third.Tombstone)
}

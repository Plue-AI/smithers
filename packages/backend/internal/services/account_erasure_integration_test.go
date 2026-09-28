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
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
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
	aEmail, aSnapshot    string
	bRelease             int64
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
		aSnapshot: fmt.Sprintf("snap-%d", base),
	}
	f.aEmail = f.aName + "@example.com"
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err, sql)
	}
	exec(`INSERT INTO users(id,username,lower_username,is_admin) VALUES ($1,$2,$2,true)`, f.admin, fmt.Sprintf("erase-admin-%d", base))
	// A signed up before asking for deletion on the fixture's request date.
	exec(`INSERT INTO users(id,username,lower_username,email,lower_email,display_name,bio,avatar_url,created_at)
	      VALUES ($1,$2,$2,$3,$3,'Alice Example','alice bio','https://example.com/a.png','2026-01-01')`, f.a, f.aName, f.aEmail)
	exec(`INSERT INTO users(id,username,lower_username,email,lower_email,display_name) VALUES ($1,$2,$2,$3,$3,'Bob')`, f.b, f.bName, f.bName+"@example.com")
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,$2,$2) RETURNING id`, f.a, f.aRepoName).Scan(&f.aRepo))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,$2,$2) RETURNING id`, f.b, f.bRepoName).Scan(&f.bRepo))
	exec(`INSERT INTO workspaces(id,user_id,repository_id,name,kind,status,vm_id) VALUES ($1,$2,$3,'dev','vm','running',$4)`, f.aWorkspace, f.a, f.aRepo, f.aVM)
	exec(`INSERT INTO workspace_snapshots(repository_id,user_id,workspace_id,name,snapshot_id) VALUES ($1,$2,$3,'nightly',$4)`, f.aRepo, f.a, f.aWorkspace, f.aSnapshot)
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
	// A's release, its asset and a job approval in B's repository belong to B's repository.
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO releases(repository_id,publisher_id,tag_name) VALUES ($1,$2,'v1') RETURNING id`, f.bRepo, f.a).Scan(&f.bRelease))
	exec(`INSERT INTO release_assets(release_id,uploader_id,name,gcs_key) VALUES ($1,$2,'a.tgz','releases/a.tgz')`, f.bRelease, f.a)
	exec(`INSERT INTO repository_job_approvals(repository_id,job,plan_digest,plan_id,flow_id,envelope,approved_by) VALUES ($1,'ci',repeat('a',64),'plan','flow','{}',$2)`, f.bRepo, f.a)
	exec(`INSERT INTO repo_push_events(delivery_id,repository_id,owner,repo,ref_name,pusher_id,pusher_login) VALUES ($1,$2,$3,$4,'refs/heads/main',$5,$6)`,
		fmt.Sprintf("delivery-%d", base), f.bRepo, f.bName, f.bRepoName, f.a, f.aName)
	exec(`INSERT INTO alpha_waitlist_entries(email,lower_email,github_username) VALUES ($1,$1,$2)`, f.aEmail, f.aName)
	// Audit rows naming A: the admin created A, and A acted from an address.
	exec(`INSERT INTO audit_log(event_type,actor_id,actor_name,target_type,target_id,target_name,action,metadata,ip_address)
	      VALUES ('admin.user.create',$1,'ops-admin','user',$2,$3,'create',$4::jsonb,'10.0.0.1')`, f.admin, f.a, f.aName, fmt.Sprintf(`{"username":%q,"email":%q}`, f.aName, f.aEmail))
	exec(`INSERT INTO audit_log(event_type,actor_id,actor_name,target_type,target_id,target_name,action,metadata,ip_address)
	      VALUES ('repo.create',$1,$2,'repository',$3,$4,'create',$5::jsonb,'203.0.113.9')`, f.a, f.aName, f.aRepo, f.aRepoName, fmt.Sprintf(`{"by":%q}`, f.aName))
	// Billing, ledger and tax records are retained by law.
	exec(`INSERT INTO billing_accounts(owner_type,owner_id,stripe_customer_id,stripe_customer_email,stripe_customer_name) VALUES ('user',$1,$2,$3,'Alice Example')`, f.a, fmt.Sprintf("cus_%d", base), f.aEmail)
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

// erasureTeardown records what the repo host and sandbox provider were asked
// to delete.
type erasureTeardown struct {
	repos, vms, snapshots []string
}

// newErasureService wires EraseUser to the real repository and workspace
// services over pool, with the repo host and sandbox provider recorded.
func newErasureService(pool *pgxpool.Pool) (*AdminUserService, *erasureTeardown) {
	q := db.New(pool)
	seen := &erasureTeardown{}
	// The repo host is the git storage process; the fake records the staged
	// delete the repository service journals and executes.
	repos := NewProductRepoServiceWithPool(q, &preparedRepoHost{
		mockRepoHostClient: &mockRepoHostClient{},
		prepareDeleteFn: func(_ context.Context, owner, repo string) (repohost.StagedDelete, error) {
			return repohost.StagedDelete{BaseURL: "http://s1.test", StorageRouteKey: "static", Token: strings.Repeat("e", 64), Owner: owner, Repo: repo}, nil
		},
		executeDeleteFn: func(_ context.Context, staged repohost.StagedDelete) error {
			seen.repos = append(seen.repos, staged.Owner+"/"+staged.Repo)
			return nil
		},
	}, pool)
	workspaces := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		deleteVMFn: func(_ context.Context, vmID string) error {
			seen.vms = append(seen.vms, vmID)
			return nil
		},
		deleteSnapshotFn: func(_ context.Context, snapshotID string) error {
			seen.snapshots = append(seen.snapshots, snapshotID)
			return nil
		},
	}))
	return NewAdminUserService(q, WithAccountErasure(AccountErasure{Pool: pool, Repos: repos, Workspaces: workspaces})), seen
}

func TestAdminEraseUserRemovesOwnedDataKeepsBilling(t *testing.T) {
	pool := setupTestPool(t)
	f := seedErasureFixture(t, pool)
	ctx := ContextWithAdminAuditActor(context.Background(), AdminAuditActor{UserID: f.admin, Username: "ops-admin"})
	svc, seen := newErasureService(pool)

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

	require.Equal(t, []string{f.aName + "/" + f.aRepoName}, seen.repos, "owned repository storage is deleted through the repo host")
	require.Equal(t, []string{f.aVM}, seen.vms, "the sandbox provider receives the delete")
	require.Equal(t, []string{f.aSnapshot}, seen.snapshots, "the sandbox provider deletes the stored snapshot")

	// The users row survives as a scrubbed tombstone; only A's contributions
	// in a repository A does not own still name it.
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
	// A's comment, release, asset and approval in B's repository stay,
	// attributed to the tombstone, as does A's audit trail.
	require.Equal(t, map[string]int64{
		"issue_comments.user_id": 1, "issue_events.actor_id": 1, "releases.publisher_id": 1,
		"release_assets.uploader_id": 1, "repository_job_approvals.approved_by": 1, "audit_log.actor_id": 1,
	}, userReferences(t, pool, f.a))
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
	require.Zero(t, counts(`SELECT count(*) FROM workspace_snapshots WHERE snapshot_id=$1`, f.aSnapshot))
	require.Zero(t, counts(`SELECT count(*) FROM owner_namespaces WHERE lower_slug=$1`, f.aName), "the username is free for reuse")
	require.Zero(t, counts(`SELECT count(*) FROM alpha_waitlist_entries WHERE lower_email=$1`, f.aEmail))
	require.Equal(t, int64(1), counts(`SELECT count(*) FROM repo_push_events WHERE pusher_id=$1 AND pusher_login=$2`, f.a, first.Tombstone))
	// Retained audit rows keep their ids and event types but lose A's
	// username, email and address.
	require.Equal(t, int64(2), counts(`SELECT count(*) FROM audit_log WHERE event_type IN ('admin.user.create','repo.create') AND (actor_id=$1 OR target_id=$1)`, f.a))
	require.Zero(t, counts(`SELECT count(*) FROM audit_log WHERE (actor_id=$1 OR target_id=$1)
		AND (strpos(metadata::text,$2)>0 OR strpos(metadata::text,$3)>0 OR actor_name=$2 OR target_name=$2 OR ip_address='203.0.113.9')`, f.a, f.aName, f.aEmail))
	// Billing, ledger and tax rows are retained with the Stripe customer id;
	// the name and email on them are scrubbed.
	require.Equal(t, int64(1), counts(`SELECT count(*) FROM billing_accounts WHERE owner_type='user' AND owner_id=$1
		AND stripe_customer_id LIKE 'cus_%' AND stripe_customer_email='' AND stripe_customer_name=''`, f.a))
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

	// Someone registers A's freed name. Retrying A's request resolves A's
	// tombstone, because C signed up after A asked for deletion.
	c := f.admin + 20
	_, err = pool.Exec(ctx, `INSERT INTO users(id,username,lower_username,email,lower_email) VALUES ($1,$2,$2,$3,$3)`, c, f.aName, "c-"+f.aEmail)
	require.NoError(t, err)
	cRow := func() string {
		var s string
		require.NoError(t, pool.QueryRow(ctx, `SELECT u::text FROM users u WHERE id=$1`, c).Scan(&s))
		return s
	}
	cBefore := cRow()
	retry, err := svc.EraseUser(ctx, f.aName, EraseUserRequest{RequestedAt: requested})
	require.NoError(t, err)
	require.Equal(t, f.a, retry.UserID)
	require.True(t, retry.AlreadyErased)
	require.Equal(t, cBefore, cRow(), "the new holder of the name is untouched")
	require.Equal(t, before, snapshot())
	require.Len(t, seen.repos, 1)
	require.Len(t, seen.vms, 1)
	require.Len(t, seen.snapshots, 1)

	// An account created after the request date with no earlier tombstone
	// cannot be the requester.
	d := f.admin + 30
	late := fmt.Sprintf("erase-late-%d", f.admin)
	_, err = pool.Exec(ctx, `INSERT INTO users(id,username,lower_username) VALUES ($1,$2,$2)`, d, late)
	require.NoError(t, err)
	_, err = svc.EraseUser(ctx, late, EraseUserRequest{RequestedAt: requested})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, pkgerrors.CodeConflict, apiErr.Code)
	require.Equal(t, int64(1), counts(`SELECT count(*) FROM users WHERE id=$1 AND is_active AND NOT prohibit_login`, d))

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
	require.Equal(t, []bool{false, true, true}, already)
	require.Equal(t, int64(1), counts(`SELECT count(*) FROM audit_log WHERE event_type='admin.user.erase_started' AND target_id=$1`, f.a))

	_, err = svc.EraseUser(ctx, "never-existed-"+f.aName, EraseUserRequest{RequestedAt: requested})
	require.True(t, isNotFound(err), "an unknown username is not found, got %v", err)
	_, err = svc.EraseUser(ctx, f.aName, EraseUserRequest{})
	require.Error(t, err, "the request date is required")

	// A suspended account whose chosen name looks like a tombstone is still erased.
	lookalike := fmt.Sprintf("erased-0123456789abcdef-%d", f.b)
	_, err = pool.Exec(ctx, `INSERT INTO users(id,username,lower_username,is_active,deleted_at,created_at) VALUES ($1,$2,$2,false,now(),'2026-01-01')`, f.admin+10, lookalike)
	require.NoError(t, err)
	third, err := svc.EraseUser(ctx, lookalike, EraseUserRequest{RequestedAt: requested})
	require.NoError(t, err)
	require.False(t, third.AlreadyErased)
	require.NotEqual(t, lookalike, third.Tombstone)
}

// failingSnapshotWorkspaces is a sandbox provider that is down: every
// snapshot delete fails.
type failingSnapshotWorkspaces struct{}

func (failingSnapshotWorkspaces) DeleteWorkspaceSnapshot(context.Context, string, int64, int64) error {
	return pkgerrors.Internal("sandbox provider unavailable")
}

func (failingSnapshotWorkspaces) DeleteWorkspace(context.Context, string, int64, int64) error {
	return pkgerrors.Internal("sandbox provider unavailable")
}

// unreachableRepos fails the test if the erase reaches repository deletion.
type unreachableRepos struct{ t *testing.T }

func (r unreachableRepos) DeleteRepo(context.Context, *db.User, string, string) error {
	r.t.Error("repository deleted after a failed snapshot teardown")
	return nil
}

func TestAdminEraseUserRecordsReceiptBeforeTeardown(t *testing.T) {
	pool := setupTestPool(t)
	f := seedErasureFixture(t, pool)
	ctx := ContextWithAdminAuditActor(context.Background(), AdminAuditActor{UserID: f.admin, Username: "ops-admin"})
	requested := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	counts := func(sql string, args ...any) int64 {
		t.Helper()
		var n int64
		require.NoError(t, pool.QueryRow(ctx, sql, args...).Scan(&n))
		return n
	}

	down := NewAdminUserService(db.New(pool), WithAccountErasure(AccountErasure{Pool: pool, Repos: unreachableRepos{t}, Workspaces: failingSnapshotWorkspaces{}}))
	_, err := down.EraseUser(ctx, f.aName, EraseUserRequest{RequestedAt: requested})
	require.Error(t, err)

	// The receipt names the operator, the account and the request date
	// before anything was destroyed; the snapshot row keeps the provider id
	// for the retry.
	var operator, requestDate, target string
	require.NoError(t, pool.QueryRow(ctx, `SELECT metadata->>'operator', metadata->>'request_date', target_name FROM audit_log
		WHERE event_type='admin.user.erase_started' AND target_id=$1`, f.a).Scan(&operator, &requestDate, &target))
	require.Equal(t, "ops-admin", operator)
	require.Equal(t, "2026-09-01", requestDate)
	require.NotContains(t, target, f.aName)
	require.Zero(t, counts(`SELECT count(*) FROM audit_log WHERE event_type='admin.user.erase' AND target_id=$1`, f.a))
	require.Equal(t, int64(1), counts(`SELECT count(*) FROM workspace_snapshots WHERE snapshot_id=$1`, f.aSnapshot))
	require.Equal(t, int64(1), counts(`SELECT count(*) FROM users WHERE id=$1 AND username=$2 AND prohibit_login`, f.a, f.aName), "sign-in stays blocked, identity intact")

	// The retry completes and audits the completion.
	svc, seen := newErasureService(pool)
	result, err := svc.EraseUser(ctx, f.aName, EraseUserRequest{RequestedAt: requested})
	require.NoError(t, err)
	require.False(t, result.AlreadyErased)
	require.Equal(t, []string{f.aSnapshot}, seen.snapshots)
	require.Equal(t, int64(2), counts(`SELECT count(*) FROM audit_log WHERE event_type='admin.user.erase_started' AND target_id=$1`, f.a))
	require.Equal(t, int64(1), counts(`SELECT count(*) FROM audit_log WHERE event_type='admin.user.erase' AND target_id=$1`, f.a))
}

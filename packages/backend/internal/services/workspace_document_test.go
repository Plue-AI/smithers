package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

type documentAdmissionFixture struct {
	pool                      *pgxpool.Pool
	service                   *WorkspaceService
	branch                    string
	owner, member, repository int64
}

func documentAdmissionDatabase(t *testing.T, hosted bool) documentAdmissionFixture {
	t.Helper()
	pool := newProductTestPool(t)
	owner, repo := setupTestUserAndRepo(t, pool)
	ctx := t.Context()
	q := db.New(pool)
	var member int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('document-member','document-member') RETURNING id`).Scan(&member))
	_, err := pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo, member)
	require.NoError(t, err)
	runtime := guestRuntime{installRuntime{level: workspaceapi.IsolationSandboxed}, "agent", 19999}
	providers := HostedBranchMachineProviders(runtime)
	if !hosted {
		installBranchOwner(t, pool, owner)
		binding := []byte(fmt.Sprintf(`{"owner_login":"owner","repository_name":"demo","repository_id":%d}`, repo))
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"owner_login":"owner","repository_name":"demo","repository_id":%d,"last_access_check_at":"2026-10-07T00:00:00Z"}`, repo))}))
		providers = InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)
	}
	machineOwner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: machineOwner, TargetBookmark: "scratch/owner/document", Kind: "container", Status: "running"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='document-machine' WHERE id=$1`, row.ID)
	require.NoError(t, err)
	for _, id := range []int64{owner, member} {
		_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: row.ID, OwnerUserID: machineOwner, GranteeUserID: id, Level: "write"})
		require.NoError(t, err)
	}
	return documentAdmissionFixture{pool, NewWorkspaceService(q, WithWorkspaceTransactions(pool), WithBranchMachineProviders(providers)), row.ID, owner, member, repo}
}
func (f documentAdmissionFixture) admit(ctx context.Context, member int64) (CodeDocumentActor, error) {
	return f.service.AdmitCodeDocument(ctx, f.branch, "src/main.ts", f.repository, member)
}

func TestCodeDocumentAdmissionDurableMembersAndMachineScope(t *testing.T) {
	for _, hosted := range []bool{false, true} {
		t.Run(fmt.Sprint("hosted=", hosted), func(t *testing.T) {
			f := documentAdmissionDatabase(t, hosted)
			ctx := t.Context()
			a, err := f.admit(ctx, f.owner)
			require.NoError(t, err)
			require.Len(t, a.Reference, 16)
			require.Equal(t, "document-machine", a.MachineID)
			b, err := f.admit(ctx, f.member)
			require.NoError(t, err)
			require.NotEqual(t, a.Reference, b.Reference)
			again, err := f.admit(ctx, f.member)
			require.NoError(t, err)
			require.Equal(t, b, again)
			tx, err := f.pool.Begin(ctx)
			require.NoError(t, err)
			identity, err := machined.ResolveActorInTx(ctx, tx, f.branch, "document-machine", b.Reference)
			require.NoError(t, err)
			require.Equal(t, machined.ActorIdentity{Kind: "person", MemberID: f.member, Via: "web"}, identity)
			require.NoError(t, tx.Rollback(ctx))
			_, err = f.pool.Exec(ctx, `UPDATE workspaces SET vm_id='replacement' WHERE id=$1`, f.branch)
			require.NoError(t, err)
			replacement, err := f.admit(ctx, f.member)
			require.NoError(t, err)
			require.NotEqual(t, b.Reference, replacement.Reference)
			require.Equal(t, "replacement", replacement.MachineID)
			_, err = f.pool.Exec(ctx, `DELETE FROM workspace_shares WHERE workspace_id=$1 AND grantee_user_id=$2`, f.branch, f.member)
			require.NoError(t, err)
			denied, err := f.admit(ctx, f.member)
			require.Error(t, err)
			require.Empty(t, denied.Reference)
			tx, err = f.pool.Begin(ctx)
			require.NoError(t, err)
			retained, err := machined.ResolveActorInTx(ctx, tx, f.branch, "document-machine", b.Reference)
			require.NoError(t, err)
			require.Equal(t, identity, retained)
			require.NoError(t, tx.Rollback(ctx))
		})
	}
}

func TestCodeDocumentAdmissionRefusals(t *testing.T) {
	for _, tc := range []struct{ name, sql string }{
		{"read share", `UPDATE workspace_shares SET level='read'`},
		{"no share", `DELETE FROM workspace_shares`},
		{"suspended member", `UPDATE collaborators SET suspended_at=now()`},
		{"read member", `UPDATE collaborators SET permission='read'`},
		{"removed member", `DELETE FROM collaborators`},
		{"inactive", `UPDATE users SET is_active=false WHERE username='document-member'`},
		{"login forbidden", `UPDATE users SET prohibit_login=true WHERE username='document-member'`},
		{"deleted member", `UPDATE users SET deleted_at=now() WHERE username='document-member'`},
		{"stopped", `UPDATE workspaces SET status='suspended'`},
		{"no machine", `UPDATE workspaces SET vm_id=''`},
		{"deleted machine", `UPDATE workspaces SET deleted_at=now()`},
		{"unbound lane", `UPDATE workspaces SET target_bookmark='smithers/unbound'`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := documentAdmissionDatabase(t, false)
			_, err := f.pool.Exec(t.Context(), tc.sql)
			require.NoError(t, err)
			actor, err := f.admit(t.Context(), f.member)
			require.Error(t, err)
			require.Empty(t, actor.Reference)
			var count int
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_actor_references`).Scan(&count))
			require.Zero(t, count)
		})
	}
}

func TestCodeDocumentAdmissionUnavailableOrMalformed(t *testing.T) {
	f := documentAdmissionDatabase(t, false)
	ctx := t.Context()
	for _, path := range []string{"", "../secret", "/secret", "a//b", "a/./b", "a\x00b"} {
		actor, err := f.service.AdmitCodeDocument(ctx, f.branch, path, f.repository, f.member)
		require.Error(t, err)
		require.Empty(t, actor.Reference)
	}
	for _, branch := range []string{"main", "00000000-0000-0000-0000-000000000000", "11111111-1111-4111-8111-111111111111"} {
		actor, err := f.service.AdmitCodeDocument(ctx, branch, "a", f.repository, f.member)
		require.Error(t, err)
		require.Empty(t, actor.Reference)
	}
	actor, err := f.service.AdmitCodeDocument(ctx, f.branch, "a", f.repository+1000, f.member)
	require.Error(t, err)
	require.Empty(t, actor.Reference)
	serviceOwner, err := db.New(f.pool).GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	actor, err = f.admit(ctx, serviceOwner)
	require.Error(t, err)
	require.Empty(t, actor.Reference)
	for _, member := range []int64{0, -1, 999999} {
		actor, err = f.admit(ctx, member)
		require.Error(t, err)
		require.Empty(t, actor.Reference)
	}
	for _, svc := range []*WorkspaceService{nil, NewWorkspaceService(db.New(f.pool))} {
		actor, err = svc.AdmitCodeDocument(ctx, f.branch, "a", f.repository, f.member)
		require.Error(t, err)
		require.Empty(t, actor.Reference)
	}
	f.service.branchMachineProviders.MicroVM = installMicroVM(installRuntime{level: workspaceapi.IsolationTrustedProcess})
	actor, err = f.admit(ctx, f.member)
	require.Error(t, err)
	require.Empty(t, actor.Reference)
}

func TestCodeDocumentAdmissionCommitFailureAndCancellation(t *testing.T) {
	f := documentAdmissionDatabase(t, false)
	ctx := t.Context()
	_, err := f.pool.Exec(ctx, `CREATE FUNCTION refuse_document_actor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected commit failure'; END $$;
 CREATE CONSTRAINT TRIGGER refuse_document_actor AFTER INSERT ON machine_actor_references DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_document_actor()`)
	require.NoError(t, err)
	actor, err := f.admit(ctx, f.member)
	require.ErrorContains(t, err, "injected commit failure")
	require.Empty(t, actor.Reference)
	var count int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM machine_actor_references`).Scan(&count))
	require.Zero(t, count)
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	actor, err = f.admit(cancelled, f.member)
	require.Error(t, err)
	require.Empty(t, actor.Reference)
}

func TestCodeDocumentAdmissionRechecksConcurrentShareDemotion(t *testing.T) {
	f := documentAdmissionDatabase(t, false)
	ctx := t.Context()
	tx, err := f.pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(ctx, `UPDATE workspace_shares SET level='read' WHERE workspace_id=$1 AND grantee_user_id=$2`, f.branch, f.member)
	require.NoError(t, err)
	type outcome struct {
		actor CodeDocumentActor
		err   error
	}
	result := make(chan outcome, 1)
	go func() { actor, err := f.admit(ctx, f.member); result <- outcome{actor, err} }()
	require.Eventually(t, func() bool {
		var waiting bool
		err := f.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR SHARE OF ws%')`).Scan(&waiting)
		return err == nil && waiting
	}, 5*time.Second, 10*time.Millisecond)
	require.NoError(t, tx.Commit(ctx))
	got := <-result
	require.Error(t, got.err)
	require.Empty(t, got.actor.Reference)
}

func TestCodeDocumentAdmissionRejectsConcurrentMachineReplacement(t *testing.T) {
	f := documentAdmissionDatabase(t, false)
	entered, resume := make(chan struct{}), make(chan struct{})
	authorize := f.service.branchMachineProviders.Authorize
	f.service.branchMachineProviders.Authorize = func(ctx context.Context, tx pgx.Tx, command string, repo int64, branch string, member int64) error {
		if err := authorize(ctx, tx, command, repo, branch, member); err != nil {
			return err
		}
		close(entered)
		select {
		case <-resume:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	type outcome struct {
		actor CodeDocumentActor
		err   error
	}
	result := make(chan outcome, 1)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	go func() { actor, err := f.admit(ctx, f.member); result <- outcome{actor, err} }()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	_, err := f.pool.Exec(ctx, `UPDATE workspaces SET vm_id='replacement' WHERE id=$1`, f.branch)
	close(resume)
	require.NoError(t, err)
	got := <-result
	require.ErrorIs(t, got.err, machined.ErrNotReady)
	require.Empty(t, got.actor.Reference)
	var count int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_actor_references`).Scan(&count))
	require.Zero(t, count)
}

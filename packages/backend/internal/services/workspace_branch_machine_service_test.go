package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	processruntime "github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The machine service needs no member grant, but it must never turn that
// exemption into permission to run branch work on the host or as guest root.
// PostgreSQL and the trusted-process runtime are real. The other capability
// fixtures exercise refusal before any VM is touched, not VM certification.
func TestBranchMachineServiceRequiresQualifiedRuntime(t *testing.T) {
	pool := newProductTestPool(t)
	person, repo := setupTestUserAndRepo(t, pool)
	ctx := t.Context()
	q := db.New(pool)
	machineOwner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	host, err := processruntime.New(processruntime.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, host.Close()) })
	isolated := installRuntime{level: workspaceapi.IsolationSandboxed}
	for _, tc := range []struct {
		name    string
		runtime workspaceapi.WorkspaceRuntime
		allowed bool
	}{
		{name: "unavailable"},
		{name: "host process", runtime: host},
		{name: "unnamed guest", runtime: isolated},
		{name: "guest root uid", runtime: guestRuntime{isolated, "agent", 0}},
		{name: "guest root login", runtime: guestRuntime{isolated, "root", 19999}},
		{name: "qualified capabilities", runtime: guestRuntime{isolated, "agent", 19999}, allowed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			providers := InstallBranchMachineProviders(ownerAuthorizer{owner: person}, tc.runtime)
			svc := NewWorkspaceService(q, WithWorkspaceTransactions(pool), WithBranchMachineProviders(providers))
			for _, operation := range []string{"preflight", "create", "mutation"} {
				t.Run(operation, func(t *testing.T) {
					branch := "scratch/owner/" + strings.ReplaceAll(tc.name, " ", "-") + "/" + operation
					var err error
					switch operation {
					case "preflight":
						err = svc.preflightBranchMachine(ctx, repo, machineOwner, branch, "")
					case "create":
						_, err = svc.createWorkspaceRow(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: machineOwner, TargetBookmark: branch, Kind: "container", Status: "starting"})
						var count int
						require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1 AND target_bookmark=$2`, repo, branch).Scan(&count))
						if tc.allowed {
							require.Equal(t, 1, count)
						} else {
							require.Zero(t, count, "refusal must precede insertion")
						}
					case "mutation":
						row, seedErr := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: machineOwner, TargetBookmark: branch, Kind: "container", Status: "suspended"})
						require.NoError(t, seedErr)
						called := false
						err = svc.withWorkspaceMutationAuthority(ctx, row, machineOwner, func(context.Context) error { called = true; return nil })
						require.Equal(t, tc.allowed, called, "runtime mutation must not start before qualification")
					}
					if tc.allowed {
						require.NoError(t, err)
					} else {
						requireBranchMachineUnavailable(t, err)
					}
				})
			}
		})
	}
}

// Exercise the actual lifecycle and trusted-process adapter: even an internal
// resume must refuse before it creates a host workspace or changes its row.
func TestBranchMachineServiceCannotStartHostWorkspace(t *testing.T) {
	pool := newProductTestPool(t)
	person, repo := setupTestUserAndRepo(t, pool)
	ctx := t.Context()
	q := db.New(pool)
	machineOwner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	host, err := processruntime.New(processruntime.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, host.Close()) })
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: machineOwner,
		TargetBookmark: "scratch/owner/no-host-fallback", Kind: "container", Status: "starting"})
	require.NoError(t, err)
	svc := NewWorkspaceService(q, WithWorkspaceTransactions(pool), WithWorkspaceRuntime(host),
		WithBranchMachineProviders(InstallBranchMachineProviders(ownerAuthorizer{owner: person}, host)))
	_, admissionErr := svc.ensureRuntimeWorkspaceRunning(ctx, row, machineOwner)
	operationCtx, err := svc.workspaceRuntimeContext(ctx, row, machineOwner, "inspect-refused-host")
	require.NoError(t, err)
	_, inspectErr := host.InspectWorkspace(operationCtx, row.ID)
	require.ErrorIs(t, inspectErr, workspaceapi.ErrWorkspaceNotFound, "refusal must leave no host runtime workspace")
	requireBranchMachineUnavailable(t, admissionErr)
	current, err := q.GetWorkspace(ctx, row.ID)
	require.NoError(t, err)
	require.Equal(t, row, current, "refusal leaves durable state untouched")
}

// A join must fit in its one transaction connection. With a second owner
// lookup through the pool, even one join waits on itself until cancellation.
func TestBranchMachineAdmissionUsesTransactionConnection(t *testing.T) {
	pool := newProductTestPool(t)
	person, repo := setupTestUserAndRepo(t, pool)
	cfg := pool.Config().Copy()
	cfg.MaxConns, cfg.MinConns = 1, 0
	single, err := pgxpool.NewWithConfig(t.Context(), cfg)
	require.NoError(t, err)
	t.Cleanup(single.Close)
	svc := NewWorkspaceService(db.New(single), WithWorkspaceTransactions(single), WithBranchMachineProviders(branchMachineTestProviders()))
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	row, err := svc.createWorkspaceRow(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: person,
		TargetBookmark: "scratch/owner/one-connection", Kind: "container", Status: "starting"})
	require.NoError(t, err)
	owner, err := db.New(pool).GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	require.Equal(t, owner, row.UserID)
	share, err := db.New(pool).GetWorkspaceShare(ctx, db.GetWorkspaceShareParams{WorkspaceID: row.ID, GranteeUserID: person})
	require.NoError(t, err)
	require.Equal(t, string(WorkspaceAccessWrite), share.Level)
	other, err := db.New(pool).CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner,
		TargetBookmark: "scratch/owner/not-shared", Kind: "container", Status: "starting"})
	require.NoError(t, err)
	var outsider int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('not-a-joiner','not-a-joiner') RETURNING id`).Scan(&outsider))
	// A separate pool lets negative controls attempt their own authorization
	// while the outer mutation retains the original single connection.
	otherService := NewWorkspaceService(db.New(pool), WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()))
	calls := 0
	err = svc.withWorkspaceMutationAuthority(ctx, row, person, func(held context.Context) error {
		for _, denied := range []struct {
			row   db.Workspace
			actor int64
		}{{other, person}, {row, outsider}} {
			err := otherService.withWorkspaceMutationAuthority(held, denied.row, denied.actor, func(context.Context) error {
				t.Fatal("held authority must not authorize another workspace or member")
				return nil
			})
			requireBranchStatus(t, err, 403)
		}
		calls++
		return svc.withWorkspaceMutationAuthority(held, row, person, func(context.Context) error {
			calls++
			return nil
		})
	})
	require.NoError(t, err, "a nested lifecycle operation reuses the held authority")
	require.Equal(t, 2, calls)
}

// A background machine stays refused to a step nested under held authority,
// and the held transaction answers that refusal: the mark below exists only
// inside it, and the one-connection pool has no second connection to give.
func TestBackgroundMachineRefusalReadsTheHeldTransaction(t *testing.T) {
	pool := newProductTestPool(t)
	person, repo := setupTestUserAndRepo(t, pool)
	cfg := pool.Config().Copy()
	cfg.MaxConns, cfg.MinConns = 1, 0
	single, err := pgxpool.NewWithConfig(t.Context(), cfg)
	require.NoError(t, err)
	t.Cleanup(single.Close)
	svc := NewWorkspaceService(db.New(single), WithWorkspaceTransactions(single), WithBranchMachineProviders(branchMachineTestProviders()))
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	row, err := svc.createWorkspaceRow(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: person,
		TargetBookmark: "scratch/owner/background", Kind: "container", Status: "starting"})
	require.NoError(t, err)
	var definition, run int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_definitions(repository_id,name,path,config) VALUES ($1,'manual','.smithers/manual.ts','{}') RETURNING id`, repo).Scan(&definition))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_runs(repository_id,workflow_definition_id,status,trigger_event,trigger_ref) VALUES ($1,$2,'running','manual','main') RETURNING id`, repo, definition).Scan(&run))
	nested := 0
	err = svc.withWorkspaceMutationAuthority(ctx, row, person, func(held context.Context) error {
		tx := heldWorkspaceMutationTransaction(held, row.ID, person)
		require.NotNil(t, tx)
		_, err := tx.Exec(held, `INSERT INTO workflow_run_flow_invocations(workflow_run_id,user_id,flow_id,operation_id,background_workspace_id) VALUES ($1,$2,'main','background-op',$3::uuid)`, run, person, row.ID)
		require.NoError(t, err)
		return svc.withWorkspaceMutationAuthority(held, row, person, func(context.Context) error {
			nested++
			return nil
		})
	})
	requireBranchStatus(t, err, 403)
	require.ErrorContains(t, err, "background machine belongs to its run")
	require.Zero(t, nested)

	// Entry must use its own admission transaction as well, with only one
	// connection available. The failed nested mutation above rolled back.
	_, err = pool.Exec(ctx, `INSERT INTO workflow_run_flow_invocations(workflow_run_id,user_id,flow_id,operation_id,background_workspace_id) VALUES ($1,$2,'main','terminal-background-op',$3::uuid)`, run, person, row.ID)
	require.NoError(t, err)
	for _, branch := range []string{row.ID, row.TargetBookmark} {
		_, err = svc.AuthorizeTerminalBranch(ctx, branch, repo, person)
		requireBranchStatus(t, err, 403)
		require.ErrorContains(t, err, "background machine belongs to its run")
	}
	// Classification outages never grant person admission. This fixture owns
	// its isolated database; restore the table even if an assertion fails.
	_, err = pool.Exec(ctx, `ALTER TABLE workflow_run_flow_invocations RENAME TO unavailable_background_classification`)
	require.NoError(t, err)
	defer pool.Exec(context.WithoutCancel(ctx), `ALTER TABLE unavailable_background_classification RENAME TO workflow_run_flow_invocations`)
	_, err = svc.AuthorizeTerminalBranch(ctx, row.ID, repo, person)
	require.Error(t, err, "an unreadable classification must fail closed")
}

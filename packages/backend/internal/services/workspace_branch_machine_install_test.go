package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// installRuntime is a workspace runtime seen only through what the install
// providers read: its isolation and, when guest is set, its guest account.
type installRuntime struct {
	workspaceapi.WorkspaceRuntime
	level workspaceapi.IsolationLevel
}

func (r installRuntime) Isolation() workspaceapi.IsolationLevel { return r.level }

type guestRuntime struct {
	installRuntime
	login string
	uid   int
}

func (r guestRuntime) GuestIdentity() (string, int) { return r.login, r.uid }

// ownerAuthorizer is the member boundary of an install whose verified owner
// is owner; calls counts its checks.
type ownerAuthorizer struct {
	owner int64
	calls *int
}

func (a ownerAuthorizer) AuthorizeMember(_ context.Context, userID int64) *pkgerrors.APIError {
	if a.calls != nil {
		*a.calls++
	}
	if userID != a.owner {
		return pkgerrors.Forbidden("credential does not belong to the installation owner")
	}
	return nil
}

func requireBranchStatus(t *testing.T, err error, status int) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, status, apiErr.Status, apiErr.Message)
}

func TestInstallBranchMachineMicroVM(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name    string
		runtime workspaceapi.WorkspaceRuntime
		ok      bool
	}{
		{name: "no runtime"},
		{name: "trusted process", runtime: installRuntime{level: workspaceapi.IsolationTrustedProcess}},
		{name: "unknown isolation", runtime: installRuntime{level: "container"}},
		{name: "microVM", runtime: installRuntime{level: workspaceapi.IsolationSandboxed}, ok: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := InstallBranchMachineProviders(ownerAuthorizer{}, tc.runtime).MicroVM(ctx)
			if tc.ok {
				require.NoError(t, err)
				return
			}
			requireBranchStatus(t, err, 503)
		})
	}
}

func TestInstallBranchMachineSessionIdentity(t *testing.T) {
	ctx := context.Background()
	isolated := installRuntime{level: workspaceapi.IsolationSandboxed}
	for _, tc := range []struct {
		name    string
		runtime workspaceapi.WorkspaceRuntime
		ok      bool
	}{
		{name: "no runtime"},
		{name: "names no guest account", runtime: isolated},
		{name: "root by name", runtime: guestRuntime{isolated, "root", 19999}},
		{name: "root by uid", runtime: guestRuntime{isolated, "agent", 0}},
		{name: "negative uid", runtime: guestRuntime{isolated, "agent", -1}},
		{name: "unnamed", runtime: guestRuntime{isolated, "", 19999}},
		{name: "agent", runtime: guestRuntime{isolated, "agent", 19999}, ok: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := InstallBranchMachineProviders(ownerAuthorizer{}, tc.runtime).SessionIdentity(ctx)
			if tc.ok {
				require.NoError(t, err)
				return
			}
			requireBranchStatus(t, err, 503)
		})
	}
}

func TestInstallBranchMachineAuthorizer(t *testing.T) {
	ctx := context.Background()
	calls := 0
	authorize := InstallBranchMachineProviders(ownerAuthorizer{owner: 7, calls: &calls}, nil).Authorize
	for _, command := range []string{"branch.join", "branches.read"} {
		require.NoError(t, authorize(ctx, nil, command, 101, "scratch/owner/a", 7), command)
	}
	require.Equal(t, 2, calls)
	requireBranchStatus(t, authorize(ctx, nil, "branch.join", 101, "scratch/owner/a", 8), 403)
	require.Equal(t, 3, calls)
	for _, command := range []string{"", "branch.fork", "branch.delete", "Branch.Join"} {
		requireBranchStatus(t, authorize(ctx, nil, command, 101, "scratch/owner/a", 7), 403)
	}
	require.Equal(t, 3, calls, "an unknown command is refused before the member check")
	requireBranchStatus(t, InstallBranchMachineProviders(nil, nil).Authorize(ctx, nil, "branch.join", 101, "main", 7), 503)
}

// installBranchOwner makes userID the install's owner, the roster's one
// member.
func installBranchOwner(t *testing.T, pool *pgxpool.Pool, userID int64) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `INSERT INTO self_host_owners(singleton,user_id) VALUES(true,$1)`, userID)
	require.NoError(t, err)
}

func TestInstallBranchMachineMembership(t *testing.T) {
	pool := newProductTestPool(t)
	owner, repo := setupTestUserAndRepo(t, pool)
	installBranchOwner(t, pool, owner)
	ctx := context.Background()
	var other int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('not-owner','not-owner') RETURNING id`).Scan(&other))
	membership := InstallBranchMachineProviders(ownerAuthorizer{owner: owner}, nil).Membership
	check := func(actor int64) error {
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		defer func() { _ = tx.Rollback(ctx) }()
		return membership(ctx, tx, repo, actor)
	}
	require.NoError(t, check(owner))
	requireBranchStatus(t, check(other), 403)
	requireBranchStatus(t, check(0), 403)
	for _, change := range []string{`is_active=false`, `prohibit_login=true`, `deleted_at=NOW()`} {
		t.Run(change, func(t *testing.T) {
			tx, err := pool.Begin(ctx)
			require.NoError(t, err)
			defer func() { _ = tx.Rollback(ctx) }()
			_, err = tx.Exec(ctx, `UPDATE users SET `+change+` WHERE id=$1`, owner)
			require.NoError(t, err)
			requireBranchStatus(t, membership(ctx, tx, repo, owner), 403)
		})
	}
	require.NoError(t, check(owner), "the refusals changed nothing")
}

func TestInstallLaneBinding(t *testing.T) {
	pool := newProductTestPool(t)
	user, repo := setupTestUserAndRepo(t, pool)
	_, otherRepo := setupTestUserAndRepo(t, pool)
	ctx := context.Background()
	q := db.New(pool)
	machine := func(name string) string {
		row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: user, Name: name, Kind: "container", Status: "starting",
			TargetBookmark: MythicalBookmark, EnvironmentSource: defaultWorkspaceEnvironmentSource})
		require.NoError(t, err)
		return row.ID
	}
	item, _, err := q.InsertMythicalChatItem(ctx, db.MythicalItem{RepositoryID: repo, IssueTitle: "lane"})
	require.NoError(t, err)
	bound, retired, unbound := machine("bound lane"), machine("retired lane"), machine("unbound")
	for name, id := range map[string]string{"bound": bound, "retired": retired} {
		_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: id, RepositoryID: repo, ItemID: item.ID, Name: name})
		require.NoError(t, err)
	}
	require.NoError(t, q.RetireMythicalLane(ctx, retired))
	laneBinding := InstallBranchMachineProviders(ownerAuthorizer{}, nil).LaneBinding
	creating := withStackLaneCreation(ctx)
	for _, tc := range []struct {
		name       string
		ctx        context.Context
		repo       int64
		branch, id string
		forbidden  bool
	}{
		{name: "scratch branch, new", ctx: ctx, repo: repo, branch: "scratch/owner/try"},
		{name: "scratch branch, existing", ctx: ctx, repo: repo, branch: "scratch/owner/try", id: unbound},
		{name: "main", ctx: ctx, repo: repo, branch: "main"},
		{name: "stack lane the stack creates", ctx: creating, repo: repo, branch: MythicalBookmark},
		{name: "stack machine created by anyone else", ctx: ctx, repo: repo, branch: MythicalBookmark, forbidden: true},
		{name: "bound lane", ctx: ctx, repo: repo, branch: MythicalBookmark, id: bound},
		{name: "bound lane in another repository", ctx: ctx, repo: otherRepo, branch: MythicalBookmark, id: bound, forbidden: true},
		{name: "retired lane", ctx: ctx, repo: repo, branch: MythicalBookmark, id: retired, forbidden: true},
		{name: "unbound stack machine", ctx: ctx, repo: repo, branch: MythicalBookmark, id: unbound, forbidden: true},
		{name: "the stack's creation marker never admits an existing machine", ctx: creating, repo: repo, branch: MythicalBookmark, id: unbound, forbidden: true},
		{name: "item branch by name", ctx: ctx, repo: repo, branch: "smithers/add-a-greeting", forbidden: true},
		{name: "item branch by name, as the stack", ctx: creating, repo: repo, branch: "smithers/add-a-greeting", forbidden: true},
		{name: "item branch through its lane", ctx: ctx, repo: repo, branch: "smithers/add-a-greeting", id: bound},
		{name: "item branch through a retired lane", ctx: ctx, repo: repo, branch: "smithers/add-a-greeting", id: retired, forbidden: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx, err := pool.Begin(ctx)
			require.NoError(t, err)
			defer func() { _ = tx.Rollback(ctx) }()
			err = laneBinding(tc.ctx, tx, tc.repo, tc.branch, tc.id)
			if tc.forbidden {
				requireBranchStatus(t, err, 403)
				return
			}
			require.NoError(t, err)
		})
	}
}

// installLaneService is a workspace service with the install's providers on a
// microVM whose guest runs as agent, owned by the install's owner.
func installLaneService(t *testing.T, pool *pgxpool.Pool, owner int64) *WorkspaceService {
	t.Helper()
	providers := InstallBranchMachineProviders(ownerAuthorizer{owner: owner},
		guestRuntime{installRuntime{level: workspaceapi.IsolationSandboxed}, "agent", 19999})
	return NewWorkspaceService(db.New(pool), WithWorkspaceTransactions(pool), WithBranchMachineProviders(providers))
}

// Every stack lane works from the stack's bookmark, yet each is its own
// branch machine (T-MCH-04): two TODOs never share one, the same lane is
// found again after a crash between its insert and its binding, and only the
// stack creates one.
func TestStackLanesAreTheirOwnBranchMachines(t *testing.T) {
	pool := newProductTestPool(t)
	owner, repo := setupTestUserAndRepo(t, pool)
	installBranchOwner(t, pool, owner)
	ctx := context.Background()
	svc := installLaneService(t, pool, owner)
	metadata := workspaceCreateMetadata{kind: "container"}
	lane := func(name string) db.Workspace {
		row, err := svc.createDerivedWorkspaceForBookmark(withStackLaneCreation(ctx), repo, owner, name, MythicalBookmark, metadata)
		require.NoError(t, err)
		return row
	}
	first, second := lane("TODO 1 attempt 1 g1"), lane("TODO 2 attempt 1 g1")
	require.NotEqual(t, first.ID, second.ID, "a second TODO gets its own machine")
	for _, row := range []db.Workspace{first, second} {
		require.Equal(t, MythicalBookmark, row.TargetBookmark, "every lane works from the stack")
		machineOwner, err := db.New(pool).GetBranchMachineOwner(ctx)
		require.NoError(t, err)
		require.Equal(t, machineOwner, row.UserID, "the machine service owns the lane")
		sole, err := db.New(pool).WorkspaceSoleWriter(ctx, db.WorkspaceSoleWriterParams{WorkspaceID: row.ID, UserID: owner})
		require.NoError(t, err)
		require.True(t, sole, "the TODO's person is the lane's one writer")
	}
	require.Equal(t, first.ID, lane("TODO 1 attempt 1 g1").ID, "an unbound lane is found again, never duplicated")
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1 AND target_bookmark=$2 AND deleted_at IS NULL`, repo, MythicalBookmark).Scan(&count))
	require.Equal(t, 2, count)

	// Only the stack creates a machine on its bookmark.
	_, err := svc.createDerivedWorkspaceForBookmark(ctx, repo, owner, "TODO 3 attempt 1 g1", MythicalBookmark, metadata)
	require.ErrorIs(t, err, errBranchMachineAdmission)
	requireBranchStatus(t, err, 403)

	// A scratch branch is still one machine per branch, whatever its name.
	scratch, err := svc.createDerivedWorkspaceForBookmark(ctx, repo, owner, "one", "scratch/owner/try", metadata)
	require.NoError(t, err)
	again, err := svc.createDerivedWorkspaceForBookmark(ctx, repo, owner, "two", "scratch/owner/try", metadata)
	require.NoError(t, err)
	require.Equal(t, scratch.ID, again.ID)

	// A person outside the roster creates nothing.
	var other int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('outsider','outsider') RETURNING id`).Scan(&other))
	_, err = svc.createDerivedWorkspaceForBookmark(withStackLaneCreation(ctx), repo, other, "TODO 4 attempt 1 g1", MythicalBookmark, metadata)
	require.ErrorIs(t, err, errBranchMachineAdmission)
}

// The stack binds a lane after creating it; until then the lane's person may
// not touch it, and once bound they may. A failed bind deletes the never
// provisioned machine, unless a claimant bound that same lane first.
func TestStackLaneCreateBindsOrDeletes(t *testing.T) {
	pool := newProductTestPool(t)
	owner, repo := setupTestUserAndRepo(t, pool)
	installBranchOwner(t, pool, owner)
	ctx := context.Background()
	svc := installLaneService(t, pool, owner)
	q := db.New(pool)
	repository, err := q.GetRepoByID(ctx, repo)
	require.NoError(t, err)
	item, _, err := q.InsertMythicalChatItem(ctx, db.MythicalItem{RepositoryID: repo, IssueTitle: "lane"})
	require.NoError(t, err)
	lanes := NewWorkspaceMythicalLanes(svc)
	refused := errors.New("bind refused")

	var created string
	_, err = lanes.Create(ctx, repository, "owner", owner, "TODO 1 attempt 1 g1", MythicalPlacement{Kind: "container"}, func(id string) error {
		created = id
		// Before its binding, the lane admits no person.
		require.ErrorIs(t, svc.preflightBranchMachine(ctx, repo, owner, MythicalBookmark, id), errBranchMachineAdmission)
		return refused
	})
	require.ErrorIs(t, err, refused)
	require.NotEmpty(t, created)
	var live int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE id=$1 AND deleted_at IS NULL`, created).Scan(&live))
	require.Zero(t, live, "an unbound lane that was never provisioned is deleted")

	var kept string
	_, err = lanes.Create(ctx, repository, "owner", owner, "TODO 1 attempt 2 g2", MythicalPlacement{Kind: "container"}, func(id string) error {
		kept = id
		_, _, err := q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: id, RepositoryID: repo, ItemID: item.ID, Name: "TODO 1 attempt 2 g2"})
		require.NoError(t, err)
		return errMythicalLaneTaken
	})
	require.ErrorIs(t, err, errMythicalLaneTaken)
	row, err := q.GetWorkspace(ctx, kept)
	require.NoError(t, err)
	require.False(t, row.DeletedAt.Valid, "a lane a claimant bound first is theirs")
	require.NoError(t, svc.preflightBranchMachine(ctx, repo, owner, MythicalBookmark, kept), "a bound lane admits its person")

	// Retirement succeeds and retains the machine; the retired lane then
	// admits no person, and the next lane is a machine of its own.
	require.NoError(t, lanes.Delete(ctx, repo, owner, kept))
	require.NoError(t, q.RetireMythicalLane(ctx, kept))
	row, err = q.GetWorkspace(ctx, kept)
	require.NoError(t, err)
	require.False(t, row.DeletedAt.Valid, "a retired lane keeps its machine")
	require.ErrorIs(t, svc.preflightBranchMachine(ctx, repo, owner, MythicalBookmark, kept), errBranchMachineAdmission)
	next, err := svc.createDerivedWorkspaceForBookmark(withStackLaneCreation(ctx), repo, owner, "TODO 1 attempt 3 g3", MythicalBookmark, workspaceCreateMetadata{kind: "container"})
	require.NoError(t, err)
	require.NotEqual(t, kept, next.ID)
}

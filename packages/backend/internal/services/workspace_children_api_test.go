package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/smithersai/smithers/packages/backend/sandbox/sandboxfake"
)

// childGuestExec answers the guest commands a parent and its children run: it
// writes the children credential from the exec's secret environment and
// removes the parent's identity exactly as the child scrub does.
func childGuestExec(machine *sandboxfake.Machine, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	ok := int32(0)
	switch req.Command {
	case workspaceChildrenTokenInstallCommand(defaultWorkspaceUser):
		machine.Files[workspaceChildrenTokenPath] = req.Secrets[workspaceChildrenTokenEnv]
		return sandbox.ExecResult{StatusCode: &ok}, nil
	case workspaceChildIdentityScrubCommand():
		for _, path := range []string{workspaceCodingConfigPath, workspaceGitCredentialEnvPath, workspaceChildrenTokenPath} {
			delete(machine.Files, path)
		}
		return sandbox.ExecResult{StatusCode: &ok}, nil
	}
	return scrubChildLogins(machine, req)
}

type childTokenRow struct {
	id        int64
	scopes    string
	system    bool
	expiresAt time.Time
}

func (f *childFixture) childTokens(t *testing.T, workspaceID string) []childTokenRow {
	t.Helper()
	rows, err := f.pool.Query(context.Background(),
		`SELECT id, scopes, system_issued, expires_at FROM access_tokens WHERE name = $1 ORDER BY id`, workspaceChildrenTokenName(workspaceID))
	require.NoError(t, err)
	defer rows.Close()
	var out []childTokenRow
	for rows.Next() {
		var row childTokenRow
		require.NoError(t, rows.Scan(&row.id, &row.scopes, &row.system, &row.expiresAt))
		out = append(out, row)
	}
	require.NoError(t, rows.Err())
	return out
}

func (f *childFixture) tokenOwner(t *testing.T, plaintext string) (userID int64, found bool) {
	t.Helper()
	sum := sha256.Sum256([]byte(plaintext))
	err := f.pool.QueryRow(context.Background(), `SELECT user_id FROM access_tokens WHERE token_hash = $1`, hex.EncodeToString(sum[:])).Scan(&userID)
	return userID, err == nil
}

func (f *childFixture) share(t *testing.T, workspaceID, level string) {
	t.Helper()
	grantee, err := f.queries.CreateUser(context.Background(), db.CreateUserParams{Username: "grantee-" + level, LowerUsername: "grantee-" + level, DisplayName: "grantee"})
	require.NoError(t, err)
	f.exec(t, `INSERT INTO workspace_shares (workspace_id, owner_user_id, grantee_user_id, level) VALUES ($1, $2, $3, $4)`,
		workspaceID, f.user, grantee.ID, level)
}

func TestWorkspaceChildrenCredential(t *testing.T) {
	ctx := context.Background()

	t.Run("is minted into the parent, scoped to its children, and never reaches a child", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.provider.ExecFunc = childGuestExec
		require.NoError(t, f.svc.installWorkspaceChildrenToken(ctx, f.parent, f.parent.VmID))
		machine, _ := f.provider.Machine(f.parent.VmID)
		plaintext := machine.Files[workspaceChildrenTokenPath]
		require.NotEmpty(t, plaintext)
		owner, found := f.tokenOwner(t, plaintext)
		require.True(t, found)
		require.Equal(t, f.user, owner)
		tokens := f.childTokens(t, f.parent.ID)
		require.Len(t, tokens, 1)
		require.True(t, tokens[0].system)
		require.WithinDuration(t, time.Now().Add(workspaceChildrenTokenTTL), tokens[0].expiresAt, time.Minute)
		require.Equal(t, "read:repository,write:workspace,repo:"+strconv.FormatInt(f.repo, 10)+",workspace:"+f.parent.ID+",credential:workspace-children", tokens[0].scopes)
		scopes := middleware.ParseTokenScopes(tokens[0].scopes)
		require.False(t, scopes.Has(middleware.ScopeWriteRepository), "it cannot push")
		require.True(t, middleware.ParseTokenWorkspaceChildrenCredential(tokens[0].scopes))

		for _, exec := range f.provider.Execs() {
			require.NotContains(t, exec.Command, plaintext, "the credential never rides the command line")
		}

		_, err := f.spawn(t, 2, "")
		require.NoError(t, err)
		for _, child := range f.receipts(t) {
			require.Equal(t, "running", child.Status)
			machine, _ := f.provider.Machine(child.VMID)
			require.NotContains(t, machine.Files, workspaceChildrenTokenPath, "a child drops the parent's credential")
			row, err := f.queries.GetWorkspace(ctx, child.WorkspaceID)
			require.NoError(t, err)
			require.NoError(t, f.svc.installWorkspaceChildrenToken(ctx, row, child.VMID))
			require.Empty(t, f.childTokens(t, child.WorkspaceID), "a child never gets a credential of its own")
		}

		require.NoError(t, f.svc.installWorkspaceChildrenToken(ctx, f.parent, f.parent.VmID))
		rotated := f.childTokens(t, f.parent.ID)
		require.Len(t, rotated, 1, "the next start revokes the previous credential")
		require.NotEqual(t, tokens[0].id, rotated[0].id)
		_, found = f.tokenOwner(t, plaintext)
		require.False(t, found)

		f.svc.revokeWorkspaceHeadToken(ctx, f.parent)
		require.Empty(t, f.childTokens(t, f.parent.ID), "stopping the workspace revokes it")
	})

	t.Run("is owned by the default workspace user when none is configured", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.provider.ExecFunc = childGuestExec
		f.svc.workspaceUsername = " "
		require.NoError(t, f.svc.installWorkspaceChildrenToken(ctx, f.parent, f.parent.VmID))
		machine, _ := f.provider.Machine(f.parent.VmID)
		require.NotEmpty(t, machine.Files[workspaceChildrenTokenPath])
		require.Contains(t, workspaceChildrenTokenInstallCommand(defaultWorkspaceUser), "chmod 600")
	})

	t.Run("is withheld from a workspace another person may write into", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.provider.ExecFunc = childGuestExec
		require.NoError(t, f.svc.installWorkspaceChildrenToken(ctx, f.parent, f.parent.VmID))
		f.share(t, f.parent.ID, "read")
		require.NoError(t, f.svc.installWorkspaceChildrenToken(ctx, f.parent, f.parent.VmID))
		require.Len(t, f.childTokens(t, f.parent.ID), 1, "a read share keeps it")
		f.share(t, f.parent.ID, "write")
		require.NoError(t, f.svc.installWorkspaceChildrenToken(ctx, f.parent, f.parent.VmID))
		require.Empty(t, f.childTokens(t, f.parent.ID), "a write share revokes it and mints none")
	})

	t.Run("is skipped where children cannot exist", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.provider.ExecFunc = childGuestExec
		desktop := f.parent
		desktop.Kind = "desktop"
		require.NoError(t, f.svc.installWorkspaceChildrenToken(ctx, desktop, f.parent.VmID))
		require.NoError(t, f.svc.installWorkspaceChildrenToken(ctx, f.parent, " "))
		require.Empty(t, f.childTokens(t, f.parent.ID))

		fork := f.parent
		fork.IsFork = true
		require.NoError(t, f.svc.installWorkspaceChildrenToken(ctx, fork, f.parent.VmID))
		require.Len(t, f.childTokens(t, f.parent.ID), 1, "an ordinary fork is a workspace like any other")

		bare := NewWorkspaceService(f.queries, WithWorkspaceSandboxClient(f.provider))
		require.NoError(t, bare.installWorkspaceChildrenToken(ctx, f.parent, f.parent.VmID), "no child store, no credential")
		bare.revokeWorkspaceChildrenToken(ctx, db.Workspace{})
		require.Len(t, f.childTokens(t, f.parent.ID), 1)
	})

	t.Run("a failed install revokes what it minted", func(t *testing.T) {
		for name, exec := range map[string]func(*sandboxfake.Machine, sandbox.ExecRequest) (sandbox.ExecResult, error){
			"transport": func(*sandboxfake.Machine, sandbox.ExecRequest) (sandbox.ExecResult, error) {
				return sandbox.ExecResult{}, errors.New("exec channel closed")
			},
			"status": func(*sandboxfake.Machine, sandbox.ExecRequest) (sandbox.ExecResult, error) {
				failed := int32(1)
				return sandbox.ExecResult{StatusCode: &failed, Stderr: "read-only file system"}, nil
			},
		} {
			t.Run(name, func(t *testing.T) {
				f := newChildFixture(t, nil)
				f.provider.ExecFunc = exec
				err := f.svc.installWorkspaceChildrenToken(ctx, f.parent, f.parent.VmID)
				require.ErrorContains(t, err, "install workspace children token")
				require.Empty(t, f.childTokens(t, f.parent.ID))
			})
		}
	})

	t.Run("storage failures install nothing", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.provider.ExecFunc = childGuestExec
		fork := f.parent
		fork.IsFork = true
		f.inject("IsWorkspaceChild")
		require.ErrorIs(t, f.svc.installWorkspaceChildrenToken(ctx, fork, f.parent.VmID), errChildFault)

		f = newChildFixture(t, nil)
		f.svc.q = childTokenStoreFault{Queries: f.queries, shares: true}
		require.ErrorContains(t, f.svc.installWorkspaceChildrenToken(ctx, f.parent, f.parent.VmID), "check workspace shares")
		f.svc.q = childTokenStoreFault{Queries: f.queries}
		require.ErrorContains(t, f.svc.installWorkspaceChildrenToken(ctx, f.parent, f.parent.VmID), "mint workspace children token")
		require.Empty(t, f.childTokens(t, f.parent.ID))
	})

	t.Run("head reporter install carries it and survives its failure", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.provider.ExecFunc = func(machine *sandboxfake.Machine, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			if req.Command == workspaceChildrenTokenInstallCommand(defaultWorkspaceUser) {
				return sandbox.ExecResult{}, errors.New("exec channel closed")
			}
			return childGuestExec(machine, req)
		}
		f.svc.gitBaseURL = "http://smithers.test"
		_, err := f.svc.installWorkspaceHeadReporter(ctx, f.parent, f.parent.VmID)
		require.NoError(t, err, "a workspace without the credential still works")
		require.Empty(t, f.childTokens(t, f.parent.ID))
		f.provider.ExecFunc = childGuestExec
		_, err = f.svc.installWorkspaceHeadReporter(ctx, f.parent, f.parent.VmID)
		require.NoError(t, err)
		require.Len(t, f.childTokens(t, f.parent.ID), 1)
	})
}

// childTokenStoreFault fails the credential's own store calls.
type childTokenStoreFault struct {
	*db.Queries
	shares bool
}

func (s childTokenStoreFault) HasWritableWorkspaceShares(ctx context.Context, id string) (bool, error) {
	if s.shares {
		return false, errChildFault
	}
	return s.Queries.HasWritableWorkspaceShares(ctx, id)
}

func (childTokenStoreFault) CreateAccessToken(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
	return db.AccessToken{}, errChildFault
}

func TestWorkspaceChildrenFromInsideASharedWorkspaceAreRefused(t *testing.T) {
	ctx := context.Background()
	f := newChildFixture(t, nil)
	f.share(t, f.parent.ID, "write")
	input := SpawnWorkspaceChildrenInput{RepositoryID: f.repo, UserID: f.user, ParentWorkspaceID: f.parent.ID, Count: 1, ViaWorkspaceCredential: true}
	_, err := f.svc.SpawnWorkspaceChildren(ctx, input)
	requireChildAPIError(t, err, pkgerrors.CodeForbidden, "others can write into")
	input.ViaWorkspaceCredential = false
	_, err = f.svc.SpawnWorkspaceChildren(ctx, input)
	require.NoError(t, err, "the owner may still spawn from outside")
	require.NoError(t, f.svc.WaitForProvisioning(ctx))

	f = newChildFixture(t, nil)
	f.inject("HasWritableWorkspaceShares")
	_, err = f.svc.SpawnWorkspaceChildren(ctx, SpawnWorkspaceChildrenInput{RepositoryID: f.repo, UserID: f.user, ParentWorkspaceID: f.parent.ID, Count: 1, ViaWorkspaceCredential: true})
	requireChildFault(t, err)
}

func TestWorkspaceChildrenSpendSandboxHours(t *testing.T) {
	ctx := context.Background()
	spent := &SandboxEntitlement{PlanKey: BillingPlanPro, ConcurrentChildren: 16, ChildMaxTTLSecs: 3600,
		HoursPerDay: 2, SecondsUsedToday: 2 * 3600, DayResetsAt: time.Now().Add(time.Hour)}

	t.Run("no child spawns once today's hours are spent", func(t *testing.T) {
		f := newChildFixture(t, spent)
		_, err := f.spawn(t, 1, "")
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		require.Equal(t, "sandbox_hours_per_day", apiErr.LimitKind)
		require.NotNil(t, apiErr.ResetAt)
		require.Empty(t, f.provider.Snapshots())
	})

	t.Run("a child's awake time is metered as sandbox time", func(t *testing.T) {
		f := newChildFixture(t, nil)
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		child := f.receipts(t)[0]
		var user int64
		var ended *time.Time
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT user_id, ended_at FROM sandbox_usage_intervals WHERE sandbox_kind = 'workspace' AND sandbox_id = $1`,
			child.WorkspaceID).Scan(&user, &ended))
		require.Equal(t, f.user, user)
		require.Nil(t, ended, "a running child is awake")
		_, err = f.svc.StopWorkspaceChild(ctx, f.parent.ID, child.WorkspaceID, f.repo, f.user)
		require.NoError(t, err)
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT ended_at FROM sandbox_usage_intervals WHERE sandbox_id = $1`, child.WorkspaceID).Scan(&ended))
		require.NotNil(t, ended, "a stopped child is not billed")
	})

	t.Run("the hours sweep stops children through their parent and never suspends them", func(t *testing.T) {
		f := newChildFixture(t, nil)
		_, err := f.spawn(t, 2, "")
		require.NoError(t, err)
		f.svc.billing = sandboxPolicyStub{entitlement: *spent}
		require.NoError(t, f.svc.CleanupOverQuotaWorkspaces(ctx))
		require.NoError(t, f.svc.WaitForProvisioning(ctx))
		parent, err := f.queries.GetWorkspace(ctx, f.parent.ID)
		require.NoError(t, err)
		require.Equal(t, "suspended", parent.Status)
		for _, child := range f.receipts(t) {
			require.Equal(t, "stopped", child.Status, "a child is never suspended")
			require.Equal(t, "parent_stopped", child.StopReason)
		}
		require.Equal(t, []string{f.parent.VmID}, f.provider.Live(), "every child machine is deleted; the parent keeps its disk")
	})

	t.Run("only a child is left to its parent", func(t *testing.T) {
		f := newChildFixture(t, nil)
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		child, err := f.queries.GetWorkspace(ctx, f.receipts(t)[0].WorkspaceID)
		require.NoError(t, err)
		for name, tc := range map[string]struct {
			workspace db.Workspace
			child     bool
		}{
			"child":         {child, true},
			"workspace":     {f.parent, false},
			"ordinary fork": {db.Workspace{ID: f.parent.ID, IsFork: true}, false},
		} {
			got, err := f.svc.overQuotaWorkspaceChild(ctx, tc.workspace)
			require.NoError(t, err, name)
			require.Equal(t, tc.child, got, name)
		}
		f.svc.billing = sandboxPolicyStub{entitlement: *spent}
		f.inject("IsWorkspaceChild")
		require.ErrorIs(t, f.svc.CleanupOverQuotaWorkspaces(ctx), errChildFault, "the cleaner counts a failed check")
		require.NoError(t, f.svc.WaitForProvisioning(ctx))
	})
}

func TestStopWorkspaceChild(t *testing.T) {
	ctx := context.Background()
	f := newChildFixture(t, nil)
	_, err := f.spawn(t, 2, "")
	require.NoError(t, err)
	receipts := f.receipts(t)

	stopped, err := f.svc.StopWorkspaceChild(ctx, f.parent.ID, receipts[0].WorkspaceID, f.repo, f.user)
	require.NoError(t, err)
	require.Equal(t, receipts[0].WorkspaceID, stopped.WorkspaceID)
	require.Equal(t, "stopped", stopped.Status)
	require.Equal(t, "requested", stopped.StopReason)
	require.NotNil(t, stopped.StoppedAt)
	require.NotContains(t, f.provider.Live(), receipts[0].VMID, "its machine is deleted at once")
	require.Contains(t, f.provider.Live(), receipts[1].VMID, "its sibling keeps running")

	again, err := f.svc.StopWorkspaceChild(ctx, f.parent.ID, receipts[0].WorkspaceID, f.repo, f.user)
	require.NoError(t, err)
	require.Equal(t, stopped.StoppedAt, again.StoppedAt, "stopping a stopped child answers its receipt")

	for name, call := range map[string]func() error{
		"another parent's child": func() error {
			other := f.workspace(t, "other", f.provider.Boot(nil))
			_, err := f.svc.StopWorkspaceChild(ctx, other.ID, receipts[1].WorkspaceID, f.repo, f.user)
			return err
		},
		"not a child": func() error {
			_, err := f.svc.StopWorkspaceChild(ctx, f.parent.ID, f.parent.ID, f.repo, f.user)
			return err
		},
		"not an id": func() error {
			_, err := f.svc.StopWorkspaceChild(ctx, f.parent.ID, "child-0", f.repo, f.user)
			return err
		},
		"another repository": func() error {
			_, err := f.svc.StopWorkspaceChild(ctx, f.parent.ID, receipts[1].WorkspaceID, f.repo+1000, f.user)
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, call(), &apiErr)
			require.Equal(t, pkgerrors.CodeNotFound, apiErr.Code)
			require.Contains(t, f.provider.Live(), receipts[1].VMID)
		})
	}

	t.Run("a machine that will not delete is left to the sweep", func(t *testing.T) {
		f.provider.DeleteErr = func(string) error { return errors.New("provider down") }
		defer func() { f.provider.DeleteErr = nil }()
		child, err := f.svc.StopWorkspaceChild(ctx, f.parent.ID, receipts[1].WorkspaceID, f.repo, f.user)
		require.NoError(t, err)
		require.Equal(t, "stopped", child.Status)
		require.Contains(t, f.provider.Live(), receipts[1].VMID)
	})

	t.Run("storage faults", func(t *testing.T) {
		for _, name := range []string{"ListWorkspaceChildReceipts", "StopWorkspaceChild"} {
			t.Run(name, func(t *testing.T) {
				f := newChildFixture(t, nil)
				_, err := f.spawn(t, 1, "")
				require.NoError(t, err)
				child := f.receipts(t)[0]
				f.inject(name)
				_, err = f.svc.StopWorkspaceChild(ctx, f.parent.ID, child.WorkspaceID, f.repo, f.user)
				requireChildFault(t, err)
			})
		}
	})

	t.Run("a shared parent's grantee cannot stop its children", func(t *testing.T) {
		f := newChildFixture(t, nil)
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		child := f.receipts(t)[0]
		grantee, err := f.queries.CreateUser(ctx, db.CreateUserParams{Username: "writer", LowerUsername: "writer", DisplayName: "writer"})
		require.NoError(t, err)
		f.exec(t, `INSERT INTO workspace_shares (workspace_id, owner_user_id, grantee_user_id, level) VALUES ($1, $2, $3, 'write')`, f.parent.ID, f.user, grantee.ID)
		_, err = f.svc.StopWorkspaceChild(ctx, f.parent.ID, child.WorkspaceID, f.repo, grantee.ID)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		require.Contains(t, []pkgerrors.Code{pkgerrors.CodeNotFound, pkgerrors.CodeForbidden}, apiErr.Code)
		require.Equal(t, "running", f.receipts(t)[0].Status)
	})

	t.Run("needs the sandbox provider", func(t *testing.T) {
		bare := NewWorkspaceService(f.queries)
		_, err := bare.StopWorkspaceChild(ctx, f.parent.ID, receipts[1].WorkspaceID, f.repo, f.user)
		requireChildAPIError(t, err, pkgerrors.CodeConflict, "sandbox provider")
	})
}

package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

func requireBranchMachineUnavailable(t *testing.T, err error) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, pkgerrors.CodeServiceUnavailable, apiErr.Code)
}

func TestBranchMachineUnavailableProviders(t *testing.T) {
	allow := func(context.Context) error { return nil }
	complete := BranchMachineProviders{
		Membership:  func(context.Context, pgx.Tx, int64, int64) error { return nil },
		Authorize:   func(context.Context, pgx.Tx, string, int64, string, int64) error { return nil },
		LaneBinding: func(context.Context, pgx.Tx, int64, string, string) error { return nil },
		MicroVM:     allow, SessionIdentity: allow,
	}
	for _, missing := range []string{"membership", "authorizer", "lane", "microvm", "identity", "transaction"} {
		t.Run(missing, func(t *testing.T) {
			p := complete
			switch missing {
			case "membership":
				p.Membership = nil
			case "authorizer":
				p.Authorize = nil
			case "lane":
				p.LaneBinding = nil
			case "microvm":
				p.MicroVM = nil
			case "identity":
				p.SessionIdentity = nil
			}
			q := &mockWorkspaceQuerier{createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
				t.Fatal("unavailable providers must write no row")
				return db.Workspace{}, nil
			}}
			svc := NewWorkspaceService(q, WithBranchMachineProviders(p))
			if missing != "transaction" {
				svc.transactions = refusingBranchTransactions{t}
			}
			input := CreateWorkspaceInput{RepositoryID: 101, UserID: 1, SourceBookmark: "feature/shared"}
			_, err := svc.CreateWorkspace(context.Background(), input)
			requireBranchMachineUnavailable(t, err)
			_, err = svc.CreateWorkspaceAsync(context.Background(), input)
			requireBranchMachineUnavailable(t, err)
			_, err = svc.ForkWorkspace(context.Background(), ForkWorkspaceInput{RepositoryID: 101, UserID: 1})
			requireBranchMachineUnavailable(t, err)
			_, err = svc.CreateAgentWorkspace(context.Background(), CreateAgentWorkspaceInput{RepositoryID: 101, UserID: 1, SessionID: "11111111-1111-4111-8111-111111111111"})
			requireBranchMachineUnavailable(t, err)
			requireBranchMachineUnavailable(t, svc.CheckAgentWorkspaceQuota(context.Background(), 1))
		})
	}
}

type refusingBranchTransactions struct{ t *testing.T }

func (r refusingBranchTransactions) Begin(context.Context) (pgx.Tx, error) {
	r.t.Fatal("missing provider must refuse before transaction")
	return nil, nil
}

func TestCreateWorkspaceNamedIdentity(t *testing.T) {
	row := db.Workspace{UserID: 77, Status: "running", Name: "first member", Kind: "vm", TargetBookmark: "feature/shared", SourceCommit: "abc"}
	for _, name := range []string{"", "another name", "first member"} {
		// Requester, name and kind cannot select a second machine.
		require.NoError(t, branchMachineCompatible(row, db.CreateWorkspaceParams{UserID: 2, Name: name, Kind: "container"}, 77))
	}
	for _, tc := range []struct {
		name   string
		change func(*db.Workspace, *db.CreateWorkspaceParams)
	}{
		{"owner", func(r *db.Workspace, _ *db.CreateWorkspaceParams) { r.UserID = 2 }},
		{"failed retained VM", func(r *db.Workspace, _ *db.CreateWorkspaceParams) { r.Status = "failed"; r.VmID = "retained" }},
		{"failed retained disk", func(r *db.Workspace, _ *db.CreateWorkspaceParams) { r.Status = "failed" }},
		{"stopped", func(r *db.Workspace, _ *db.CreateWorkspaceParams) { r.Status = "stopped" }},
		{"source", func(_ *db.Workspace, a *db.CreateWorkspaceParams) { a.SourceCommit = "other" }},
		{"snapshot", func(_ *db.Workspace, a *db.CreateWorkspaceParams) {
			a.SourceSnapshotID = pgUUIDFromString("11111111-1111-4111-8111-111111111111")
		}},
		{"fork", func(_ *db.Workspace, a *db.CreateWorkspaceParams) {
			a.ParentWorkspaceID = pgUUIDFromString("11111111-1111-4111-8111-111111111111")
		}},
		{"cpu", func(_ *db.Workspace, a *db.CreateWorkspaceParams) { a.VcpuCount = pgtype.Int4{Valid: true, Int32: 2} }},
		{"memory", func(_ *db.Workspace, a *db.CreateWorkspaceParams) { a.MemoryMb = pgtype.Int4{Valid: true, Int32: 1024} }},
		{"disk", func(_ *db.Workspace, a *db.CreateWorkspaceParams) { a.DiskMb = pgtype.Int4{Valid: true, Int32: 4096} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, a := row, db.CreateWorkspaceParams{}
			tc.change(&r, &a)
			var e *pkgerrors.APIError
			require.ErrorAs(t, branchMachineCompatible(r, a, 77), &e)
			require.Equal(t, 409, e.Status)
		})
	}
}

func TestBranchMachineStateProjection(t *testing.T) {
	for _, tc := range []struct{ status, vm, want string }{
		{"running", "vm", "awake"}, {"suspended", "vm", "asleep"}, {"stopped", "", "asleep"},
		{"pending", "", "provisioning"}, {"starting", "", "provisioning"}, {"starting", "vm", "waking"},
		{"failed", "retained", "failed"}, {"archived", "", "closed"},
	} {
		require.Equal(t, tc.want, branchMachineState(db.Workspace{Status: tc.status, VmID: tc.vm}))
	}
}

func TestAgentRunFailurePreservesSharedMachine(t *testing.T) {
	svc := NewWorkspaceService(&mockWorkspaceQuerier{
		getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			t.Fatal("run failure must not mutate or stop its branch machine")
			return db.Workspace{}, nil
		},
	})
	require.NoError(t, svc.FailAgentWorkspace(context.Background(), "shared"))
	require.NoError(t, svc.SuspendAgentWorkspace(context.Background(), "shared"))
}

func TestBranchMachineProviderFailureOrdering(t *testing.T) {
	for fail := 0; fail < 5; fail++ {
		var calls []string
		denied := errors.New("provider refused")
		check := func(name string) error {
			calls = append(calls, name)
			if len(calls) == fail+1 {
				return denied
			}
			return nil
		}
		svc := NewWorkspaceService(&mockWorkspaceQuerier{}, WithWorkspaceTransactions(refusingBranchTransactions{t}), WithBranchMachineProviders(BranchMachineProviders{
			Membership: func(context.Context, pgx.Tx, int64, int64) error { return check("membership") },
			Authorize: func(_ context.Context, _ pgx.Tx, command string, repo int64, branch string, actor int64) error {
				require.Equal(t, "branch.join", command)
				require.EqualValues(t, 101, repo)
				require.Equal(t, "scratch/alice/shared", branch)
				require.EqualValues(t, 2, actor)
				return check("authorizer")
			},
			LaneBinding: func(_ context.Context, _ pgx.Tx, _ int64, _, workspaceID string) error {
				require.Equal(t, "shared-machine", workspaceID)
				return check("lane")
			},
			MicroVM: func(context.Context) error { return check("microvm") }, SessionIdentity: func(context.Context) error { return check("identity") },
		}))
		require.ErrorIs(t, svc.authorizeBranchMachine(context.Background(), nil, 101, 2, "scratch/alice/shared", "shared-machine"), denied)
		require.Equal(t, []string{"membership", "authorizer", "lane", "microvm", "identity"}[:fail+1], calls)
	}
}

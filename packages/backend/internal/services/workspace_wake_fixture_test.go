package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
)

// noBranchMachineOwner answers that the install has no machine service owner
// yet. Once the activation providers are composed, lifecycle authority reads
// this store (branchMachineOwned) and then decides by the row's owner.
type noBranchMachineOwner struct{}

func (noBranchMachineOwner) GetBranchMachineOwner(context.Context) (int64, error) {
	return 0, pgx.ErrNoRows
}

// ownerlessWorkspaceQuerier is a unit store with that owner lookup.
type ownerlessWorkspaceQuerier struct {
	*mockWorkspaceQuerier
	branchMachineOwnerStore
}

// composeHostedSandboxWake gives a hosted sandbox service what a branch wake
// requires since c240bd3cf7 (#3568): machine admission and the activation
// providers (authorizeWorkspaceResume). The wake itself opens no branch
// transaction (unopenedBranchTransactions); a session open also takes the
// provisioning lock, a PostgreSQL advisory transaction.
func composeHostedSandboxWake(s *WorkspaceService, transactions RepositoryJobTransactions) *WorkspaceService {
	WithWorkspaceTransactions(transactions)(s)
	WithBranchMachineProviders(branchMachineTestProviders())(s)
	s.EnableMachineAdmission(nil)
	return s
}

// composeRuntimeWake gives a workspace runtime service what a branch wake
// requires: machine admission through the billing policy's start intent, the
// activation providers, and the PostgreSQL transactions that move the branch
// row between suspended and starting (transitionBranchMachine).
func composeRuntimeWake(s *WorkspaceService, pool *pgxpool.Pool, base BillingPolicy) *WorkspaceService {
	WithWorkspaceTransactions(pool)(s)
	WithBranchMachineProviders(branchMachineTestProviders())(s)
	WithWorkspaceBillingPolicy(NewMachineAdmissionPolicy(base))(s)
	s.EnableMachineAdmission(nil)
	return s
}

// runtimeWakeRow inserts a branch row with the status and machine a runtime
// wake reads and transitions in PostgreSQL.
func runtimeWakeRow(t *testing.T, pool *pgxpool.Pool, name, status, vmID string) db.Workspace {
	t.Helper()
	ctx := context.Background()
	user, repo := setupTestUserAndRepo(t, pool)
	row, err := db.New(pool).CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: user, Name: name, TargetBookmark: name, Kind: "container", Status: status})
	require.NoError(t, err)
	if vmID != "" {
		_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id=$2 WHERE id=$1`, row.ID, vmID)
		require.NoError(t, err)
		row.VmID = vmID
	}
	return row
}

// admissionGranting grants a start once the service's admission Ready check
// passes, as the native runtime does after it takes a slot.
type admissionGranting struct{}

func (admissionGranting) WaitAdmission(ctx context.Context, p microsandbox.AdmissionProviders, class, holder, actor, reason string) (context.Context, error) {
	if err := p.Ready(ctx, microsandbox.AdmissionRequest{Class: class, Holder: holder, Actor: actor, Reason: reason}); err != nil {
		return nil, err
	}
	return ctx, nil
}

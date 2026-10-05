package services

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/identity"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// GuestIdentityRuntime is a workspace runtime that runs every repository
// command in its guests as one fixed account (microsandbox.Runtime).
type GuestIdentityRuntime interface {
	GuestIdentity() (login string, uid int)
}

// branchMachineCommands are the commands the install's one member may run on
// a branch: join it, or read the branch list.
var branchMachineCommands = map[string]bool{"branch.join": true, "branches.read": true}

// InstallBranchMachineProviders are a self-hosted install's branch machine
// providers (T-MCH-04, #3565), composed only on its microVM runtime:
//   - Membership is the install's roster: its owner (M-17 adds members), an
//     active account that may sign in, held FOR SHARE until the transaction
//     ends so a suspension waits for the admitted write.
//   - Authorize is the one member authorizer every transport uses
//     (identity.MemberBoundary): the verified owner, for branch.join and
//     branches.read only.
//   - LaneBinding: see installLaneBinding.
//   - MicroVM admits only an isolated runtime; there is no host fallback.
//   - SessionIdentity admits only a runtime that runs repository code as one
//     fixed non-root guest account. Member sessions (terminals, SSH) stay
//     refused at their own doors until T-MCH-11.
func InstallBranchMachineProviders(members identity.MemberAuthorizer, runtime workspaceapi.WorkspaceRuntime) BranchMachineProviders {
	return BranchMachineProviders{
		Membership:      installBranchMembership,
		Authorize:       installBranchAuthorizer(members),
		LaneBinding:     installLaneBinding,
		MicroVM:         installMicroVM(runtime),
		SessionIdentity: installSessionIdentity(runtime),
	}
}

func installBranchMembership(ctx context.Context, tx pgx.Tx, _, actorID int64) error {
	var id int64
	err := tx.QueryRow(ctx, `SELECT u.id FROM self_host_owners o JOIN users u ON u.id = o.user_id
        WHERE o.singleton AND u.id = $1 AND u.is_active AND u.deleted_at IS NULL AND NOT u.prohibit_login
        FOR SHARE OF u`, actorID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Forbidden("not a member of this install")
	}
	return err
}

func installBranchAuthorizer(members identity.MemberAuthorizer) func(context.Context, pgx.Tx, string, int64, string, int64) error {
	return func(ctx context.Context, _ pgx.Tx, command string, _ int64, _ string, actorID int64) error {
		if !branchMachineCommands[command] {
			return pkgerrors.Forbidden("branch command " + command + " is not allowed")
		}
		if members == nil {
			return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch authorizer unavailable")
		}
		if err := members.AuthorizeMember(ctx, actorID); err != nil {
			return err
		}
		return nil
	}
}

// scratchBranchPrefix starts every scratch branch: scratch/<member>/<name>
// (spec §8.1.1), which only a fork creates (forkScratchWorkspace).
const scratchBranchPrefix = "scratch/"

// installLaneBinding admits a machine on the stack's bookmark only while the
// stack creates it as a lane (StackLaneCreation: the binding is recorded
// right after) or while it is a lane the stack bound and has not retired, or
// the workspace the repository's flow-load is bound to (flow_load.go). An
// item branch (smithers/<slug>) has a machine only through its TODO's lane,
// so one is never created by name. A scratch branch (scratch/<member>/<name>)
// is no lane: it is admitted by name, created and joined as its own machine.
// Every other branch is identified by its workspace.
func installLaneBinding(ctx context.Context, tx pgx.Tx, repositoryID int64, branch, workspaceID string) error {
	stack := branch == MythicalBookmark
	if strings.HasPrefix(branch, scratchBranchPrefix) || !stack && !strings.HasPrefix(branch, "smithers/") {
		return nil
	}
	if workspaceID == "" {
		if stack && StackLaneCreation(ctx) {
			return nil
		}
		return pkgerrors.Forbidden("only the stack creates a lane's machine")
	}
	var bound bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM mythical_lanes
        WHERE workspace_id = $1 AND repository_id = $2 AND retired_at IS NULL)
        OR ($3 AND EXISTS (SELECT 1 FROM flow_loads WHERE workspace_id = $1 AND repository_id = $2))`,
		workspaceID, repositoryID, stack).Scan(&bound); err != nil {
		return err
	}
	if !bound {
		return pkgerrors.Forbidden("this machine is no lane of the stack")
	}
	return nil
}

func installMicroVM(runtime workspaceapi.WorkspaceRuntime) func(context.Context) error {
	return func(context.Context) error {
		if runtime == nil || runtime.Isolation() != workspaceapi.IsolationSandboxed {
			return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch machines run only on the install's microVM runtime")
		}
		return nil
	}
}

func installSessionIdentity(runtime workspaceapi.WorkspaceRuntime) func(context.Context) error {
	return func(context.Context) error {
		guest, ok := runtime.(GuestIdentityRuntime)
		if !ok {
			return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "the workspace runtime names no guest account")
		}
		if login, uid := guest.GuestIdentity(); uid <= 0 || login == "" || login == "root" {
			return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "repository code must not run as root")
		}
		return nil
	}
}

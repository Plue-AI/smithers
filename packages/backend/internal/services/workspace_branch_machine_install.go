package services

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// GuestIdentityRuntime is a workspace runtime that runs every repository
// command in its guests as one fixed account (microsandbox.Runtime).
type GuestIdentityRuntime interface {
	GuestIdentity() (login string, uid int)
}

// branchMachineCommands are the commands install members may run on
// a branch: join it, or read the branch list.
var branchMachineCommands = map[string]bool{"branch.join": true, "branches.read": true, "branch.read": true}

// InstallBranchMachineProviders are a self-hosted install's branch machine
// providers (T-MCH-04, #3565), composed only on its microVM runtime:
//   - Membership holds the roster and active member rows until commit, so
//     removal and suspension wait for admitted writes.
//   - Authorize uses the shared member boundary for branch commands.
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

func installBranchMembership(ctx context.Context, tx pgx.Tx, repositoryID, actorID int64) error {
	// Roster mutations acquire this row FOR UPDATE before touching users or
	// shares. Taking it first gives joins and mutations the same lock order.
	var owner int64
	if err := tx.QueryRow(ctx, `SELECT user_id FROM self_host_owners WHERE singleton FOR SHARE`).Scan(&owner); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Forbidden("not a member of this install")
		}
		return err
	}
	var id int64
	err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 AND is_active
        AND deleted_at IS NULL AND NOT prohibit_login FOR SHARE`, actorID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Forbidden("not a member of this install")
	}
	if err != nil || actorID == owner {
		return err
	}
	err = tx.QueryRow(ctx, `SELECT c.id FROM collaborators c
        JOIN install_settings s ON s.key='github.repository'
        AND c.repository_id=(s.value->>'repository_id')::bigint
        WHERE c.repository_id=$1 AND c.user_id=$2 AND c.suspended_at IS NULL
        AND c.permission IN ('write','admin') FOR SHARE OF c`, repositoryID, actorID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Forbidden("not a member of this install")
	}
	return err
}

func installBranchAuthorizer(members identity.MemberAuthorizer) func(context.Context, pgx.Tx, string, int64, string, int64) error {
	return func(ctx context.Context, tx pgx.Tx, command string, _ int64, _ string, actorID int64) error {
		if !branchMachineCommands[command] {
			return pkgerrors.Forbidden("branch command " + command + " is not allowed")
		}
		if members == nil {
			return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch authorizer unavailable")
		}
		boundary := members
		if _, databaseBoundary := members.(*identity.MemberBoundary); tx != nil && databaseBoundary {
			// Reuse the admission transaction: acquiring another connection
			// while every join holds one can exhaust the pool.
			boundary = identity.NewMemberBoundary(db.New(tx))
		}
		if err := boundary.AuthorizeMember(identity.WithMemberRoute(ctx), actorID); err != nil {
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

package services

import (
	"context"
	"strings"

	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// AuthorizeTerminalBranch checks branch.join for both owners and watchers.
// Watching does not create a workspace share, wake a machine or open a PTY.
func (s *WorkspaceService) AuthorizeTerminalBranch(ctx context.Context, branch string, repo, member int64) (db.Workspace, error) {
	if err := s.requireBranchMachineProviders(); err != nil {
		return db.Workspace{}, err
	}
	var row db.Workspace
	var err error
	if _, parseErr := uuid.Parse(branch); parseErr == nil {
		row, err = s.q.GetWorkspace(ctx, branch)
	} else {
		row, err = s.branchFileWorkspace(ctx, branch, repo, member)
	}
	if err != nil {
		return row, err
	}
	if row.RepositoryID != repo || row.DeletedAt.Valid {
		return row, pkgerrors.NotFound("branch not found")
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return row, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	p := s.branchMachineProviders
	if err = p.Membership(ctx, tx, repo, member); err != nil {
		return row, err
	}
	if err = p.Authorize(ctx, tx, "branch.join", repo, row.TargetBookmark, member); err != nil {
		return row, err
	}
	if err = p.LaneBinding(ctx, tx, repo, row.TargetBookmark, row.ID); err != nil {
		return row, err
	}
	return row, tx.Commit(ctx)
}

// OpenOwnerTerminal has no runtime/SSH fallback and writes no terminal-kind
// workspace_sessions row. The PTY uses only the admitted broker link.
func (s *WorkspaceService) OpenOwnerTerminal(ctx context.Context, registry *machined.Registry, branch, id string, repo, member int64) (workspaceapi.Terminal, error) {
	if s.machineAdmission == nil || s.machineAdmission.FreeDisk == nil || registry == nil || s.runtime == nil || s.runtime.Isolation() != workspaceapi.IsolationSandboxed || s.credentialIssuer == nil || strings.TrimSpace(s.gitBaseURL) == "" {
		return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "owner terminal providers unavailable")
	}
	runtime, ok := s.runtime.(interface {
		EnsureMachined(context.Context, string) error
		WaitAdmission(context.Context, microsandbox.AdmissionProviders, string, string, string, string) (context.Context, error)
		SessionCredentialsForMember(context.Context, string, microsandbox.MemberIdentity) (microsandbox.MemberSessionCredentials, error)
	})
	if !ok {
		return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "owner session provider unavailable")
	}
	row, err := s.AuthorizeTerminalBranch(ctx, branch, repo, member)
	if err != nil {
		return nil, err
	}
	ctx, err = s.admitWorkspaceOperation(personMachineDemand(ctx), row, member)
	if err != nil {
		return nil, err
	}
	join, err := s.transactions.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer join.Rollback(context.WithoutCancel(ctx))
	if err = s.authorizeBranchMachine(ctx, join, repo, member, row.TargetBookmark, row.ID); err != nil {
		return nil, err
	}
	// Hold branch.join authority through wake. Owner-uid terminals do not
	// grant legacy same-user write shares, including alongside a coding host.
	err = commitWorkspaceMutation(ctx, join, workspaceMutationAuthority{workspaceID: row.ID, userID: member}, func(ctx context.Context) error {
		var err error
		row, err = s.ensureExistingWorkspaceRunningFor(personMachineDemand(ctx), row, member)
		return err
	})
	if err != nil {
		return nil, err
	}
	if err = runtime.EnsureMachined(ctx, row.ID); err != nil {
		return nil, err
	}
	link, err := registry.Current(row.ID)
	if err != nil {
		return nil, err
	}
	if err = link.RequireReady(row.ID); err != nil {
		return nil, err
	}
	if s.branchTerminalHost != nil {
		if err = s.branchTerminalHost(ctx, row, member); err != nil {
			return nil, err
		}
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	// Serialize membership allocation with removal until the session is bound.
	if err = s.branchMachineProviders.Membership(ctx, tx, repo, member); err != nil {
		return nil, err
	}
	var user machined.SessionUser
	if err = tx.QueryRow(ctx, `SELECT unix_login,unix_uid FROM collaborators WHERE repository_id=$1 AND user_id=$2 AND suspended_at IS NULL AND permission IN ('write','admin')`, repo, member).Scan(&user.Login, &user.UID); err != nil {
		return nil, err
	}
	writer, err := runtime.SessionCredentialsForMember(ctx, row.ID, microsandbox.MemberIdentity{Login: user.Login, UID: int(user.UID), Active: true})
	if err != nil {
		return nil, err
	}
	credential := &terminalCredential{registry: s.terminalCredentials, issuer: s.credentialIssuer, tokens: s.q, writer: writer, workspaceID: row.ID, sessionID: id, userID: member, repositoryID: repo, url: strings.TrimRight(s.gitBaseURL, "/"), ownerUID: user.UID}
	if err = s.installTerminalCredential(ctx, credential); err != nil {
		return nil, err
	}
	// The installed member runtime seals the exact credential binding before
	// broker spawn. Only its dropped-uid launcher reads the token and environment.
	terminal, err := writer.OpenTerminal(ctx, row.ID, id, credential.identity, workspaceapi.Command{Args: []string{"/bin/bash", "-l"}, Environment: credential.environment()})
	if err != nil {
		credential.Close()
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		_ = terminal.Close()
		credential.Close()
		return nil, err
	}
	if ctx.Err() != nil {
		_ = terminal.Close()
		credential.Close()
		return nil, ctx.Err()
	}
	return &signedInTerminal{Terminal: terminal, terminalCredential: credential}, nil
}

func (s *WorkspaceService) OwnerTerminalAvailable(registry *machined.Registry) bool {
	if s == nil || s.machineAdmission == nil || s.machineAdmission.FreeDisk == nil || registry == nil || s.runtime == nil || s.runtime.Isolation() != workspaceapi.IsolationSandboxed || s.credentialIssuer == nil || strings.TrimSpace(s.gitBaseURL) == "" {
		return false
	}
	_, ok := s.runtime.(interface {
		EnsureMachined(context.Context, string) error
		WaitAdmission(context.Context, microsandbox.AdmissionProviders, string, string, string, string) (context.Context, error)
		SessionCredentialsForMember(context.Context, string, microsandbox.MemberIdentity) (microsandbox.MemberSessionCredentials, error)
	})
	return ok && s.requireBranchMachineProviders() == nil
}

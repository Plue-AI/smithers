package services

import (
	"context"
	"strings"

	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
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
// workspace_sessions row. All guest effects go through the admitted link.
func (s *WorkspaceService) OpenOwnerTerminal(ctx context.Context, registry *machined.Registry, branch, id string, repo, member int64) (workspaceapi.Terminal, error) {
	if registry == nil || s.runtime == nil || s.runtime.Isolation() != workspaceapi.IsolationSandboxed || s.credentialIssuer == nil || strings.TrimSpace(s.gitBaseURL) == "" {
		return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "owner terminal providers unavailable")
	}
	row, err := s.AuthorizeTerminalBranch(ctx, branch, repo, member)
	if err != nil {
		return nil, err
	}
	join, err := s.transactions.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if err = s.authorizeBranchMachine(ctx, join, repo, member, row.TargetBookmark, row.ID); err == nil {
		err = ensureWorkspaceShare(ctx, db.New(join), row, member)
	}
	if err != nil {
		_ = join.Rollback(context.WithoutCancel(ctx))
		return nil, err
	}
	if err = join.Commit(ctx); err != nil {
		return nil, err
	}
	// The person's existing branch entry supplies admission and the shared
	// lifecycle barrier; a terminal never creates a second branch machine.
	err = s.withBranchMachineMutation(ctx, row, member, func(ctx context.Context) error {
		var err error
		row, err = s.ensureExistingWorkspaceRunningFor(personMachineDemand(ctx), row, member)
		return err
	})
	if err != nil {
		return nil, err
	}
	link, err := registry.Current(row.ID)
	if err != nil {
		return nil, err
	}
	if err = link.RequireReady(row.ID); err != nil {
		return nil, err
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
	sessions := machined.NewSessions(link.Connection, row.ID, registry.Sessions(row.ID))
	writer := machined.NewOwnerSessionCredentials(sessions, user, row.ID)
	if err = writer.Prepare(ctx, id); err != nil {
		return nil, err
	}
	defer writer.ClosePrepared()
	credential := &terminalCredential{registry: s.terminalCredentials, issuer: s.credentialIssuer, tokens: s.q, writer: writer, workspaceID: row.ID, sessionID: id, userID: member, repositoryID: repo, url: strings.TrimRight(s.gitBaseURL, "/"), ownerUID: user.UID}
	if err = s.installTerminalCredential(ctx, credential); err != nil {
		return nil, err
	}
	// /usr/bin/env runs only after broker uid drop. No bearer is in argv or env;
	// the shell receives only its exact delegated file and the public address.
	terminal, err := sessions.OpenTerminal(ctx, user, []string{"/usr/bin/env", "SMITHERS_TOKEN_FILE=" + credential.path, "SMITHERS_URL=" + credential.url, "/bin/bash", "-l"}, 80, 24)
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

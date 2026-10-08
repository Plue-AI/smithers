package services

import (
	"context"
	"fmt"
	"strings"
	"time"

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
	// The manager registers startup before entering this method. A close that
	// committed before registration must still fence admission, while a close
	// after this read cancels the registered startup through the same manager.
	if s.ownerTerminalClose != nil {
		tx, err := s.transactions.Begin(ctx)
		if err != nil {
			return nil, err
		}
		var closed bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND event_type='terminal.closed' AND data->>'session'=$3)`, scopeTenant(repo), fmt.Sprintf("member:%d", member), id).Scan(&closed)
		_ = tx.Rollback(context.WithoutCancel(ctx))
		if err != nil {
			return nil, err
		}
		if closed {
			return nil, context.Canceled
		}
	}

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
	// Wait for this branch's wake before acquiring a database connection.
	// Coalesced terminals share a machine, so holding one authority transaction
	// per waiter would exhaust the pool while the first guest is still booting.
	// Recheck and hold branch.join after the lock is acquired, through the wake.
	err = func() error {
		unlock := s.lockRuntimeWorkspace(row.ID)
		defer unlock()
		if err := ctx.Err(); err != nil {
			return err
		}
		current, err := s.currentRuntimeWorkspaceLocked(ctx, row)
		if err != nil {
			return err
		}
		join, err := s.transactions.Begin(ctx)
		if err != nil {
			return err
		}
		defer join.Rollback(context.WithoutCancel(ctx))
		if err = s.authorizeBranchMachine(ctx, join, repo, member, current.TargetBookmark, current.ID); err != nil {
			return err
		}
		return commitWorkspaceMutation(ctx, join, workspaceMutationAuthority{workspaceID: current.ID, userID: member}, func(ctx context.Context) error {
			var err error
			row, err = s.ensureRuntimeWorkspaceRunningLocked(personMachineDemand(ctx), current, member)
			return err
		})
	}()
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
	// Serialize identity and credential allocation with removal. Startup
	// rechecks authorization after the broker replies.
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
	// Do not hold roster locks across a pending broker response: removal must
	// commit and cancel startup within its five-second bound.
	if err = tx.Commit(ctx); err != nil {
		credential.Close()
		return nil, err
	}
	// The installed member runtime seals the exact credential binding before
	// broker spawn. Only its dropped-uid launcher reads the token and environment.
	// Hold one credential snapshot until the broker replies. Renewal cannot
	// replace the delegated file while startup still uses its old binding.
	credential.mu.Lock()
	terminal, err := writer.OpenTerminal(ctx, row.ID, id, credential.identity, workspaceapi.Command{Args: []string{"/bin/bash", "-l"}, Environment: map[string]string{"SMITHERS_TOKEN_FILE": credential.path, "SMITHERS_URL": credential.url}})
	if err == nil {
		// Token deletion through the API may finish while the broker is opening.
		// A late reply must never publish a session under a retired credential.
		token, tokenErr := db.New(credential.issuer.Members.Pool).GetAccessTokenByID(ctx, credential.tokenID)
		if tokenErr != nil || token.TokenHash != credential.identity || !token.ExpiresAt.Valid || !token.ExpiresAt.Time.After(time.Now()) {
			_ = terminal.Close()
			err = pkgerrors.Unauthorized("terminal credential expired")
		}
	}
	credential.mu.Unlock()
	if err != nil {
		credential.Close()
		return nil, err
	}
	if _, err = s.AuthorizeTerminalBranch(ctx, row.ID, repo, member); err != nil {
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

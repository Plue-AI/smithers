package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// GetWorkspaceSSHConnectionInfo returns tokenized SSH connection details for a workspace.
func (s *WorkspaceService) GetWorkspaceSSHConnectionInfo(ctx context.Context, workspaceID string, repositoryID, userID int64) (WorkspaceSSHConnectionInfo, error) {
	return s.GetWorkspaceSSHConnectionInfoAs(ctx, workspaceID, repositoryID, userID, "")
}

// Stage-1 SSH can name only its unprivileged configured account. Member SSH
// remains unavailable until the roster and production daemon consume the S2
// identity contract; the legacy provider never grants root or developer.
func (s *WorkspaceService) resolveWorkspaceSSHUser(requested string) (string, error) {
	requested = strings.TrimSpace(requested)
	user := strings.TrimSpace(s.workspaceSSHUsername)
	if user == "agent" && (requested == "" || requested == user) {
		return user, nil
	}
	return "", pkgerrors.New(pkgerrors.CodeWorkspaceSSHUserInvalid, fmt.Sprintf("workspace ssh user %q is unavailable", requested))
}

// GetWorkspaceSSHConnectionInfoAs is GetWorkspaceSSHConnectionInfo for a
// chosen guest user; the minted grant allows only that user.
func (s *WorkspaceService) GetWorkspaceSSHConnectionInfoAs(ctx context.Context, workspaceID string, repositoryID, userID int64, guestUser string) (WorkspaceSSHConnectionInfo, error) {
	guestUser, err := s.resolveWorkspaceSSHUser(guestUser)
	if err != nil {
		return WorkspaceSSHConnectionInfo{}, err
	}
	if s.q == nil {
		return WorkspaceSSHConnectionInfo{}, pkgerrors.Internal("workspace store unavailable")
	}
	if s.sandbox == nil {
		return WorkspaceSSHConnectionInfo{}, pkgerrors.Internal("sandbox provider unavailable")
	}

	var info WorkspaceSSHConnectionInfo
	err = s.withWorkspaceMutation(ctx, workspaceID, repositoryID, userID, func(ctx context.Context, workspace db.Workspace) error {
		workspace, err := s.ensureExistingWorkspaceRunningFor(ctx, workspace, userID)
		if err != nil {
			return err
		}
		if err := s.waitForWorkspaceGuestActivation(ctx, workspace); err != nil {
			return err
		}
		info, err = s.buildWorkspaceSSHConnectionInfoAs(ctx, workspace, guestUser)
		if err != nil {
			return err
		}
		s.touchWorkspaceEntryRecency(ctx, workspace.ID, "workspace_ssh")
		return nil
	})
	if err != nil {
		return WorkspaceSSHConnectionInfo{}, err
	}
	return info, nil
}

// GetSSHConnectionInfo returns tokenized SSH connection details for a workspace session.
func (s *WorkspaceService) GetSSHConnectionInfo(ctx context.Context, sessionID string, repositoryID, userID int64) (WorkspaceSSHConnectionInfo, error) {
	if s.q == nil {
		return WorkspaceSSHConnectionInfo{}, pkgerrors.Internal("workspace store unavailable")
	}
	if s.sandbox == nil {
		return WorkspaceSSHConnectionInfo{}, pkgerrors.Internal("sandbox provider unavailable")
	}

	session, err := s.loadOwnedWorkspaceSession(ctx, sessionID, repositoryID, userID)
	if err != nil {
		return WorkspaceSSHConnectionInfo{}, err
	}
	switch strings.ToLower(strings.TrimSpace(session.Status)) {
	case "running":
	case "failed":
		return WorkspaceSSHConnectionInfo{}, pkgerrors.Conflict("workspace session provisioning failed; create a new session and retry")
	case "stopped":
		return WorkspaceSSHConnectionInfo{}, pkgerrors.Conflict("workspace session is stopped; create a new session and retry")
	default:
		return WorkspaceSSHConnectionInfo{}, pkgerrors.Conflict("workspace session is still provisioning")
	}

	// Load as the REQUESTER (already write-authorized by the session loader),
	// not the session creator: authorizing via the creator's identity would
	// deny the workspace owner on a collaborator-created session and outlive
	// share revocation for the creator.
	workspace, err := s.loadOwnedWorkspace(ctx, session.WorkspaceID, session.RepositoryID, userID)
	if err != nil {
		return WorkspaceSSHConnectionInfo{}, err
	}

	workspace, err = s.ensureWorkspaceRunning(ctx, workspace, CreateWorkspaceSessionInput{
		RepositoryID: session.RepositoryID,
		UserID:       session.UserID,
		Cols:         session.Cols,
		Rows:         session.Rows,
	})
	if err != nil {
		return WorkspaceSSHConnectionInfo{}, err
	}
	if err := s.waitForWorkspaceGuestActivation(ctx, workspace); err != nil {
		return WorkspaceSSHConnectionInfo{}, err
	}

	info, err := s.buildWorkspaceSSHConnectionInfo(ctx, workspace)
	if err != nil {
		return WorkspaceSSHConnectionInfo{}, err
	}
	info.SessionID = session.ID

	// Ticket 0117: SECURITY-CRITICAL. Do NOT persist the freshly-minted
	// SSH access token or the executable command string (which embeds the
	// same token). The workspace_sessions row is replicated into client
	// SQLite via the realtime stream and is therefore cache/backup/dump
	// territory; minted credentials MUST NOT land there.
	//
	// What we persist is the identifier half only: host, port, username,
	// ssh_host, workspace_id, session_id, vm_id, and the host-key trust
	// anchors (ticket 0130). The token and command are returned to the
	// HTTP caller in memory on this request and are never stored.
	safe := info.RedactedForPersistence()
	payload, _ := json.Marshal(safe)
	if _, err := s.q.UpdateWorkspaceSessionSSHConnectionInfo(ctx, db.UpdateWorkspaceSessionSSHConnectionInfoParams{
		ID:                session.ID,
		SshConnectionInfo: payload,
	}); err != nil {
		return WorkspaceSSHConnectionInfo{}, pkgerrors.Internal("persist ssh connection info: " + err.Error())
	}
	if session.Status != "running" {
		_, _ = s.q.UpdateWorkspaceSessionStatus(ctx, db.UpdateWorkspaceSessionStatusParams{
			ID:     session.ID,
			Status: "running",
		})
	}
	_ = s.q.TouchWorkspaceActivity(ctx, workspace.ID)
	_ = s.q.TouchWorkspaceSessionActivity(ctx, session.ID)
	s.touchWorkspaceEntryRecency(ctx, workspace.ID, "session_ssh")
	s.notifyWorkspaceSession(ctx, session.ID, "running")

	return info, nil
}

// TouchSessionActivity updates last_activity_at on the workspace session identified by
// sessionID. It is called by the terminal WebSocket handler on every burst of I/O
// so that idle-cleanup does not evict a session with live traffic.
func (s *WorkspaceService) TouchSessionActivity(ctx context.Context, sessionID string) error {
	if s.q == nil {
		return nil
	}
	return s.q.TouchWorkspaceSessionActivity(ctx, sessionID)
}

const (
	workspaceGuestActivationWait   = 60 * time.Second
	workspaceGuestExecHeadroom     = 5 * time.Second
	workspaceGuestResponseHeadroom = time.Second
)

type workspaceGuestExecutor interface {
	Execute(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error)
}

// waitForWorkspaceGuestActivation covers running VMs created by older API
// revisions and cold resumes, where the one-shot ReadySignal does not fire
// again. Container workspaces have a conventional /bin/bash and pass without
// another provider round trip.
func (s *WorkspaceService) waitForWorkspaceGuestActivation(ctx context.Context, workspace db.Workspace) error {
	if sandboxKindForWorkspace(workspace.Kind) == "container" {
		return nil
	}
	executor, ok := s.sandbox.(workspaceGuestExecutor)
	if !ok {
		return pkgerrors.Internal("sandbox provider cannot check workspace guest activation")
	}
	if ctx.Err() != nil {
		return pkgerrors.Internal("wait for workspace guest activation: " + ctx.Err().Error())
	}

	// The provider must finish the guest command before its RPC deadline,
	// and the API needs time to return the retryable result to the caller.
	waitDeadline := time.Now().Add(workspaceGuestActivationWait + workspaceGuestExecHeadroom)
	timeoutMS := workspaceGuestActivationWait.Milliseconds()
	if deadline, ok := ctx.Deadline(); ok {
		deadline = deadline.Add(-workspaceGuestResponseHeadroom)
		if deadline.Before(waitDeadline) {
			waitDeadline = deadline
			timeoutMS = (time.Until(deadline) - workspaceGuestExecHeadroom).Milliseconds()
		}
	}
	if timeoutMS <= 0 {
		return pkgerrors.GuestNotReady("workspace guest is still starting; retry shortly")
	}
	waitCtx, cancel := context.WithDeadline(ctx, waitDeadline)
	defer cancel()
	result, err := executor.Execute(waitCtx, workspace.VmID, sandbox.ExecRequest{
		Command:   workspaceNixActivationWaitCommand,
		TimeoutMS: &timeoutMS,
	})
	if ctx.Err() != nil {
		return pkgerrors.Internal("wait for workspace guest activation: " + ctx.Err().Error())
	}
	if err == nil && (result.StatusCode == nil || *result.StatusCode == 0) {
		return nil
	}
	if err != nil && waitCtx.Err() == nil && !errors.Is(err, context.DeadlineExceeded) {
		return pkgerrors.Internal("wait for workspace guest activation: " + err.Error())
	}
	return pkgerrors.GuestNotReady("workspace guest is still starting; retry shortly")
}

func (s *WorkspaceService) buildWorkspaceSSHConnectionInfo(ctx context.Context, workspace db.Workspace) (WorkspaceSSHConnectionInfo, error) {
	return s.buildWorkspaceSSHConnectionInfoAs(ctx, workspace, s.workspaceSSHUsername)
}

// buildWorkspaceSSHConnectionInfoAs mints a grant bound to guestUser and
// returns the connection details for it.
func (s *WorkspaceService) buildWorkspaceSSHConnectionInfoAs(ctx context.Context, workspace db.Workspace, guestUser string) (WorkspaceSSHConnectionInfo, error) {
	resolved, resolveErr := s.resolveWorkspaceSSHUser(guestUser)
	if resolveErr != nil {
		return WorkspaceSSHConnectionInfo{}, resolveErr
	}
	guestUser = resolved
	var (
		identity sandbox.Identity
		err      error
	)
	if scoped, ok := s.sandbox.(sandbox.IdentityForSandboxProvider); ok {
		identity, err = scoped.CreateIdentityForSandbox(ctx, workspace.VmID)
	} else {
		identity, err = s.sandbox.CreateIdentity(ctx)
	}
	if err != nil {
		return WorkspaceSSHConnectionInfo{}, pkgerrors.Internal("create sandbox access identity: " + err.Error())
	}
	grantReq := sandbox.GrantAccessRequest{AllowedUsers: []string{guestUser}}
	if _, err := s.sandbox.GrantAccess(ctx, identity.ID, workspace.VmID, grantReq); err != nil {
		return WorkspaceSSHConnectionInfo{}, pkgerrors.Internal("grant sandbox ssh permission: " + err.Error())
	}
	createdToken, err := s.sandbox.CreateIdentityToken(ctx, identity.ID)
	if err != nil {
		return WorkspaceSSHConnectionInfo{}, pkgerrors.Internal("create sandbox ssh token: " + err.Error())
	}

	publicHost, dialHost, hostKeyLoader := s.workspaceSSHEndpoint()
	sshHost := fmt.Sprintf("%s+%s@%s", workspace.VmID, guestUser, publicHost)

	hostKeys, err := s.loadAdvertisedHostKeys(hostKeyLoader)
	if err != nil {
		// Fail closed: the terminal handler refuses to dial without
		// pinned host keys, so an unreadable host-key directory is a
		// hard service error, not a "return anyway" degradation.
		return WorkspaceSSHConnectionInfo{}, pkgerrors.Internal("load ssh host keys: " + err.Error())
	}

	return WorkspaceSSHConnectionInfo{
		WorkspaceID: workspace.ID,
		VMID:        workspace.VmID,
		Kind:        normalizeWorkspaceKind(workspace.Kind),
		Host:        publicHost,
		DialHost:    dialHost,
		SSHHost:     sshHost,
		Username:    guestUser,
		Port:        22,
		Workdir:     defaultWorkspaceClonePath,
		AccessToken: createdToken.Token,
		Command:     fmt.Sprintf("ssh %s+%s:%s@%s", workspace.VmID, guestUser, createdToken.Token, publicHost),
		HostKeys:    hostKeys,
	}, nil
}

// loadAdvertisedHostKeys returns the gateway host-key trust anchor the
// API publishes to clients. It uses the injected HostKeyLoader when
// present (tests), otherwise a disk-backed loader bound to the
// configured HostKeyDir. When neither is configured the service logs a
// warning and returns an empty slice; the terminal handler will refuse
// to dial in that configuration.
func (s *WorkspaceService) workspaceSSHEndpoint() (string, string, HostKeyLoader) {
	return s.sshHost, s.sshDialHost, s.hostKeyLoader
}

func (s *WorkspaceService) loadAdvertisedHostKeys(loader HostKeyLoader) ([]WorkspaceSSHHostKey, error) {
	if loader == nil && s.sshHostKeyDir != "" {
		loader = NewDiskHostKeyLoader(s.sshHostKeyDir)
	}
	if loader == nil {
		slog.Warn("workspace ssh connection info: no host key source configured; advertising empty host_keys")
		return nil, nil
	}
	return loader.LoadHostKeys()
}

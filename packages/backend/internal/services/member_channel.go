package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// MemberChannel owns one host-selected, delegated SSH process lifecycle.
// Its persisted session reservation exists before admission and is closed even
// when the original person's membership has since been revoked.
type MemberChannel struct {
	service    *WorkspaceService
	row        db.WorkspaceSession
	credential *terminalCredential
	user       machined.SessionUser
	mu         sync.Mutex
	client     *machined.Sessions
	id         uint32
	closed     bool
	cancel     context.CancelFunc
}

func (s *WorkspaceService) ValidateMemberChannel(ctx context.Context, branch string, member int64, login string, uid uint32) error {
	if s.transactions == nil {
		return machined.ErrNotReady
	}
	row, err := s.q.GetWorkspace(ctx, branch)
	if err != nil {
		return err
	}
	if err = s.preflightBranchMachine(ctx, row.RepositoryID, member, row.TargetBookmark, row.ID); err != nil {
		return err
	}
	roster, ok := s.q.(interface {
		ListCollaboratorsByRepo(context.Context, int64) ([]db.Collaborator, error)
	})
	if !ok {
		return machined.ErrNotReady
	}
	members, err := roster.ListCollaboratorsByRepo(ctx, row.RepositoryID)
	if err != nil {
		return err
	}
	for _, entry := range members {
		if entry.UserID.Valid && entry.UserID.Int64 == member && !entry.SuspendedAt.Valid && (entry.Permission == "write" || entry.Permission == "admin") && entry.UnixLogin.Valid && entry.UnixLogin.String == login && uint32(entry.UnixUid) == uid && uid >= 20000 {
			return nil
		}
	}
	return machined.ErrUnauthorized
}
func (s *WorkspaceService) AdmitMemberChannel(ctx context.Context, session string, repository, member int64, login string, uid uint32) (*MemberChannel, error) {
	row, err := s.loadOwnedWorkspaceSession(ctx, session, repository, member)
	if err != nil {
		return nil, err
	}
	if row.UserID != member || row.Status != "running" {
		return nil, machined.ErrNotReady
	}
	if err = s.ValidateMemberChannel(ctx, row.WorkspaceID, member, login, uid); err != nil {
		return nil, err
	}
	workspace, err := s.q.GetWorkspace(ctx, row.WorkspaceID)
	if err != nil {
		return nil, err
	}
	credential, err := s.signInMemberSession(ctx, workspace, row.ID, member, "ssh")
	if err != nil {
		return nil, err
	}
	if credential == nil {
		return nil, machined.ErrNotReady
	}
	if _, ok := credential.writer.(*microsandbox.MemberCredentials); !ok {
		credential.Close()
		return nil, machined.ErrNotReady
	}
	if err = credential.AcquireCredential(ctx); err != nil {
		credential.Close()
		return nil, err
	}
	metadata, _ := json.Marshal(map[string]any{"via": "ssh"})
	if _, err = s.q.UpdateWorkspaceSessionSSHConnectionInfo(ctx, db.UpdateWorkspaceSessionSSHConnectionInfoParams{ID: row.ID, SshConnectionInfo: metadata}); err != nil {
		credential.Close()
		return nil, err
	}
	lifetime, cancel := context.WithCancel(context.Background())
	channel := &MemberChannel{service: s, row: row, credential: credential, user: machined.SessionUser{Login: login, UID: uid}, cancel: cancel}
	go func() {
		timer := time.NewTicker(10 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-lifetime.Done():
				return
			case <-timer.C:
				touch, stop := context.WithTimeout(lifetime, 5*time.Second)
				_ = s.TouchSessionActivity(touch, row.ID)
				stop()
			}
		}
	}()
	return channel, nil
}
func (c *MemberChannel) Open(ctx context.Context, user machined.SessionUser, kind machined.SessionKind, argv []string, size *machined.SessionSize) (uint32, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.id != 0 || user.Login != c.user.Login || user.UID != c.user.UID {
		return 0, machined.ErrUnauthorized
	}
	if err := c.service.ValidateMemberChannel(ctx, c.row.WorkspaceID, c.row.UserID, user.Login, user.UID); err != nil {
		return 0, err
	}
	c.credential.mu.Lock()
	digest := c.credential.identity
	c.credential.mu.Unlock()
	client, id, err := c.credential.writer.(*microsandbox.MemberCredentials).OpenSession(ctx, c.row.WorkspaceID, c.row.ID, digest, workspaceapi.Command{Args: argv, Environment: c.credential.environment()}, kind, size)
	if err != nil {
		return 0, err
	}
	metadata, _ := json.Marshal(map[string]any{"via": "ssh", "broker_session": id})
	if _, err = c.service.q.UpdateWorkspaceSessionSSHConnectionInfo(ctx, db.UpdateWorkspaceSessionSSHConnectionInfoParams{ID: c.row.ID, SshConnectionInfo: metadata}); err != nil {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, killErr := client.KillUser(cleanup, c.user)
		_ = client.CloseSession(cleanup, id)
		if killErr != nil {
			_ = client.CloseConnection()
			return 0, errors.Join(err, fmt.Errorf("%w: %v", workspaceapi.ErrCommandTerminationUnconfirmed, killErr))
		}
		return 0, err
	}
	c.client, c.id = client, id
	return id, nil
}
func (c *MemberChannel) Stream(ctx context.Context, id uint32) (*machined.SessionStream, error) {
	c.mu.Lock()
	client, own := c.client, c.id
	c.mu.Unlock()
	if client == nil || id != own {
		return nil, machined.ErrUnauthorized
	}
	return client.Stream(ctx, id)
}
func (c *MemberChannel) CloseSession(ctx context.Context, id uint32) error {
	c.mu.Lock()
	client, own := c.client, c.id
	c.mu.Unlock()
	if client == nil || id != own {
		return machined.ErrUnauthorized
	}
	return client.CloseSession(ctx, id)
}
func (c *MemberChannel) HasSession(id uint32) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.closed && id != 0 && c.id == id
}
func (c *MemberChannel) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	client, id := c.client, c.id
	c.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if client != nil && id != 0 {
		_ = client.CloseSession(ctx, id)
	}
	c.cancel()
	c.credential.Close()
	_ = c.service.CloseMemberReservation(ctx, c.row.ID, c.row.RepositoryID, c.row.UserID)
}

func (s *WorkspaceService) CloseMemberReservation(ctx context.Context, id string, repository, member int64) error {
	row, err := s.q.GetWorkspaceSessionByRepo(ctx, db.GetWorkspaceSessionByRepoParams{ID: id, RepositoryID: repository})
	if err != nil {
		return err
	}
	if row.UserID != member {
		return machined.ErrUnauthorized
	}
	_, err = s.q.UpdateWorkspaceSessionStatus(ctx, db.UpdateWorkspaceSessionStatusParams{ID: id, Status: "stopped"})
	if err != nil {
		return err
	}
	s.notifyWorkspaceSession(ctx, id, "stopped")
	if runtime, ok := s.runtime.(interface{ CancelFailedAdmission(string, string) }); ok {
		runtime.CancelFailedAdmission(machineQueueHolder(row.WorkspaceID), sessionMachineActor(member, id))
	}
	s.revokeWorkspaceTerminalCredential(ctx, row, member)
	return nil
}

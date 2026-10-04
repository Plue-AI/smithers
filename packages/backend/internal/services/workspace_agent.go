package services

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// CreateAgentWorkspaceInput describes a run attaching to its branch machine.
type CreateAgentWorkspaceInput struct {
	RepositoryID   int64
	UserID         int64
	SessionID      string
	RepoOwner      string
	RepoName       string
	SourceBookmark string
	// EgressSecrets are the run's proxy bindings (platform model seats, the
	// per-run cache token). They are merged over the
	// repository's own bound secrets; the run's bindings win on a name clash.
	EgressSecrets []sandbox.EgressProxySecret
	// Members are cross-repository changeset members to clone beside the
	// primary checkout (authenticated clone URLs, pinned revisions).
	Members []sandbox.GitRepositorySpec
}

// AgentWorkspaceResult is what dispatch needs back.
type AgentWorkspaceResult struct {
	WorkspaceID       string
	VMID              string
	Forked            bool
	SourceWorkspaceID string
}

func pgUUIDFromString(value string) pgtype.UUID {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		return pgtype.UUID{}
	}
	return pgtype.UUID{Bytes: parsed, Valid: true}
}

// CheckAgentWorkspaceQuota remains the dispatch admission boundary; branch
// attachment consumes no member quota and never allocates an agent computer.
func (s *WorkspaceService) CheckAgentWorkspaceQuota(ctx context.Context, userID int64) error {
	return s.requireBranchMachineProviders()
}

// CreateAgentWorkspace attaches this session to the canonical branch machine.
func (s *WorkspaceService) CreateAgentWorkspace(ctx context.Context, input CreateAgentWorkspaceInput) (AgentWorkspaceResult, error) {
	if err := s.requireBranchMachineProviders(); err != nil {
		return AgentWorkspaceResult{}, err
	}
	if !pgUUIDFromString(input.SessionID).Valid {
		return AgentWorkspaceResult{}, pkgerrors.BadRequest("session is required")
	}
	// Per-run egress and cross-repository setup cannot mutate a shared machine.
	// Their scoped delivery contract must be available before attachment.
	if len(input.EgressSecrets) != 0 || len(input.Members) != 0 {
		return AgentWorkspaceResult{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "shared run bindings unavailable")
	}
	if err := s.validateBranchMachineSession(ctx, input); err != nil {
		return AgentWorkspaceResult{}, err
	}
	row, err := s.CreateWorkspace(ctx, CreateWorkspaceInput{
		RepositoryID: input.RepositoryID, UserID: input.UserID,
		RepoOwner: input.RepoOwner, RepoName: input.RepoName, SourceBookmark: input.SourceBookmark,
	})
	if err != nil {
		return AgentWorkspaceResult{}, err
	}
	if err := s.attachBranchMachineSession(ctx, row.ID, input); err != nil {
		return AgentWorkspaceResult{}, err
	}
	workspace, err := s.q.GetWorkspace(ctx, row.ID)
	if err != nil {
		return AgentWorkspaceResult{}, err
	}
	return AgentWorkspaceResult{WorkspaceID: row.ID, VMID: workspace.VmID}, nil
}

// runForkedWorkspaceCommand mints a short-lived fetch token and runs the
// builder's command as root in the forked VM.
func (s *WorkspaceService) runForkedWorkspaceCommand(ctx context.Context, vmID string, userID int64, build func(token string) string) error {
	execClient, ok := s.sandbox.(sandboxExecClient)
	if !ok {
		return pkgerrors.Internal("sandbox exec client unavailable")
	}
	token, err := issueTemporaryRepoCloneToken(ctx, s.q, userID, "sandbox-fork-fetch")
	if err != nil {
		return pkgerrors.Internal("create fork fetch token: " + err.Error())
	}
	defer revokeTemporaryRepoCloneToken(context.WithoutCancel(ctx), s.q, userID, token.ID)
	// Two minutes: shorter than the clone budget so a stuck fork prepare
	// still leaves room for the cold-clone fallback.
	const forkPrepareTimeout = 2 * time.Minute
	timeoutMS := int64(forkPrepareTimeout / time.Millisecond)
	execCtx, cancel := context.WithTimeout(ctx, forkPrepareTimeout)
	defer cancel()
	resp, err := execClient.Execute(execCtx, vmID, sandbox.ExecRequest{
		Command:   build(token.Plaintext),
		TimeoutMS: &timeoutMS,
	})
	if err != nil {
		return pkgerrors.Internal("prepare forked workspace: " + err.Error())
	}
	if resp.StatusCode != nil && *resp.StatusCode != 0 {
		detail := strings.TrimSpace(resp.Stderr)
		if out := strings.TrimSpace(resp.Stdout); out != "" {
			if detail != "" {
				detail += "\n"
			}
			detail += out
		}
		if len(detail) > 1000 {
			detail = detail[len(detail)-1000:]
		}
		return pkgerrors.Internal(fmt.Sprintf("prepare forked workspace failed with status %d: %s", *resp.StatusCode, detail))
	}
	return nil
}

// A run ending or failing does not stop or delete a machine shared by members.
// Branch release and confirmed-stop accounting belong to T-MCH-06.
func (s *WorkspaceService) SuspendAgentWorkspace(ctx context.Context, workspaceID string) error {
	return nil
}
func (s *WorkspaceService) FailAgentWorkspace(ctx context.Context, workspaceID string) error {
	return nil
}

// SnapshotAgentWorkspace snapshots a finished run's computer and returns the
// workspace snapshot id to stamp on the run's revisions.
func (s *WorkspaceService) SnapshotAgentWorkspace(ctx context.Context, workspaceID, name string) (string, error) {
	if s.q == nil {
		return "", pkgerrors.Internal("workspace store unavailable")
	}
	workspace, err := s.q.GetWorkspace(ctx, strings.TrimSpace(workspaceID))
	if err != nil {
		return "", pkgerrors.Internal("load agent workspace: " + err.Error())
	}
	if workspace.Status != "running" || strings.TrimSpace(workspace.VmID) == "" {
		return "", pkgerrors.Conflict("agent workspace is not running")
	}
	snapshot, err := s.CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotInput{
		RepositoryID: workspace.RepositoryID,
		UserID:       workspace.UserID,
		WorkspaceID:  workspace.ID,
		Name:         name,
	})
	if err != nil {
		return "", err
	}
	return snapshot.ID, nil
}

// TouchAgentWorkspace records run activity on the workspace so idle
// suspension does not stop a working agent.
func (s *WorkspaceService) TouchAgentWorkspace(ctx context.Context, workspaceID string) {
	if s.q == nil || strings.TrimSpace(workspaceID) == "" {
		return
	}
	_ = s.q.TouchWorkspaceActivity(ctx, workspaceID)
}

// repositoryDefaultBookmarkResolver is the optional querier surface used to
// pick a run's bookmark when the dispatch names none.
type repositoryDefaultBookmarkResolver interface {
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
}

func (s *WorkspaceService) repositoryDefaultBookmark(ctx context.Context, repositoryID int64) string {
	if resolver, ok := s.q.(repositoryDefaultBookmarkResolver); ok {
		if repo, err := resolver.GetRepoByID(ctx, repositoryID); err == nil {
			return targetWorkspaceBookmark(repo.DefaultBookmark)
		}
	}
	return targetWorkspaceBookmark("")
}

// resolveWorkspaceBookmark returns the requested bookmark (or the repository
// default when omitted) together with the repository default. Keeping both
// lets callers distinguish the reusable primary workspace from a derived
// bookmark workspace even when the repository default is not "main".
func (s *WorkspaceService) resolveWorkspaceBookmark(ctx context.Context, repositoryID int64, requested string) (string, string, error) {
	resolver, ok := s.q.(repositoryDefaultBookmarkResolver)
	if !ok {
		return "", "", pkgerrors.Internal("repository default bookmark resolver unavailable")
	}
	repo, err := resolver.GetRepoByID(ctx, repositoryID)
	if err != nil {
		return "", "", pkgerrors.Internal("load repository default bookmark: " + err.Error())
	}
	defaultBookmark := targetWorkspaceBookmark(repo.DefaultBookmark)
	bookmark := strings.TrimSpace(requested)
	if bookmark == "" {
		bookmark = defaultBookmark
	}
	return targetWorkspaceBookmark(bookmark), defaultBookmark, nil
}

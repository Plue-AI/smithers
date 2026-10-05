package services

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// WithWorkspaceUserRefs lets workspace creation check out one of the caller's
// pushed refs (#1968).
func WithWorkspaceUserRefs(host UserRefHost) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.userRefs = host }
}

type workspaceMythicalStackReader interface {
	GetMythicalStack(context.Context, int64) (db.MythicalStack, error)
}

// createUserRefWorkspace creates a new workspace that checks out the commit of
// the caller's pushed ref. The ref resolves only in the caller's own
// namespace; it is pinned under the new workspace's source ref before the row
// exists, so provisioning and every later restart fetch an immutable commit.
// Like a fork, it is an independent derived resource: it reserves no named
// identity and is never a primary workspace or a fork source.
func (s *WorkspaceService) createUserRefWorkspace(ctx context.Context, input CreateWorkspaceInput, bookmark string, metadata workspaceCreateMetadata) (db.Workspace, error) {
	if s.userRefs == nil {
		return db.Workspace{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "pushed refs unavailable")
	}
	stacks, ok := s.q.(workspaceMythicalStackReader)
	if !ok {
		return db.Workspace{}, pkgerrors.Internal("workspace store cannot read mythical stacks")
	}
	// A repository that lands through its mythical stack starts every change
	// from the stack tip, as UserRefService.StartFrom does.
	if _, err := stacks.GetMythicalStack(ctx, input.RepositoryID); err == nil {
		return db.Workspace{}, pkgerrors.New(pkgerrors.CodeUserRefStack, "this repository lands through its mythical stack")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return db.Workspace{}, pkgerrors.Internal("load mythical stack: " + err.Error())
	}
	if err := s.enforceWorkspaceQuota(ctx, input.UserID); err != nil {
		return db.Workspace{}, err
	}
	id := uuid.New()
	retained, err := s.userRefs.RetainUserRef(ctx, input.RepoOwner, input.RepoName, input.UserID,
		repohost.RetainUserRefRequest{Name: input.SourceRef, WorkspaceID: id.String()})
	if err != nil {
		return db.Workspace{}, userRefHostError(err)
	}
	if !isLowerHexRevision(retained.CommitID) || retained.SourceRef != repohost.WorkspaceSourceRef(id.String(), retained.CommitID) {
		return db.Workspace{}, pkgerrors.Internal("repository host returned an invalid pinned ref")
	}
	workspace, err := s.createPinnedWorkspace(ctx, input, bookmark, metadata, pinnedWorkspaceSource{id: id, commit: retained.CommitID})
	if err != nil {
		return db.Workspace{}, mapWorkspaceCreateError(err, "create pushed-ref workspace")
	}
	return workspace, nil
}

// pinnedWorkspaceSource is the one retained commit a new workspace checks
// out, under its own source ref, and for a scratch fork what that commit was
// forked from (spec §8.5.3): the item, the base its change is measured from
// and the item's workspace.
type pinnedWorkspaceSource struct {
	id     uuid.UUID
	commit string
	parent string
	item   pgtype.UUID
	base   string
}

// createPinnedWorkspace records a workspace that starts from source.commit,
// already retained under its source ref: a caller's pushed ref
// (createUserRefWorkspace) or a revision the stack service resolved
// (forkScratchWorkspace).
func (s *WorkspaceService) createPinnedWorkspace(ctx context.Context, input CreateWorkspaceInput, bookmark string, metadata workspaceCreateMetadata, source pinnedWorkspaceSource) (db.Workspace, error) {
	metadata = normalizeWorkspaceCreateMetadata(metadata)
	vcpu, memory, disk := workspaceResourceColumns(metadata.resources)
	return s.createWorkspaceRow(ctx, db.CreateWorkspaceParams{
		VcpuCount: vcpu, MemoryMb: memory, DiskMb: disk,
		ID: pgtype.UUID{Bytes: source.id, Valid: true}, SourceCommit: source.commit,
		RepositoryID: input.RepositoryID, UserID: input.UserID, Name: strings.TrimSpace(input.Name), IsFork: true,
		ParentWorkspaceID: pgUUIDFromString(source.parent), ForkedFromItem: source.item, ForkedFromBase: source.base,
		TargetBookmark: targetWorkspaceBookmark(bookmark), Kind: metadata.kind,
		EnvironmentSource:      metadata.environment.Source,
		EnvironmentRevision:    metadata.environment.Revision,
		EnvironmentClosureHash: metadata.environment.ClosureHash, Status: "starting",
	})
}

// ScratchFork is one fork the stack service resolved (spec §8.5, M-32): the
// scratch branch scratch/<member>/<name> it creates, the revision it starts
// from (main's tip, or an item's last verified head) and what it was forked
// from. Retain and Publish are the stack service's own writes: the revision
// pinned under the new workspace's source ref, and the branch itself.
type ScratchFork struct {
	RepositoryID int64
	Owner, Repo  string
	ActorID      int64
	Branch       string
	Commit, Base string
	Item         pgtype.UUID
	Parent       string
	Retain       func(ctx context.Context, workspaceID string) error
	Publish      func(ctx context.Context) error
}

// forkScratchWorkspace creates a scratch fork's workspace on the pushed-ref
// path, from a revision the stack resolved rather than a caller's ref: it
// needs no stack refusal, since the stack is its source. The requester is
// admitted on the branch before anything is written; the branch is published
// only once its workspace exists, and the machine provisions in the
// background. A second fork of the same name from the same revision is the
// same branch (createBranchMachineRow joins it). Nothing here touches the
// source item's workspace or run (§8.5.2).
func (s *WorkspaceService) forkScratchWorkspace(ctx context.Context, fork ScratchFork) (db.Workspace, error) {
	if !isLowerHexRevision(fork.Commit) || !strings.HasPrefix(fork.Branch, scratchBranchPrefix) || fork.Retain == nil || fork.Publish == nil {
		return db.Workspace{}, pkgerrors.Internal("invalid scratch fork")
	}
	if err := s.preflightBranchMachine(ctx, fork.RepositoryID, fork.ActorID, fork.Branch, ""); err != nil {
		return db.Workspace{}, err
	}
	id := uuid.New()
	if err := fork.Retain(ctx, id.String()); err != nil {
		return db.Workspace{}, err
	}
	name := fork.Branch[strings.LastIndex(fork.Branch, "/")+1:]
	workspace, err := s.createPinnedWorkspace(ctx, CreateWorkspaceInput{RepositoryID: fork.RepositoryID, UserID: fork.ActorID, Name: name},
		fork.Branch, workspaceCreateMetadata{}, pinnedWorkspaceSource{id: id, commit: fork.Commit, parent: fork.Parent, item: fork.Item, base: fork.Base})
	if err != nil {
		// A refusal (the branch has another source, the person may not
		// join) keeps its status; anything else is the store's.
		var refused *pkgerrors.APIError
		if errors.As(err, &refused) {
			return db.Workspace{}, refused
		}
		return db.Workspace{}, mapWorkspaceCreateError(err, "create scratch workspace")
	}
	if err := fork.Publish(ctx); err != nil {
		return db.Workspace{}, err
	}
	s.provisionWorkspaceAsync(ctx, workspace, CreateWorkspaceSessionInput{RepositoryID: fork.RepositoryID, UserID: fork.ActorID,
		RepoOwner: fork.Owner, RepoName: fork.Repo, SourceBookmark: fork.Branch})
	return workspace, nil
}

// ForkScratch creates a scratch fork's workspace for the stack service and
// answers the branch with its machine.
func (l *workspaceMythicalLanes) ForkScratch(ctx context.Context, fork ScratchFork) (BranchMachineResponse, error) {
	if l == nil || l.workspaces == nil || l.workspaces.q == nil {
		return BranchMachineResponse{}, pkgerrors.Internal("workspaces are unavailable")
	}
	workspace, err := l.workspaces.forkScratchWorkspace(ctx, fork)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	return BranchMachineResponse{Name: workspace.TargetBookmark, Kind: branchKind(workspace.TargetBookmark), State: branchMachineState(workspace),
		Machine: l.workspaces.toWorkspaceResponse(workspace)}, nil
}

// workspaceSourceCheckout names what a new workspace's working copy starts
// from: its bookmark, or the pinned pushed-ref commit.
func workspaceSourceCheckout(row db.Workspace, bookmark string) string {
	if row.SourceCommit != "" {
		return row.SourceCommit
	}
	return bookmark
}

// fetchRuntimeWorkspaceSource fetches the pinned pushed-ref commit into a
// runtime workspace's clone and checks it out. A bookmark workspace needs
// nothing.
func (s *WorkspaceService) fetchRuntimeWorkspaceSource(ctx context.Context, row db.Workspace, requesterID int64, environment map[string]string) error {
	if row.SourceCommit == "" {
		return nil
	}
	args := []string{"git", "fetch"}
	if depth := workspaceSourceFetchDepth(s.workspaceCloneDepth(ctx, row.RepositoryID)); depth != "" {
		args = append(args, depth)
	}
	args = append(args, "origin", repohost.WorkspaceSourceRef(row.ID, row.SourceCommit))
	if err := s.runRuntimeRepositoryCommand(ctx, row, requesterID, "fetch-source", workspaceapi.Command{Args: args, Environment: environment}); err != nil {
		return err
	}
	// Jujutsu imports Git's HEAD when it initializes, which makes the pinned
	// commit visible to it.
	return s.runRuntimeRepositoryCommand(ctx, row, requesterID, "checkout-source", workspaceapi.Command{
		Args: []string{"git", "checkout", "--detach", row.SourceCommit},
	})
}

// workspaceSourceFetchDepth keeps the pushed-ref fetch as shallow as the
// workspace clone.
func workspaceSourceFetchDepth(depth int) string {
	if resolved := sandbox.ResolveCloneDepth(depth); resolved > 0 {
		return "--depth=" + strconv.Itoa(resolved)
	}
	return ""
}

// workspaceCloneSource is the pinned pushed-ref commit a VM clone checks out;
// the zero value checks out the bookmark.
type workspaceCloneSource struct {
	Ref    string
	Commit string
}

func workspaceCloneSourceOf(row db.Workspace) workspaceCloneSource {
	if row.SourceCommit == "" {
		return workspaceCloneSource{}
	}
	return workspaceCloneSource{Ref: repohost.WorkspaceSourceRef(row.ID, row.SourceCommit), Commit: row.SourceCommit}
}

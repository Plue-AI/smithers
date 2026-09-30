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
	metadata = normalizeWorkspaceCreateMetadata(metadata)
	workspace, err := s.createWorkspaceRow(ctx, db.CreateWorkspaceParams{
		ID: pgtype.UUID{Bytes: id, Valid: true}, SourceCommit: retained.CommitID,
		RepositoryID: input.RepositoryID, UserID: input.UserID, Name: strings.TrimSpace(input.Name), IsFork: true,
		TargetBookmark: targetWorkspaceBookmark(bookmark), Kind: metadata.kind,
		EnvironmentSource:      metadata.environment.Source,
		EnvironmentRevision:    metadata.environment.Revision,
		EnvironmentClosureHash: metadata.environment.ClosureHash, Status: "starting",
	})
	if err != nil {
		return db.Workspace{}, mapWorkspaceCreateError(err, "create pushed-ref workspace")
	}
	return workspace, nil
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

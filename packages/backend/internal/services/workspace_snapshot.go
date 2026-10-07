package services

import (
	"context"
	"encoding/base64"
	"net/http"
	"path"
	"sort"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// Snapshot reads use only install-shipped repository-store operations. No guest
// entry, captured executable, hook or branch-selected tool participates.
type workspaceSnapshotStore interface {
	BranchHeadReader
	GetChange(context.Context, string, string, string) (repohost.Change, error)
	ListDirectory(context.Context, string, string, string, string, string, int) ([]repohost.TreeEntry, error)
	GetFileAtCommit(context.Context, string, string, string, string) (repohost.FileContent, error)
}

// Metadata and snapshot reads share the credential's branch restriction.
// Snapshot verification belongs only to reads that consume retained objects.
func authorizeWorkspaceReadBinding(ctx context.Context, row db.Workspace) error {
	if delegation, delegated := middleware.AuthInfoFromContext(ctx).Delegation(); delegated && (delegation.Branch == "" || !strings.EqualFold(delegation.Branch, row.ID)) {
		return pkgerrors.Forbidden("credential is bound to another branch")
	}
	return nil
}

func (s *WorkspaceService) workspaceSnapshotTarget(ctx context.Context, id string, repositoryID, userID int64) (db.Workspace, string, string, string, bool, error) {
	row, err := s.loadWorkspaceWithAccess(ctx, id, repositoryID, userID, WorkspaceAccessRead)
	if err != nil {
		return row, "", "", "", false, err
	}
	if err := authorizeWorkspaceReadBinding(ctx, row); err != nil {
		return row, "", "", "", false, err
	}
	if row.Status != "suspended" && row.Status != "stopped" {
		return row, "", "", "", false, nil
	}
	unavailable := func() (db.Workspace, string, string, string, bool, error) {
		return row, "", "", "", true, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "verified branch snapshot unavailable")
	}
	store, ok := s.branchHeads.(workspaceSnapshotStore)
	if !ok || s.transactions == nil || s.branchMachineProviders.LaneBinding == nil || row.HeadCommitID == "" || strings.TrimSpace(row.VmID) == "" {
		return unavailable()
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return row, "", "", "", true, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := s.branchMachineProviders.LaneBinding(ctx, tx, repositoryID, row.TargetBookmark, row.ID); err != nil {
		return row, "", "", "", true, err
	}
	slug, err := s.workspaceRepoSlug(ctx, repositoryID)
	if err != nil {
		return row, "", "", "", true, err
	}
	owner, repo, _ := strings.Cut(slug, "/")
	advertisement, err := store.InfoRefsUploadPack(ctx, owner, repo)
	if err != nil {
		return unavailable()
	}
	refs, err := parseUploadPackAdvertisement(advertisement)
	if err != nil {
		return unavailable()
	}
	for _, ref := range refs {
		if ref.name == repohost.BranchHeadRef(row.ID) && ref.oid == row.HeadCommitID {
			commit, err := store.GetChange(ctx, owner, repo, row.HeadCommitID)
			if err != nil || commit.CommitID != row.HeadCommitID {
				return unavailable()
			}
			return row, owner, repo, row.HeadCommitID, true, nil
		}
	}
	return unavailable()
}

// RetainedBranchHead verifies the objects behind an asleep branch's file
// reads. A metadata projection is not a snapshot verification receipt.
func (s *WorkspaceService) RetainedBranchHead(ctx context.Context, id string, repositoryID, userID int64) (string, error) {
	_, _, _, head, asleep, err := s.workspaceSnapshotTarget(ctx, id, repositoryID, userID)
	if err != nil {
		return "", err
	}
	if !asleep {
		return "", pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch snapshot changed")
	}
	return head, nil
}

func (s *WorkspaceService) readWorkspaceSnapshot(ctx context.Context, owner, repo, head, relative string) (WorkspaceFileContent, error) {
	file, err := s.branchHeads.(workspaceSnapshotStore).GetFileAtCommit(ctx, owner, repo, head, relative)
	if repohost.IsFileNotFound(err) {
		return WorkspaceFileContent{}, pkgerrors.NotFound("file not found")
	}
	if err != nil {
		return WorkspaceFileContent{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch snapshot file unavailable").WithCause(err)
	}
	if file.TooLarge {
		return WorkspaceFileContent{}, pkgerrors.RequestEntityTooLarge("workspace file exceeds 1 MiB limit")
	}
	content := []byte(file.Content)
	switch file.Encoding {
	case "", "utf8":
	case "base64":
		content, err = base64.StdEncoding.DecodeString(file.Content)
		if err != nil {
			return WorkspaceFileContent{}, pkgerrors.Internal("invalid snapshot file encoding").WithCause(err)
		}
	default:
		return WorkspaceFileContent{}, pkgerrors.Internal("invalid snapshot file encoding")
	}
	if len(content) > MaxWorkspaceFileBytes {
		return WorkspaceFileContent{}, pkgerrors.RequestEntityTooLarge("workspace file exceeds 1 MiB limit")
	}
	return workspaceFileContent(relative, content), nil
}

func (s *WorkspaceService) listWorkspaceSnapshot(ctx context.Context, row db.Workspace, owner, repo, head, relative string) ([]WorkspaceFileEntry, error) {
	store := s.branchHeads.(workspaceSnapshotStore)
	entries := []WorkspaceFileEntry{}
	after := ""
	for {
		page, err := store.ListDirectory(ctx, owner, repo, head, relative, after, 1000)
		if err != nil {
			return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch snapshot directory unavailable").WithCause(err)
		}
		for _, entry := range page {
			if path.Dir(entry.Path) != relative && !(relative == "" && path.Dir(entry.Path) == ".") {
				return nil, pkgerrors.Internal("invalid snapshot directory entry")
			}
			kind := entry.Kind
			if kind == "directory" {
				kind = "dir"
			}
			value := WorkspaceFileEntry{Name: path.Base(entry.Path), Path: entry.Path, Type: kind}
			if kind == "file" {
				file, err := store.GetFileAtCommit(ctx, owner, repo, head, entry.Path)
				if err != nil {
					// The tree can include symlinks and submodules. The bounded file
					// API refuses those; retain their entry without invented byte metadata.
					status, ok := repohost.IsStatusError(err)
					if !ok || status.StatusCode != http.StatusNotFound || repohost.IsFileNotFound(err) {
						return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch snapshot metadata unavailable").WithCause(err)
					}
				} else if !file.TooLarge {
					switch file.Encoding {
					case "", "utf8":
						value.Size = int64(len(file.Content))
					case "base64":
						raw, err := base64.StdEncoding.DecodeString(file.Content)
						if err != nil {
							return nil, pkgerrors.Internal("invalid snapshot file encoding").WithCause(err)
						}
						value.Size = int64(len(raw))
					default:
						return nil, pkgerrors.Internal("invalid snapshot file encoding")
					}
				}
			}

			entries = append(entries, value)
		}
		if len(page) < 1000 {
			break
		}
		next := page[len(page)-1].Path
		if next <= after {
			return nil, pkgerrors.Internal("invalid snapshot directory cursor")
		}
		after = next
	}
	sort.Slice(entries, func(i, j int) bool {
		if (entries[i].Type == "dir") != (entries[j].Type == "dir") {
			return entries[i].Type == "dir"
		}
		return entries[i].Name < entries[j].Name
	})
	s.touchWorkspaceEntryRecency(ctx, row.ID, "files")
	return entries, nil
}

// CapturedHead gives the existing stack diff reader the same verified head as
// File and Branch cards, through the production lane adapter.
func (l *workspaceMythicalLanes) CapturedHead(ctx context.Context, id string, repositoryID, userID int64) (string, error) {
	if l == nil || l.workspaces == nil {
		return "", pkgerrors.New(pkgerrors.CodeServiceUnavailable, "verified branch snapshot unavailable")
	}
	_, _, _, head, asleep, err := l.workspaces.workspaceSnapshotTarget(ctx, id, repositoryID, userID)
	if err != nil {
		return "", err
	}
	if !asleep {
		return "", pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch state changed")
	}
	return head, nil
}

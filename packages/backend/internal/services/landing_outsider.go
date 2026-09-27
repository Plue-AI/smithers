package services

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// landingProvenanceStore records which workspace opened a landing and whether
// that workspace ran work started from an outsider's text.
type landingProvenanceStore interface {
	RecordLandingSourceWorkspace(ctx context.Context, landingRequestID int64, workspaceID string) error
	IsOutsiderLanding(ctx context.Context, landingRequestID int64) (bool, error)
}

// recordLandingSource keeps the workspace named by the creating landing
// credential. A replayed create records it again, idempotently.
func (s *LandingService) recordLandingSource(ctx context.Context, landingID int64) error {
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || !info.IsTokenAuth {
		return nil
	}
	workspaceID := middleware.ParseTokenLandingWorkspace(info.RawScopes)
	if workspaceID == "" {
		return nil
	}
	store, ok := s.queries.(landingProvenanceStore)
	if !ok {
		return pkgerrors.Internal("landing provenance store unavailable")
	}
	if err := store.RecordLandingSourceWorkspace(ctx, landingID, workspaceID); err != nil {
		return pkgerrors.Internal("record landing workspace").WithCause(err)
	}
	return nil
}

// landingProtectedFileReader reads a target revision's files.
type landingProtectedFileReader interface {
	GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
}

// landingProtectedDirectoryReader lists a target revision's directories.
type landingProtectedDirectoryReader interface {
	ListDirectory(ctx context.Context, owner, repo, changeID, prefix, after string, limit int) ([]repohost.TreeEntry, error)
}

// landingProtectedChangeReader resolves a target revision to its commit.
type landingProtectedChangeReader interface {
	GetChange(ctx context.Context, owner, repo, changeID string) (repohost.Change, error)
}

// refuseProtectedPaths refuses touched paths that the list on the target
// revision protects (protectedPathsAt). A maintainer makes such a change.
// The list is read at the revision's commit and kept per repository for
// that commit (protectedPathsCache).
func refuseProtectedPaths(ctx context.Context, files landingProtectedFileReader, owner, repo, targetRevision string, touched []string) error {
	directories, ok := files.(landingProtectedDirectoryReader)
	if !ok {
		return pkgerrors.Internal("protected path listing unavailable")
	}
	changes, ok := files.(landingProtectedChangeReader)
	if !ok {
		return pkgerrors.Internal("protected path revision resolver unavailable")
	}
	target, err := changes.GetChange(ctx, owner, repo, targetRevision)
	if err != nil {
		return mapLandingRepoHostError(err, "failed to resolve the target revision")
	}
	commit := target.CommitID
	entries, err := protectedPathsCache.at(ctx, owner+"/"+repo, commit, func(ctx context.Context) ([]string, error) {
		return protectedPathsAt(ctx, landingRevisionTree{reader: files, directories: directories, owner: owner, repo: repo, revision: commit})
	})
	if err != nil {
		return err
	}
	if refused := protectedPathsTouched(touched, entries); len(refused) > 0 {
		return pkgerrors.UnprocessableEntity("a maintainer changes protected paths: " + strings.Join(refused, ", "))
	}
	return nil
}

// landingRevisionTree reads one revision through the repo host.
type landingRevisionTree struct {
	reader                landingProtectedFileReader
	directories           landingProtectedDirectoryReader
	owner, repo, revision string
}

func (t landingRevisionTree) read(ctx context.Context, file string) ([]byte, bool, error) {
	content, err := t.reader.GetFileAtChange(ctx, t.owner, t.repo, t.revision, file)
	if status, ok := repohost.IsStatusError(err); ok && status.StatusCode == 404 {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if content.TooLarge || content.Encoding == "base64" {
		return nil, false, fmt.Errorf("%s is not readable text", file)
	}
	return []byte(content.Content), true, nil
}

func (t landingRevisionTree) files(ctx context.Context, dir string) ([]string, error) {
	var files []string
	pending := []string{dir}
	for len(pending) > 0 {
		prefix := pending[0]
		pending = pending[1:]
		after := ""
		for {
			page, err := t.directories.ListDirectory(ctx, t.owner, t.repo, t.revision, prefix, after, 1000)
			if status, ok := repohost.IsStatusError(err); ok && status.StatusCode == 404 {
				break
			}
			if err != nil {
				return nil, err
			}
			for _, entry := range page {
				switch entry.Kind {
				case "dir":
					pending = append(pending, entry.Path)
				case "file":
					files = append(files, entry.Path)
				}
				if len(files)+len(pending) > workflowTrustReadLimit {
					return nil, errors.New(prefix + " is too large to derive protected paths from")
				}
			}
			if len(page) < 1000 {
				break
			}
			if next := page[len(page)-1].Path; next > after {
				after = next
			} else {
				return nil, errors.New(prefix + " listing does not advance")
			}
		}
	}
	return files, nil
}

// isOutsiderLanding reports whether a workspace that ran outsider-started
// work opened the landing; without a provenance store it fails closed.
func isOutsiderLanding(ctx context.Context, store any, landingID int64) (bool, error) {
	provenance, ok := store.(landingProvenanceStore)
	if !ok {
		return false, pkgerrors.Internal("landing provenance store unavailable")
	}
	return provenance.IsOutsiderLanding(ctx, landingID)
}

// refuseOutsiderLandingPaths refuses, before a landing leaves Smithers, an
// outsider landing that changes a protected path. Every commit a push would
// carry must be one of the landing's changes, stacked on the target.
func (s *LandingService) refuseOutsiderLandingPaths(ctx context.Context, owner, repo string, landingID int64, changeIDs []string, targetBookmark string) error {
	outsider, err := isOutsiderLanding(ctx, s.queries, landingID)
	if err != nil || !outsider {
		return err
	}
	target, err := s.targetBookmarkRevision(ctx, owner, repo, targetBookmark)
	if err != nil {
		return err
	}
	var touched []string
	parent := target
	for _, changeID := range changeIDs {
		change, err := s.repoHost.GetChange(ctx, owner, repo, changeID)
		if err != nil {
			return mapLandingRepoHostError(err, "failed to resolve a landing change")
		}
		if len(change.ParentChangeIDs) != 1 || change.ParentChangeIDs[0] != parent {
			return pkgerrors.Conflict("the landing's changes are not stacked on " + targetBookmark + "; rebase it first")
		}
		parent = change.ChangeID
		files, err := s.repoHost.GetChangeFiles(ctx, owner, repo, change.CommitID)
		if err != nil {
			return mapLandingRepoHostError(err, "failed to list a landing change's files")
		}
		for _, file := range files {
			touched = append(touched, file.Path)
		}
	}
	return refuseProtectedPaths(ctx, s.repoHost, owner, repo, target, touched)
}

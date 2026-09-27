package services

import (
	"context"
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

// landingProtectedFileReader reads main's factory projection.
type landingProtectedFileReader interface {
	GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
}

// refuseProtectedPaths refuses touched paths that the list on the target
// revision protects. A maintainer makes such a change.
func refuseProtectedPaths(ctx context.Context, files landingProtectedFileReader, owner, repo, targetRevision string, touched []string) error {
	var projection []byte
	file, err := files.GetFileAtChange(ctx, owner, repo, targetRevision, factoryProjectionPath)
	if status, ok := repohost.IsStatusError(err); !ok || status.StatusCode != 404 {
		if err != nil {
			return err
		}
		if file.TooLarge || file.Encoding == "base64" {
			return fmt.Errorf("%s is not readable text", factoryProjectionPath)
		}
		projection = []byte(file.Content)
	}
	entries, err := protectedPaths(projection)
	if err != nil {
		return err
	}
	if refused := protectedPathsTouched(touched, entries); len(refused) > 0 {
		return pkgerrors.UnprocessableEntity("a maintainer changes protected paths: " + strings.Join(refused, ", "))
	}
	return nil
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

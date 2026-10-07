package services

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Branch files reuse the workspace facets and their credential, confinement and
// snapshot checks. The install resolves the repository, never a request body.
func (s *WorkspaceService) branchFileWorkspace(ctx context.Context, branch string, repositoryID, userID int64) (db.Workspace, error) {
	if _, err := uuid.Parse(branch); err == nil {
		return s.loadWorkspaceWithAccess(ctx, branch, repositoryID, userID, WorkspaceAccessRead)
	}
	lookup, ok := s.q.(interface {
		GetBranchWorkspace(context.Context, db.GetBranchWorkspaceParams) (db.Workspace, error)
	})
	if !ok {
		return db.Workspace{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch store unavailable")
	}
	row, err := lookup.GetBranchWorkspace(ctx, db.GetBranchWorkspaceParams{RepositoryID: repositoryID, TargetBookmark: branch})
	if errors.Is(err, pgx.ErrNoRows) {
		return row, pkgerrors.NotFound("branch not found")
	}
	return row, err
}

func (s *WorkspaceService) ListBranchFiles(ctx context.Context, branch string, repositoryID, userID int64, filePath string) ([]WorkspaceFileEntry, error) {
	row, err := s.branchFileWorkspace(ctx, branch, repositoryID, userID)
	if err != nil {
		return nil, err
	}
	return s.ListWorkspaceFiles(ctx, row.ID, repositoryID, userID, filePath)
}

// A read does not depend on guest-entry, admission or session-identity gates.
// Membership and the authoritative branch binding still hold in one transaction.
func (s *WorkspaceService) authorizeBranchFileRead(ctx context.Context, row db.Workspace, userID int64) error {
	if err := s.requireBranchMachineProviders(); err != nil {
		return err
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	p := s.branchMachineProviders
	if err := p.Membership(ctx, tx, row.RepositoryID, userID); err != nil {
		return err
	}
	if err := p.Authorize(ctx, tx, "branch.read", row.RepositoryID, row.TargetBookmark, userID); err != nil {
		return err
	}
	return p.LaneBinding(ctx, tx, row.RepositoryID, row.TargetBookmark, row.ID)
}

// PresenceBranch resolves a branch under the same membership, lane and branch
// authorizer as file reads. Presence metadata never opens a guest file or wakes it.
func (s *WorkspaceService) PresenceBranch(ctx context.Context, branch string, repositoryID, userID int64) (db.Workspace, error) {
	row, err := s.branchFileWorkspace(ctx, branch, repositoryID, userID)
	if err != nil {
		return row, err
	}
	if err := s.requireWorkspaceAccess(ctx, row.ID, row.UserID, userID, WorkspaceAccessRead); err != nil {
		return row, err
	}
	return row, s.authorizeBranchFileRead(ctx, row, userID)
}

// ReadBranchFile uses the same confined working-copy reader and sleep snapshot
// selection as the workspace facet. Reads never launch or wake a machine.
func (s *WorkspaceService) ReadBranchFile(ctx context.Context, branch string, repositoryID, userID int64, filePath, digest string) (WorkspaceFileContent, error) {
	row, err := s.PresenceBranch(ctx, branch, repositoryID, userID)
	if err != nil {
		return WorkspaceFileContent{}, err
	}
	content, err := s.ReadWorkspaceFile(ctx, row.ID, repositoryID, userID, filePath)
	if err != nil && (digest == "" || digest == "absent") {
		return content, err
	}
	if digest != "" && (err != nil || digest != content.Digest && digest != "sha256:"+content.Digest) {
		if s.burstPool != nil && s.burstVersions != nil {
			var version, blob string
			err := s.burstPool.QueryRow(ctx, `SELECT e.data->>'versions',f.after_blob FROM burst_files f JOIN product_job_events e ON e.event_id=f.event_id WHERE e.tenant_id=$1 AND e.principal_id=$2 AND f.path=$3 AND f.post_digest=$4 AND f.after_blob IS NOT NULL ORDER BY e.sequence DESC LIMIT 1`, fmt.Sprint(repositoryID), "branch:"+row.ID, filePath, strings.TrimPrefix(digest, "sha256:")).Scan(&version, &blob)
			if err == nil {
				bytes, err := s.readBurstFile(ctx, repositoryID, "b/"+filePath, version, blob)
				if err != nil {
					return WorkspaceFileContent{}, err
				}
				if fmt.Sprintf("%x", sha256.Sum256(bytes)) != strings.TrimPrefix(digest, "sha256:") {
					return WorkspaceFileContent{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "invalid file version digest")
				}
				captured := workspaceFileContent(filePath, bytes)
				captured.Digest = digest
				return captured, nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return WorkspaceFileContent{}, err
			}
		}
		return WorkspaceFileContent{}, pkgerrors.Conflict("file changed since requested digest")
	}
	return content, err
}

// BranchFileFact is the latest durable per-file burst, fenced by branch access.
type BranchFileFact struct {
	Actor                              json.RawMessage
	Change, RenamedTo, Version, Digest string
	At                                 time.Time
}

func (s *WorkspaceService) BranchFileFact(ctx context.Context, branch string, repositoryID, userID int64, filePath string) (*BranchFileFact, error) {
	row, err := s.PresenceBranch(ctx, branch, repositoryID, userID)
	if err != nil {
		return nil, err
	}
	if s.burstPool == nil {
		return nil, nil
	}
	fact := &BranchFileFact{}
	err = s.burstPool.QueryRow(ctx, `SELECT COALESCE(e.data->'actor','null'::jsonb),f.change,COALESCE(f.renamed_to,''),COALESCE(e.data->>'versions',''),COALESCE(f.post_digest,'absent'),e.recorded_at FROM burst_files f JOIN product_job_events e ON e.event_id=f.event_id WHERE e.tenant_id=$1 AND e.principal_id=$2 AND f.path=$3 ORDER BY e.sequence DESC LIMIT 1`, fmt.Sprint(repositoryID), "branch:"+row.ID, filePath).Scan(&fact.Actor, &fact.Change, &fact.RenamedTo, &fact.Version, &fact.Digest, &fact.At)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return fact, err
}

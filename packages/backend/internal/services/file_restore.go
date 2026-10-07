package services

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type BurstVersionReader interface {
	GetFileAtCommit(context.Context, string, string, string, string) (repohost.FileContent, error)
}

func WithWorkspaceBurstVersions(pool *pgxpool.Pool, reader BurstVersionReader) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.burstPool = pool; s.burstVersions = reader }
}

// RestoreBranchFile selects only a retained version belonging to this branch,
// then reuses the one guarded write service. Actor and base never come from
// the file bytes, guest or request's supplied attribution.
func (s *WorkspaceService) RestoreBranchFile(ctx context.Context, branch string, repositoryID, userID int64, filePath, version, base string, deleted bool) (*WorkspaceFileWriteResult, error) {
	if s.burstPool == nil || s.burstVersions == nil {
		return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "file versions unavailable")
	}
	if !workspaceFileBaseDigestPattern.MatchString(base) && base != "absent" {
		return nil, pkgerrors.BadRequest("invalid base digest")
	}
	if len(version) != 40 || strings.Trim(version, "0123456789abcdef") != "" {
		return nil, pkgerrors.BadRequest("invalid file version")
	}
	if err := ValidateRepositoryPath(filePath); err != nil {
		return nil, err
	}
	row, err := s.PresenceBranch(ctx, branch, repositoryID, userID)
	if err != nil {
		return nil, err
	}
	var before, post, change string
	err = s.burstPool.QueryRow(ctx, `SELECT COALESCE(f.before_blob,''),COALESCE(f.post_digest,'absent'),f.change FROM burst_files f JOIN product_job_events e ON e.event_id=f.event_id WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.data->>'versions'=$3 AND f.path=$4 ORDER BY e.sequence DESC LIMIT 1`, fmt.Sprint(repositoryID), "branch:"+row.ID, version, filePath).Scan(&before, &post, &change)
	if err == pgx.ErrNoRows {
		return nil, pkgerrors.NotFound("file version not found")
	}
	if err != nil {
		return nil, err
	}
	if deleted && change != "deleted" {
		return nil, pkgerrors.BadRequest("file version is not deleted")
	}
	if base != post {
		return nil, pkgerrors.Conflict("file version base differs")
	}
	var content []byte
	if before != "" {
		slug, err := s.workspaceRepoSlug(ctx, repositoryID)
		if err != nil {
			return nil, err
		}
		owner, repo, _ := strings.Cut(slug, "/")
		file, err := s.burstVersions.GetFileAtCommit(ctx, owner, repo, version, "a/"+filePath)
		if err != nil {
			return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "file version unavailable")
		}
		if file.TooLarge {
			return nil, pkgerrors.RequestEntityTooLarge("file version exceeds 1 MiB")
		}
		switch file.Encoding {
		case "", "utf-8":
			content = []byte(file.Content)
		case "base64":
			content, err = base64.StdEncoding.DecodeString(file.Content)
		default:
			err = fmt.Errorf("unknown file encoding")
		}
		if err != nil || len(content) > MaxWorkspaceFileBytes {
			return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "invalid file version")
		}
		// Independently verify the indexed blob, even if the object reader is
		// remote. Empty files remain distinct from absent before versions.
		header := []byte(fmt.Sprintf("blob %d\x00", len(content)))
		header = append(header, content...)
		actual := fmt.Sprintf("%x", sha1.Sum(header))
		if len(before) == 64 {
			actual = fmt.Sprintf("%x", sha256.Sum256(header))
		}
		if actual != before {
			return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "invalid file version")
		}
	}
	return s.WriteWorkspaceFiles(ctx, row.ID, repositoryID, userID, []workspaceapi.FileMutation{{Path: filePath, BaseDigest: post, Content: content}})
}

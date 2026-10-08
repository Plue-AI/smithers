package services

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
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

// RestoreBranchFile verifies a retained version belonging to this branch and
// restores its before bytes or the last document text through one guarded
// write service. Actor and base never come from supplied attribution.
func (s *WorkspaceService) RestoreBranchFile(ctx context.Context, branch string, repositoryID, userID int64, filePath, version, base string, deleted bool, documentText ...*string) (*WorkspaceFileWriteResult, error) {
	if len(documentText) > 1 || (len(documentText) == 1 && documentText[0] != nil && (!deleted || len(*documentText[0]) > MaxWorkspaceFileBytes)) {
		return nil, pkgerrors.BadRequest("invalid document restore text")
	}
	if s.burstPool == nil || s.burstVersions == nil {
		return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "file versions unavailable")
	}
	if err := validateFileRestoreInput(filePath, version, base); err != nil {
		return nil, err
	}

	var subject InstallSubject
	if s.installQueries != nil {
		var command string
		var err error
		subject, command, err = InstallFileRestoreSubject(ctx, s.installQueries, repositoryID, branch, filePath, version, base, deleted, documentText...)
		if err != nil {
			return nil, err
		}
		decision, err := Authorize(ctx, s.installQueries, command, subject)
		if err != nil {
			return nil, err
		}
		if decision.UserID != userID {
			return nil, confirmationPermission()
		}
		ctx = WithInstallAuthorization(ctx, command, decision, subject)
	}

	row, err := s.PresenceBranch(ctx, branch, repositoryID, userID)
	if err != nil {
		return nil, err
	}
	if s.installQueries != nil && row.ID != subject.WorkspaceID {
		return nil, confirmationPermission()
	}
	if row.Status != "running" {
		return nil, pkgerrors.Conflict("branch is asleep")
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
	content, err := s.readBurstBefore(ctx, repositoryID, filePath, version, before)
	if err != nil {
		return nil, err
	}
	// S3 restores the member's last document text as one attributed write;
	// S2 keeps the verified before-version. Both require the retained deletion
	// fact and use the same absent-base guarded mutation below.
	if len(documentText) == 1 && documentText[0] != nil {
		content = []byte(*documentText[0])
	}
	return s.writeWorkspaceFiles(ctx, row.ID, repositoryID, userID, []workspaceapi.FileMutation{{Path: filePath, BaseDigest: post, Content: content}}, false)
}

// readBurstBefore verifies the retained blob before exposing or restoring bytes.
func (s *WorkspaceService) readBurstBefore(ctx context.Context, repositoryID int64, filePath, version, before string) ([]byte, error) {
	return s.readBurstFile(ctx, repositoryID, "a/"+filePath, version, before)
}
func (s *WorkspaceService) readBurstFile(ctx context.Context, repositoryID int64, objectPath, version, before string) ([]byte, error) {
	var content []byte
	if before != "" {
		slug, err := s.workspaceRepoSlug(ctx, repositoryID)
		if err != nil {
			return nil, err
		}
		owner, repo, _ := strings.Cut(slug, "/")
		file, err := s.burstVersions.GetFileAtCommit(ctx, owner, repo, version, objectPath)
		if err != nil {
			return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "file version unavailable")
		}
		if file.TooLarge {
			return nil, pkgerrors.RequestEntityTooLarge("file version exceeds 1 MiB")
		}
		switch file.Encoding {
		case "", "utf-8", "utf8":
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
	return content, nil
}

func (s *WorkspaceService) CompareBranchFile(ctx context.Context, branch string, repositoryID, userID int64, filePath, version string) (WorkspaceFileContent, error) {
	return s.compareBranchFile(ctx, branch, repositoryID, userID, filePath, version, false)
}

// CompareOutsideBranchFile reads the retained outside end state, rather than
// the pre-burst version used by ordinary file recovery.
func (s *WorkspaceService) CompareOutsideBranchFile(ctx context.Context, branch string, repositoryID, userID int64, filePath, version string) (WorkspaceFileContent, error) {
	return s.compareBranchFile(ctx, branch, repositoryID, userID, filePath, version, true)
}

func (s *WorkspaceService) compareBranchFile(ctx context.Context, branch string, repositoryID, userID int64, filePath, version string, outside bool) (WorkspaceFileContent, error) {
	if s.burstPool == nil || s.burstVersions == nil {
		return WorkspaceFileContent{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "file versions unavailable")
	}
	if len(version) != 40 || strings.Trim(version, "0123456789abcdef") != "" {
		return WorkspaceFileContent{}, pkgerrors.BadRequest("invalid file version")
	}
	if err := ValidateRepositoryPath(filePath); err != nil {
		return WorkspaceFileContent{}, err
	}
	row, err := s.PresenceBranch(ctx, branch, repositoryID, userID)
	if err != nil {
		return WorkspaceFileContent{}, err
	}
	column, objectPath := "before_blob", "a/"+filePath
	if outside {
		column, objectPath = "after_blob", "b/"+filePath
	}
	var before string
	err = s.burstPool.QueryRow(ctx, `SELECT COALESCE(f.`+column+`,'') FROM burst_files f JOIN product_job_events e ON e.event_id=f.event_id WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.data->>'versions'=$3 AND f.path=$4 ORDER BY e.sequence DESC LIMIT 1`, fmt.Sprint(repositoryID), "branch:"+row.ID, version, filePath).Scan(&before)
	if err == pgx.ErrNoRows {
		return WorkspaceFileContent{}, pkgerrors.NotFound("file version not found")
	}
	if err != nil {
		return WorkspaceFileContent{}, err
	}
	content, err := s.readBurstFile(ctx, repositoryID, objectPath, version, before)
	if err != nil {
		return WorkspaceFileContent{}, err
	}
	return workspaceFileContent(filePath, content), nil
}

// InstallFileRestoreSubject binds the retained version and validated request to
// the stored branch before disclosure or mutation. It grants no membership.
func InstallFileRestoreSubject(ctx context.Context, q *db.Queries, repository int64, branch, path, version, base string, deleted bool, documentText ...*string) (InstallSubject, string, error) {
	command := "file.restore"
	if deleted {
		command = "file.restore-deleted"
	}
	if err := validateFileRestoreInput(path, version, base); err != nil {
		return InstallSubject{}, command, err
	}

	if branch == "" || branch == "main" {
		return InstallSubject{}, command, confirmationPermission()
	}
	var row db.Workspace
	var err error
	if _, parse := uuid.Parse(branch); parse == nil {
		row, err = q.GetWorkspace(ctx, branch)
	} else {
		row, err = q.GetBranchWorkspace(ctx, db.GetBranchWorkspaceParams{RepositoryID: repository, TargetBookmark: branch})
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return InstallSubject{}, command, confirmationPermission()
	}
	if err != nil {
		return InstallSubject{}, command, err
	}
	if row.RepositoryID != repository || row.DeletedAt.Valid {
		return InstallSubject{}, command, confirmationPermission()
	}
	payload := []any{branch, path, version, base, deleted}
	if len(documentText) == 1 && documentText[0] != nil {
		payload = append(payload, *documentText[0])
	}
	raw, _ := json.Marshal(payload)
	digest := sha256.Sum256(raw)
	return InstallSubject{RepositoryID: repository, WorkspaceID: row.ID, Source: version, Base: base, Resource: path, PayloadDigest: fmt.Sprintf("%x", digest)}, command, nil
}

func validateFileRestoreInput(path, version, base string) error {
	if !workspaceFileBaseDigestPattern.MatchString(base) && base != "absent" {
		return pkgerrors.BadRequest("invalid base digest")
	}
	if len(version) != 40 || strings.Trim(version, "0123456789abcdef") != "" {
		return pkgerrors.BadRequest("invalid file version")
	}
	if err := ValidateRepositoryPath(path); err != nil {
		return err
	}
	return nil
}
